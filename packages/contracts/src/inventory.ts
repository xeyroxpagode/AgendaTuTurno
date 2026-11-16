import { z } from "zod";

// Physical quantities are whole units; bounded identically in SQL and TypeScript.
export const MAX_STOCK = 1_000_000_000;
export const stockQuantity = z.number().int().min(0).max(MAX_STOCK);
export const positiveStockQuantity = stockQuantity.min(1);
export const inventoryPurpose = z.enum(["SALE", "INTERNAL"]);
export const inventoryUse = z.enum(["SALE", "INTERNAL", "MIXED"]);
const reason = z.string().trim().min(3).max(1000);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const inventoryItemSchema = z.object({
  sku: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Usá letras, números, puntos, guiones o guiones bajos en el SKU').transform(s => s.toUpperCase()),
  name: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).default(""),
  category: z.string().trim().max(80).default(""), use: inventoryUse,
  unit: z.literal("unidad").default("unidad"), parentId: z.string().uuid().nullable().default(null),
  priceMinor: z.number().int().positive().max(MAX_STOCK).nullable().default(null),
  costMinor: stockQuantity.nullable().default(null), imageUrl: z.string().url().max(2000).nullable().default(null),
  minimum: stockQuantity.nullable().default(null),
}).strict().refine(v => v.use === "INTERNAL" || v.priceMinor !== null, { path: ["priceMinor"], message: "Ingresá el precio de venta" });
export const inventoryItemUpdateSchema = z.object({
  expectedRevision: revision, name: z.string().trim().min(1).max(120), description: z.string().trim().max(2000),
  category: z.string().trim().max(80), use: inventoryUse,
  priceMinor: z.number().int().positive().max(MAX_STOCK).nullable(), costMinor: stockQuantity.nullable(),
  imageUrl: z.string().url().max(2000).nullable(),
}).strict().refine(v => v.use === "INTERNAL" || v.priceMinor !== null, { path: ["priceMinor"], message: "Ingresá el precio de venta" });
export const inventoryLifecycleSchema = z.object({ expectedRevision: revision, active: z.boolean(), reason }).strict();
export const inventoryPublishSchema = z.object({ expectedRevision: revision, published: z.boolean() }).strict();
export const inventoryLocationSchema = z.object({ name: z.string().trim().min(1).max(100), staffMemberId: z.string().uuid().nullable().default(null), active: z.boolean().default(true) }).strict();
export const inventoryLocationUpdateSchema = inventoryLocationSchema.extend({ expectedRevision: revision }).strict();
export const inventoryLineSchema = z.object({ sku: z.string().trim().min(1).max(64), locationId: z.string().uuid(), purpose: inventoryPurpose, quantity: positiveStockQuantity }).strict();
export const inventoryMovementSchema = z.object({
  kind: z.enum(["OPENING", "RECEIPT", "LOSS", "RETURN", "TRANSFER", "REALLOCATE", "ISSUE"]),
  lines: z.array(inventoryLineSchema).min(1).max(50), reason,
  effectiveAt: z.string().datetime({ offset: true }),
  destinationLocationId: z.string().uuid().optional(), destinationPurpose: inventoryPurpose.optional(),
  sourceReference: z.string().trim().min(3).max(200).optional(), fitForUse: z.literal(true).optional(),
}).strict().superRefine((v,c) => {
  if (["TRANSFER","REALLOCATE"].includes(v.kind) && v.lines.length !== 1) c.addIssue({ code:"custom",message:"Seleccioná una sola posición",path:["lines"] });
  if (v.kind === "TRANSFER" && (!v.destinationLocationId || v.destinationLocationId === v.lines[0]?.locationId)) c.addIssue({code:"custom",message:"Elegí otra ubicación",path:["destinationLocationId"]});
  if (v.kind === "REALLOCATE" && (!v.destinationPurpose || v.destinationPurpose === v.lines[0]?.purpose)) c.addIssue({code:"custom",message:"Elegí otro destino de uso",path:["destinationPurpose"]});
  if (v.kind === "RETURN" && (!v.sourceReference || !v.fitForUse)) c.addIssue({code:"custom",message:"Indicá el origen y confirmá que está apto para uso",path:["sourceReference"]});
  if (v.kind === "ISSUE" && !v.sourceReference) c.addIssue({code:"custom",message:"Indicá la causa de la salida física",path:["sourceReference"]});
});
export const inventoryConsumptionSchema = inventoryLineSchema.extend({
  attendanceId: z.string().uuid().nullable().default(null), attendanceRevision: revision.optional(),
  usedByStaffMemberId: z.string().uuid(), effectiveAt: z.string().datetime({ offset: true }), reason,
}).strict();
export const inventoryCorrectionSchema = z.object({ reason }).strict();
export const inventoryCountSchema = z.object({ sku: z.string().min(1).max(64), locationId: z.string().uuid(), purpose: inventoryPurpose,
  observedQuantity: stockQuantity, expectedVersion: revision, observedAt: z.string().datetime({ offset:true }), reason,
  previousCountId: z.string().uuid().optional(),
}).strict();
export const inventoryCountAdjustSchema = z.object({ expectedVersion: revision, reason }).strict();
export const inventoryMinimumSchema = z.object({ sku: z.string().min(1).max(64), locationId: z.string().uuid().nullable().default(null), quantity: stockQuantity.nullable() }).strict();
export const inventoryQuerySchema = z.object({ sku: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(100).default(30), before: z.string().uuid().optional() }).strict();
export type InventoryItemInput = z.infer<typeof inventoryItemSchema>;
export type InventoryLine = z.infer<typeof inventoryLineSchema>;
export type InventoryMovementInput = z.infer<typeof inventoryMovementSchema>;
export type InventoryConsumptionInput = z.infer<typeof inventoryConsumptionSchema>;
export type InventoryCountInput = z.infer<typeof inventoryCountSchema>;
export type StockPurpose = z.infer<typeof inventoryPurpose>;
export type InventoryCriticality = "UNCONFIGURED" | "NO_POSITION" | "ZERO" | "LOW" | "NEGATIVE" | "OK";
export function stockCriticality(physical: number, minimum: number | null, hasPosition = true): InventoryCriticality {
  if (physical < 0) return "NEGATIVE";
  if (!hasPosition) return "NO_POSITION";
  if (physical === 0) return "ZERO";
  if (minimum === null) return "UNCONFIGURED";
  return physical < minimum ? "LOW" : "OK";
}
export function inventoryValidationMessage(error:unknown):string {
  return error instanceof z.ZodError ? error.issues[0]?.message??'Revisá los datos.' : error instanceof Error ? error.message : 'Revisá los datos.';
}
