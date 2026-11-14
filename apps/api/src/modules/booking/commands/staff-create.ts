/**
 * H03.U05 · Comando `booking.staff.create` — creación asistida de reserva.
 *
 * Reutiliza el motor transaccional de U04 (`executePrincipalOperation`,
 * `lockAvailabilityGuard`, `resolveSlot`, `claimAllocation`) y el mismo
 * cálculo de snapshot (`computeReservationSnapshot`, `toPolicySnapshot`).
 * NO existe una segunda fuente de verdad: la reserva creada es una fila de
 * `booking.reservations` con su Allocation y su evento, igual que el flujo
 * público de U04.
 *
 * El principal es STAFF: la idempotencia queda atada a `operation_id`,
 * `request_hash` y al `account_id` del actor.
 */
import { DomainError, type ProfessionalPreference } from "@youngkingz/contracts";
import { executePrincipalOperation, type Tx } from "../../system/operations.js";
import { lockAvailabilityGuard } from "../../availability/guard.js";
import { resolveSlot } from "../../availability/queries.js";
import { claimAllocation } from "../../availability/allocation.js";
import { computeReservationSnapshot, toPolicySnapshot } from "../domain/reservation.js";
import { randomUUID } from "node:crypto";

const STAFF_CREATE_COMMAND = "booking.staff.create";

export type StaffCreateInput = {
  businessId: string;
  actorAccountId: string;
  serviceIds: string[];
  localDate: string;
  visibleStart: string;
  professionalPreference: ProfessionalPreference;
  contact: { name: string; phone: string; email?: string | null };
  reason?: string;
  operationId: string;
  now?: Date;
};

export type StaffCreateResult = {
  reservationId: string;
  status: "CONFIRMED";
  startsAt: string;
  endsAt: string;
  staffMemberId: string;
  commercialTotalMinor: number;
  currency: "ARS";
  operationId: string;
  replayed: boolean;
};

export async function createStaffReservation(input: StaffCreateInput): Promise<StaffCreateResult> {
  const now = input.now ?? new Date();
  const visibleStartMinute = parseClock(input.visibleStart);

  const result = await executePrincipalOperation<Omit<StaffCreateResult, "replayed">>({
    operationId: input.operationId,
    command: STAFF_CREATE_COMMAND,
    principal: { kind: "STAFF", businessId: input.businessId, accountId: input.actorAccountId },
    payload: {
      serviceIds: [...input.serviceIds].sort(),
      localDate: input.localDate,
      visibleStart: input.visibleStart,
      professionalPreference: input.professionalPreference,
      reason: input.reason ?? null,
    },
  }, async (tx) => {
    await lockAvailabilityGuard(tx, input.businessId);

    const [business] = await tx`select id,timezone from business.businesses where id=${input.businessId}`;
    if (!business) throw new DomainError("BOOKING_NOT_FOUND", "Business not found", 404);

    // Términos vigentes SIEMPRE desde el servidor (el Staff no envía precios).
    const terms = await loadCurrentTerms(tx, input.businessId, input.serviceIds);
    const policy = await loadCurrentPolicy(tx, input.businessId);
    const snapshot = computeReservationSnapshot(terms);

    const slot = await resolveSlot(tx, {
      businessId: input.businessId,
      serviceIds: input.serviceIds,
      localDate: input.localDate,
      visibleStartMinute,
      professionalPreference: input.professionalPreference,
      requirePublic: false,
      now,
    });

    const reservationId = randomUUID();
    await tx`insert into booking.reservations(id,business_id,revision,status,owner_type,contact_snapshot,staff_member_id,policy_version_id,policy_snapshot,commercial_total_minor,currency,starts_at,ends_at,occupied_starts_at,occupied_ends_at,business_local_date,business_timezone_snapshot,created_operation_id)
      values (${reservationId},${input.businessId},1,'CONFIRMED','GUEST',${JSON.stringify({ name: input.contact.name, phone: input.contact.phone, email: input.contact.email ?? null })}::jsonb,${slot.staffMemberId},${policy.id},${JSON.stringify(toPolicySnapshot(policy))}::jsonb,${snapshot.commercialTotalMinor},'ARS',${slot.visibleStartAt.toISOString()},${slot.visibleEndAt.toISOString()},${slot.occupiedStartAt.toISOString()},${slot.occupiedEndAt.toISOString()},${slot.localDate},${business!.timezone as string},${input.operationId})`;

    const claimed = await claimAllocation(tx, {
      businessId: input.businessId,
      sourceType: "RESERVATION",
      sourceId: reservationId,
      serviceIds: input.serviceIds,
      localDate: slot.localDate,
      visibleStart: formatMinute(slot.visibleStartMinute),
      professionalPreference: input.professionalPreference,
      historicalTerms: terms.map((item) => ({ id: item.serviceId, durationMinutes: item.durationMinutes, preBufferMinutes: item.preBufferMinutes, postBufferMinutes: item.postBufferMinutes })),
    }, now);

    await tx`update booking.reservations set current_allocation_id=${claimed.allocationId}, starts_at=${claimed.visibleStartAt.toISOString()}, ends_at=${claimed.visibleEndAt.toISOString()}, occupied_starts_at=${claimed.occupiedStartAt.toISOString()}, occupied_ends_at=${claimed.occupiedEndAt.toISOString()}, staff_member_id=${claimed.staffMemberId} where business_id=${input.businessId} and id=${reservationId}`;

    for (const item of snapshot.items) {
      await tx`insert into booking.reservation_items(business_id,reservation_id,position,service_id,service_name_snapshot,terms_version_id,duration_minutes,pre_buffer_minutes,post_buffer_minutes,price_minor,currency,conditions_snapshot)
        values (${input.businessId},${reservationId},${item.position},${item.serviceId},${item.serviceName},${item.termsVersionId},${item.durationMinutes},${item.preBufferMinutes},${item.postBufferMinutes},${item.priceMinor},'ARS',${item.conditions ?? null})`;
    }

    await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,actor_account_id,changes)
      values (${input.businessId},${reservationId},1,'RESERVATION_CONFIRMED',${input.operationId},'STAFF',${input.actorAccountId},${JSON.stringify({ status: { before: null, after: "CONFIRMED" }, staffMemberId: { before: null, after: claimed.staffMemberId }, source: "STAFF_ASSISTED" })}::jsonb)`;

    await tx`insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${input.businessId},${input.actorAccountId},${input.operationId},'booking.reservation.created_by_staff','bookings.create',${JSON.stringify({ type: "BUSINESS", businessId: input.businessId })}::jsonb,'RESERVATION',${reservationId},'SUCCEEDED',${JSON.stringify({ staffMemberId: claimed.staffMemberId, reason: input.reason ?? null })}::jsonb)`;

    return {
      reservationId,
      status: "CONFIRMED" as const,
      startsAt: claimed.visibleStartAt.toISOString(),
      endsAt: claimed.visibleEndAt.toISOString(),
      staffMemberId: claimed.staffMemberId,
      commercialTotalMinor: snapshot.commercialTotalMinor,
      currency: "ARS" as const,
      operationId: input.operationId,
    };
  });

  return { ...result.data, replayed: result.replayed };
}

type CurrentTerm = {
  serviceId: string;
  serviceName: string;
  termsVersionId: string;
  durationMinutes: number;
  preBufferMinutes: number;
  postBufferMinutes: number;
  priceMinor: number;
  currency: string;
  conditions: string | null;
};

async function loadCurrentTerms(tx: Tx, businessId: string, serviceIds: string[]): Promise<CurrentTerm[]> {
  const rows = await tx`select s.id "serviceId", s.name "serviceName", s.lifecycle::text lifecycle, s.publication::text publication, c.lifecycle::text "categoryLifecycle", t.id "termsVersionId", t.duration_minutes "durationMinutes", t.pre_buffer_minutes "preBufferMinutes", t.post_buffer_minutes "postBufferMinutes", t.price_minor "priceMinor", t.currency, t.conditions
    from catalog.services s
    left join catalog.service_categories c on c.business_id=s.business_id and c.id=s.category_id
    left join catalog.service_terms_versions t on t.business_id=s.business_id and t.service_id=s.id and t.id=s.current_terms_version_id
    where s.business_id=${businessId} and s.id=any(${serviceIds}::uuid[])`;

  const byId = new Map(rows.map((row) => [row.serviceId as string, row]));
  return serviceIds.map((serviceId) => {
    const row = byId.get(serviceId);
    if (!row || row.lifecycle !== "ACTIVE" || row.categoryLifecycle !== "ACTIVE" || !row.termsVersionId) {
      throw new DomainError("SERVICE_NOT_BOOKABLE", "A selected Service is not bookable", 409, { serviceId });
    }
    return {
      serviceId,
      serviceName: row.serviceName as string,
      termsVersionId: row.termsVersionId as string,
      durationMinutes: Number(row.durationMinutes),
      preBufferMinutes: Number(row.preBufferMinutes),
      postBufferMinutes: Number(row.postBufferMinutes),
      priceMinor: Number(row.priceMinor),
      currency: row.currency as string,
      conditions: (row.conditions as string | null) ?? null,
    };
  });
}

async function loadCurrentPolicy(tx: Tx, businessId: string) {
  const [row] = await tx`select v.id, v.version_number "versionNumber", s.revision, v.horizon_calendar_dates "horizonCalendarDates", v.min_lead_minutes "minLeadMinutes", v.start_step_minutes "startStepMinutes", v.cancel_cutoff_minutes "cancelCutoffMinutes", v.reschedule_cutoff_minutes "rescheduleCutoffMinutes", v.public_booking_enabled "publicBookingEnabled"
    from business.booking_policy_states s join business.booking_policy_versions v on v.business_id=s.business_id and v.id=s.current_version_id
    where s.business_id=${businessId}`;
  if (!row) throw new DomainError("BOOKING_POLICY_MISSING", "Booking Policy is not configured", 409);
  return {
    id: row.id as string,
    versionNumber: Number(row.versionNumber),
    revision: Number(row.revision),
    horizonCalendarDates: Number(row.horizonCalendarDates),
    minLeadMinutes: Number(row.minLeadMinutes),
    startStepMinutes: Number(row.startStepMinutes),
    cancelCutoffMinutes: Number(row.cancelCutoffMinutes),
    rescheduleCutoffMinutes: Number(row.rescheduleCutoffMinutes),
    publicBookingEnabled: Boolean(row.publicBookingEnabled),
  };
}

function parseClock(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new DomainError("VALIDATION_ERROR", "Time must be HH:mm", 400);
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatMinute(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
