import { DomainError } from "@youngkingz/contracts";
import { rows, sql } from "../../lib/sql.js";
import type { Tx } from "../system/operations.js";

export type CourseRow = {
  id: string; title: string; summary: string | null; description: string | null;
  status: string; revision: number; publishedAt: Date | null;
  contactChannel: string | null; contactValue: string | null;
};
export type SessionRow = {
  id: string; courseId: string; instructorStaffMemberId: string; localDate: string;
  localStartMinute: number | null; durationMinutes: number | null; timezone: string;
  occupiedStartAt: Date; occupiedEndAt: Date; status: string; revision: number;
};

export async function getCourse(businessId: string, courseId: string, tx?: Tx) {
  if (tx) {
    const result = await tx`select id, title, summary, description, status::text status, revision, published_at "publishedAt", contact_channel "contactChannel", contact_value "contactValue" from courses.courses where business_id=${businessId} and id=${courseId} for update` as unknown as CourseRow[];
    return result[0];
  }
  const result = await rows<CourseRow>(sql`select id, title, summary, description, status::text status, revision, published_at "publishedAt", contact_channel "contactChannel", contact_value "contactValue" from courses.courses where business_id=${businessId} and id=${courseId}`);
  return result[0];
}

export async function requireCourse(businessId: string, courseId: string, tx?: Tx) {
  const course = await getCourse(businessId, courseId, tx);
  if (!course) throw new DomainError("NOT_FOUND", "Course not found", 404);
  return course;
}

export async function listCourses(businessId: string) {
  return rows(sql`select id, title, summary, contact_channel "contactChannel", contact_value "contactValue", status::text status, revision, published_at "publishedAt", created_at "createdAt" from courses.courses where business_id=${businessId} order by created_at desc`);
}

export async function listSessions(businessId: string, courseId: string) {
  return rows<SessionRow>(sql`select id, course_id "courseId", instructor_staff_member_id "instructorStaffMemberId", local_date "localDate", local_start_minute "localStartMinute", duration_minutes "durationMinutes", timezone, occupied_start_at "occupiedStartAt", occupied_end_at "occupiedEndAt", status::text status, revision from courses.course_sessions where business_id=${businessId} and course_id=${courseId} order by occupied_start_at`);
}

export async function getSession(businessId: string, sessionId: string, tx?: Tx) {
  if (tx) {
    const result = await tx`select id, course_id "courseId", instructor_staff_member_id "instructorStaffMemberId", local_date "localDate", local_start_minute "localStartMinute", duration_minutes "durationMinutes", timezone, occupied_start_at "occupiedStartAt", occupied_end_at "occupiedEndAt", status::text status, revision from courses.course_sessions where business_id=${businessId} and id=${sessionId} for update` as unknown as SessionRow[];
    return result[0];
  }
  const result = await rows<SessionRow>(sql`select id, course_id "courseId", instructor_staff_member_id "instructorStaffMemberId", local_date "localDate", local_start_minute "localStartMinute", duration_minutes "durationMinutes", timezone, occupied_start_at "occupiedStartAt", occupied_end_at "occupiedEndAt", status::text status, revision from courses.course_sessions where business_id=${businessId} and id=${sessionId}`);
  return result[0];
}

export async function requireSession(businessId: string, sessionId: string, tx?: Tx) {
  const session = await getSession(businessId, sessionId, tx);
  if (!session) throw new DomainError("NOT_FOUND", "Session not found", 404);
  return session;
}

export async function sessionHistory(businessId: string, where: { courseId?: string; sessionId?: string }) {
  return rows(sql`
    select e.id, e.event_type "eventType", e.changes, e.created_at "createdAt",
           e.session_id "sessionId", e.course_id "courseId"
    from (
      select id, event_type, changes, created_at, course_id, null::uuid session_id, business_id from courses.course_events
      union all
      select se.id, se.event_type, se.changes, se.created_at, s.course_id, se.session_id, se.business_id
      from courses.course_session_events se
      join courses.course_sessions s on s.business_id=se.business_id and s.id=se.session_id
    ) e
    where e.business_id=${businessId}
      and (${where.courseId ?? null}::uuid is null or e.course_id=${where.courseId ?? null}::uuid)
      and (${where.sessionId ?? null}::uuid is null or e.session_id=${where.sessionId ?? null}::uuid)
    order by e.created_at desc limit 200`);
}

export async function publicCourseBusinesses() {
  return rows<{ id: string; name: string }>(sql`
    select b.id, b.display_name name
    from business.businesses b
    where b.status='ACTIVE' and exists (
      select 1 from courses.courses c where c.business_id=b.id and c.status='PUBLISHED'
    )
    order by b.display_name, b.id`);
}

/** Discovery público de un negocio activo y sus sesiones confirmadas. */
export async function publicCourses(businessId: string) {
  const [business] = await rows<{ id: string; name: string; bookingEnabled: boolean }>(sql`
    select b.id, b.display_name name, coalesce(v.public_booking_enabled, false) "bookingEnabled"
    from business.businesses b
    left join business.booking_policy_states ps on ps.business_id=b.id
    left join business.booking_policy_versions v on v.business_id=b.id and v.id=ps.current_version_id
    where b.id=${businessId} and b.status='ACTIVE'`);
  if (!business) throw new DomainError("NOT_FOUND", "Este enlace no corresponde a una barbería activa", 404);
  const courses = await rows(sql`
    select id, title, summary, description, contact_channel "contactChannel", case when contact_channel <> 'NONE' then contact_value end "contactValue", published_at "publishedAt"
    from courses.courses where business_id=${businessId} and status='PUBLISHED' order by published_at desc`);
  const sessions = await rows(sql`
    select s.id, s.course_id "courseId", s.local_date "localDate", s.timezone,
           s.occupied_start_at "start", s.occupied_end_at "end",
           pp.professional_display_name "instructorName"
    from courses.course_sessions s
    join courses.courses c on c.business_id=s.business_id and c.id=s.course_id
    join team.staff_members sm on sm.business_id=s.business_id and sm.id=s.instructor_staff_member_id
    left join team.professional_profiles pp on pp.business_id=sm.business_id and pp.staff_member_id=sm.id
    where s.business_id=${businessId} and c.status='PUBLISHED'
      and s.status in ('CONFIRMED','RESCHEDULED') and s.occupied_end_at > now()
    order by s.occupied_start_at`);
  return { business, courses, sessions };
}
