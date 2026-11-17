import { z } from "zod";

/**
 * H05 · CAP-05-02 Money + CAP-05-03 Recovery — contratos compartidos.
 *
 * Reglas congeladas que estos esquemas materializan:
 *  · D11/D27/B-DEC-08 — importes EXACTOS en unidades menores enteras (ARS).
 *    Prohibidos los floats binarios. Todo el cálculo es entero.
 *  · D05 — cobro mixto por componentes CONFIRMADOS (nunca por componentes
 *    declarados: una transferencia sin acreditar o una tarjeta sin resultado
 *    confirmable NO son dinero confirmado).
 *  · D06/B-DEC-03 — transferencia y tarjeta externa requieren evidencia.
 *  · D21 — el vuelto está ligado al cobro: no es Refund ni Expense.
 *  · D20/B-DEC-09 — UNKNOWN permanece recuperable; no se resuelve a FAILED.
 *  · D23/B-DEC-04 — pagador, receptor físico y titular económico se registran
 *    por separado; el titular no se infiere del cajero.
 */

/** Techo de importes: 1.000.000.000 de unidades menores (1.000.000 ARS). */
export const MAX_AMOUNT_MINOR = 1_000_000_000;

/** Divisor de presentación. El cálculo NUNCA usa punto flotante. */
export const MINOR_UNITS_PER_MAJOR = 100;

export const currencySchema = z.literal("ARS");
export type Currency = z.infer<typeof currencySchema>;

/** Importe en unidades menores enteras. Nunca negativo, nunca decimal. */
export const amountMinorSchema = z.number().int().min(0).max(MAX_AMOUNT_MINOR);

/** Importe estrictamente positivo (operaciones de dinero reales). */
export const positiveAmountMinorSchema = z.number().int().min(1).max(MAX_AMOUNT_MINOR);

/** Medios de pago soportados en H05 V1. Sin pagos online, sin Mercado Pago. */
export const paymentMethods = ["CASH", "TRANSFER", "CARD"] as const;
export const paymentMethodSchema = z.enum(paymentMethods);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/**
 * Resultado de un componente de cobro.
 *  · CONFIRMED — dinero real confirmado. Es el único estado que suma dinero.
 *  · PENDING — declarado pero sin acreditación (transferencia sin comprobante).
 *  · UNKNOWN — resultado externo no confirmable. Nunca se resuelve a FAILED
 *    por timeout (F13, D20).
 */
export const moneyComponentOutcomes = ["CONFIRMED", "PENDING", "UNKNOWN"] as const;
export const moneyComponentOutcomeSchema = z.enum(moneyComponentOutcomes);
export type MoneyComponentOutcome = z.infer<typeof moneyComponentOutcomeSchema>;

/**
 * Componente en efectivo.
 *
 * `tenderedMinor` es lo que el cliente entregó; `changeMinor` es lo que se
 * devolvió. El efectivo neto que entra a la caja es
 * `tenderedMinor - changeMinor`, y ese valor debe ser EXACTAMENTE
 * `amountMinor` (el dinero acreditado por este componente). El vuelto nunca
 * es negativo y nunca excede lo entregado (F09, D21).
 */
export const cashComponentSchema = z.object({
  method: z.literal("CASH"),
  amountMinor: positiveAmountMinorSchema,
  tenderedMinor: amountMinorSchema.optional(),
  changeMinor: amountMinorSchema.default(0),
  /**
   * Resultado real del efectivo. `UNKNOWN` significa que el operador no
   * puede confirmar el efectivo recibido: el efectivo esperado de la caja
   * deja de ser confiable y el cierre queda bloqueado (B-DEC-09 / F26).
   */
  outcome: z.enum(["CONFIRMED", "PENDING", "UNKNOWN"]).default("CONFIRMED"),
}).strict().superRefine((value, context) => {
  const tendered = value.tenderedMinor ?? value.amountMinor;
  if (tendered < value.changeMinor) {
    context.addIssue({ code: "custom", path: ["changeMinor"], message: "El vuelto no puede exceder lo entregado" });
  }
  if (tendered - value.changeMinor !== value.amountMinor) {
    context.addIssue({ code: "custom", path: ["amountMinor"], message: "El efectivo neto debe coincidir exactamente con el importe acreditado" });
  }
});

/**
 * Componente por transferencia bancaria.
 *
 * `accredited` distingue la transferencia acreditada (F10) de la no
 * acreditada (F11). Una transferencia no acreditada NO es dinero confirmado:
 * queda PENDING y puede acreditarse después por el mismo `operation_id`,
 * sin crear una segunda MoneyOperation (D10/D18, B-DEC-06).
 */
export const transferComponentSchema = z.object({
  method: z.literal("TRANSFER"),
  amountMinor: positiveAmountMinorSchema,
  accredited: z.boolean().default(false),
  reference: z.string().trim().max(200).optional(),
  evidenceReference: z.string().trim().max(200).optional(),
}).strict().superRefine((value, context) => {
  // B-DEC-03: una declaración del cliente NO es acreditación bancaria. La V1
  // permite confirmación manual autorizada, pero exige referencia operativa
  // AND evidencia de la acreditación. Sin ambos, el componente NO es dinero.
  if (value.accredited && !value.reference) {
    context.addIssue({ code: "custom", path: ["reference"], message: "Una transferencia acreditada exige referencia comprobable" });
  }
  if (value.accredited && (!value.evidenceReference || value.evidenceReference.trim().length < 3)) {
    context.addIssue({ code: "custom", path: ["evidenceReference"], message: "Una transferencia acreditada exige evidencia de la acreditación" });
  }
});

/**
 * Componente por tarjeta en terminal externa.
 *
 * `outcome` refleja el resultado REAL de la terminal (D17/B-DEC-03):
 *  · CONFIRMED — la terminal confirmó el cobro (F12).
 *  · UNKNOWN — el resultado no es comprobable (F13). No se registra PAN/CVV.
 */
export const cardComponentSchema = z.object({
  method: z.literal("CARD"),
  amountMinor: positiveAmountMinorSchema,
  /**
   * Por defecto NO se confirma: la ausencia de un resultado verificable de la
   * terminal jamás puede traducirse en dinero confirmado (F12/F13, B-DEC-03).
   */
  outcome: z.enum(["CONFIRMED", "UNKNOWN"]).default("UNKNOWN"),
  reference: z.string().trim().max(200).optional(),
  evidenceReference: z.string().trim().max(200).optional(),
}).strict().superRefine((value, context) => {
  // Sólo un resultado REAL de terminal, con referencia operativa y evidencia,
  // puede acreditar una tarjeta externa. No se almacenan PAN/CVV: el esquema
  // es estricto y rechaza cualquier campo adicional.
  if (value.outcome === "CONFIRMED" && (!value.reference || value.reference.trim().length < 3)) {
    context.addIssue({ code: "custom", path: ["reference"], message: "Una tarjeta confirmada exige la referencia operativa de la terminal" });
  }
  if (value.outcome === "CONFIRMED" && (!value.evidenceReference || value.evidenceReference.trim().length < 3)) {
    context.addIssue({ code: "custom", path: ["evidenceReference"], message: "Una tarjeta confirmada exige evidencia del resultado de la terminal" });
  }
});

export const moneyComponentSchema = z.discriminatedUnion("method", [
  cashComponentSchema,
  transferComponentSchema,
  cardComponentSchema
]);
export type MoneyComponent = z.infer<typeof moneyComponentSchema>;

/** Estado durable de una MoneyOperation (protocolo de recovery, B01.5). */
export const moneyOperationStatuses = ["PROCESSING", "SUCCEEDED", "PROVEN_FAILED", "UNKNOWN"] as const;
export const moneyOperationStatusSchema = z.enum(moneyOperationStatuses);
export type MoneyOperationStatus = z.infer<typeof moneyOperationStatusSchema>;

/** Naturaleza de la operación: cobro o devolución. Un refund es un hecho nuevo. */
export const moneyOperationKinds = ["PAYMENT", "REFUND"] as const;
export const moneyOperationKindSchema = z.enum(moneyOperationKinds);

/**
 * Alta de una MoneyOperation.
 *
 * `saleId` / `obligationId` son la aplicación INICIAL opcional del dinero
 * confirmado. Un anticipo se registra sin destino y se aplica después con
 * `POST /v1/money/operations/:id/allocate` (D10/D18, B-DEC-06): asignar
 * dinero existente NUNCA genera dinero nuevo.
 */
export const moneyOperationInputSchema = z.object({
  kind: moneyOperationKindSchema.default("PAYMENT"),
  saleId: z.string().uuid().optional(),
  obligationId: z.string().uuid().optional(),
  /** Sesión de caja abierta donde impacta el efectivo real (obligatoria si hay efectivo). */
  cashSessionId: z.string().uuid().optional(),
  components: z.array(moneyComponentSchema).min(1).max(10),
  payerName: z.string().trim().min(1).max(120).optional(),
  receiverStaffMemberId: z.string().uuid().optional(),
  economicHolderName: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.saleId && value.obligationId) {
    context.addIssue({ code: "custom", path: ["obligationId"], message: "Un cobro se aplica a una venta o a una obligación, nunca a ambas" });
  }
});
export type MoneyOperationInput = z.infer<typeof moneyOperationInputSchema>;

/**
 * Asignación posterior de dinero YA CONFIRMADO a una sale u obligación.
 * No genera dinero nuevo; sólo mueve el destino de un hecho existente.
 */
export const moneyAllocationInputSchema = z.object({
  targetType: z.enum(["sale", "obligation"]),
  targetId: z.string().uuid(),
  amountMinor: positiveAmountMinorSchema,
}).strict();
export type MoneyAllocationInput = z.infer<typeof moneyAllocationInputSchema>;

/**
 * Refund parcial o total (D25/B-DEC-02).
 * Es un hecho monetario NUEVO que referencia el cobro original, conserva el
 * original, exige motivo y evidencia, respeta el medio usado y no puede
 * superar el importe disponible para devolver.
 */
export const moneyRefundInputSchema = z.object({
  amountMinor: positiveAmountMinorSchema,
  reason: z.string().trim().min(3).max(500),
  evidenceReference: z.string().trim().max(200).optional(),
  /** Sesión de caja VIGENTE donde se registra la salida de efectivo (si el medio es efectivo). */
  cashSessionId: z.string().uuid().optional(),
}).strict();
export type MoneyRefundInput = z.infer<typeof moneyRefundInputSchema>;

/**
 * Resolución manual autorizada de un intento UNKNOWN (B01.5, D20).
 * Nunca se dispara por timeout: exige operador con `operations.resolve`,
 * evidencia y un veredicto explícito.
 */
export const moneyResolutionInputSchema = z.object({
  outcome: z.enum(["SUCCEEDED", "PROVEN_FAILED"]),
  evidenceReference: z.string().trim().min(3).max(500),
}).strict();
export type MoneyResolutionInput = z.infer<typeof moneyResolutionInputSchema>;

/**
 * Conciliación de dinero contra caja (WP-02-T06).
 * La diferencia se REGISTRA con motivo; nunca se ajusta en silencio.
 */
export const moneyReconciliationInputSchema = z.object({
  cashSessionId: z.string().uuid(),
  expectedAmountMinor: amountMinorSchema,
  observedAmountMinor: amountMinorSchema,
  reason: z.string().trim().min(3).max(500),
}).strict();
export type MoneyReconciliationInput = z.infer<typeof moneyReconciliationInputSchema>;

/**
 * Saldo derivado de una venta. NUNCA se almacena: se deriva de los hechos.
 */
export const saleBalanceStates = ["PENDING", "PARTIAL", "SETTLED"] as const;
export const saleBalanceStateSchema = z.enum(saleBalanceStates);
export type SaleBalanceState = z.infer<typeof saleBalanceStateSchema>;

/** Suma exacta (entera) de los importes de una lista de componentes. */
export function sumComponentAmounts(components: readonly MoneyComponent[]): number {
  return components.reduce((total, component) => total + component.amountMinor, 0);
}

/**
 * Suma exacta del dinero REALMENTE confirmado. Sólo los componentes
 * CONFIRMED cuentan: una transferencia no acreditada o una tarjeta UNKNOWN
 * NO son dinero (D05, D06, F11, F13).
 */
export function sumConfirmedAmounts(components: readonly MoneyComponent[]): number {
  return components.reduce((total, component) => {
    if (component.method === "CASH") return total + (component.outcome === "CONFIRMED" ? component.amountMinor : 0);
    if (component.method === "TRANSFER") return total + (component.accredited ? component.amountMinor : 0);
    return total + (component.outcome === "CONFIRMED" ? component.amountMinor : 0);
  }, 0);
}

/** Suma exacta del vuelto entregado. Nunca negativa. */
export function sumChangeAmounts(components: readonly MoneyComponent[]): number {
  return components.reduce((total, component) => total + (component.method === "CASH" ? component.changeMinor : 0), 0);
}

/** ¿El componente aporta efectivo físico a la caja? (D08: sólo efectivo real) */
export function isCashComponent(component: MoneyComponent): boolean {
  return component.method === "CASH";
}

/** Presentación exacta. El redondeo sólo ocurre al mostrar, nunca al calcular. */
export function formatMinor(amountMinor: number): string {
  const negative = amountMinor < 0;
  const absolute = Math.abs(amountMinor);
  const major = Math.floor(absolute / MINOR_UNITS_PER_MAJOR);
  const minor = absolute % MINOR_UNITS_PER_MAJOR;
  return `${negative ? "-" : ""}${major}.${String(minor).padStart(2, "0")}`;
}
