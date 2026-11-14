/**
 * H03.U04 + U02 · AssociateGuestReservation.
 *
 * Asocia una reserva creada como GUEST a una cuenta CLIENT autenticada.
 *
 * Exigencias congeladas:
 *  - Sesión CLIENT válida y viva (U02), con AAL2 real.
 *  - Prueba de control del invitado: credencial de acceso activa (token) de ESA
 *    reserva. Sin prueba no hay asociación.
 *  - Todo en UNA transacción: cambio de propietario + revocación/transformación
 *    del acceso invitado + evento de historia + auditoría.
 *  - NO se fusiona CRM automáticamente: no se crea `ClientProfile`, no se crea
 *    `client_account_links` y no se toca el teléfono del contacto.
 *  - Idempotencia por principal y Business (`executePrincipalOperation`).
 */
import { DomainError } from "@youngkingz/contracts";
import { executePrincipalOperation, type Tx } from "../../system/operations.js";
import { guestTokenDigest } from "../security/guest-access.js";

const ASSOCIATE_COMMAND = "booking.reservation.associate";

export type AssociateGuestInput = {
  businessId: string;
  reservationId: string;
  accountId: string;
  authSessionId: string;
  guestToken: string;
  operationId: string;
};

export type AssociateGuestResult = {
  reservationId: string;
  ownerType: "CLIENT";
  ownerAccountId: string;
  guestAccess: "REVOKED";
  associatedAt: string;
};

export async function associateGuestReservation(input: AssociateGuestInput): Promise<AssociateGuestResult & { replayed: boolean }> {
  const principal = { kind: "CLIENT" as const, businessId: input.businessId, accountId: input.accountId, principalRef: input.authSessionId };

  const result = await executePrincipalOperation<AssociateGuestResult>({
    operationId: input.operationId,
    command: ASSOCIATE_COMMAND,
    principal,
    payload: { reservationId: input.reservationId, accountId: input.accountId },
  }, async (tx) => {
    const [reservation] = await tx`select id,status,owner_type "ownerType",owner_account_id "ownerAccountId",revision from booking.reservations where business_id=${input.businessId} and id=${input.reservationId} for update`;
    if (!reservation) throw new DomainError("BOOKING_NOT_FOUND", "Reservation not found", 404);
    if (reservation.ownerType === "CLIENT") {
      if (reservation.ownerAccountId !== input.accountId) {
        throw new DomainError("BOOKING_NOT_OWNED", "Reservation already belongs to another account", 403);
      }
      throw new DomainError("CONFLICT", "Reservation is already associated with this account", 409);
    }
    if (reservation.status !== "CONFIRMED") throw new DomainError("BOOKING_ALREADY_CANCELLED", "Reservation is not active", 409);

    // Prueba de control: credencial invitada ACTIVE de ESTA reserva.
    const digest = guestTokenDigest(input.guestToken);
    const [credential] = await tx`select id,status::text status from booking.guest_credentials where business_id=${input.businessId} and reservation_id=${input.reservationId} and token_digest=${digest} for update`;
    if (!credential || credential.status !== "ACTIVE") {
      throw new DomainError("GUEST_ACCESS_INVALID", "Guest credential is invalid for this reservation", 403);
    }

    // Cambio de propietario + revocación del acceso invitado (accesos seguros).
    await tx`update booking.reservations set owner_type='CLIENT', owner_account_id=${input.accountId}, revision=revision+1, updated_at=now() where business_id=${input.businessId} and id=${input.reservationId}`;
    await tx`update booking.guest_credentials set status='REVOKED', revoked_at=now() where business_id=${input.businessId} and reservation_id=${input.reservationId} and status='ACTIVE'`;
    await tx`update booking.guest_delivery_envelopes set consumed_at=now() where business_id=${input.businessId} and reservation_id=${input.reservationId} and consumed_at is null`;

    const [after] = await tx`select revision from booking.reservations where business_id=${input.businessId} and id=${input.reservationId}`;
    const sequence = await nextSeq(tx, input.businessId, input.reservationId);
    await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,actor_account_id,before_revision,after_revision,changes)
      values (${input.businessId},${input.reservationId},${sequence},'RESERVATION_ACCOUNT_ASSOCIATED',${input.operationId},'CLIENT',${input.accountId},${reservation.revision as number},${Number(after!.revision)},${JSON.stringify({ ownerType: { before: "GUEST", after: "CLIENT" }, guestAccess: { before: "ACTIVE", after: "REVOKED" } })}::jsonb)`;
    await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,actor_account_id,changes)
      values (${input.businessId},${input.reservationId},${sequence + 1},'GUEST_ACCESS_REVOKED',${input.operationId},'CLIENT',${input.accountId},${JSON.stringify({ reason: "ACCOUNT_ASSOCIATED" })}::jsonb)`;

    await tx`insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${input.businessId},${input.accountId},${input.operationId},'booking.reservation.associated','bookings.read',${JSON.stringify({ type: "BUSINESS", businessId: input.businessId })}::jsonb,'RESERVATION',${input.reservationId},'SUCCEEDED',${JSON.stringify({ ownerType: "CLIENT", crmMerged: false })}::jsonb)`;

    return {
      reservationId: input.reservationId,
      ownerType: "CLIENT" as const,
      ownerAccountId: input.accountId,
      guestAccess: "REVOKED" as const,
      associatedAt: new Date().toISOString(),
    };
  });

  return { ...result.data, replayed: result.replayed };
}

async function nextSeq(tx: Tx, businessId: string, reservationId: string): Promise<number> {
  const [row] = await tx`select coalesce(max(sequence),0)+1 "next" from booking.reservation_events where business_id=${businessId} and reservation_id=${reservationId}`;
  return Number(row!.next);
}
