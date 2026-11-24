import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  courseSessionHistorySchema, rescheduleCourseSessionSchema, updateCourseSchema,
  scheduleCourseSessionSchema, DomainError, type Capability
} from "@youngkingz/contracts";
import { operationId } from "../system/operations.js";
import { authorizationService } from "../iam/authorization.js";
import { createCourse, updateCourse, publishCourse, unpublishCourse, scheduleSession, cancelCourse } from "./commands.js";
import { confirmSession, rescheduleSession, cancelSession, completeSession } from "./session-commands.js";
import { listCourses, listSessions, sessionHistory, publicCourses } from "./repository.js";

type PreHandler = (request: FastifyRequest) => Promise<void>;

function actorOf(request: FastifyRequest) {
  if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication is required", 401);
  authorizationService.require(request.actor, "courses.read");
  return request.actor;
}

function need(request: FastifyRequest, capability: Capability) {
  if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication is required", 401);
  authorizationService.require(request.actor, capability);
  return request.actor;
}

export function registerCourseRoutes(app: FastifyInstance, authenticate: PreHandler) {
  const auth = { preHandler: authenticate };
  const op = (request: FastifyRequest) => operationId(request.headers as Record<string, unknown>);

  app.get("/v1/courses", auth, async (request) => ({ data: await listCourses(actorOf(request).businessId) }));

  app.post("/v1/courses", auth, async (request) => {
    const actor = need(request, "courses.manage");
    return { data: await createCourse(actor, request.body, op(request)) };
  });

  app.patch("/v1/courses/:id", auth, async (request) => {
    const actor = need(request, "courses.manage");
    const { id } = request.params as { id: string };
    updateCourseSchema.parse(request.body);
    return { data: await updateCourse(actor, id, request.body, op(request)) };
  });

  app.post("/v1/courses/:id/publish", auth, async (request) => {
    const actor = need(request, "courses.publish");
    return { data: await publishCourse(actor, (request.params as { id: string }).id, op(request)) };
  });

  app.post("/v1/courses/:id/unpublish", auth, async (request) => {
    const actor = need(request, "courses.publish");
    return { data: await unpublishCourse(actor, (request.params as { id: string }).id, op(request)) };
  });

  app.post("/v1/courses/:id/cancel", auth, async (request) => {
    const actor = need(request, "courses.manage");
    return { data: await cancelCourse(actor, (request.params as { id: string }).id, op(request)) };
  });

  app.get("/v1/courses/:id/sessions", auth, async (request) => {
    const actor = actorOf(request);
    return { data: await listSessions(actor.businessId, (request.params as { id: string }).id) };
  });

  app.post("/v1/courses/:id/sessions", auth, async (request) => {
    const actor = need(request, "courses.sessions.manage");
    const { id } = request.params as { id: string };
    const input = scheduleCourseSessionSchema.parse(request.body);
    if (input.courseId !== id) throw new DomainError("VALIDATION_ERROR", "courseId in body must match the route", 400);
    return { data: await scheduleSession(actor, input, op(request)) };
  });

  app.get("/v1/courses/history", auth, async (request) => {
    const actor = actorOf(request);
    return { data: await sessionHistory(actor.businessId, courseSessionHistorySchema.parse(request.query)) };
  });

  app.post("/v1/course-sessions/:id/confirm", auth, async (request) => {
    const actor = need(request, "courses.sessions.manage");
    return { data: await confirmSession(actor, { sessionId: (request.params as { id: string }).id }, op(request)) };
  });

  app.post("/v1/course-sessions/:id/reschedule", auth, async (request) => {
    const actor = need(request, "courses.sessions.manage");
    const { id } = request.params as { id: string };
    const input = rescheduleCourseSessionSchema.parse(request.body);
    if (input.sessionId !== id) throw new DomainError("VALIDATION_ERROR", "sessionId in body must match the route", 400);
    return { data: await rescheduleSession(actor, input, op(request)) };
  });

  app.post("/v1/course-sessions/:id/cancel", auth, async (request) => {
    const actor = need(request, "courses.sessions.manage");
    return { data: await cancelSession(actor, { sessionId: (request.params as { id: string }).id }, op(request)) };
  });

  app.post("/v1/course-sessions/:id/complete", auth, async (request) => {
    const actor = need(request, "courses.sessions.manage");
    return { data: await completeSession(actor, { sessionId: (request.params as { id: string }).id }, op(request)) };
  });

  /** CAP-07-05 · Discovery público. Sólo PUBLICADOS; sin CTA académico. */
  app.get("/v1/public/businesses/:businessId/courses", async (request) => {
    const { businessId } = request.params as { businessId: string };
    return { data: await publicCourses(businessId) };
  });
}
