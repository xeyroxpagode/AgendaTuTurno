import {
  DomainError, createCourseSchema, updateCourseSchema, scheduleCourseSessionSchema,
  parseClockToMinute
} from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { authorizationService } from "../iam/authorization.js";
import { audit, executeOperation, revalidateAuthority } from "../system/operations.js";
import { assertInstructorEligible, businessTimezone, composeLocalInterval } from "./domain.js";
import { requireCourse } from "./repository.js";
import { recordCourseEvent, recordSessionEvent } from "./events.js";
import { releaseAllocation } from "../availability/allocation.js";

const MANAGE = "courses.manage" as const;
const PUBLISH = "courses.publish" as const;
const SCHEDULE = "courses.sessions.manage" as const;

export async function createCourse(actor: Actor, raw: unknown, operationId: string) {
  authorizationService.require(actor, MANAGE);
  const input = createCourseSchema.parse(raw);
  return executeOperation({ operationId, command: "course.create", actor, payload: input }, async (tx) => {
    const [course] = await tx`
      insert into courses.courses(business_id, title, summary, description, contact_channel, contact_value, created_by_account_id, operation_id)
      values (${actor.businessId}, ${input.title}, ${input.summary ?? null}, ${input.description ?? null},
              ${input.contactChannel}, ${input.contactValue ?? null}, ${actor.accountId}, ${operationId})
      returning id, revision`;
    await recordCourseEvent(tx, actor, { courseId: course!.id as string, eventType: "CREATED", operationId, changes: { title: input.title } });
    await revalidateAuthority(tx, actor, MANAGE);
    await audit(tx, { actor, operationId, action: "course.created", capability: MANAGE, resourceType: "COURSE", resourceId: course!.id as string, changes: { title: input.title } });
    return { id: course!.id as string, status: "DRAFT", revision: Number(course!.revision) };
  });
}

export async function updateCourse(actor: Actor, courseId: string, raw: unknown, operationId: string) {
  authorizationService.require(actor, MANAGE);
  const input = updateCourseSchema.parse(raw);
  return executeOperation({ operationId, command: "course.update", actor, payload: { courseId, ...input } }, async (tx) => {
    const course = await requireCourse(actor.businessId, courseId, tx);
    if (Number(course.revision) !== input.revision) throw new DomainError("STALE_REVISION", "Course revision is stale", 409);
    if (course.status === "CANCELLED") throw new DomainError("SESSION_STATE_INVALID", "A cancelled course cannot be edited", 409);
    const [updated] = await tx`
      update courses.courses set
        title=coalesce(${input.title ?? null},title), summary=case when ${input.summary === undefined} then summary else ${input.summary ?? null} end,
        description=case when ${input.description === undefined} then description else ${input.description ?? null} end,
        contact_channel=coalesce(${input.contactChannel ?? null},contact_channel),
        contact_value=case when ${input.contactValue === undefined} then contact_value else ${input.contactValue ?? null} end,
        revision=revision+1, updated_at=now()
      where business_id=${actor.businessId} and id=${courseId} returning revision`;
    await recordCourseEvent(tx, actor, { courseId, eventType: "UPDATED", operationId, changes: { fields: Object.keys(input).filter((key) => key !== "revision") } });
    await revalidateAuthority(tx, actor, MANAGE);
    await audit(tx, { actor, operationId, action: "course.updated", capability: MANAGE, resourceType: "COURSE", resourceId: courseId });
    return { id: courseId, status: String(course.status), revision: Number(updated!.revision) };
  });
}

async function changePublication(actor: Actor, courseId: string, operationId: string, target: "PUBLISHED" | "UNPUBLISHED") {
  authorizationService.require(actor, PUBLISH);
  return executeOperation({ operationId, command: `course.${target.toLowerCase()}`, actor, payload: { courseId } }, async (tx) => {
    const course = await requireCourse(actor.businessId, courseId, tx);
    if (target === "PUBLISHED" && !["DRAFT", "UNPUBLISHED"].includes(String(course.status))) throw new DomainError("SESSION_STATE_INVALID", "Course cannot be published from this state", 409);
    if (target === "UNPUBLISHED" && String(course.status) !== "PUBLISHED") throw new DomainError("SESSION_STATE_INVALID", "Course is not published", 409);
    const [updated] = await tx`
      update courses.courses set status=${target}, published_at=${target === "PUBLISHED" ? new Date().toISOString() : null},
        revision=revision+1, updated_at=now()
      where business_id=${actor.businessId} and id=${courseId} returning revision`;
    await recordCourseEvent(tx, actor, { courseId, eventType: target, operationId, changes: { from: course.status, to: target } });
    await revalidateAuthority(tx, actor, PUBLISH);
    await audit(tx, { actor, operationId, action: `course.${target.toLowerCase()}`, capability: PUBLISH, resourceType: "COURSE", resourceId: courseId, changes: { from: course.status, to: target } });
    return { id: courseId, status: target, revision: Number(updated!.revision) };
  });
}

export function publishCourse(actor: Actor, courseId: string, operationId: string) {
  return changePublication(actor, courseId, operationId, "PUBLISHED");
}
export function unpublishCourse(actor: Actor, courseId: string, operationId: string) {
  return changePublication(actor, courseId, operationId, "UNPUBLISHED");
}

export async function scheduleSession(actor: Actor, raw: unknown, operationId: string) {
  const parsed = scheduleCourseSessionSchema.parse(raw);
  authorizationService.require(actor, SCHEDULE, { staffMemberId: parsed.instructorStaffMemberId });
  return executeOperation({ operationId, command: "session.schedule", actor, payload: parsed }, async (tx) => {
    await requireCourse(actor.businessId, parsed.courseId, tx);
    await assertInstructorEligible(tx, actor.businessId, parsed.instructorStaffMemberId);
    const timezone = await businessTimezone(actor.businessId, tx);
    const startMinute = parseClockToMinute(parsed.localStart);
    const interval = composeLocalInterval({ localDate: parsed.localDate, startMinute, durationMinutes: parsed.durationMinutes, timezone });
    const [session] = await tx`
      insert into courses.course_sessions(
        business_id, course_id, instructor_staff_member_id, local_date, local_start_minute, duration_minutes,
        timezone, occupied_start_at, occupied_end_at, operation_id)
      values (${actor.businessId}, ${parsed.courseId}, ${parsed.instructorStaffMemberId}, ${parsed.localDate},
              ${startMinute}, ${parsed.durationMinutes}, ${timezone},
              ${interval.occupiedStartAt.toISOString()}, ${interval.occupiedEndAt.toISOString()}, ${operationId})
      returning id, revision`;
    await recordSessionEvent(tx, actor, { sessionId: session!.id as string, eventType: "SCHEDULED", operationId, changes: { courseId: parsed.courseId, localDate: parsed.localDate, localStart: parsed.localStart, durationMinutes: parsed.durationMinutes } });
    await revalidateAuthority(tx, actor, SCHEDULE, { staffMemberId: parsed.instructorStaffMemberId });
    await audit(tx, { actor, operationId, action: "session.scheduled", capability: SCHEDULE, resourceType: "COURSE_SESSION", resourceId: session!.id as string, changes: { courseId: parsed.courseId, instructorStaffMemberId: parsed.instructorStaffMemberId } });
    return { id: session!.id as string, status: "SCHEDULED", revision: Number(session!.revision) };
  });
}

export async function cancelCourse(actor: Actor, courseId: string, operationId: string) {
  authorizationService.require(actor, MANAGE);
  return executeOperation({ operationId, command: "course.cancel", actor, payload: { courseId } }, async (tx) => {
    const course = await requireCourse(actor.businessId, courseId, tx);
    if (String(course.status) === "CANCELLED") throw new DomainError("SESSION_STATE_INVALID", "Course is already cancelled", 409);
    const sessions = await tx`
      select id, status::text status from courses.course_sessions
      where business_id=${actor.businessId} and course_id=${courseId} and status in ('SCHEDULED','CONFIRMED','RESCHEDULED')`;
    for (const session of sessions) {
      const [allocation] = await tx`
        select id from availability.resource_allocations where business_id=${actor.businessId}
          and source_type='COURSE_SESSION' and source_id=${session.id} and status='ACTIVE' for update`;
      if (allocation) await releaseAllocation(tx, { businessId: actor.businessId, sourceType: "COURSE_SESSION", sourceId: session.id as string, reason: "COURSE_CANCELLED" });
      await tx`update courses.course_sessions set status='CANCELLED', cancelled_at=now(), revision=revision+1, updated_at=now() where business_id=${actor.businessId} and id=${session.id}`;
      await recordSessionEvent(tx, actor, { sessionId: session.id as string, eventType: "CANCELLED", operationId, changes: { cause: "COURSE_CANCELLED" } });
    }
    await tx`update courses.courses set status='CANCELLED', revision=revision+1, updated_at=now() where business_id=${actor.businessId} and id=${courseId}`;
    await recordCourseEvent(tx, actor, { courseId, eventType: "CANCELLED", operationId, changes: { affectedSessions: sessions.length } });
    await revalidateAuthority(tx, actor, MANAGE);
    await audit(tx, { actor, operationId, action: "course.cancelled", capability: MANAGE, resourceType: "COURSE", resourceId: courseId, changes: { affectedSessions: sessions.length } });
    return { courseId, status: "CANCELLED", affectedSessions: sessions.length };
  });
}
