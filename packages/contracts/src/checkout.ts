import { z } from "zod";
import { moneyComponentSchema, moneyRefundInputSchema } from "@youngkingz/contracts/money";

/**
 * H05 · CAP-05-06 Checkout — contratos compartidos.
 *
 * Reglas congeladas materializadas:
 *  · D13 — Checkout es recuperable, transaccional donde aplica e idempotente.
 *  · D16/F33 — el checkout ordinario se completa sólo con cobertura monetaria
 *    y hechos físicos requeridos confirmados. Si el dinero quedó confirmado y
 *    la entrega falló, se preservan AMBOS hechos y se abre una incidencia
 *    recuperable: nunca un InventoryMovement falso ni un Refund automático.
 *  · D24/F37 — el operador necesita `checkout.create` (capacidad comercial
 *    específica). NO necesita `inventory.operate` general: la entrega física
 *    la ejecuta la frontera interna H05→H04 con autoridad de checkout.
 *  · B01.8.5/D10 — lacobro incierto conserva su `operation_id`; no se crea un
 *    nuevo `operation_id` para recuperar un cobro incierto.
 */

/**
 * Estados del checkout. No es un ledger monetario ni de stock: es la
 * coordinación recuperable entre Sale, Money, Cash e Inventory.
 */
export const checkoutStatuses = [
  "PENDING",
  "MONEY_CONFIRMED",
  "DELIVERED",
  "DELIVERY_PENDING",
  "RESOLVED",
  "FAILED",
  "UNKNOWN"
] as const;
export const checkoutStatusSchema = z.enum(checkoutStatuses);
export type CheckoutStatus = z.infer<typeof checkoutStatusSchema>;

/**
 * Solicitud de checkout.
 *
 * `saleId` referencia una venta EXISTENTE del mismo Business. El checkout
 * confirma esa venta, registra el dinero, refleja el efectivo en la caja
 * abierta y entrega físicamente las líneas de producto.
 *
 * `cashSessionId` es obligatorio si algún componente es CASH (D08: sólo el
 * efectivo real afecta al efectivo esperado).
 */
export const createCheckoutSchema = z.object({
  saleId: z.string().uuid(),
  components: z.array(moneyComponentSchema).min(1).max(10),
  cashSessionId: z.string().uuid().optional(),
  payerName: z.string().trim().min(1).max(120).optional(),
  receiverStaffMemberId: z.string().uuid().optional(),
  economicHolderName: z.string().trim().min(1).max(120).optional(),
  deliver: z.boolean().default(true),
  note: z.string().trim().max(500).optional()
}).strict().superRefine((value, context) => {
  const needsCash = value.components.some((component) => component.method === "CASH");
  if (needsCash && !value.cashSessionId) {
    context.addIssue({ code: "custom", path: ["cashSessionId"], message: "Un cobro en efectivo requiere la sesión de caja abierta" });
  }
});
export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;

/**
 * Reanudación de una incidencia de checkout (WP-05-T03).
 *
 *  · DELIVER — reintenta la entrega física. NO vuelve a cobrar.
 *  · REFUND — refund explícito y autorizado (crea un hecho monetario nuevo).
 *
 * Ninguna otra acción está disponible: no existe el refund automático ni el
 * cobro automático (F33).
 */
export const resumeCheckoutSchema = z.object({
  resolution: z.enum(["DELIVER", "REFUND"]),
  reason: z.string().trim().min(3).max(500),
  expectedRevision: z.number().int().min(1),
  evidenceReference: z.string().trim().min(3).max(200).optional(),
  cashSessionId: z.string().uuid().optional(),
  components: moneyRefundInputSchema.shape.components,
  attributions: moneyRefundInputSchema.shape.attributions,
}).strict();
export type ResumeCheckoutInput = z.infer<typeof resumeCheckoutSchema>;

/**
 * Estado consultable del checkout. Expone el hecho real, nunca una promesa:
 * `moneyConfirmed` indica si el dinero quedó confirmado; `deliveryPending`
 * indica una incidencia recuperable abierta.
 */
export type CheckoutSnapshot = {
  id: string;
  businessId: string;
  saleId: string;
  moneyOperationId: string | null;
  cashSessionId: string | null;
  status: CheckoutStatus;
  totalMinor: number;
  confirmedMinor: number;
  balance: "PENDING" | "PARTIAL" | "SETTLED";
  operationId: string;
  sourceReference: string;
  revision: number;
  incidentReason: string | null;
  createdAt: string;
  updatedAt: string;
};
