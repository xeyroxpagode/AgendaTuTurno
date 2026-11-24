import { z } from "zod";
import { MAX_AMOUNT_MINOR } from "@youngkingz/contracts/money";

/** H08 · CAP-08-01..06. Unidades menores de ARS. Sin tasas universales. */

export const modalities = ["COMMISSION", "FIXED", "CHAIR_RENT", "MIXED"] as const;
export const modalitySchema = z.enum(modalities);
export const commissionBases = ["REALIZED", "COLLECTED"] as const;
export const commissionBaseSchema = z.enum(commissionBases);

/** Techo de CÁLCULO: permite los oráculos de gran importe sin usar float. */
export const MAX_CALC_MINOR = BigInt("1000000000000000000000000");
const ZERO = BigInt(0);
const TEN_THOUSAND = BigInt(10000);
export function assertMinorRange(value: bigint): bigint {
  if (value < ZERO || value > MAX_CALC_MINOR) throw new RangeError("Amount is outside the supported minor-unit range");
  return value;
}
/** Comisión determinista: floor(base * bps / 10000), 100% en BigInt. */
export function commissionMinor(baseMinor: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new RangeError("bps must be an integer between 0 and 10000");
  return assertMinorRange((assertMinorRange(baseMinor) * BigInt(bps)) / TEN_THOUSAND);
}
/** postgres.js devuelve bigint como string; nunca se convierte a Number. */
export function parseMinor(value: unknown): bigint {
  if (typeof value === "bigint") return assertMinorRange(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return assertMinorRange(BigInt(value));
  if (typeof value === "number" && Number.isSafeInteger(value)) return assertMinorRange(BigInt(value));
  throw new TypeError("Minor amount must be an exact integer");
}
/** Serialización segura: BigInt NO es serializable en JSON. */
export function minorToString(value: bigint): string { return assertMinorRange(value).toString(); }

const minorInput = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const createAgreementVersionSchema = z.object({
  staffMemberId: z.string().uuid(),
  modality: modalitySchema,
  commissionBase: commissionBaseSchema.optional(),
  bps: z.number().int().min(0).max(10000).optional(),
  fixedAmountMinor: minorInput.optional(),
  rentAmountMinor: minorInput.optional(),
  validFrom: z.string().datetime(),
  validTo: z.string().datetime()
}).strict().superRefine((input, ctx) => {
  if (input.validTo <= input.validFrom) ctx.addIssue({ code: "custom", path: ["validTo"], message: "validTo must be after validFrom" });
  const hasCommission = input.commissionBase !== undefined && input.bps !== undefined;
  const hasFixed = input.fixedAmountMinor !== undefined;
  const hasRent = input.rentAmountMinor !== undefined;
  if (input.modality === "COMMISSION" && !hasCommission) ctx.addIssue({ code: "custom", path: ["commissionBase"], message: "COMMISSION requires an explicit base and bps (CL-08)" });
  if (input.modality === "FIXED" && !hasFixed) ctx.addIssue({ code: "custom", path: ["fixedAmountMinor"], message: "FIXED requires an explicit amount (CL-09)" });
  if (input.modality === "CHAIR_RENT" && !hasRent) ctx.addIssue({ code: "custom", path: ["rentAmountMinor"], message: "CHAIR_RENT requires an explicit amount" });
  if (input.modality === "MIXED" && ![hasCommission, hasFixed, hasRent].filter(Boolean).length) {
    ctx.addIssue({ code: "custom", path: ["modality"], message: "MIXED requires at least one explicit component" });
  }
  if (input.commissionBase !== undefined && input.bps === undefined) ctx.addIssue({ code: "custom", path: ["bps"], message: "A commission base requires bps" });
  if (input.bps !== undefined && input.commissionBase === undefined) ctx.addIssue({ code: "custom", path: ["commissionBase"], message: "bps requires an explicit base (no implicit fallback)" });
});

export const economyPeriodSchema = z.object({
  staffMemberId: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime()
}).strict().refine((input) => input.to > input.from, { message: "to must be after from", path: ["to"] });

export const closeSettlementSchema = economyPeriodSchema.extend({
  confirmation: z.literal("CLOSE_SETTLEMENT")
});

export const settlementPaymentSchema = z.object({
  settlementId: z.string().uuid(),
  // H05: el pago consume una MoneyOperation YA CONFIRMADA; nunca inventa dinero.
  moneyOperationId: z.string().uuid(),
  // El pago se integra con H05: no puede exceder el techo real de Money.
  amountMinor: z.number().int().min(1).max(MAX_AMOUNT_MINOR),
  kind: z.enum(["PAYABLE", "RECEIVABLE"]).default("PAYABLE")
}).strict();

export const settlementAdjustmentSchema = z.object({
  settlementId: z.string().uuid(),
  amountMinor: z.number().int().min(-MAX_AMOUNT_MINOR).max(MAX_AMOUNT_MINOR).refine((value) => value !== 0, { message: "Adjustment must be non-zero" }),
  reason: z.string().trim().min(3).max(500),
  // CL-08-05: payable y receivable NO se compensan. El ajuste declara el lado.
  kind: z.enum(["PAYABLE", "RECEIVABLE"]).default("PAYABLE"),
  sourceType: z.enum(["REFUND", "CORRECTION", "MANUAL"]).optional(),
  sourceId: z.string().uuid().optional()
}).strict();

/** CL-13 · alcance propio: el servidor fuerza staffMemberId = actor. */
export const selfEconomyQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime()
}).strict().refine((input) => input.to > input.from, { message: "to must be after from" });
