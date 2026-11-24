import type { Actor } from "../iam/authorization.js";
import type { Tx } from "../system/operations.js";

/** H07 · Historial append-only. La identidad (courseId/sessionId) nunca cambia. */
export async function recordCourseEvent(
  tx: Tx,
  actor: Actor,
  input: { courseId: string; eventType: string; operationId: string; changes?: object }
): Promise<void> {
  await tx`
    insert into courses.course_events(business_id, course_id, event_type, actor_account_id, operation_id, changes)
    values (${actor.businessId}, ${input.courseId}, ${input.eventType}, ${actor.accountId}, ${input.operationId}, ${JSON.stringify(input.changes ?? {})}::jsonb)`;
}

export async function recordSessionEvent(
  tx: Tx,
  actor: Actor,
  input: { sessionId: string; eventType: string; operationId: string; changes?: object }
): Promise<void> {
  await tx`
    insert into courses.course_session_events(business_id, session_id, event_type, actor_account_id, operation_id, changes)
    values (${actor.businessId}, ${input.sessionId}, ${input.eventType}, ${actor.accountId}, ${input.operationId}, ${JSON.stringify(input.changes ?? {})}::jsonb)`;
}
