/**
 * H03.U06 · CAP-03-07 · Ausencias y conflictos — API.
 *
 * Todas las rutas exigen identidad STAFF y la capability correspondiente en
 * `preHandler` (defensa en profundidad: la capability se comprueba ANTES de
 * la lógica de negocio).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DomainError, absenceApproveSchema, absenceApplySchema, absenceConflictSyncSchema,
  absenceQuerySchema, absenceRejectSchema, absenceRequestSchema, absenceWithdrawSchema
} from "@youngkingz/contracts";
import { authorizationService, type Actor } from "../iam/authorization.js";
import { operationId as opIdFromHeader } from "../system/operations.js";
import { applyAbsence, approveAbsence, rejectAbsence, requestAbsence, syncAbsenceConflicts, withdrawAbsence } from "./commands.js";
import { getAbsenceDetail, listAbsenceConflicts, listAbsences } from "./queries.js";

const uuidParam = z.object({ id: z.string().uuid() });

async function authenticate(request: FastifyRequest) { request.actor = await authorizationService.authenticate(request); }
function actor(request: FastifyRequest): Actor { if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401); return request.actor; }
function requireCapability(request: FastifyRequest, capability: Parameters<typeof authorizationService.require>[1]) { const value = actor(request); authorizationService.require(value, capability); return value; }

export async function registerAbsenceRoutes(app: FastifyInstance) {
  /* Listar ausencias del ámbito del actor. */
  app.get("/v1/absences", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "absence.read");
    const query = absenceQuerySchema.parse(request.query);
    return { items: await listAbsences(a, query) };
  });

  /* Detalle de una ausencia + su historial append-only. */
  app.get("/v1/absences/:id", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "absence.read");
    const { id } = uuidParam.parse(request.params);
    return getAbsenceDetail(a, id);
  });

  /* Compromisos afectados + estado de sus conflictos. */
  app.get("/v1/absences/:id/conflicts", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "absence.read");
    const { id } = uuidParam.parse(request.params);
    return { items: await listAbsenceConflicts(a, id) };
  });

  /* Re-sincronizar conflictos tras resolver compromisos con Booking. */
  app.post("/v1/absences/:id/conflicts/sync", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "absence.apply");
    const { id } = uuidParam.parse(request.params);
    absenceConflictSyncSchema.parse(request.body ?? {});
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return syncAbsenceConflicts({ actor: a, absenceId: id, operationId });
  });

  /* Solicitar ausencia (crea PENDING; no bloquea disponibilidad). */
  app.post("/v1/absences", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "absence.request");
    const body = absenceRequestSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return requestAbsence({
      actor: a,
      staffMemberId: body.staffMemberId,
      localDate: body.localDate,
      startMinute: body.startMinute,
      endMinute: body.endMinute,
      reason: body.reason,
      operationId
    });
  });

  /* Aprobar (PENDING -> APPROVED). */
  app.post("/v1/absences/:id/approve", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "absence.approve");
    const { id } = uuidParam.parse(request.params);
    const body = absenceApproveSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return approveAbsence({ actor: a, absenceId: id, expectedRevision: body.expectedRevision, operationId });
  });

  /* Rechazar (PENDING|APPROVED -> REJECTED). */
  app.post("/v1/absences/:id/reject", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "absence.reject");
    const { id } = uuidParam.parse(request.params);
    const body = absenceRejectSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return rejectAbsence({ actor: a, absenceId: id, expectedRevision: body.expectedRevision, reason: body.reason, operationId });
  });

  /* Retirar (PENDING|APPROVED -> WITHDRAWN). */
  app.post("/v1/absences/:id/withdraw", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "absence.withdraw");
    const { id } = uuidParam.parse(request.params);
    const body = absenceWithdrawSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return withdrawAbsence({ actor: a, absenceId: id, expectedRevision: body.expectedRevision, reason: body.reason, operationId });
  });

  /* Aplicar (APPROVED -> APPLIED): exige conflictos resueltos. */
  app.post("/v1/absences/:id/apply", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "absence.apply");
    const { id } = uuidParam.parse(request.params);
    const body = absenceApplySchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return applyAbsence({
      actor: a,
      absenceId: id,
      expectedRevision: body.expectedRevision,
      resolutionReferences: body.resolutionReferences,
      operationId
    });
  });
}
