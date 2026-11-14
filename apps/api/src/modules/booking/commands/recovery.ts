/**
 * H03.U04 · Recuperación asistida de credencial invitada.
 *
 * Canal de entrega: ENVELOPE (mecanismo integrado, mismo que la reserva original).
 * La credencial se almacena cifrada en booking.guest_delivery_envelopes y se
 * recupera por el invitado mediante prueba de control (intent-proof), exactamente
 * como en el flujo de reserva público. Fail-closed sólo si el canal se configura
 * explícitamente como NONE.
 */
import { randomUUID } from "node:crypto";
import { DomainError } from "@youngkingz/contracts";
import { executePrincipalOperation, type Tx } from "../../system/operations.js";
import { lockAvailabilityGuard } from "../../availability/guard.js";
import { issueGuestToken, encryptEnvelope, CURRENT_KEY_VERSION, intentProofDigest } from "../security/guest-access.js";

const RECOVERY_COMMAND = "booking.guest_access.recover";

export type AssistedRecoveryInput = {
  businessId: string;
  reservationId: string;
  requestingStaffId: string;
  verificationMethod: string;
  evidenceReference: string;
  reason: string;
  outcome: "VERIFIED" | "REJECTED";
  operationId: string;
};

export async function assistedGuestRecovery(input: AssistedRecoveryInput): Promise<{ caseId: string; status: string; replayed: boolean }> {
  const channel = process.env.BOOKING_RECOVERY_DELIVERY_CHANNEL ?? "ENVELOPE";
  if (channel === "NONE") {
    throw new DomainError("GUEST_RECOVERY_NOT_VERIFIED", "No real delivery channel is configured; recovery cannot complete", 409);
  }
  if (channel !== "ENVELOPE") {
    throw new DomainError("GUEST_RECOVERY_NOT_VERIFIED", `Unsupported delivery channel: ${channel}`, 409);
  }

  const result = await executePrincipalOperation<{ caseId: string; status: string }>({
    operationId: input.operationId,
    command: RECOVERY_COMMAND,
    principal: { kind: "STAFF", businessId: input.businessId, accountId: input.requestingStaffId },
    payload: { reservationId: input.reservationId, verificationMethod: input.verificationMethod, evidenceReference: input.evidenceReference, reason: input.reason, outcome: input.outcome },
  }, async (tx) => {
    await lockAvailabilityGuard(tx, input.businessId);

    const [reservation] = await tx`select id,status from booking.reservations where business_id=${input.businessId} and id=${input.reservationId} for update`;
    if (!reservation) throw new DomainError("BOOKING_NOT_FOUND", "Reservation not found", 404);

    const caseId = randomUUID();
    if (input.outcome === "REJECTED") {
      await tx`insert into booking.guest_recovery_cases(id,business_id,reservation_id,requested_by_staff_id,verification_method,evidence_reference,reason,status,audit_reference)
        values (${caseId},${input.businessId},${input.reservationId},${input.requestingStaffId},${input.verificationMethod},${input.evidenceReference},${input.reason},'REJECTED',${input.operationId})`;
      await tx`insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
        values (${input.businessId},null,${input.operationId},'booking.guest_access.recovery_rejected','bookings.guest_access.recover',${JSON.stringify({ type: "BUSINESS", businessId: input.businessId })}::jsonb,'GUEST_RECOVERY_CASE',${caseId},'DENIED',${JSON.stringify({ reason: input.reason })}::jsonb)`;
      return { caseId, status: "REJECTED" };
    }

    // VERIFIED: revocar anteriores y emitir nueva credencial en una sola transacción.
    await tx`update booking.guest_credentials set status='REVOKED',revoked_at=now() where business_id=${input.businessId} and reservation_id=${input.reservationId} and status='ACTIVE'`;
    const { token, digest } = issueGuestToken();
    const [cred] = await tx`insert into booking.guest_credentials(business_id,reservation_id,token_digest,generation,status) values (${input.businessId},${input.reservationId},${digest},(select coalesce(max(generation),0)+1 from booking.guest_credentials where business_id=${input.businessId} and reservation_id=${input.reservationId}),'ACTIVE') returning id`;
    const intentProofDigestValue = intentProofDigest(token);
    const envelopePlaintext = JSON.stringify({ reservationId: input.reservationId, guestToken: token, credentialId: cred!.id });
    const envelope = encryptEnvelope(envelopePlaintext, CURRENT_KEY_VERSION);
    await tx`insert into booking.guest_delivery_envelopes(business_id,operation_id,reservation_id,intent_proof_digest,encrypted_payload,key_version,expires_at)
      values (${input.businessId},${input.operationId},${input.reservationId},${intentProofDigestValue},${envelope}::bytea,${CURRENT_KEY_VERSION},now() + interval '24 hours')`;

    await tx`insert into booking.guest_recovery_cases(id,business_id,reservation_id,requested_by_staff_id,verification_method,evidence_reference,verified_by_staff_id,verified_at,reason,status,completed_at,audit_reference)
      values (${caseId},${input.businessId},${input.reservationId},${input.requestingStaffId},${input.verificationMethod},${input.evidenceReference},${input.requestingStaffId},now(),${input.reason},'COMPLETED',now(),${input.operationId})`;

    // Rotación de acceso: revocar anterior, emitir nuevo.
    await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,changes)
      values (${input.businessId},${input.reservationId},${await nextSeq(tx, input.businessId, input.reservationId)},'GUEST_ACCESS_REISSUED',${input.operationId},'STAFF',${JSON.stringify({ credentialId: { before: null, after: cred!.id } })}::jsonb)`;

    await tx`insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${input.businessId},null,${input.operationId},'booking.guest_access.recovered','bookings.guest_access.recover',${JSON.stringify({ type: "BUSINESS", businessId: input.businessId })}::jsonb,'GUEST_RECOVERY_CASE',${caseId},'SUCCEEDED',${JSON.stringify({ reason: input.reason })}::jsonb)`;

    return { caseId, status: "COMPLETED" };
  });

  return { ...result.data, replayed: result.replayed };
}

async function nextSeq(tx: Tx, businessId: string, reservationId: string): Promise<number> {
  const [row] = await tx`select coalesce(max(sequence),0)+1 "next" from booking.reservation_events where business_id=${businessId} and reservation_id=${reservationId}`;
  return Number(row!.next);
}