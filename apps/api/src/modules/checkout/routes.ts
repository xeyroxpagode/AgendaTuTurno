import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createCheckoutSchema, resumeCheckoutSchema } from "@youngkingz/contracts";
import { operationId } from "../system/operations.js";
import { actorOf, h05Route } from "../h05/routes.js";
import { createCheckout, resumeCheckout } from "./commands.js";
import { checkoutQuerySchema, getCheckout, listCheckouts } from "./queries.js";

const uuidParam = z.object({ id: z.string().uuid() });

export async function registerCheckoutRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/checkout", { ...h05Route, schema: { tags: ["checkout"], summary: "Listar checkouts" } }, async request =>
    listCheckouts(actorOf(request), checkoutQuerySchema.parse(request.query))
  );
  app.get("/v1/checkout/:id", { ...h05Route, schema: { tags: ["checkout"], summary: "Consultar un checkout" } }, async request =>
    getCheckout(actorOf(request), uuidParam.parse(request.params).id)
  );
  app.post("/v1/checkout", { ...h05Route, schema: { tags: ["checkout"], summary: "Ejecutar un checkout" } }, async request =>
    createCheckout(actorOf(request), createCheckoutSchema.parse(request.body), operationId(request.headers))
  );
  app.post("/v1/checkout/:id/resume", { ...h05Route, schema: { tags: ["checkout"], summary: "Reanudar un checkout con incidencia" } }, async request =>
    resumeCheckout(actorOf(request), uuidParam.parse(request.params).id, resumeCheckoutSchema.parse(request.body), operationId(request.headers))
  );
}
