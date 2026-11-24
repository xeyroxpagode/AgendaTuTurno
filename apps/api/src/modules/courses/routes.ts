import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  courseSessionHistorySchema, rescheduleCourseSessionSchema, updateCourseSchema,
  scheduleCourseSessionSchema, publicCourseListSchema, DomainError, type Capability
} from "@youngkingz/contracts";
import { operationId } from "../system/operations.js";
import { authorizationService } from "../iam/authorization.js";
import { createCourse, updateCourse, publishCourse, unpublishCourse, scheduleSession, cancelCourse } from "./commands.js";
import { confirmSession, rescheduleSession, cancelSession, completeSession } from "./session-commands.js";
import { eligibleInstructors } from "./domain.js";
import { listCourses, listSessions, sessionHistory, publicCourses, publicCourseBusinesses } from "./repository.js";
import { rows, sql } from "../../lib/sql.js";

type PreHandler = (request: FastifyRequest) => Promise<void>;

function actorOf(request: FastifyRequest) {
  if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication is required", 401);
  authorizationService.require(request.actor, "courses.read");
  return request.actor;
}

function need(request: FastifyRequest, capability: Capability, scope?: { staffMemberId?: string }) {
  if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication is required", 401);
  authorizationService.require(request.actor, capability, scope);
  return request.actor;
}

/** Scope real de una sesión: la revalidación transaccional usa el mismo profesional. */
async function sessionScope(actor: { businessId: string }, sessionId: string) {
  const row = await rows<{ staffMemberId: string }>(sql`
    select instructor_staff_member_id "staffMemberId" from courses.course_sessions
    where business_id=${actor.businessId} and id=${sessionId}`);
  return row[0] ? { staffMemberId: String(row[0].staffMemberId) } : undefined;
}

async function needSession(request: FastifyRequest, sessionId: string) {
  if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication is required", 401);
  const scope = await sessionScope(request.actor, sessionId);
  // Una sesión inexistente es NOT_FOUND, no un conflicto de scope.
  if (!scope) throw new DomainError("NOT_FOUND", "Course session not found", 404);
  return need(request, "courses.sessions.manage", scope);
}

export function registerCourseRoutes(app: FastifyInstance, authenticate: PreHandler) {
  const auth = { preHandler: authenticate };
  const op = (request: FastifyRequest) => operationId(request.headers as Record<string, unknown>);

  app.get("/v1/courses", auth, async (request) => ({ data: await listCourses(actorOf(request).businessId) }));

  app.post("/v1/courses", auth, async (request) => {
    const actor = need(request, "courses.manage");
    const result = await createCourse(actor, request.body, op(request)); return { data: result.data, replayed: result.replayed };
  });

  app.patch("/v1/courses/:id", auth, async (request) => {
    const actor = need(request, "courses.manage");
    const { id } = request.params as { id: string };
    updateCourseSchema.parse(request.body);
    const result = await updateCourse(actor, id, request.body, op(request)); return { data: result.data, replayed: result.replayed };
  });

  app.post("/v1/courses/:id/publish", auth, async (request) => {
    const actor = need(request, "courses.publish");
    const result = await publishCourse(actor, (request.params as { id: string }).id, op(request)); return { data: result.data, replayed: result.replayed };
  });

  app.post("/v1/courses/:id/unpublish", auth, async (request) => {
    const actor = need(request, "courses.publish");
    const result = await unpublishCourse(actor, (request.params as { id: string }).id, op(request)); return { data: result.data, replayed: result.replayed };
  });

  app.post("/v1/courses/:id/cancel", auth, async (request) => {
    const actor = need(request, "courses.manage");
    const result = await cancelCourse(actor, (request.params as { id: string }).id, op(request)); return { data: result.data, replayed: result.replayed };
  });

  app.get("/v1/courses/:id/sessions", auth, async (request) => {
    const actor = actorOf(request);
    return { data: await listSessions(actor.businessId, (request.params as { id: string }).id) };
  });

  app.get("/v1/courses/instructors", auth, async (request) => ({ data: await eligibleInstructors(actorOf(request).businessId) }));

  app.post("/v1/courses/:id/sessions", auth, async (request) => {
    const { id } = request.params as { id: string };
    const input = scheduleCourseSessionSchema.parse(request.body);
    if (input.courseId !== id) throw new DomainError("VALIDATION_ERROR", "courseId in body must match the route", 400);
    const actor = need(request, "courses.sessions.manage", { staffMemberId: input.instructorStaffMemberId });
    const result = await scheduleSession(actor, input, op(request)); return { data: result.data, replayed: result.replayed };
  });

  app.get("/v1/courses/history", auth, async (request) => {
    const actor = actorOf(request);
    return { data: await sessionHistory(actor.businessId, courseSessionHistorySchema.parse(request.query)) };
  });

  app.post("/v1/course-sessions/:id/confirm", auth, async (request) => {
    const id = (request.params as { id: string }).id;
    const actor = await needSession(request, id);
    const result = await confirmSession(actor, { sessionId: id }, op(request)); return { data: result.data, replayed: result.replayed };
  });

  app.post("/v1/course-sessions/:id/reschedule", auth, async (request) => {
    const id = (request.params as { id: string }).id;
    const actor = await needSession(request, id);
    const input = rescheduleCourseSessionSchema.parse(request.body);
    if (input.sessionId !== id) throw new DomainError("VALIDATION_ERROR", "sessionId in body must match the route", 400);
    const result = await rescheduleSession(actor, input, op(request)); return { data: result };
  });

  app.post("/v1/course-sessions/:id/cancel", auth, async (request) => {
    const id = (request.params as { id: string }).id;
    const actor = await needSession(request, id);
    const result = await cancelSession(actor, { sessionId: id }, op(request)); return { data: result.data, replayed: result.replayed };
  });

  app.post("/v1/course-sessions/:id/complete", auth, async (request) => {
    const id = (request.params as { id: string }).id;
    const actor = await needSession(request, id);
    const result = await completeSession(actor, { sessionId: id }, op(request)); return { data: result.data, replayed: result.replayed };
  });

  /** CAP-07-05 · Discovery público. Sólo PUBLICADOS; sin CTA académico. */
  app.get("/v1/public/businesses/:businessId/courses", async (request) => {
    const parsed = publicCourseListSchema.safeParse(request.params);
    if (!parsed.success) throw new DomainError("NOT_FOUND", "Este enlace no corresponde a una barbería activa", 404);
    return { data: await publicCourses(parsed.data.businessId) };
  });

  app.get("/v1/public/course-businesses", async () => ({ data: await publicCourseBusinesses() }));
}

