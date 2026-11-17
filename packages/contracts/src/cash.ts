import { z } from "zod";
import { amountMinorSchema, MAX_AMOUNT_MINOR } from "@youngkingz/contracts/money";

/**
 * H05 · CAP-05-04 Cash — contratos compartidos.
 *
 * Reglas congeladas materializadas:
 *  · D08 — Cash refleja SÓLO efectivo físico real. Una transferencia o una
 *    tarjeta NO generan CashMovement.
 *  · D09 — el cierre conserva snapshot histórico inmutable.
 *  · D19/B-DEC-07 — la sesión pertenece a una CAJA FÍSICA IDENTIFICADA
 *    (`cashbox_id`), no a una sesión de login. Una sesión abierta por caja.
 *  · D20/B-DEC-09 — no se cierra con UNKNOWN relevante para el efectivo
 *    esperado; primero la resolución segura y auditada del intento original.
 *  · B01.6.6 — el conteo cero y el conteo obsoleto se detectan y se reportan;
 *    no se bloquean silenciosamente.
 */

export const cashSessionStatuses = ["OPEN", "CLOSED"] as const;
export const cashSessionStatusSchema = z.enum(cashSessionStatuses);
export type CashSessionStatus = z.infer<typeof cashSessionStatusSchema>;

/**
 * Tipos de movimiento de efectivo dentro de una sesión.
 *  · INCOME — efectivo que entra a la caja.
 *  · EXPENSE — efectivo que sale de la caja (gasto real de la caja).
 *  · CHANGE — vuelto entregado al cliente. Es egreso de caja LIGADO al cobro
 *    (D21): nunca es Refund ni Expense de negocio.
 *  · SALE_CASH — efectivo cobrado por una venta.
 */
export const cashMovementTypes = ["INCOME", "EXPENSE", "CHANGE", "SALE_CASH"] as const;
export const cashMovementTypeSchema = z.enum(cashMovementTypes);
export type CashMovementType = z.infer<typeof cashMovementTypeSchema>;

/** Caja física identificada. El piloto usa una caja ordinaria por Business. */
export const cashboxSchema = z.object({
  id: z.string().uuid(),
  businessId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  active: z.boolean().default(true)
}).strict();
export type Cashbox = z.infer<typeof cashboxSchema>;

/**
 * Apertura de sesión de caja.
 *
 * `cashboxId` es opcional: si se omite, el servidor resuelve (o crea una vez)
 * la caja ordinaria del Business, siempre con identidad explícita persistida.
 */
export const openCashSessionSchema = z.object({
  cashboxId: z.string().uuid().optional(),
  cashboxName: z.string().trim().min(1).max(80).optional(),
  openingAmountMinor: amountMinorSchema.default(0),
  note: z.string().trim().max(500).optional()
}).strict();
export type OpenCashSessionInput = z.infer<typeof openCashSessionSchema>;

/**
 * Movimiento de efectivo manual. Sólo afecta al efectivo esperado si la
 * sesión está OPEN. El importe es estrictamente positivo; el signo lo define
 * el tipo.
 */
export const cashMovementInputSchema = z.object({
  cashSessionId: z.string().uuid(),
  type: z.enum(["INCOME", "EXPENSE"]),
  amountMinor: z.number().int().min(1).max(MAX_AMOUNT_MINOR),
  reason: z.string().trim().min(3).max(500),
  moneyOperationId: z.string().uuid().optional()
}).strict();
export type CashMovementInput = z.infer<typeof cashMovementInputSchema>;

/**
 * Cierre de caja.
 *
 * `expectedRevision` detecta el conteo obsoleto (F23: STALE_REVISION).
 * `countedAmountMinor` admite CERO (F22: un conteo cero es válido).
 * `reason` es obligatorio cuando existe diferencia (F25): la diferencia se
 * REGISTRA, no se ajusta en silencio.
 */
export const closeCashSessionSchema = z.object({
  countedAmountMinor: amountMinorSchema,
  expectedRevision: z.number().int().min(1),
  reason: z.string().trim().min(3).max(500).optional()
}).strict().superRefine((value, context) => {
  if (value.countedAmountMinor === 0 && !value.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Un conteo de cero requiere un motivo explícito" });
  }
});
export type CloseCashSessionInput = z.infer<typeof closeCashSessionSchema>;

/**
 * Snapshot inmutable de una sesión cerrada (D09).
 * Es una fotografía del estado: no admite movimientos ni cambios posteriores.
 */
export type CashSnapshot = {
  cashSessionId: string;
  businessId: string;
  cashboxId: string;
  status: CashSessionStatus;
  openedAt: string;
  openedByAccountId: string;
  openingAmountMinor: number;
  movementTotalMinor: number;
  expectedAmountMinor: number;
  countedAmountMinor: number | null;
  differenceMinor: number | null;
  closedAt: string | null;
  closedByAccountId: string | null;
  reason: string | null;
  revision: number;
  movements: Array<{
    id: string;
    type: CashMovementType;
    amountMinor: number;
    reason: string;
    actorAccountId: string;
    moneyOperationId: string | null;
    createdAt: string;
  }>;
};

/**
 * Efectivo esperado de una sesión: fondo inicial + ingresos − egresos.
 * Sólo los movimientos de efectivo físico existen en la sesión (D08), por lo
 * que el resultado es exacto sin depender de medios externos.
 */
export function expectedCashMinor(openingAmountMinor: number, movements: readonly { type: CashMovementType; amountMinor: number }[]): number {
  return movements.reduce((total, movement) => {
    if (movement.type === "INCOME" || movement.type === "SALE_CASH") return total + movement.amountMinor;
    return total - movement.amountMinor;
  }, openingAmountMinor);
}

/** Signo del movimiento sobre el efectivo esperado. */
export function movementSign(type: CashMovementType): 1 | -1 {
  return type === "INCOME" || type === "SALE_CASH" ? 1 : -1;
}
