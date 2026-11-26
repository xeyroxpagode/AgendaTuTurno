/**
 * H09 · Seis endpoints GET, idempotentes y read-only. `businessId` se resuelve
 * en servidor desde la identidad verificada; ningún parámetro de la URL puede
 * cambiar la autoridad. Las negativas de capability/rol son 403 y no revelan
 * existencia de otros negocios.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { DomainError } from "@youngkingz/contracts";
import { commercial, history, indicator, interventions, operational, ownerSummary } from "./blocks.js";

type PreHandler = (request: FastifyRequest) => Promise<void>;

function actorOf(request: FastifyRequest) {
  if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
  return request.actor;
}

export async function registerReportingRoutes(app: FastifyInstance, authenticate: PreHandler): Promise<void> {
  const auth = {
    preHandler: authenticate,
    onRequest: async (_request: FastifyRequest, reply: { header: (key: string, value: string) => unknown }) => {
      reply.header("cache-control", "no-store");
    }
  };

  app.get("/v1/reporting/owner-summary", { ...auth, schema: { tags: ["reporting"], summary: "Resumen del Dueño (tres bloques)" } },
    async (request) => ownerSummary(actorOf(request), request.query));

  app.get("/v1/reporting/commercial", { ...auth, schema: { tags: ["reporting"], summary: "Proyección comercial M01–M06/M11/M12/M16" } },
    async (request) => commercial(actorOf(request), request.query));

  app.get("/v1/reporting/operational", { ...auth, schema: { tags: ["reporting"], summary: "Proyección operativa M07–M10/M13–M15" } },
    async (request) => operational(actorOf(request), request.query));

  app.get("/v1/reporting/interventions", { ...auth, schema: { tags: ["reporting"], summary: "Causas vigentes derivadas, sin persistencia" } },
    async (request) => interventions(actorOf(request), request.query));

  app.get("/v1/reporting/history", { ...auth, schema: { tags: ["reporting"], summary: "Historial transversal paginado" } },
    async (request) => history(actorOf(request), request.query));

  app.get("/v1/reporting/indicators/:id", { ...auth, schema: { tags: ["reporting"], summary: "Definición reproducible de un indicador" } },
    async (request) => indicator((request.params as { id: string }).id));
}
