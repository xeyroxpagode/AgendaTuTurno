/**
 * H03.U05 · Comando `booking.staff.reassign` — reasignación de profesional.
 *
 * Conserva el `reservation_id` (RB-06), los servicios y los snapshots
 * históricos (RB-07). El profesional destino DEBE:
 *   · pertenecer al mismo Business (AC-12 → `FORBIDDEN` si es de otro);
 *   · ser elegible para TODOS los servicios de la reserva (AC-11 →
 *     `PROFESSIONAL_NOT_ELIGIBLE`);
 *   · tener libre el slot destino (AC-11 → `SLOT_CONFLICT`).
 *
 * La reasignación NO puede cambiar la fecha/hora del turno: es una operación
 * de personal, no de agenda. El turno se reprograma con
 * `booking.staff.reschedule`.
 */
import { DomainError, type ProfessionalPreference } from "@youngkingz/contracts";
import { executePrincipalOperation, type Tx } from "../../system/operations.js";
import { lockAvailabilityGuard } from "../../availability/guard.js";
import { resolveSlot } from "../../availability/queries.js";
import { businessLocalMinuteOfDay } from "../../availability/temporal.js";
import { replaceAllocation } from "../../availability/allocation.js";
import { assertExpectedRevision } from "../domain/reservation.js";

const REASSIGN_COMMAND = "booking.staff.reassign";

export type StaffReassignInput = {
  businessId: string;
  actorAccountId: string;
  actorStaffMemberId: string;
  reservationId: string;
  expectedRevision: number;
  staffMemberId: string;
  reason: string;
  /** Ámbito propio: sólo reservas asignadas al profesional actor. */
  selfScopeOnly: boolean;
  operationId: string;
  now?: Date;
};

export type StaffReassignResult = {
  reservationId: string;
  status: "CONFIRMED";
  staffMemberId: string;
  startsAt: string;
  endsAt: string;
  revision: number;
  replayed: boolean;
};

export async function reassignStaffReservation(input: StaffReassignInput): Promise<StaffReassignResult> {
  const now = input.now ?? new Date();

  const result = await executePrincipalOperation<Omit<StaffReassignResult, "replayed">>({
    operationId: input.operationId,
    command: REASSIGN_COMMAND,
    principal: { kind: "STAFF", businessId: input.businessId, accountId: input.actorAccountId },
    payload: { reservationId: input.reservationId, expectedRevision: input.expectedRevision, staffMemberId: input.staffMemberId, reason: input.reason },
  }, async (tx) => {
    await lockAvailabilityGuard(tx, input.businessId);

    const [reservation] = await tx`select id,status,revision,staff_member_id "staffMemberId",starts_at "startsAt",ends_at "endsAt",occupied_starts_at "occupiedStartsAt",occupied_ends_at "occupiedEndsAt",business_local_date "localDate",business_timezone_snapshot "timezone" from booking.reservations where business_id=${input.businessId} and id=${input.reservationId} for update`;
    if (!reservation) throw new DomainError("BOOKING_NOT_FOUND", "Reservation not found", 404);
    if (input.selfScopeOnly && reservation.staffMemberId !== input.actorStaffMemberId) {
      throw new DomainError("FORBIDDEN", "Reservation is not assigned to this professional", 403);
    }
    if (reservation.status !== "CONFIRMED") {
      throw new DomainError("BOOKING_ALREADY_CANCELLED", "Reservation is not active", 409, { status: reservation.status });
    }
    assertExpectedRevision(Number(reservation.revision), input.expectedRevision);

    // AC-12: el profesional destino debe pertenecer a este Business.
    const [target] = await tx`select id from team.staff_members where id=${input.staffMemberId}`;
    if (!target) throw new DomainError("NOT_FOUND", "Staff member not found", 404);
    const [sameBusiness] = await tx`select id from team.staff_members where id=${input.staffMemberId} and business_id=${input.businessId}`;
    if (!sameBusiness) throw new DomainError("FORBIDDEN", "Staff member belongs to another Business", 403);

    // AC-11: elegible para TODOS los servicios de la reserva.
    const items = await tx`select service_id "serviceId", duration_minutes "durationMinutes", pre_buffer_minutes "preBufferMinutes", post_buffer_minutes "postBufferMinutes" from booking.reservation_items where business_id=${input.businessId} and reservation_id=${input.reservationId} order by position`;
    if (!items.length) throw new DomainError("BOOKING_NOT_FOUND", "Reservation has no items", 404);
    const serviceIds = items.map((item) => item.serviceId as string);
    const eligible = await tx`select sm.id from team.staff_members sm
      join team.staff_service_sets sets on sets.business_id=sm.business_id and sets.staff_member_id=sm.id
      join team.staff_service_assignments a on a.business_id=sets.business_id and a.staff_service_set_id=sets.id and a.service_id=any(${serviceIds}::uuid[])
      where sm.business_id=${input.businessId} and sm.id=${input.staffMemberId}
        and sm.employment_status='ACTIVE' and sm.access_status='ACTIVE'
      group by sm.id having count(distinct a.service_id)=${serviceIds.length}`;
    if (!eligible.length) throw new DomainError("PROFESSIONAL_NOT_ELIGIBLE", "Professional cannot perform every Service of the reservation", 409, { staffMemberId: input.staffMemberId });

    if (reservation.staffMemberId === input.staffMemberId) {
      throw new DomainError("VALIDATION_ERROR", "Reservation is already assigned to this professional", 400);
    }

    // AC-11: el slot destino debe estar libre para el profesional destino.
    const historicalTerms = items.map((item) => ({
      id: item.serviceId as string,
      durationMinutes: Number(item.durationMinutes),
      preBufferMinutes: Number(item.preBufferMinutes),
      postBufferMinutes: Number(item.postBufferMinutes),
    }));
    const preference: ProfessionalPreference = { type: "SPECIFIC", staffMemberId: input.staffMemberId };
    const slot = await resolveSlot(tx, {
      businessId: input.businessId,
      serviceIds,
      localDate: reservation.localDate as string,
      visibleStartMinute: visibleMinuteOf(reservation.startsAt as string, reservation.timezone as string),
      professionalPreference: preference,
      requirePublic: false,
      now,
      termsOverride: historicalTerms,
      // La reasignación conserva el turno existente: no aplica el horizonte de
      // alta ni la anticipación mínima (esas reglas gobiernan nueva reserva).
      allowPastSlot: true,
    });

    const replaced = await replaceAllocation(tx, {
      origin: { businessId: input.businessId, sourceType: "RESERVATION", sourceId: input.reservationId },
      destination: {
        businessId: input.businessId,
        sourceType: "RESERVATION",
        sourceId: input.reservationId,
        serviceIds,
        localDate: slot.localDate,
        visibleStart: minuteToClock(slot.visibleStartMinute),
        professionalPreference: preference,
        historicalTerms,
        allowPastSlot: true,
      },
      releaseReason: input.reason,
    }, now);

    await tx`update booking.reservations
      set current_allocation_id=${replaced.destination.allocationId},
          staff_member_id=${replaced.destination.staffMemberId},
          starts_at=${replaced.destination.visibleStartAt.toISOString()},
          ends_at=${replaced.destination.visibleEndAt.toISOString()},
          occupied_starts_at=${replaced.destination.occupiedStartAt.toISOString()},
          occupied_ends_at=${replaced.destination.occupiedEndAt.toISOString()},
          business_local_date=${replaced.destination.localDate},
          revision=revision+1,
          updated_at=now()
      where business_id=${input.businessId} and id=${input.reservationId}`;

    const sequence = await nextSeq(tx, input.businessId, input.reservationId);
    // H03.U06 · WP-11 · U05-CORR-07: la reasignación de profesional tiene su
    // propio evento (`RESERVATION_REASSIGNED`). Reutilizar
    // `RESERVATION_RESCHEDULED` hacía la auditoría ambigua: una reasignación
    // NO reprograma el turno (conserva fecha y hora).
    await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,actor_account_id,staff_member_id,before_revision,after_revision,changes,reason_code)
      values (${input.businessId},${input.reservationId},${sequence},'RESERVATION_REASSIGNED',${input.operationId},'STAFF',${input.actorAccountId},${input.actorStaffMemberId},${Number(reservation.revision)},${Number(reservation.revision) + 1},${JSON.stringify({ staffMemberId: { before: reservation.staffMemberId, after: replaced.destination.staffMemberId } })}::jsonb,${input.reason})`;

    await tx`insert into system.audit_events(business_id,actor_account_id,operation_id,action,capability,scope,resource_type,resource_id,outcome,changes)
      values (${input.businessId},${input.actorAccountId},${input.operationId},'booking.reservation.reassigned','bookings.override.reschedule',${JSON.stringify({ type: "BUSINESS", businessId: input.businessId })}::jsonb,'RESERVATION',${input.reservationId},'SUCCEEDED',${JSON.stringify({ staffMemberId: { before: reservation.staffMemberId, after: replaced.destination.staffMemberId }, reason: input.reason })}::jsonb)`;

    return {
      reservationId: input.reservationId,
      status: "CONFIRMED" as const,
      staffMemberId: replaced.destination.staffMemberId,
      startsAt: replaced.destination.visibleStartAt.toISOString(),
      endsAt: replaced.destination.visibleEndAt.toISOString(),
      revision: Number(reservation.revision) + 1,
    };
  });

  return { ...result.data, replayed: result.replayed };
}

/** Minuto local (zona del Business) del inicio visible de la reserva. */
function visibleMinuteOf(startsAt: string, timezone: string): number {
  return businessLocalMinuteOfDay(new Date(startsAt), timezone);
}

function minuteToClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

async function nextSeq(tx: Tx, businessId: string, reservationId: string): Promise<number> {
  const [row] = await tx`select coalesce(max(sequence),0)+1 "next" from booking.reservation_events where business_id=${businessId} and reservation_id=${reservationId}`;
  return Number(row!.next);
}
