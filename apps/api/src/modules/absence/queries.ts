/**
 * H03.U06 · CAP-03-07 · Ausencias y conflictos — consultas.
 *
 * Todas las lecturas están acotadas por `business_id = actor.businessId`
 * (INV-G-07: el aislamiento multi-Business no revela existencia) y por el
 * alcance profesional del actor (`BARBER` sólo ve las suyas).
 */
import { DomainError } from "@youngkingz/contracts";
import type { AbsenceQuery, AbsenceStatus, AbsenceSummary } from "@youngkingz/contracts";
import { rows, sql } from "../../lib/sql.js";
import type { Actor } from "../iam/authorization.js";
import { resolveAbsenceScope } from "./commands.js";

export type AbsenceDetail = {
  absence: AbsenceSummary;
  events: Array<{
    sequence: number;
    eventType: string;
    principalType: string;
    actorAccountId: string | null;
    occurredAt: string;
    beforeRevision: number | null;
    afterRevision: number | null;
    changes: Record<string, unknown>;
    reasonCode: string | null;
  }>;
};

const absenceSelect = sql`
  select ar.id, ar.business_id "businessId", ar.staff_member_id "staffMemberId",
         (p.first_name || coalesce(' ' || p.last_name, '')) "staffMemberName",
         ar.requested_by_account_id "requestedByAccountId",
         ar.local_date::text "localDate", ar.start_minute "startMinute", ar.end_minute "endMinute",
         ar.reason, ar.status::text status, ar.revision::int revision,
         ar.approved_by_account_id "approvedByAccountId", ar.approved_at "approvedAt",
         ar.reject_reason "rejectReason", ar.applied_at "appliedAt",
         ar.created_at "createdAt", ar.updated_at "updatedAt"
    from absence.absence_requests ar
    join team.staff_members sm on sm.business_id = ar.business_id and sm.id = ar.staff_member_id
    join iam.persons p on p.id = sm.person_id`;

export async function listAbsences(actor: Actor, query: AbsenceQuery): Promise<AbsenceSummary[]> {
  const scope = resolveAbsenceScope(actor);
  if (scope.staffMemberId && query.staffMemberId && query.staffMemberId !== scope.staffMemberId) {
    throw new DomainError("FORBIDDEN", "Cannot read another professional's absences", 403);
  }
  const effectiveStaff = scope.staffMemberId ?? query.staffMemberId;
  const statusFilter = query.status === "ALL" ? sql`` : sql`and ar.status = ${query.status}`;
  const staffFilter = effectiveStaff ? sql`and ar.staff_member_id = ${effectiveStaff}` : sql``;
  const exactDate = query.localDate ? sql`and ar.local_date = ${query.localDate}` : sql``;
  const fromFilter = query.fromDate ? sql`and ar.local_date >= ${query.fromDate}` : sql``;
  const toFilter = query.toDate ? sql`and ar.local_date <= ${query.toDate}` : sql``;

  return rows<AbsenceSummary>(sql`
    ${absenceSelect}
    where ar.business_id = ${actor.businessId}
      ${statusFilter} ${staffFilter} ${exactDate} ${fromFilter} ${toFilter}
    order by ar.local_date desc, ar.start_minute asc, ar.created_at desc
    limit ${query.limit}`);
}

export async function getAbsenceDetail(actor: Actor, absenceId: string): Promise<AbsenceDetail> {
  const [absence] = await rows<AbsenceSummary>(sql`
    ${absenceSelect}
    where ar.business_id = ${actor.businessId} and ar.id = ${absenceId}`);
  if (!absence) throw new DomainError("NOT_FOUND", "Absence request not found", 404);

  const scope = resolveAbsenceScope(actor);
  if (scope.staffMemberId && scope.staffMemberId !== absence.staffMemberId) {
    throw new DomainError("FORBIDDEN", "Absence is not within the actor's professional scope", 403);
  }

  const events = await rows<AbsenceDetail["events"][number]>(sql`
    select sequence, event_type::text "eventType", principal_type "principalType",
           actor_account_id "actorAccountId", occurred_at "occurredAt",
           before_revision::int "beforeRevision", after_revision::int "afterRevision",
           changes, reason_code "reasonCode"
      from absence.absence_events
     where business_id = ${actor.businessId} and absence_request_id = ${absenceId}
     order by sequence`);

  return { absence, events };
}

/**
 * Compromisos afectados por la ausencia: reservas `CONFIRMED` que solapan el
 * intervalo, con el estado del conflicto registrado en
 * `availability.commitment_conflicts`.
 */
export async function listAbsenceConflicts(actor: Actor, absenceId: string): Promise<Array<{
  reservationId: string | null;
  courseId: string | null;
  courseTitle: string | null;
  allocationId: string;
  staffMemberId: string;
  localDate: string;
  visibleStartAt: string;
  visibleEndAt: string;
  startsAt: string | null;
  endsAt: string | null;
  customerName: string | null;
  status: string | null;
  revision: number | null;
  serviceNames: string[];
  conflictId: string | null;
  conflictStatus: "OPEN" | "RESOLVED" | null;
  resolutionReference: string | null;
}>> {
  const detail = await getAbsenceDetail(actor, absenceId);
  const absence = detail.absence;

  const affected = await rows<{
    reservationId: string | null; courseId: string | null; courseTitle: string | null;
    allocationId: string; staffMemberId: string; localDate: string;
    visibleStartAt: Date; visibleEndAt: Date; startsAt: Date | null; endsAt: Date | null;
    customerName: string | null; status: string | null; revision: number | null; serviceNames: string[];
  }>(sql`
    select r.id "reservationId", a.id "allocationId", a.staff_member_id "staffMemberId",
           a.local_date::text "localDate", a.visible_start_at "visibleStartAt", a.visible_end_at "visibleEndAt",
           r.starts_at "startsAt", r.ends_at "endsAt", c.id "courseId", c.title "courseTitle",
           r.contact_snapshot->>'name' "customerName", coalesce(r.status::text,s.status) status, r.revision::int revision,
           coalesce((select array_agg(i.service_name_snapshot order by i.position)
                       from booking.reservation_items i
                      where i.business_id = r.business_id and i.reservation_id = r.id), '{}') "serviceNames"
      from availability.resource_allocations a
      left join booking.reservations r
             on r.business_id = a.business_id and r.id = a.source_id and a.source_type = 'RESERVATION'
      left join courses.course_sessions s
             on s.business_id=a.business_id and s.id=a.source_id and a.source_type='COURSE_SESSION'
      left join courses.courses c on c.business_id=s.business_id and c.id=s.course_id
     where a.business_id = ${actor.businessId}
       and a.staff_member_id = ${absence.staffMemberId}
       and a.local_date = ${absence.localDate}
       and a.status = 'ACTIVE'
       and (a.visible_end_at > a.visible_start_at)
     order by a.visible_start_at`);

  const conflicts = await rows<{ allocationId: string; id: string; status: string; resolutionReference: string | null }>(sql`
    select c.allocation_id "allocationId", c.id, c.status::text status, c.resolution_reference "resolutionReference"
      from availability.commitment_conflicts c
     where c.business_id = ${actor.businessId} and c.reason_code = 'APPLIED_ABSENCE'
       and c.source_operation_id=(select ar.created_operation_id from absence.absence_requests ar where ar.business_id=c.business_id and ar.id=${absenceId})
     order by c.detected_at desc`);

  const byAllocation = new Map(conflicts.map((conflict) => [conflict.allocationId, conflict]));

  // Sólo los compromisos que SOLAPAN el intervalo de la ausencia son conflictos.
  const timezoneRows = await rows<{ timezone: string }>(sql`select timezone from business.businesses where id = ${actor.businessId}`);
  const timezone = timezoneRows[0]?.timezone ?? "UTC";

  const { localDateTimeToInstant } = await import("../availability/temporal.js");
  const rangeStart = localDateTimeToInstant(absence.localDate, absence.startMinute, timezone);
  const rangeEnd = localDateTimeToInstant(absence.localDate, absence.endMinute, timezone);

  return affected
    .filter((item) => new Date(item.visibleStartAt).getTime() < rangeEnd.getTime() && rangeStart.getTime() < new Date(item.visibleEndAt).getTime())
    .map((item) => {
      const conflict = byAllocation.get(item.allocationId);
      return {
        reservationId: item.reservationId,
        courseId: item.courseId,
        courseTitle: item.courseTitle,
        allocationId: item.allocationId,
        staffMemberId: item.staffMemberId,
        localDate: item.localDate,
        visibleStartAt: new Date(item.visibleStartAt).toISOString(),
        visibleEndAt: new Date(item.visibleEndAt).toISOString(),
        startsAt: item.startsAt ? new Date(item.startsAt).toISOString() : null,
        endsAt: item.endsAt ? new Date(item.endsAt).toISOString() : null,
        customerName: item.customerName,
        status: item.status,
        revision: item.revision,
        serviceNames: item.serviceNames,
        conflictId: conflict?.id ?? null,
        conflictStatus: (conflict?.status as "OPEN" | "RESOLVED" | undefined) ?? null,
        resolutionReference: conflict?.resolutionReference ?? null
      };
    });
}

export type { AbsenceStatus };
