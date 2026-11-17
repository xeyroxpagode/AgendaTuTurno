import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createObligationSchema, payObligationSchema, settleObligationSchema, updateObligationSchema } from "@youngkingz/contracts";
import { operationId } from "../system/operations.js";
import { actorOf, h05Route } from "../h05/routes.js";
import { createObligation, payObligation, settleObligation, updateObligation } from "./commands.js";
import { getObligation, listObligations, obligationQuerySchema } from "./queries.js";

const uuidParam = z.object({ id: z.string().uuid() });

export async function registerObligationsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/obligations", { ...h05Route, schema: { tags: ["obligations"], summary: "Listar obligaciones" } }, async request =>
    listObligations(actorOf(request), obligationQuerySchema.parse(request.query))
  );
  app.get("/v1/obligations/:id", { ...h05Route, schema: { tags: ["obligations"], summary: "Ver una obligación" } }, async request =>
    getObligation(actorOf(request), uuidParam.parse(request.params).id)
  );
  app.post("/v1/obligations", { ...h05Route, schema: { tags: ["obligations"], summary: "Registrar una obligación" } }, async request =>
    createObligation(actorOf(request), createObligationSchema.parse(request.body), operationId(request.headers))
  );
  app.patch("/v1/obligations/:id", { ...h05Route, schema: { tags: ["obligations"], summary: "Actualizar una obligación" } }, async request =>
    updateObligation(actorOf(request), uuidParam.parse(request.params).id, updateObligationSchema.parse(request.body), operationId(request.headers))
  );
  app.post("/v1/obligations/:id/pay", { ...h05Route, schema: { tags: ["obligations"], summary: "Pagar una obligación" } }, async request =>
    payObligation(actorOf(request), uuidParam.parse(request.params).id, payObligationSchema.parse(request.body), operationId(request.headers))
  );
  app.post("/v1/obligations/:id/settle", { ...h05Route, schema: { tags: ["obligations"], summary: "Liquidar una obligación" } }, async request =>
    settleObligation(actorOf(request), uuidParam.parse(request.params).id, settleObligationSchema.parse(request.body), operationId(request.headers))
  );
}
