import { z } from "zod";
import { amountMinorSchema, MAX_AMOUNT_MINOR } from "@youngkingz/contracts/money";

/**
 * H05 · CAP-05-01 Sales — contratos compartidos.
 *
 * Reglas congeladas materializadas:
 *  · D01 — una Sale contiene servicios, productos o ambos.
 *  · D02 — Attendance completada NO crea Sale automáticamente: la venta es
 *    un acto comercial explícito, causalmente vinculado a la atención real.
 *  · D03/D15 — cada línea conserva precio, moneda y descuento HISTÓRICOS.
 *    Un cambio posterior de catálogo no reescribe la venta.
 *  · B-DEC-01 — descuentos manuales autorizados: importe exacto en ARS,
 *    capability efectiva, motivo, actor y snapshot; no excede la base
 *    comercial elegible ni produce total negativo; sin motor de promociones.
 *  · B01.3.10 — el saldo es DERIVADO de los hechos de dinero, nunca un saldo
 *    canónico editable en paralelo.
 */

export const saleStatuses = ["DRAFT", "CONFIRMED", "CANCELLED"] as const;
export const saleStatusSchema = z.enum(saleStatuses);
export type SaleStatus = z.infer<typeof saleStatusSchema>;

/**
 * Origen causal de la venta (B01.2 — reglas de unicidad causal).
 *  · ATTENDANCE — vínculo a una atención real (obligatorio `attendanceId`).
 *  · WALK_IN — atención sin reserva documentada vía `contactSnapshot`.
 *  · DIRECT — venta directa de productos (sin atención).
 */
export const saleSources = ["ATTENDANCE", "WALK_IN", "DIRECT"] as const;
export const saleSourceSchema = z.enum(saleSources);
export type SaleSource = z.infer<typeof saleSourceSchema>;

export const saleLineKinds = ["SERVICE", "PRODUCT"] as const;
export const saleLineKindSchema = z.enum(saleLineKinds);
export type SaleLineKind = z.infer<typeof saleLineKindSchema>;

/** Snapshot de contacto. Obligatorio en walk-in. NO crea Reservation ni CLIENT. */
export const saleContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(6).max(40),
  email: z.string().email().max(254).optional(),
}).strict();
export type SaleContact = z.infer<typeof saleContactSchema>;

/**
 * Línea de venta.
 *
 * `unitPriceMinor` y `discountMinor` son el SNAPSHOT histórico. La línea
 * guarda `lineTotalMinor` ya calculado en enteros exactos: nunca se recalcula
 * desde el catálogo vigente.
 */
export const saleLineInputSchema = z.object({
  kind: saleLineKindSchema,
  serviceId: z.string().uuid().optional(),
  sku: z.string().trim().min(1).max(64).optional(),
  locationId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  quantity: z.number().int().min(1).max(1_000_000),
  unitPriceMinor: amountMinorSchema,
  discountMinor: amountMinorSchema.default(0),
  discountReason: z.string().trim().min(3).max(500).optional(),
  durationMinutes: z.number().int().min(0).max(1440).optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "SERVICE" && !value.serviceId) {
    context.addIssue({ code: "custom", path: ["serviceId"], message: "Una línea de servicio referencia el servicio del catálogo" });
  }
  if (value.kind === "PRODUCT" && !value.sku) {
    context.addIssue({ code: "custom", path: ["sku"], message: "Una línea de producto referencia el SKU" });
  }
  if (value.kind === "PRODUCT" && !value.locationId) {
    context.addIssue({ code: "custom", path: ["locationId"], message: "Una línea de producto indica la ubicación de la existencia" });
  }
  const base = value.unitPriceMinor * value.quantity;
  if (value.discountMinor > base) {
    context.addIssue({ code: "custom", path: ["discountMinor"], message: "El descuento no puede superar la base comercial de la línea" });
  }
  if (value.discountMinor > 0 && !value.discountReason) {
    context.addIssue({ code: "custom", path: ["discountReason"], message: "El descuento autorizado exige un motivo" });
  }
  if (base - value.discountMinor > MAX_AMOUNT_MINOR) {
    context.addIssue({ code: "custom", path: ["unitPriceMinor"], message: "El importe de la línea excede el máximo permitido" });
  }
});
export type SaleLineInput = z.infer<typeof saleLineInputSchema>;

/**
 * Alta de una venta.
 *
 * Exactamente un origen causal:
 *  · `attendanceId` presente ⇒ origen ATTENDANCE (o WALK_IN si la atención
 *    registrada fue walk-in). La atención DEBE existir, ser del mismo
 *    Business y estar en estado terminal.
 *  · `contactSnapshot` presente sin `attendanceId` ⇒ origen WALK_IN.
 *  · Sólo líneas de producto ⇒ origen DIRECT.
 */
export const createSaleSchema = z.object({
  attendanceId: z.string().uuid().optional(),
  contactSnapshot: saleContactSchema.optional(),
  // Con `attendanceId`, los servicios se toman del snapshot performed y el
  // array puede venir vacío (B01.3.1). Sin atención, hace falta al menos una
  // línea de producto (ver superRefine).
  lines: z.array(saleLineInputSchema).max(50).default([]),
  note: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  const hasService = value.lines.some((line) => line.kind === "SERVICE");
  if (!value.attendanceId && !value.contactSnapshot && !value.lines.some((line) => line.kind === "PRODUCT")) {
    context.addIssue({ code: "custom", path: ["lines"], message: "La venta necesita un origen causal: atención, walk-in o producto directo" });
  }
  if (value.attendanceId && value.contactSnapshot) {
    context.addIssue({ code: "custom", path: ["contactSnapshot"], message: "Una venta con atención no duplica el snapshot de contacto" });
  }
  if (value.attendanceId && hasService) {
    context.addIssue({ code: "custom", path: ["lines"], message: "Una venta desde atención toma sus servicios del snapshot performed" });
  }
});
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

/**
 * Confirmación de la venta.
 *
 * Si el precio de catálogo cambió entre el borrador y la confirmación, el
 * servidor revalida e informa: nunca confirma en silencio con un precio
 * distinto al snapshot (B01.3.12).
 */
export const confirmSaleSchema = z.object({
  expectedRevision: z.number().int().min(1),
  acceptPriceChanges: z.boolean().default(false),
}).strict();
export type ConfirmSaleInput = z.infer<typeof confirmSaleSchema>;

/** Anulación trazable. El motivo es OBLIGATORIO (B01.3.9). */
export const cancelSaleSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  expectedRevision: z.number().int().min(1),
}).strict();
export type CancelSaleInput = z.infer<typeof cancelSaleSchema>;

/**
 * Corrección comercial trazable (B01.9.1).
 * Conserva el original y exige motivo; genera un hecho posterior, no una
 * reescritura retroactiva.
 */
export const correctSaleSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  expectedRevision: z.number().int().min(1),
  lines: z.array(saleLineInputSchema).min(1).max(50).optional(),
}).strict();
export type CorrectSaleInput = z.infer<typeof correctSaleSchema>;

/** Totales exactos de una venta en enteros. El saldo NO se envía. */
export function lineTotal(line: Pick<SaleLineInput, "unitPriceMinor" | "quantity" | "discountMinor">): number {
  return line.unitPriceMinor * line.quantity - line.discountMinor;
}

/** Total exacto de una venta. Suma de líneas, sin redondeo. */
export function saleTotal(lines: readonly Pick<SaleLineInput, "unitPriceMinor" | "quantity" | "discountMinor">[]): number {
  return lines.reduce((total, line) => total + lineTotal(line), 0);
}

/**
 * Saldo DERIVADO de una venta. Nunca se persiste como saldo canónico.
 *  · PENDING — nada cobrado.
 *  · PARTIAL — cobertura parcial.
 *  · SETTLED — cubierta.
 */
export function deriveSaleBalance(targetMinor: number, settledMinor: number): "PENDING" | "PARTIAL" | "SETTLED" {
  if (settledMinor <= 0) return "PENDING";
  if (settledMinor >= targetMinor) return "SETTLED";
  return "PARTIAL";
}

/** Snapshot serializable de una línea confirmada (historia inmutable). */
export type SaleLineSnapshot = {
  kind: SaleLineKind;
  serviceId: string | null;
  sku: string | null;
  locationId: string | null;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  lineTotalMinor: number;
  currency: "ARS";
  durationMinutes: number | null;
  snapshotAt: string;
};

export type SaleSnapshot = {
  id: string;
  businessId: string;
  status: SaleStatus;
  source: SaleSource;
  attendanceId: string | null;
  contact: SaleContact | null;
  currency: "ARS";
  totalMinor: number;
  settledMinor: number;
  balance: "PENDING" | "PARTIAL" | "SETTLED";
  lines: SaleLineSnapshot[];
  revision: number;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
};

export { MAX_AMOUNT_MINOR };
