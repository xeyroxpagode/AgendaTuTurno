/**
 * H03.U05 · Comando `booking.staff.arrival` — registro de llegada.
 *
 * La llegada NO es Attendance (U07): la reserva conserva su estado
 * `CONFIRMED` y su Allocation activa. La única evidencia es el evento
 * append-only `ARRIVAL_REGISTERED` en `booking.reservation_events`.
 *
 * No existe una segunda fuente de verdad: no se agrega columna `arrived_at`
 * a `booking.reservations`; la presencia se lee del ledger de eventos.
 */
import { DomainError } from "@youngkingz/contracts";
import { executePrincipalOperation, type Tx } from "../../system/operations.js";
import { lockAvailabilityGuard } from "../../availability/guard.js";
import { assertExpectedRevision } from "../domain/reservation.js";

const ARRIVAL_COMMAND = "booking.staff.arrival";

export type StaffArrivalInput = {
  businessId: string;
  actorAccountId: string;
  actorStaffMemberId: string;
  reservationId: string;
  expectedRevision: number;
  arrivalMethod?: "PRESENCIAL" | "TELEFONICO";
  /** Ámbito propio: sólo reservas asignadas al profesional actor. */
  selfScopeOnly: boolean;
  operationId: string;
  now?: Date;
};

export type StaffArrivalResult = {
  reservationId: string;
  status: "CONFIRMED";
  arrivedAt: string;
  revision: number;
  replayed: boolean;
};

export async function registerStaffArrival(input: StaffArrivalInput): Promise<StaffArrivalResult> {
  const now = input.now ?? new Date();

  const result = await executePrincipalOperation<Omit<StaffArrivalResult, "replayed">>({
    operationId: input.operationId,
    command: ARRIVAL_COMMAND,
    principal: { kind: "STAFF", businessId: input.businessId, accountId: input.actorAccountId },
    payload: { reservationId: input.reservationId, expectedRevision: input.expectedRevision, arrivalMethod: input.arrivalMethod ?? null },
  }, async (tx) => {
    await lockAvailabilityGuard(tx, input.businessId);

    const [reservation] = await tx`select id,status,revision,staff_member_id "staffMemberId" from booking.reservations where business_id=${input.businessId} and id=${input.reservationId} for update`;
    if (!reservation) throw new DomainError("BOOKING_NOT_FOUND", "Reservation not found", 404);
    if (input.selfScopeOnly && reservation.staffMemberId !== input.actorStaffMemberId) {
      throw new DomainError("FORBIDDEN", "Reservation is not assigned to this professional", 403);
    }
    if (reservation.status !== "CONFIRMED") {
      throw new DomainError("BOOKING_ALREADY_CANCELLED", "Reservation is not active", 409, { status: reservation.status });
    }

    // Idempotencia semántica: la llegada ya registrada no se duplica y se
    // devuelve EXACTAMENTE la marca temporal del evento original.
    //
    // H03.U06 · WP-11 · U05-CORR-DB-02: el camino idempotente también valida
    // la revisión esperada. Un replay con `expectedRevision` obsoleto es un
    // CONFLICTO (409 STALE_REVISION), no un replay silencioso.
    const [existing] = await tx`select occurred_at "occurredAt", sequence from booking.reservation_events where business_id=${input.businessId} and reservation_id=${input.reservationId} and event_type='ARRIVAL_REGISTERED' order by sequence limit 1`;
    if (existing) {
      assertExpectedRevision(Number(reservation.revision), input.expectedRevision);
      return {
        reservationId: input.reservationId,
        status: "CONFIRMED" as const,
        arrivedAt: new Date(existing!.occurredAt as string).toISOString(),
        revision: Number(reservation.revision),
      };
    }

    assertExpectedRevision(Number(reservation.revision), input.expectedRevision);

    const sequence = await nextSeq(tx, input.businessId, input.reservationId);
    const occurredAt = now.toISOString();
    await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,actor_account_id,staff_member_id,before_revision,after_revision,changes,occurred_at)
      values (${input.businessId},${input.reservationId},${sequence},'ARRIVAL_REGISTERED',${input.operationId},'STAFF',${input.actorAccountId},${input.actorStaffMemberId},${Number(reservation.revision)},${Number(reservation.revision) + 1},${JSON.stringify({ arrivalMethod: input.arrivalMethod ?? null, status: { before: "CONFIRMED", after: "CONFIRMED" } })}::jsonb,${occurredAt})`;

    await tx`update booking.reservations set revision=revision+1, updated_at=now() where business_id=${input.businessId} and id=${input.reservationId}`;

    await tx`insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${input.businessId},${input.actorAccountId},${input.operationId},'booking.reservation.arrival','bookings.arrival',${JSON.stringify({ type: "BUSINESS", businessId: input.businessId })}::jsonb,'RESERVATION',${input.reservationId},'SUCCEEDED',${JSON.stringify({ arrivalMethod: input.arrivalMethod ?? null })}::jsonb)`;

    return {
      reservationId: input.reservationId,
      status: "CONFIRMED" as const,
      arrivedAt: occurredAt,
      revision: Number(reservation.revision) + 1,
    };
  });

  return { ...result.data, replayed: result.replayed };
}

async function nextSeq(tx: Tx, businessId: string, reservationId: string): Promise<number> {
  const [row] = await tx`select coalesce(max(sequence),0)+1 "next" from booking.reservation_events where business_id=${businessId} and reservation_id=${reservationId}`;
  return Number(row!.next);
}
