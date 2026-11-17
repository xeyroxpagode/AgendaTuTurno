import { z } from "zod";
import { positiveAmountMinorSchema } from "@youngkingz/contracts/money";

/**
 * H05 · CAP-05-05 Obligations — contratos compartidos.
 *
 * Reglas congeladas materializadas:
 *  · D22 — una obligación de cuantía DESCONOCIDA no se considera cero ni
 *    saldada. `amountMinor` es NULL y el estado del importe es
 *    UNKNOWN_AMOUNT, nunca 0.
 *  · B01.7.10 — la recepción física H04 de un bien o servicio NO prueba pago
 *    ni obliga a inventar deuda saldada.
 *  · B01.7.7/8 — pagos parciales permitidos con saldo remanente; el
 *    settlement se vincula a una MoneyOperation existente.
 *  · B01.7.11 — todo cambio lleva motivo y operador.
 */

export const obligationKinds = ["PAYABLE", "RECEIVABLE"] as const;
export const obligationKindSchema = z.enum(obligationKinds);
export type ObligationKind = z.infer<typeof obligationKindSchema>;

/**
 * Estado del IMPORTE. `UNKNOWN_AMOUNT` es un estado devernight: el importe
 * no se conoce, y eso NO es cero (F28).
 */
export const obligationAmountStates = ["KNOWN", "UNKNOWN_AMOUNT"] as const;
export const obligationAmountStateSchema = z.enum(obligationAmountStates);
export type ObligationAmountState = z.infer<typeof obligationAmountStateSchema>;

export const obligationStatuses = ["OPEN", "PARTIAL", "SETTLED", "CANCELLED"] as const;
export const obligationStatusSchema = z.enum(obligationStatuses);
export type ObligationStatus = z.infer<typeof obligationStatusSchema>;

/**
 * Alta de obligación.
 *
 * `amountMinor` ausente ⇒ `UNKNOWN_AMOUNT` (importe desconocido). Si se
 * informa, debe ser positivo. `counterpartyName` es obligatorio: las
 * contrapartes se identifican (B01.7.3).
 */
export const createObligationSchema = z.object({
  kind: obligationKindSchema,
  title: z.string().trim().min(1).max(160),
  counterpartyName: z.string().trim().min(1).max(160),
  amountMinor: positiveAmountMinorSchema.optional(),
  currency: z.literal("ARS").default("ARS"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().trim().max(500).optional()
}).strict();
export type CreateObligationInput = z.infer<typeof createObligationSchema>;

/**
 * Cambio cuantitativo autorizado y trazable. El motivo es obligatorio.
 * Pasar a un importe conocido sobre una obligación abierta es un hecho
 * posterior: el historial se conserva.
 */
export const updateObligationSchema = z.object({
  expectedRevision: z.number().int().min(1),
  title: z.string().trim().min(1).max(160).optional(),
  counterpartyName: z.string().trim().min(1).max(160).optional(),
  amountMinor: positiveAmountMinorSchema.optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type UpdateObligationInput = z.infer<typeof updateObligationSchema>;

/**
 * Pago (total o parcial) de una obligación.
 *
 * `moneyOperationId` referencia una MoneyOperation EXISTENTE: el pago no
 * inventa dinero, consume dinero ya confirmado (B01.7.8). `amountMinor` es
 * el importe cubierto por esa operación.
 */
export const payObligationSchema = z.object({
  moneyOperationId: z.string().uuid(),
  amountMinor: positiveAmountMinorSchema,
}).strict();
export type PayObligationInput = z.infer<typeof payObligationSchema>;

/**
 * Settlement (liquidación) de la obligación, vinculado a dinero real.
 * Requiere una MoneyOperation existente y cubre el saldo remanente.
 */
export const settleObligationSchema = z.object({
  moneyOperationId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type SettleObligationInput = z.infer<typeof settleObligationSchema>;

/**
 * Saldo de una obligación.
 *  · `amountMinor === null` ⇒ saldo DESCONOCIDO (no cero).
 *  · `settledMinor` es la suma de pagos vinculados a dinero confirmado.
 */
export function deriveObligationBalance(amountMinor: number | null, settledMinor: number): {
  status: ObligationStatus;
  balanceMinor: number | null;
} {
  if (amountMinor === null) {
    return { status: settledMinor > 0 ? "PARTIAL" : "OPEN", balanceMinor: null };
  }
  if (settledMinor <= 0) return { status: "OPEN", balanceMinor: amountMinor };
  if (settledMinor >= amountMinor) return { status: "SETTLED", balanceMinor: 0 };
  return { status: "PARTIAL", balanceMinor: amountMinor - settledMinor };
}
