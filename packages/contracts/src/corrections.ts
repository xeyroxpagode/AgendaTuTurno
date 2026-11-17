import { z } from "zod";
import { saleLineInputSchema } from "@youngkingz/contracts/sales";

/**
 * H05 · CAP-05-07 Corrections — contratos compartidos.
 *
 * Reglas congeladas materializadas:
 *  · D14/D26 — una corrección es un HECHO POSTERIOR que conserva el original.
 *    Nunca se reescribe la historia para ocultar un error.
 *  · B01.9.1 — el motivo es obligatorio, trazable y vinculado al hecho
 *    original.
 *  · B01.9.2 — la corrección conserva un snapshot before/after, el operador y
 *    la fecha.
 *  · B01.9.5/6 — una corrección financiera NO genera una devolución física
 *    ficticia; una corrección física NO genera un movimiento monetario
 *    automático.
 */

export const correctionTypes = ["COMMERCIAL", "MONETARY", "CASH", "PHYSICAL"] as const;
export const correctionTypeSchema = z.enum(correctionTypes);
export type CorrectionType = z.infer<typeof correctionTypeSchema>;

/** Hecho original que la corrección referencia. */
export const correctionTargetTypes = ["SALE", "MONEY_OPERATION", "CASH_SESSION", "INVENTORY_MOVEMENT"] as const;
export const correctionTargetTypeSchema = z.enum(correctionTargetTypes);
export type CorrectionTargetType = z.infer<typeof correctionTargetTypeSchema>;

export const correctionStatuses = ["PENDING", "APPLIED", "REJECTED"] as const;
export const correctionStatusSchema = z.enum(correctionStatuses);
export type CorrectionStatus = z.infer<typeof correctionStatusSchema>;

/**
 * Corrección COMERCIAL: modifica líneas de una venta conservando el original.
 * Requiere `sales.correct`. Genera una venta corregida trazada por la
 * corrección; no borra ni reescribe la venta original.
 */
export const commercialCorrectionSchema = z.object({
  type: z.literal("COMMERCIAL"),
  targetType: z.literal("SALE"),
  targetId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
  lines: z.array(saleLineInputSchema).min(1).max(50),
  evidenceReference: z.string().trim().max(200).optional()
}).strict();

/**
 * Corrección MONETARIA: anota/rectifica los METADATOS de una MoneyOperation
 * (referencia externa, evidencia) sin generar dinero nuevo y sin mutar el
 * importe confirmado. Devolver dinero es un REFUND (hecho monetario nuevo),
 * no una corrección.
 */
export const monetaryCorrectionSchema = z.object({
  type: z.literal("MONETARY"),
  targetType: z.literal("MONEY_OPERATION"),
  targetId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
  evidenceReference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional()
}).strict();

/**
 * Corrección de CAJA: ajuste real de efectivo dentro de una sesión abierta,
 * con motivo, vinculado a la sesión y al hecho original.
 * Es un movimiento de efectivo EXPLÍCITO: no se genera en silencio.
 */
export const cashCorrectionSchema = z.object({
  type: z.literal("CASH"),
  targetType: z.literal("CASH_SESSION"),
  targetId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
  amountMinor: z.number().int().min(1).max(1_000_000_000),
  direction: z.enum(["INCOME", "EXPENSE"]),
  evidenceReference: z.string().trim().max(200).optional()
}).strict();

/**
 * Corrección FÍSICA H04: delega en `inventory.correctMovement`
 * (movimiento inverso, `inventory.adjust`). NO corrige entregas DELIVERY y
 * NO genera movimiento monetario.
 */
export const physicalCorrectionSchema = z.object({
  type: z.literal("PHYSICAL"),
  targetType: z.literal("INVENTORY_MOVEMENT"),
  targetId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
  evidenceReference: z.string().trim().max(200).optional()
}).strict();

export const createCorrectionSchema = z.discriminatedUnion("type", [
  commercialCorrectionSchema,
  monetaryCorrectionSchema,
  cashCorrectionSchema,
  physicalCorrectionSchema
]);
export type CreateCorrectionInput = z.infer<typeof createCorrectionSchema>;

/**
 * Snapshot before/after de una corrección.
 * `before` es el estado del hecho original al momento de corregir;
 * `after` es el estado resultante. La historia se conserva íntegra.
 */
export type CorrectionSnapshot = {
  id: string;
  businessId: string;
  type: CorrectionType;
  targetType: CorrectionTargetType;
  targetId: string;
  status: CorrectionStatus;
  reason: string;
  evidenceReference: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  actorAccountId: string;
  operationId: string;
  createdAt: string;
};
