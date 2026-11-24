/**
 * H06 · API HTTP. Los 18 endpoints de C01 §9.1 se conservan. El body NUNCA
 * incluye `sourceReference`, `reuseCommitments` ni autoridad de entrega:
 * `sourceReference` se deriva en servidor (T-05/CORR-04).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError, orderRequestInput } from "@youngkingz/contracts";
import { operationId } from "../system/operations.js";
import { authenticateH05, actorOf } from "../h05/routes.js";
import { resolveProviderIdentity } from "../client-auth/provider.js";
import { resolveClientPrincipal } from "../client-auth/service.js";
import {
  orderRequest, orderConfirm, orderReject, orderCancel, orderPrepare,
  orderReady, orderDeliver, resolveD22Exception, reissueCredential
} from "./commands.js";
import {
  publicCatalog, publicProduct, staffOrders, staffOrderDetail,
  guestOrderTracking, clientOrders, orderOperationState
} from "./queries.js";
import type { OrderPrincipal } from "./domain.js";

const idParam = z.object({ id: z.string().uuid() });
const businessParam = z.object({ businessId: z.string().uuid() });
const productParam = z.object({ sku: z.string().trim().min(1).max(64) });
const operationParam = z.object({ operationId: z.string().uuid() });
const guestQuery = z.object({ businessId: z.string().uuid() });
const catalogQuery = z.object({
  sku: z.string().max(64).optional(), cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30)
}).strict();

const staffRoute = { preHandler: authenticateH05 };

function credentialOf(request: FastifyRequest): string {
  const value = request.headers["x-order-credential"];
  if (typeof value !== "string" || value.length < 20) {
    throw new DomainError("ORDER_CREDENTIAL_INVALID", "Credencial de pedido requerida", 404);
  }
  return value;
}

/** CLIENT autenticado por el proveedor H03; sin inferencia por teléfono. */
async function clientPrincipal(request: FastifyRequest): Promise<{ accountId: string; businessId: string }> {
  const principal = await resolveClientPrincipal(await resolveProviderIdentity(request));
  const businessId = guestQuery.parse(request.query).businessId;
  return { accountId: principal.accountId, businessId };
}

export async function registerOrdersRoutes(app: FastifyInstance): Promise<void> {
  // ── Catálogo público (CAP-06-01): sin stock, ubicación ni compromiso ──
  app.get("/v1/public/businesses/:businessId/products", { schema: { tags: ["orders"], summary: "Catálogo público de productos" } },
    async (request) => {
      const { businessId } = businessParam.parse(request.params);
      return { data: await publicCatalog(businessId, catalogQuery.parse(request.query)) };
    });
  app.get("/v1/public/businesses/:businessId/products/:sku", { schema: { tags: ["orders"], summary: "Detalle público de producto" } },
    async (request) => {
      const { businessId } = businessParam.parse(request.params);
      const { sku } = productParam.parse(request.params);
      return { data: await publicProduct(businessId, sku.toUpperCase()) };
    });

  // ── Solicitudes privadas / asistidas (CAP-06-02) ──
  app.post("/v1/public/orders", { schema: { tags: ["orders"], summary: "Solicitud de pedido como invitado" } },
    async (request) => {
      const input = orderRequestInput.parse(request.body);
      const principal: OrderPrincipal = { kind: "GUEST", businessId: input.businessId, orderId: "", credentialToken: "" };
      const result = await orderRequest(principal, request.body, operationId(request.headers));
      return { data: result.data, replayed: result.replayed };
    });
  app.post("/v1/orders", { ...staffRoute, schema: { tags: ["orders"], summary: "Solicitud asistida por Staff" } },
    async (request) => {
      const actor = actorOf(request);
      const principal: OrderPrincipal = { kind: "STAFF", actor };
      const result = await orderRequest(principal, request.body, operationId(request.headers));
      return { data: result.data, replayed: result.replayed };
    });

  // ── Lecturas con scope ──
  app.get("/v1/orders", { ...staffRoute, schema: { tags: ["orders"], summary: "Bandeja de pedidos" } },
    async (request) => ({ data: await staffOrders(actorOf(request), request.query) }));
  app.get("/v1/orders/:id", { ...staffRoute, schema: { tags: ["orders"], summary: "Detalle de pedido" } },
    async (request) => ({ data: await staffOrderDetail(actorOf(request), idParam.parse(request.params).id) }));
  app.get("/v1/public/orders/:id", { schema: { tags: ["orders"], summary: "Seguimiento invitado por credencial" } },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { businessId } = guestQuery.parse(request.query);
      return { data: await guestOrderTracking(credentialOf(request), businessId, id) };
    });
  app.get("/v1/client/orders", { schema: { tags: ["orders"], summary: "Pedidos vinculados del cliente" } },
    async (request) => {
      const { accountId, businessId } = await clientPrincipal(request);
      return { data: await clientOrders(accountId, businessId, request.query) };
    });

  // ── Comandos Staff (CAP-06-03..06) ──
  app.post("/v1/orders/:id/confirm", { ...staffRoute, schema: { tags: ["orders"], summary: "Confirmar pedido (all-or-none)" } },
    async (request) => orderConfirm(actorOf(request), idParam.parse(request.params).id, request.body, operationId(request.headers)));
  app.post("/v1/orders/:id/reject", { ...staffRoute, schema: { tags: ["orders"], summary: "Rechazar pedido" } },
    async (request) => orderReject(actorOf(request), idParam.parse(request.params).id, request.body, operationId(request.headers)));
  app.post("/v1/orders/:id/prepare", { ...staffRoute, schema: { tags: ["orders"], summary: "Iniciar preparación" } },
    async (request) => orderPrepare(actorOf(request), idParam.parse(request.params).id, request.body, operationId(request.headers)));
  app.post("/v1/orders/:id/ready", { ...staffRoute, schema: { tags: ["orders"], summary: "Marcar listo para retiro" } },
    async (request) => orderReady(actorOf(request), idParam.parse(request.params).id, request.body, operationId(request.headers)));
  app.post("/v1/orders/:id/deliver", { ...staffRoute, schema: { tags: ["orders"], summary: "Retiro presencial con hechos reales" } },
    async (request) => orderDeliver(actorOf(request), idParam.parse(request.params).id, request.body, operationId(request.headers)));
  app.post("/v1/orders/:id/exception", { ...staffRoute, schema: { tags: ["orders"], summary: "Excepción D22/Q42 autorizada" } },
    async (request) => resolveD22Exception(actorOf(request), idParam.parse(request.params).id, request.body, operationId(request.headers)));
  app.post("/v1/orders/:id/credential/reissue", { ...staffRoute, schema: { tags: ["orders"], summary: "Reemitir credencial invitado" } },
    async (request) => reissueCredential(actorOf(request), idParam.parse(request.params).id, request.body, operationId(request.headers)));

  // Cancelación: Staff, Cliente vinculado o Invitado por credencial de recurso.
  app.post("/v1/orders/:id/cancel", { schema: { tags: ["orders"], summary: "Cancelar pedido por fase" } },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const credential = request.headers["x-order-credential"];
      // `businessId` sólo es obligatorio para invitado/cliente. Staff resuelve
      // su negocio desde el token (G01: la UI Staff no envía query string).
      const query = z.object({ businessId: z.string().uuid().optional() }).parse(request.query);
      let principal: OrderPrincipal;
      if (typeof credential === "string") {
        if (!query.businessId) throw new DomainError("ORDER_CREDENTIAL_INVALID", "Credencial de pedido requerida", 404);
        principal = { kind: "GUEST", businessId: query.businessId, orderId: id, credentialToken: credential };
      } else if (request.headers.authorization && query.businessId) {
        const { accountId, businessId } = await clientPrincipal(request);
        principal = { kind: "CLIENT", businessId, accountId, clientProfileId: "" };
      } else {
        await authenticateH05(request);
        principal = { kind: "STAFF", actor: actorOf(request) };
      }
      return await orderCancel(principal, id, request.body, operationId(request.headers));
    });

  // ── Recuperación: reutiliza /v1/operations/:id, sin ledger propio ──
  app.get("/v1/public/orders/:id/operations/:operationId", { schema: { tags: ["orders"], summary: "Estado durable invitado" } },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { operationId: opId } = operationParam.parse(request.params);
      const { businessId } = guestQuery.parse(request.query);
      return { data: await orderOperationState(opId, undefined, credentialOf(request), businessId, id) };
    });
}
