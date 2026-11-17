import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { moneyAllocationInputSchema, moneyOperationInputSchema, moneyReconciliationInputSchema, moneyRefundInputSchema, moneyResolutionInputSchema } from "@youngkingz/contracts";
import { operationId } from "../system/operations.js";
import { actorOf, h05Route } from "../h05/routes.js";
import { allocateMoney, createMoneyOperation, reconcileMoney, refundMoney, resolveMoneyOperation } from "./commands.js";
import { getMoneyOperation, listMoneyOperations, moneyOperationQuerySchema } from "./queries.js";

const uuidParam = z.object({ id: z.string().uuid() });

export async function registerMoneyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/money/operations", { ...h05Route, schema: { tags: ["money"], summary: "Listar operaciones de dinero" } }, async request =>
    listMoneyOperations(actorOf(request), moneyOperationQuerySchema.parse(request.query))
  );
  app.get("/v1/money/operations/:id", { ...h05Route, schema: { tags: ["money"], summary: "Consultar una operación de dinero" } }, async request =>
    getMoneyOperation(actorOf(request), uuidParam.parse(request.params).id)
  );
  app.post("/v1/money/operations", { ...h05Route, schema: { tags: ["money"], summary: "Registrar un cobro" } }, async request =>
    createMoneyOperation(actorOf(request), moneyOperationInputSchema.parse(request.body), operationId(request.headers))
  );
  app.post("/v1/money/operations/:id/allocate", { ...h05Route, schema: { tags: ["money"], summary: "Aplicar dinero confirmado a una venta u obligación" } }, async request =>
    allocateMoney(actorOf(request), uuidParam.parse(request.params).id, moneyAllocationInputSchema.parse(request.body), operationId(request.headers))
  );
  app.post("/v1/money/operations/:id/refund", { ...h05Route, schema: { tags: ["money"], summary: "Reembolsar un cobro" } }, async request =>
    refundMoney(actorOf(request), uuidParam.parse(request.params).id, moneyRefundInputSchema.parse(request.body), operationId(request.headers))
  );
  app.post("/v1/money/operations/:id/resolve", { ...h05Route, schema: { tags: ["money"], summary: "Resolver manualmente un cobro incierto" } }, async request =>
    resolveMoneyOperation(actorOf(request), uuidParam.parse(request.params).id, moneyResolutionInputSchema.parse(request.body), operationId(request.headers))
  );
  app.post("/v1/money/reconciliations", { ...h05Route, schema: { tags: ["money"], summary: "Conciliar dinero contra caja" } }, async request =>
    reconcileMoney(actorOf(request), moneyReconciliationInputSchema.parse(request.body), operationId(request.headers))
  );
}
