import { DomainError, parseClockToMinute, type Capability } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { audit, executeOperation, revalidateAuthority, type Tx } from "../system/operations.js";
import { lockAvailabilityGuard } from "../availability/guard.js";
import { releaseAllocation } from "../availability/allocation.js";
import { assertSessionTransition, businessTimezone, composeLocalInterval } from "./domain.js";
import { claimCourseSession } from "./claim.js";
import { requireCourse, requireSession } from "./repository.js";
import { recordSessionEvent } from "./events.js";

const CAPABILITY: Capability = "courses.sessions.manage";

async function releaseSessionAllocation(tx: Tx, actor: Actor, sessionId: string): Promise<string> {
  const [allocation] = await tx`
    select id from availability.resource_allocations
    where business_id=${actor.businessId} and source_type='COURSE_SESSION' and source_id=${sessionId}
      and status='ACTIVE' for update`;
  if (!allocation) throw new DomainError("SESSION_ALLOCATION_MISSING", "The session has no active allocation to release", 409, { sessionId });
  await releaseAllocation(tx, { businessId: actor.businessId, sourceType: "COURSE_SESSION", sourceId: sessionId, reason: "COURSE_SESSION_STATE_CHANGE" });
  return allocation.id as string;
}

export async function confirmSession(actor: Actor, input: { sessionId: string }, operationId: string) {
  return executeOperation({ operationId, command: "session.confirm", actor, payload: input }, async (tx) => {
    await lockAvailabilityGuard(tx, actor.businessId);
    const session = await requireSession(actor.businessId, input.sessionId, tx);
    const course = await requireCourse(actor.businessId, String(session.courseId), tx);
    if (course.status === "CANCELLED") throw new DomainError("SESSION_STATE_INVALID", "El curso está cancelado", 409);
    assertSessionTransition(String(session.status), "CONFIRMED");
    await claimCourseSession(tx, actor, {
      businessId: actor.businessId, sessionId: input.sessionId,
      instructorStaffMemberId: String(session.instructorStaffMemberId),
      localDate: String(session.localDate),
      startMinute: Number(session.localStartMinute),
      durationMinutes: Number(session.durationMinutes)
    });
    const [updated] = await tx`
      update courses.course_sessions set status='CONFIRMED', confirmed_by_account_id=${actor.accountId},
        confirmed_at=now(), revision=revision+1, updated_at=now()
      where business_id=${actor.businessId} and id=${input.sessionId} returning revision`;
    await recordSessionEvent(tx, actor, { sessionId: input.sessionId, eventType: "CONFIRMED", operationId, changes: { from: session.status, to: "CONFIRMED" } });
    await revalidateAuthority(tx, actor, CAPABILITY, { staffMemberId: String(session.instructorStaffMemberId) });
    await audit(tx, { actor, operationId, action: "session.confirmed", capability: CAPABILITY, resourceType: "COURSE_SESSION", resourceId: input.sessionId, changes: { courseId: session.courseId } });
    return { sessionId: input.sessionId, status: "CONFIRMED", revision: Number(updated!.revision) };
  });
}

export async function rescheduleSession(
  actor: Actor,
  input: { sessionId: string; localDate: string; localStart: string; durationMinutes: number; revision: number },
  operationId: string
) {
  const result = await executeOperation({ operationId, command: "session.reschedule", actor, payload: input }, async (tx) => {
    await lockAvailabilityGuard(tx, actor.businessId);
    const session = await requireSession(actor.businessId, input.sessionId, tx);
    if (Number(session.revision) !== input.revision) throw new DomainError("STALE_REVISION", "Session revision is stale", 409);
    assertSessionTransition(String(session.status), "RESCHEDULED");
    const timezone = await businessTimezone(actor.businessId, tx);
    const interval = composeLocalInterval({
      localDate: input.localDate, startMinute: parseClockToMinute(input.localStart),
      durationMinutes: input.durationMinutes, timezone
    });
    const originAllocationId = await releaseSessionAllocation(tx, actor, input.sessionId);
    const claimed = await claimCourseSession(tx, actor, {
      businessId: actor.businessId, sessionId: input.sessionId,
      instructorStaffMemberId: String(session.instructorStaffMemberId),
      localDate: input.localDate, startMinute: interval.startMinute, durationMinutes: input.durationMinutes
    });
    const [updated] = await tx`
      update courses.course_sessions set status='RESCHEDULED', local_date=${input.localDate}, timezone=${timezone},
        local_start_minute=${interval.startMinute}, duration_minutes=${input.durationMinutes},
        occupied_start_at=${interval.occupiedStartAt.toISOString()}, occupied_end_at=${interval.occupiedEndAt.toISOString()},
        revision=revision+1, updated_at=now()
      where business_id=${actor.businessId} and id=${input.sessionId} returning revision`;
    await recordSessionEvent(tx, actor, {
      sessionId: input.sessionId, eventType: "RESCHEDULED", operationId,
      changes: { from: { localDate: session.localDate, occupiedStartAt: session.occupiedStartAt, occupiedEndAt: session.occupiedEndAt }, to: { localDate: input.localDate, occupiedStartAt: interval.occupiedStartAt, occupiedEndAt: interval.occupiedEndAt }, originAllocationId, destinationAllocationId: claimed.allocationId }
    });
    await revalidateAuthority(tx, actor, CAPABILITY, { staffMemberId: String(session.instructorStaffMemberId) });
    await audit(tx, { actor, operationId, action: "session.rescheduled", capability: CAPABILITY, resourceType: "COURSE_SESSION", resourceId: input.sessionId, changes: { originAllocationId, destinationAllocationId: claimed.allocationId } });
    return { sessionId: input.sessionId, status: "RESCHEDULED", revision: Number(updated!.revision), allocationId: claimed.allocationId };
  });
  // N-11 · un replay no debe devolver un estado obsoleto tras una liberación.
  if (result.replayed) {
    const current = await requireSession(actor.businessId, input.sessionId);
    return {
      ...result.data,
      status: String(current.status),
      revision: Number(current.revision),
      currentStatus: String(current.status),
      currentRevision: Number(current.revision),
      replayed: true
    };
  }
  return { ...result.data, replayed: false };
}

export async function cancelSession(actor: Actor, input: { sessionId: string }, operationId: string) {
  return executeOperation({ operationId, command: "session.cancel", actor, payload: input }, async (tx) => {
    await lockAvailabilityGuard(tx, actor.businessId);
    const session = await requireSession(actor.businessId, input.sessionId, tx);
    assertSessionTransition(String(session.status), "CANCELLED");
    const released = session.status === "SCHEDULED" ? null : await releaseSessionAllocation(tx, actor, input.sessionId);
    const [updated] = await tx`
      update courses.course_sessions set status='CANCELLED', cancelled_at=now(), revision=revision+1, updated_at=now()
      where business_id=${actor.businessId} and id=${input.sessionId} returning revision`;
    await recordSessionEvent(tx, actor, { sessionId: input.sessionId, eventType: "CANCELLED", operationId, changes: { from: session.status, releasedAllocationId: released } });
    await revalidateAuthority(tx, actor, CAPABILITY, { staffMemberId: String(session.instructorStaffMemberId) });
    await audit(tx, { actor, operationId, action: "session.cancelled", capability: CAPABILITY, resourceType: "COURSE_SESSION", resourceId: input.sessionId, changes: { releasedAllocationId: released } });
    return { sessionId: input.sessionId, status: "CANCELLED", revision: Number(updated!.revision), releasedAllocationId: released };
  });
}

export async function completeSession(actor: Actor, input: { sessionId: string }, operationId: string) {
  return executeOperation({ operationId, command: "session.complete", actor, payload: input }, async (tx) => {
    await lockAvailabilityGuard(tx, actor.businessId);
    const session = await requireSession(actor.businessId, input.sessionId, tx);
    assertSessionTransition(String(session.status), "COMPLETED");
    if (new Date(session.occupiedEndAt).getTime() > Date.now()) {
      throw new DomainError("SESSION_STATE_INVALID", "Registrá la realización cuando termine la sesión", 409);
    }
    const released = await releaseSessionAllocation(tx, actor, input.sessionId);
    const [updated] = await tx`
      update courses.course_sessions set status='COMPLETED', completed_by_account_id=${actor.accountId},
        completed_at=now(), revision=revision+1, updated_at=now()
      where business_id=${actor.businessId} and id=${input.sessionId} returning revision`;
    await recordSessionEvent(tx, actor, { sessionId: input.sessionId, eventType: "COMPLETED", operationId, changes: { from: session.status, releasedAllocationId: released } });
    await revalidateAuthority(tx, actor, CAPABILITY, { staffMemberId: String(session.instructorStaffMemberId) });
    await audit(tx, { actor, operationId, action: "session.completed", capability: CAPABILITY, resourceType: "COURSE_SESSION", resourceId: input.sessionId, changes: { releasedAllocationId: released } });
    // QX-05: NINGÚn Money/Settlement automático.
    return { sessionId: input.sessionId, status: "COMPLETED", revision: Number(updated!.revision) };
  });
}
