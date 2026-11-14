/**
 * H03.U06 · CAP-03-08 · Prestación real (Attendance) — API.
 *
 * Cada ruta exige identidad STAFF y su capability en `preHandler`
 * (defensa en profundidad). El alcance profesional se resuelve en servidor.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DomainError, attendanceCorrectionSchema, attendanceQuerySchema,
  attendanceRegisterSchema, attendanceStateSchema
} from "@youngkingz/contracts";
import { authorizationService, type Actor } from "../iam/authorization.js";
import { operationId as opIdFromHeader } from "../system/operations.js";
import { correctAttendance, registerAttendance, setAttendanceState } from "./commands.js";
import { getAttendanceDetail, listAttendances } from "./queries.js";

const uuidParam = z.object({ id: z.string().uuid() });

async function authenticate(request: FastifyRequest) { request.actor = await authorizationService.authenticate(request); }
function actor(request: FastifyRequest): Actor { if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401); return request.actor; }
function requireCapability(request: FastifyRequest, capability: Parameters<typeof authorizationService.require>[1]) { const value = actor(request); authorizationService.require(value, capability); return value; }

export async function registerAttendanceRoutes(app: FastifyInstance) {
  /* Historial de atenciones con filtros. */
  app.get("/v1/attendance", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "attendance.read");
    const query = attendanceQuerySchema.parse(request.query);
    return { items: await listAttendances(a, query) };
  });

  /* Detalle: servicios realizados vs. reservados + correcciones + historial. */
  app.get("/v1/attendance/:id", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "attendance.read");
    const { id } = uuidParam.parse(request.params);
    return getAttendanceDetail(a, id);
  });

  /* Registrar atención (desde reserva o walk-in). */
  app.post("/v1/attendance", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "attendance.register");
    const body = attendanceRegisterSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return registerAttendance({
      actor: a,
      reservationId: body.reservationId ?? null,
      staffMemberId: body.staffMemberId ?? null,
      attendedByStaffMemberId: body.attendedByStaffMemberId ?? null,
      clientProfileId: body.clientProfileId ?? null,
      walkIn: body.walkIn,
      contactSnapshot: body.contactSnapshot ?? null,
      servicesPerformedSnapshot: body.servicesPerformedSnapshot ?? null,
      startedAt: body.startedAt ?? null,
      status: body.status ?? null,
      notes: body.notes ?? null,
      operationId
    });
  });

  /* Establecer el estado terminal (COMPLETED / PARTIAL / INTERRUPTED). */
  app.post("/v1/attendance/:id/state", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "attendance.register");
    const { id } = uuidParam.parse(request.params);
    const body = attendanceStateSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return setAttendanceState({
      actor: a,
      attendanceId: id,
      status: body.status,
      servicesPerformedSnapshot: body.servicesPerformedSnapshot,
      finishedAt: body.finishedAt ?? null,
      notes: body.notes ?? null,
      expectedRevision: body.expectedRevision,
      operationId
    });
  });

  /* Corrección autorizada con trazabilidad (motivo obligatorio). */
  app.patch("/v1/attendance/:id/correct", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "attendance.correct");
    const { id } = uuidParam.parse(request.params);
    const body = attendanceCorrectionSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return correctAttendance({
      actor: a,
      attendanceId: id,
      status: body.status ?? null,
      attendedByStaffMemberId: body.attendedByStaffMemberId ?? null,
      contactSnapshot: body.contactSnapshot ?? null,
      servicesPerformedSnapshot: body.servicesPerformedSnapshot ?? null,
      notes: body.notes ?? null,
      reason: body.reason,
      expectedRevision: body.expectedRevision,
      operationId
    });
  });
}
