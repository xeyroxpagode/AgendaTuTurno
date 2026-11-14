/**
 * H03.U06 · Fixtures de Ausencias y Prestación real.
 *
 * Reutiliza el Business de U05 (`seedStaffAgendaBusiness`) y añade helpers
 * para sembrar reservas en minutos LOCALES del Business, que es la unidad en
 * que se expresan las ausencias.
 *
 * La zona horaria del fixture es `America/Argentina/Buenos_Aires` (UTC-3 fijo,
 * sin horario de verano), por lo que `localHour` → `UTC + 3`.
 */
import { randomUUID } from "node:crypto";
import { database } from "../../../apps/api/src/lib/runtime";
import { reservationOperation, type StaffAgendaSeed } from "./staff-agenda-fixtures";

export type { StaffAgendaSeed };
export { seedStaffAgendaBusiness, destroyStaffAgendaBusiness } from "./staff-agenda-fixtures";

/** Miércoles (el fixture define horarios sólo para el weekday 3). */
export const ABSENCE_DATE = "2026-12-02";
/** Otro miércoles, para las pruebas que necesitan dos días independientes. */
export const ABSENCE_DATE_2 = "2026-12-09";

const UTC_OFFSET_HOURS = 3;

/** Instante UTC que corresponde a un minuto local del Business. */
export function localInstant(localDate: string, minuteOfDay: number): Date {
  const [year, month, day] = localDate.split("-").map(Number);
  const utcMinutes = minuteOfDay + UTC_OFFSET_HOURS * 60;
  return new Date(Date.UTC(year!, month! - 1, day!, 0, utcMinutes));
}

/** `HH:mm` a partir de un minuto local. */
export function minuteToClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/**
 * Siembra una reserva `CONFIRMED` con su Allocation ACTIVE en un intervalo de
 * minutos LOCALES del Business. `occupiedStart`/`occupiedEnd` incluyen los
 * buffers (5 min cada lado), como en el motor real de Booking.
 */
export async function seedLocalReservation(
  seed: StaffAgendaSeed,
  input: { staffMemberId: string; localDate?: string; startMinute: number; durationMinutes?: number; customerName?: string },
) {
  const reservationId = randomUUID();
  const localDate = input.localDate ?? ABSENCE_DATE;
  const duration = input.durationMinutes ?? 50;
  const visibleStart = localInstant(localDate, input.startMinute);
  const visibleEnd = localInstant(localDate, input.startMinute + duration);
  const occupiedStart = localInstant(localDate, input.startMinute - 5);
  const occupiedEnd = localInstant(localDate, input.startMinute + duration + 5);

  await database.client.begin(async (tx) => {
    const operationId = await reservationOperation(tx, seed.business);
    const [allocation] = await tx`
      insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at)
      values (${seed.business},${input.staffMemberId},'RESERVATION',${reservationId},${localDate},${visibleStart.toISOString()},${visibleEnd.toISOString()},${occupiedStart.toISOString()},${occupiedEnd.toISOString()})
      returning id`;
    await tx`
      insert into booking.reservations(id,business_id,revision,status,owner_type,contact_snapshot,staff_member_id,policy_version_id,policy_snapshot,commercial_total_minor,currency,current_allocation_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,business_local_date,business_timezone_snapshot,created_operation_id)
      values (${reservationId},${seed.business},1,'CONFIRMED','GUEST',${JSON.stringify({ name: input.customerName ?? "Cliente Ausencia", phone: "1100000000" })}::jsonb,${input.staffMemberId},${seed.policyVersionId},'{}'::jsonb,10000,'ARS',${allocation!.id},${visibleStart.toISOString()},${visibleEnd.toISOString()},${occupiedStart.toISOString()},${occupiedEnd.toISOString()},${localDate},'America/Argentina/Buenos_Aires',${operationId})`;
    await tx`
      insert into booking.reservation_items(business_id,reservation_id,position,service_id,service_name_snapshot,terms_version_id,duration_minutes,pre_buffer_minutes,post_buffer_minutes,price_minor,currency)
      values (${seed.business},${reservationId},1,${seed.serviceCut},'Corte U05',${seed.termsCut},30,5,5,10000,'ARS')`;
    await tx`
      insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,changes)
      values (${seed.business},${reservationId},1,'RESERVATION_CONFIRMED',${operationId},'STAFF','{}'::jsonb)`;
  });

  return { reservationId, staffMemberId: input.staffMemberId, localDate, startMinute: input.startMinute, endsAtMinute: input.startMinute + duration };
}

/** Conteo de ausencias aplicadas que bloquean al profesional en ese día. */
export async function countEffectiveUnavailability(businessId: string, staffMemberId: string, localDate: string) {
  const [row] = await database.client`
    select count(*)::int count from team.staff_effective_unavailability
     where business_id=${businessId} and staff_member_id=${staffMemberId} and local_date=${localDate} and released_at is null`;
  return Number(row?.count ?? 0);
}

/** Estado persistido de una solicitud de ausencia. */
export async function absenceState(absenceId: string) {
  const [row] = await database.client`
    select id, status::text status, revision::int revision, applied_at "appliedAt",
           approved_at "approvedAt", reject_reason "rejectReason",
           start_minute "startMinute", end_minute "endMinute", local_date::text "localDate",
           staff_member_id "staffMemberId"
      from absence.absence_requests where id=${absenceId}`;
  const events = await database.client`
    select event_type::text "eventType", sequence, before_revision::int "beforeRevision", after_revision::int "afterRevision"
      from absence.absence_events where absence_request_id=${absenceId} order by sequence`;
  return { absence: row, events };
}
