/**
 * H03.U04 · CancelBooking — CONFIRMED → CANCELLED + Release U03, atómico.
 */
import { DomainError } from "@youngkingz/contracts";
import { executePrincipalOperation, type Tx } from "../../system/operations.js";
import { lockAvailabilityGuard } from "../../availability/guard.js";
import { releaseAllocation } from "../../availability/allocation.js";
import { assertStatusTransition, assertExpectedRevision, cutoffAllows } from "../domain/reservation.js";

const CANCEL_COMMAND = "booking.reservation.cancel";

export type CancelInput = {
  businessId: string;
  reservationId: string;
  expectedRevision: number;
  principal: "STAFF" | "CLIENT" | "GUEST_RESERVATION";
  accountId?: string;
  credentialId?: string;
  actorBusinessId?: string;
  reason?: string;
  operationId: string;
  bypassCutoff?: boolean;
  now?: Date;
};

export async function cancelBooking(input: CancelInput): Promise<{ reservationId: string; status: "CANCELLED"; cancelledAt: string; released: boolean; replayed: boolean }> {
  const now = input.now ?? new Date();

  const principalOp = input.principal === "STAFF"
    ? { kind: "STAFF" as const, businessId: input.businessId, accountId: input.accountId! }
    : input.principal === "CLIENT"
      ? { kind: "CLIENT" as const, businessId: input.businessId, accountId: input.accountId! }
      : { kind: "GUEST_RESERVATION" as const, businessId: input.businessId, reservationId: input.reservationId, credentialId: input.credentialId! };

  const result = await executePrincipalOperation<{ reservationId: string; status: "CANCELLED"; cancelledAt: string; released: boolean }>({
    operationId: input.operationId,
    command: CANCEL_COMMAND,
    principal: principalOp,
    payload: { reservationId: input.reservationId, expectedRevision: input.expectedRevision, reason: input.reason },
  }, async (tx) => {
    await lockAvailabilityGuard(tx, input.businessId);

    const [reservation] = await tx`select id,status,revision,staff_member_id "staffMemberId",starts_at "startsAt",current_allocation_id "currentAllocationId",policy_snapshot "policySnapshot",owner_type "ownerType",owner_account_id "ownerAccountId" from booking.reservations where business_id=${input.businessId} and id=${input.reservationId} for update`;
    if (!reservation) throw new DomainError("BOOKING_NOT_FOUND", "Reservation not found", 404);
    // Aislamiento por cuenta: un CLIENT sólo opera reservas de su propia cuenta.
    if (input.principal === "CLIENT" && (reservation.ownerType !== "CLIENT" || reservation.ownerAccountId !== input.accountId)) {
      throw new DomainError("BOOKING_NOT_OWNED", "Reservation does not belong to this account", 403);
    }
    if (reservation.status === "CANCELLED") throw new DomainError("BOOKING_ALREADY_CANCELLED", "Reservation is already cancelled", 409);
    assertStatusTransition(reservation.status as "CONFIRMED" | "CANCELLED", "CANCELLED");
    assertExpectedRevision(Number(reservation.revision), input.expectedRevision);

    // Cutoff histórico inclusivo (segundos de servidor), desde la política congelada.
    const policy = reservation.policySnapshot as { cancelCutoffMinutes: number };
    const scheduledStart = new Date(reservation.startsAt as string);
    if (!input.bypassCutoff && !cutoffAllows(scheduledStart, now, policy.cancelCutoffMinutes)) {
      throw new DomainError("BOOKING_CUTOFF_EXPIRED", "Cancellation is outside the allowed window", 409);
    }

    // Release U03 en la misma transacción.
    const released = await releaseAllocation(tx, { businessId: input.businessId, sourceType: "RESERVATION", sourceId: input.reservationId, reason: input.reason ?? "public_cancel" });

    // Mutación de estado + historia.
    await tx`update booking.reservations set status='CANCELLED', cancelled_at=now(), revision=revision+1, updated_at=now() where business_id=${input.businessId} and id=${input.reservationId}`;
    const [after] = await tx`select cancelled_at "cancelledAt" from booking.reservations where business_id=${input.businessId} and id=${input.reservationId}`;

    await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,changes,reason_code)
      values (${input.businessId},${input.reservationId},${await nextSeq(tx, input.businessId, input.reservationId)},'RESERVATION_CANCELLED',${input.operationId},${input.principal === "STAFF" ? "STAFF" : input.principal === "CLIENT" ? "CLIENT" : "GUEST_RESERVATION"},${JSON.stringify({ status: { before: "CONFIRMED", after: "CANCELLED" } })}::jsonb,${input.reason ?? null})`;

    await tx`insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${input.businessId},${input.accountId ?? null},${input.operationId},'booking.reservation.cancelled','bookings.read',${JSON.stringify({ type: "BUSINESS", businessId: input.businessId })}::jsonb,'RESERVATION',${input.reservationId},'SUCCEEDED',${JSON.stringify({ reason: input.reason ?? null })}::jsonb)`;

    return { reservationId: input.reservationId, status: "CANCELLED" as const, cancelledAt: new Date(after!.cancelledAt as string).toISOString(), released: released.changed };
  });

  return { ...result.data, replayed: result.replayed };
}

async function nextSeq(tx: Tx, businessId: string, reservationId: string): Promise<number> {
  const [row] = await tx`select coalesce(max(sequence),0)+1 "next" from booking.reservation_events where business_id=${businessId} and reservation_id=${reservationId}`;
  return Number(row!.next);
}
