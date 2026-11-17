import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { cancelSaleSchema, confirmSaleSchema, correctSaleSchema } from "@youngkingz/contracts";
import { operationId } from "../system/operations.js";
import { actorOf, h05Route } from "../h05/routes.js";
import { cancelSale, confirmSale, correctSale, createSale } from "./commands.js";
import { getSale, listSales, saleQuerySchema } from "./queries.js";

const uuidParam = z.object({ id: z.string().uuid() });

export async function registerSalesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/sales", { ...h05Route, schema: { tags: ["sales"], summary: "Listar ventas del negocio" } }, async request =>
    listSales(actorOf(request), saleQuerySchema.parse(request.query))
  );
  app.get("/v1/sales/:id", { ...h05Route, schema: { tags: ["sales"], summary: "Ver una venta" } }, async request =>
    getSale(actorOf(request), uuidParam.parse(request.params).id)
  );
  app.post("/v1/sales", { ...h05Route, schema: { tags: ["sales"], summary: "Crear una venta" } }, async request =>
    createSale(actorOf(request), request.body, operationId(request.headers))
  );
  app.post("/v1/sales/:id/confirm", { ...h05Route, schema: { tags: ["sales"], summary: "Confirmar una venta" } }, async request =>
    confirmSale(actorOf(request), uuidParam.parse(request.params).id, confirmSaleSchema.parse(request.body), operationId(request.headers))
  );
  app.post("/v1/sales/:id/cancel", { ...h05Route, schema: { tags: ["sales"], summary: "Anular una venta" } }, async request =>
    cancelSale(actorOf(request), uuidParam.parse(request.params).id, cancelSaleSchema.parse(request.body), operationId(request.headers))
  );
  app.post("/v1/sales/:id/correct", { ...h05Route, schema: { tags: ["sales"], summary: "Corregir una venta" } }, async request =>
    correctSale(actorOf(request), uuidParam.parse(request.params).id, correctSaleSchema.parse(request.body), operationId(request.headers))
  );
}
