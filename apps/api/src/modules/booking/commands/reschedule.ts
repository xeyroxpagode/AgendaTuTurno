/**
 * H03.U04 · RescheduleBooking — misma Reservation, Replace atómico.
 */
import { DomainError } from "@youngkingz/contracts";
import { executePrincipalOperation, type Tx } from "../../system/operations.js";
import { lockAvailabilityGuard } from "../../availability/guard.js";
import { resolveSlot } from "../../availability/queries.js";
import { releaseAllocation, claimAllocation } from "../../availability/allocation.js";
import { assertExpectedRevision, cutoffAllows } from "../domain/reservation.js";

const RESCHEDULE_COMMAND = "booking.reservation.reschedule";

export type RescheduleInput = {
  businessId: string;
  reservationId: string;
  expectedRevision: number;
  principal: "STAFF" | "CLIENT" | "GUEST_RESERVATION";
  accountId?: string;
  credentialId?: string;
  localDate: string;
  visibleStart: string;
  professionalPreference?: { type: "ANY" } | { type: "SPECIFIC"; staffMemberId: string };
  allowStaffOverride?: boolean;
  reason?: string;
  operationId: string;
  bypassCutoff?: boolean;
  now?: Date;
};

export async function rescheduleBooking(input: RescheduleInput): Promise<{ reservationId: string; status: "CONFIRMED"; startsAt: string; endsAt: string; replayed: boolean }> {
  const now = input.now ?? new Date();

  const principalOp = input.principal === "STAFF"
    ? { kind: "STAFF" as const, businessId: input.businessId, accountId: input.accountId! }
    : input.principal === "CLIENT"
      ? { kind: "CLIENT" as const, businessId: input.businessId, accountId: input.accountId! }
      : { kind: "GUEST_RESERVATION" as const, businessId: input.businessId, reservationId: input.reservationId, credentialId: input.credentialId! };

  const result = await executePrincipalOperation<{ reservationId: string; status: "CONFIRMED"; startsAt: string; endsAt: string }>({
    operationId: input.operationId,
    command: RESCHEDULE_COMMAND,
    principal: principalOp,
    payload: { reservationId: input.reservationId, expectedRevision: input.expectedRevision, localDate: input.localDate, visibleStart: input.visibleStart },
  }, async (tx) => {
    await lockAvailabilityGuard(tx, input.businessId);

    const [reservation] = await tx`select id,status,revision,staff_member_id "staffMemberId",starts_at "startsAt",current_allocation_id "currentAllocationId",policy_snapshot "policySnapshot",owner_type "ownerType",owner_account_id "ownerAccountId" from booking.reservations where business_id=${input.businessId} and id=${input.reservationId} for update`;
    if (!reservation) throw new DomainError("BOOKING_NOT_FOUND", "Reservation not found", 404);
    // Aislamiento por cuenta: un CLIENT sólo reprograma reservas de su propia cuenta.
    if (input.principal === "CLIENT" && (reservation.ownerType !== "CLIENT" || reservation.ownerAccountId !== input.accountId)) {
      throw new DomainError("BOOKING_NOT_OWNED", "Reservation does not belong to this account", 403);
    }
    if (reservation.status !== "CONFIRMED") throw new DomainError("BOOKING_ALREADY_CANCELLED", "Reservation is not active", 409);
    assertExpectedRevision(Number(reservation.revision), input.expectedRevision);

    const policy = reservation.policySnapshot as { rescheduleCutoffMinutes: number };
    const scheduledStart = new Date(reservation.startsAt as string);
    if (!input.bypassCutoff && !cutoffAllows(scheduledStart, now, policy.rescheduleCutoffMinutes)) {
      throw new DomainError("BOOKING_CUTOFF_EXPIRED", "Reschedule is outside the allowed window", 409);
    }

    // Términos históricos desde el servidor (nunca del navegador).
    const itemRows = await tx`select service_id "serviceId", terms_version_id "termsVersionId", duration_minutes "durationMinutes", pre_buffer_minutes "preBufferMinutes", post_buffer_minutes "postBufferMinutes", price_minor "priceMinor", currency "currency", service_name_snapshot "serviceName" from booking.reservation_items where business_id=${input.businessId} and reservation_id=${input.reservationId} order by position`;
    if (!itemRows.length) throw new DomainError("BOOKING_NOT_FOUND", "Reservation has no items", 404);
    const historicalTerms = itemRows.map(r => ({
      id: r.serviceId as string,
      durationMinutes: Number(r.durationMinutes),
      preBufferMinutes: Number(r.preBufferMinutes),
      postBufferMinutes: Number(r.postBufferMinutes),
    }));
    const serviceIds = itemRows.map(r => r.serviceId as string);

    // Publicación actual: el servicio retirado no admite reprogramación pública automática.
    const requirePublic = !input.allowStaffOverride;
    const preference = input.professionalPreference ?? { type: "SPECIFIC" as const, staffMemberId: reservation.staffMemberId as string };
    // For public (non-override) keep the original professional regardless of client input.
    const effectivePreference = input.allowStaffOverride ? preference : { type: "SPECIFIC" as const, staffMemberId: reservation.staffMemberId as string };

    // Liberar la allocation activa del origen ANTES de resolver el slot, para
    // que reprogramar al mismo horario no choque consigo mismo (D-02/D-03).
    if (reservation.currentAllocationId) {
      await releaseAllocation(tx, { businessId: input.businessId, sourceType: "RESERVATION", sourceId: input.reservationId, reason: input.reason ?? "reschedule" });
    }

    const slot = await resolveSlot(tx, {
      businessId: input.businessId,
      serviceIds,
      localDate: input.localDate,
      visibleStartMinute: parseClockSafe(input.visibleStart),
      professionalPreference: effectivePreference,
      requirePublic,
      now,
      termsOverride: historicalTerms,
    });

    const visibleStart = minuteToHhMm(slot.visibleStartMinute);
    const destination = await claimAllocation(tx, {
      businessId: input.businessId,
      sourceType: "RESERVATION",
      sourceId: input.reservationId,
      serviceIds,
      localDate: slot.localDate,
      visibleStart,
      professionalPreference: effectivePreference,
      historicalTerms,
    }, now);

    // Actualizar la reserva conservando ID, servicios, precios y política históricos.
    await tx`update booking.reservations
      set current_allocation_id=${destination.allocationId},
          staff_member_id=${destination.staffMemberId},
          starts_at=${destination.visibleStartAt.toISOString()},
          ends_at=${destination.visibleEndAt.toISOString()},
          occupied_starts_at=${destination.occupiedStartAt.toISOString()},
          occupied_ends_at=${destination.occupiedEndAt.toISOString()},
          business_local_date=${destination.localDate},
          revision=revision+1,
          updated_at=now()
      where business_id=${input.businessId} and id=${input.reservationId}`;

    const [after] = await tx`select starts_at "startsAt", ends_at "endsAt" from booking.reservations where business_id=${input.businessId} and id=${input.reservationId}`;

    await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,changes,reason_code)
      values (${input.businessId},${input.reservationId},${await nextSeq(tx, input.businessId, input.reservationId)},'RESERVATION_RESCHEDULED',${input.operationId},${input.principal === "STAFF" ? "STAFF" : input.principal === "CLIENT" ? "CLIENT" : "GUEST_RESERVATION"},${JSON.stringify({ startsAt: { before: scheduledStart.toISOString(), after: destination.visibleStartAt.toISOString() }, staffMemberId: { before: reservation.staffMemberId, after: destination.staffMemberId } })}::jsonb,${input.reason ?? null})`;

    await tx`insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${input.businessId},${input.accountId ?? null},${input.operationId},'booking.reservation.rescheduled','bookings.read',${JSON.stringify({ type: "BUSINESS", businessId: input.businessId })}::jsonb,'RESERVATION',${input.reservationId},'SUCCEEDED',${JSON.stringify({ localDate: input.localDate, visibleStart: input.visibleStart })}::jsonb)`;

    return { reservationId: input.reservationId, status: "CONFIRMED" as const, startsAt: new Date((after!.startsAt as string)).toISOString(), endsAt: new Date((after!.endsAt as string)).toISOString() };
  });

  return { ...result.data, replayed: result.replayed };
}

function parseClockSafe(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new DomainError("VALIDATION_ERROR", "Time must be HH:mm", 400);
  return Number(match[1]) * 60 + Number(match[2]);
}

function minuteToHhMm(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

async function nextSeq(tx: Tx, businessId: string, reservationId: string): Promise<number> {
  const [row] = await tx`select coalesce(max(sequence),0)+1 "next" from booking.reservation_events where business_id=${businessId} and reservation_id=${reservationId}`;
  return Number(row!.next);
}
