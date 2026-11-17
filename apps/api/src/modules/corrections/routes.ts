import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createCorrectionSchema } from "@youngkingz/contracts";
import { operationId } from "../system/operations.js";
import { actorOf, h05Route } from "../h05/routes.js";
import { createCorrection } from "./commands.js";
import { correctionQuerySchema, getCorrection, listCorrections } from "./queries.js";

const uuidParam = z.object({ id: z.string().uuid() });

export async function registerCorrectionsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/corrections", { ...h05Route, schema: { tags: ["corrections"], summary: "Listar correcciones" } }, async request =>
    listCorrections(actorOf(request), correctionQuerySchema.parse(request.query))
  );
  app.get("/v1/corrections/:id", { ...h05Route, schema: { tags: ["corrections"], summary: "Ver una corrección" } }, async request =>
    getCorrection(actorOf(request), uuidParam.parse(request.params).id)
  );
  app.post("/v1/corrections", { ...h05Route, schema: { tags: ["corrections"], summary: "Registrar una corrección" } }, async request =>
    createCorrection(actorOf(request), createCorrectionSchema.parse(request.body), operationId(request.headers))
  );
}
