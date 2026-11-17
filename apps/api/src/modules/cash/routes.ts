import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { cashMovementInputSchema, closeCashSessionSchema, openCashSessionSchema } from "@youngkingz/contracts";
import { operationId } from "../system/operations.js";
import { actorOf, h05Route } from "../h05/routes.js";
import { closeCashSession, createCashMovement, openCashSession } from "./commands.js";
import { cashSessionQuerySchema, getCashSnapshot, listCashSessions } from "./queries.js";

const uuidParam = z.object({ id: z.string().uuid() });

export async function registerCashRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/cash/sessions", { ...h05Route, schema: { tags: ["cash"], summary: "Listar sesiones de caja" } }, async request =>
    listCashSessions(actorOf(request), cashSessionQuerySchema.parse(request.query))
  );
  app.get("/v1/cash/sessions/:id/snapshot", { ...h05Route, schema: { tags: ["cash"], summary: "Snapshot de una sesión de caja" } }, async request =>
    getCashSnapshot(actorOf(request), uuidParam.parse(request.params).id)
  );
  app.post("/v1/cash/sessions", { ...h05Route, schema: { tags: ["cash"], summary: "Abrir una sesión de caja" } }, async request =>
    openCashSession(actorOf(request), openCashSessionSchema.parse(request.body), operationId(request.headers))
  );
  app.patch("/v1/cash/sessions/:id/close", { ...h05Route, schema: { tags: ["cash"], summary: "Cerrar una sesión de caja" } }, async request =>
    closeCashSession(actorOf(request), uuidParam.parse(request.params).id, closeCashSessionSchema.parse(request.body), operationId(request.headers))
  );
  app.post("/v1/cash/movements", { ...h05Route, schema: { tags: ["cash"], summary: "Registrar un movimiento de efectivo" } }, async request =>
    createCashMovement(actorOf(request), cashMovementInputSchema.parse(request.body), operationId(request.headers))
  );
}
