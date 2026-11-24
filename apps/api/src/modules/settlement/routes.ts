import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  DomainError, economyPeriodSchema, settlementAdjustmentSchema, settlementPaymentSchema
} from "@youngkingz/contracts";
import { operationId } from "../system/operations.js";
import { authorizationService } from "../iam/authorization.js";
import { database } from "../../lib/runtime.js";
import { createAgreementVersion, agreementVersions } from "./agreements.js";
import { requireCapability } from "../h05/domain.js";
import { calculateEstimate } from "./calculator.js";
import { closeSettlement } from "./close.js";
import { adjustSettlement, settlementHistory } from "./adjustments.js";
import { registerSettlementPayment } from "./payments.js";
import { selfEconomy } from "./self.js";

type PreHandler = (request: FastifyRequest) => Promise<void>;

function need(request: FastifyRequest, capability: Parameters<typeof authorizationService.require>[1]) {
  if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication is required", 401);
  requireCapability(request.actor, capability);
  return request.actor;
}

export function registerEconomyRoutes(app: FastifyInstance, authenticate: PreHandler) {
  const auth = { preHandler: authenticate };
  const op = (request: FastifyRequest) => operationId(request.headers as Record<string, unknown>);

  app.get("/v1/economy/agreements/:staffMemberId", auth, async (request) => {
    const actor = need(request, "economy.settlement.read");
    const { staffMemberId } = request.params as { staffMemberId: string };
    authorizationService.require(actor, "economy.settlement.read", { staffMemberId });
    return { data: await agreementVersions(actor, staffMemberId) };
  });

  app.post("/v1/economy/agreements/versions", auth, async (request) => {
    const actor = need(request, "economy.agreements.manage");
    const result = await createAgreementVersion(actor, request.body, op(request)); return { data: result.data, replayed: result.replayed };
  });

  app.get("/v1/economy/estimate", auth, async (request) => {
    const actor = need(request, "economy.estimate.read");
    const input = economyPeriodSchema.parse(request.query);
    authorizationService.require(actor, "economy.estimate.read", { staffMemberId: input.staffMemberId });
    const data = await database.client.begin((tx) => calculateEstimate(tx, actor, { staffMemberId: input.staffMemberId, from: new Date(input.from), to: new Date(input.to) }));
    return { data };
  });

  app.post("/v1/economy/settlements/close", auth, async (request) => {
    const actor = need(request, "economy.settlement.close");
    const result = await closeSettlement(actor, request.body, op(request)); return { data: result.data, replayed: result.replayed };
  });

  app.post("/v1/economy/settlements/adjust", auth, async (request) => {
    const actor = need(request, "economy.settlement.close");
    settlementAdjustmentSchema.parse(request.body);
    const result = await adjustSettlement(actor, request.body, op(request)); return { data: result.data, replayed: result.replayed };
  });

  app.post("/v1/economy/settlements/payment", auth, async (request) => {
    const actor = need(request, "economy.payment.manage");
    settlementPaymentSchema.parse(request.body);
    const result = await registerSettlementPayment(actor, request.body, op(request)); return { data: result.data, replayed: result.replayed };
  });

  app.get("/v1/economy/settlements/:staffMemberId/history", auth, async (request) => {
    const actor = need(request, "economy.settlement.read");
    const { staffMemberId } = request.params as { staffMemberId: string };
    authorizationService.require(actor, "economy.settlement.read", { staffMemberId });
    return { data: await settlementHistory(actor, staffMemberId) };
  });

  /** CL-13 · el staffMemberId es SIEMPRE el del Actor autenticado. */
  app.get("/v1/economy/me", auth, async (request) => {
    const actor = need(request, "economy.self.read");
    return { data: await selfEconomy(actor, request.query) };
  });
}

