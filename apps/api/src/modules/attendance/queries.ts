/**
 * H03.U06 · CAP-03-08 · Prestación real (Attendance) — consultas.
 *
 * El historial contrasta lo RESERVADO (`booking.reservation_items`) con lo
 * REALIZADO (`attendance.attendances.services_performed_snapshot`): la
 * diferencia es información de negocio, no un error de datos.
 */
import { DomainError } from "@youngkingz/contracts";
import type { AttendanceQuery, AttendanceSummary } from "@youngkingz/contracts";
import { rows, sql } from "../../lib/sql.js";
import type { Actor } from "../iam/authorization.js";
import { resolveAttendanceScope } from "./commands.js";

const attendanceSelect = sql`
  select at.id, at.business_id "businessId", at.reservation_id "reservationId",
         at.staff_member_id "staffMemberId",
         at.attended_by_staff_member_id "attendedByStaffMemberId",
         (p.first_name || coalesce(' ' || p.last_name, '')) "attendedByStaffMemberName",
         at.client_profile_id "clientProfileId", at.walk_in "walkIn", at.status::text status,
         at.started_at "startedAt", at.finished_at "finishedAt",
         at.contact_snapshot "contactSnapshot", at.services_performed_snapshot "servicesPerformedSnapshot",
         at.notes, at.revision::int revision, at.created_at "createdAt", at.updated_at "updatedAt",
         (select count(*)::int from attendance.attendance_corrections c
           where c.business_id = at.business_id and c.attendance_id = at.id) "correctionCount"
    from attendance.attendances at
    join team.staff_members sm on sm.business_id = at.business_id and sm.id = at.attended_by_staff_member_id
    join iam.persons p on p.id = sm.person_id`;

/** Fila cruda de la proyección SQL (aún sin `contact` ni `reservedServices`). */
type RawAttendance = Omit<AttendanceSummary, "contact" | "servicesPerformed" | "reservedServices"> & {
  contactSnapshot: { name?: string; phone?: string; email?: string | null } | null;
  servicesPerformedSnapshot: Array<{ name?: string; durationMinutes?: number; priceMinor?: number | null }> | null;
};

export async function listAttendances(actor: Actor, query: AttendanceQuery): Promise<AttendanceSummary[]> {
  const scope = resolveAttendanceScope(actor);
  if (scope.staffMemberId && query.staffMemberId && query.staffMemberId !== scope.staffMemberId) {
    throw new DomainError("FORBIDDEN", "Cannot read another professional's attendances", 403);
  }
  const effectiveStaff = scope.staffMemberId ?? query.staffMemberId;
  const staffFilter = effectiveStaff ? sql`and at.attended_by_staff_member_id = ${effectiveStaff}` : sql``;
  const statusFilter = query.status === "ALL" ? sql`` : sql`and at.status = ${query.status}`;
  const clientFilter = query.clientProfileId ? sql`and at.client_profile_id = ${query.clientProfileId}` : sql``;
  const reservationFilter = query.reservationId ? sql`and at.reservation_id = ${query.reservationId}` : sql``;
  const fromFilter = query.fromDate ? sql`and (at.started_at at time zone (select timezone from business.businesses where id = ${actor.businessId}))::date >= ${query.fromDate}` : sql``;
  const toFilter = query.toDate ? sql`and (at.started_at at time zone (select timezone from business.businesses where id = ${actor.businessId}))::date <= ${query.toDate}` : sql``;
  const walkInFilter = query.walkIn === "ONLY" ? sql`and at.walk_in = true`
    : query.walkIn === "EXCLUDE" ? sql`and at.walk_in = false` : sql``;

  const items = await rows<RawAttendance>(sql`
    ${attendanceSelect}
    where at.business_id = ${actor.businessId}
      ${staffFilter} ${statusFilter} ${clientFilter} ${reservationFilter} ${fromFilter} ${toFilter} ${walkInFilter}
    order by at.started_at desc
    limit ${query.limit}`);

  return items.map((item) => decorate(item));
}

export async function getAttendanceDetail(actor: Actor, attendanceId: string) {
  const scope = resolveAttendanceScope(actor);
  const [item] = await rows<RawAttendance>(sql`
    ${attendanceSelect}
    where at.business_id = ${actor.businessId} and at.id = ${attendanceId}`);
  if (!item) throw new DomainError("NOT_FOUND", "Attendance not found", 404);
  if (scope.staffMemberId && scope.staffMemberId !== item.attendedByStaffMemberId) {
    throw new DomainError("FORBIDDEN", "Attendance is not within the actor's professional scope", 403);
  }

  const reserved = item.reservationId
    ? await rows<{ name: string; durationMinutes: number; priceMinor: number }>(sql`
        select service_name_snapshot "name", duration_minutes "durationMinutes", price_minor::int "priceMinor"
          from booking.reservation_items
         where business_id = ${actor.businessId} and reservation_id = ${item.reservationId}
         order by position`)
    : [];

  const corrections = await rows<{
    id: string; changedByAccountId: string; changedByName: string | null; changedAt: Date;
    beforeSnapshot: Record<string, unknown>; afterSnapshot: Record<string, unknown>; reason: string;
  }>(sql`
    select c.id, c.changed_by_account_id "changedByAccountId",
           (p.first_name || coalesce(' ' || p.last_name, '')) "changedByName",
           c.changed_at "changedAt", c.before_snapshot "beforeSnapshot", c.after_snapshot "afterSnapshot", c.reason
      from attendance.attendance_corrections c
      left join iam.user_accounts ua on ua.id = c.changed_by_account_id
      left join iam.persons p on p.id = ua.person_id
     where c.business_id = ${actor.businessId} and c.attendance_id = ${attendanceId}
     order by c.changed_at desc`);

  const events = await rows<{
    sequence: number; eventType: string; principalType: string; actorAccountId: string | null;
    occurredAt: Date; beforeRevision: number | null; afterRevision: number | null;
    changes: Record<string, unknown>; reasonCode: string | null;
  }>(sql`
    select sequence, event_type::text "eventType", principal_type "principalType",
           actor_account_id "actorAccountId", occurred_at "occurredAt",
           before_revision::int "beforeRevision", after_revision::int "afterRevision",
           changes, reason_code "reasonCode"
      from attendance.attendance_events
     where business_id = ${actor.businessId} and attendance_id = ${attendanceId}
     order by sequence`);

  return { attendance: decorate(item, reserved), reservedServices: reserved, corrections, events };
}

type RawAttendanceRow = RawAttendance;

function decorate(item: RawAttendanceRow, reservedServices: AttendanceSummary["reservedServices"] = []): AttendanceSummary {
  const contact = item.contactSnapshot ?? null;
  const performed = Array.isArray(item.servicesPerformedSnapshot) ? item.servicesPerformedSnapshot : [];
  return {
    ...item,
    contact: { name: contact?.name ?? null, phone: contact?.phone ?? null, email: contact?.email ?? null },
    servicesPerformed: performed.map((service) => ({
      name: service.name ?? "",
      durationMinutes: Number(service.durationMinutes ?? 0),
      priceMinor: service.priceMinor === null || service.priceMinor === undefined ? null : Number(service.priceMinor)
    })),
    reservedServices
  };
}
