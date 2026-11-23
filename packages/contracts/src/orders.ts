import { z } from "zod";
import { moneyComponentSchema } from "@youngkingz/contracts/money";

/**
 * H06 · CAP-06-01..07 — contratos canónicos de Orders.
 *
 * Reglas congeladas materializadas (F01 §6/§21/§22; C01 §8.3):
 *  · D01/D03: el catálogo no promete stock; la confirmación es all-or-none
 *    entre 1 y 50 líneas, en la misma transacción.
 *  · D08/D18: la credencial de invitado es privada; el token nunca viaja en
 *    el body, la URL ni los logs; el teléfono nunca es credencial.
 *  · D14/D16: `requestedSnapshot` inmutable; `confirmedSnapshot` congelado y
 *    única fuente de la Sale causal.
 *  · D24/D26: sin TTL y sin sexta pestaña; READY sin retirar permanece READY.
 *  · D25: `UNKNOWN` es estado de operación, NUNCA estado comercial.
 *
 * NOTA DE SEGURIDAD (CORR-04): este archivo NO expone `sourceReference` ni
 * `reuseCommitments` como entradas configurables del cliente. `sourceReference`
 * se deriva en servidor desde el `order.id` validado con `FOR UPDATE`.
 */

export const MAX_ORDER_LINES = 50;

/** Estados comerciales. `UNKNOWN` queda deliberadamente FUERA (D25). */
export const orderStatuses = [
  "REQUESTED", "CONFIRMED", "PREPARING", "READY", "DELIVERED", "REJECTED", "CANCELLED"
] as const;
export const orderStatusSchema = z.enum(orderStatuses);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

/** Fases con operationId v4 propio (T-08). Sin UUIDv5 ni NS_ORDERS. */
export const orderOperationPhases = [
  "order.create", "order.confirm", "order.prepare", "order.ready",
  "sale.create", "checkout.create", "delivery"
] as const;
export const orderOperationPhaseSchema = z.enum(orderOperationPhases);
export type OrderOperationPhase = z.infer<typeof orderOperationPhaseSchema>;

export const orderCustomerKinds = ["CLIENT", "GUEST"] as const;
export const orderCustomerKindSchema = z.enum(orderCustomerKinds);

export const orderLineInput = z.object({
  sku: z.string().trim().regex(/^[A-Z0-9._-]{1,64}$/).transform((value) => value.toUpperCase()),
  locationId: z.string().uuid().optional(),
  quantity: z.number().int().min(1).max(1_000_000_000),
}).strict();
export type OrderLineInput = z.infer<typeof orderLineInput>;

/** Contacto sólo para entrega; NUNCA credencial ni prueba de propiedad. */
export const orderContactInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().email().optional(),
  phone: z.string().trim().min(6).max(24).optional(),
}).strict();

export const orderRequestInput = z.object({
  businessId: z.string().uuid(),
  lines: z.array(orderLineInput).min(1).max(MAX_ORDER_LINES),
  contact: orderContactInput.optional(),
  clientProfileId: z.string().uuid().optional(),
}).strict().refine(
  (value) => new Set(value.lines.map((line) => line.sku)).size === value.lines.length,
  { message: "Líneas duplicadas por SKU" }
);
export type OrderRequestInput = z.infer<typeof orderRequestInput>;

export const orderRevisionInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const orderRejectInput = orderRevisionInput.extend({
  reason: z.string().trim().min(3).max(500),
}).strict();

export const orderCancelInput = orderRevisionInput.extend({
  reason: z.string().trim().min(3).max(500),
}).strict();

export const orderPrepareInput = orderRevisionInput.extend({
  checklist: z.array(z.object({
    sku: z.string().trim().min(1).max(64),
    done: z.boolean(),
  })).max(MAX_ORDER_LINES).optional(),
}).strict();

export const orderReadyInput = orderRevisionInput.extend({
  verifiedLines: z.array(orderLineInput).min(1).max(MAX_ORDER_LINES),
  missing: z.array(z.object({
    sku: z.string().trim().min(1).max(64),
    quantity: z.number().int().positive(),
  })).max(MAX_ORDER_LINES).optional(),
}).strict();

/**
 * Componentes de dinero: se REUTILIZA el contrato H05 sin crear un segundo
 * modelo monetario (invariante H05: un solo motor de cobro).
 */
export const orderMoneyComponentSchema = moneyComponentSchema;
export type OrderMoneyComponent = z.infer<typeof orderMoneyComponentSchema>;

export const orderReceiverSchema = z.object({
  kind: z.enum(["CUSTOMER", "THIRD_PARTY"]),
  name: z.string().trim().min(1).max(120),
  verificationMethod: z.enum(["CREDENTIAL", "DOCUMENT", "STAFF_VERIFIED"]),
}).strict();
export type OrderReceiver = z.infer<typeof orderReceiverSchema>;

export const orderDeliverInput = orderRevisionInput.extend({
  receiver: orderReceiverSchema,
  components: z.array(orderMoneyComponentSchema).min(1).max(10),
  cashSessionId: z.string().uuid().optional(),
}).strict();
export type OrderDeliverInput = z.infer<typeof orderDeliverInput>;

/**
 * Excepción D22/Q42: flujo FUERA de los siete comandos. Requiere hecho
 * físico real y autorización registrada; nunca habilita fiado ni SETTLED
 * ficticio (F01 §26).
 */
export const orderExceptionInput = orderRevisionInput.extend({
  reason: z.string().trim().min(3).max(1000),
  evidenceReference: z.string().trim().min(3).max(200),
}).strict();
export type OrderExceptionInput = z.infer<typeof orderExceptionInput>;

export const orderCredentialReissueInput = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();

export const orderQuerySchema = z.object({
  status: z.enum([...orderStatuses, "ALL"]).default("ALL"),
  customerKind: z.enum([...orderCustomerKinds, "ALL"]).default("ALL"),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
}).strict();
export type OrderQuery = z.infer<typeof orderQuerySchema>;

/** Prefijo canónico de la referencia causal de inventory.commitments. */
export const ORDER_SOURCE_PREFIX = "order:";

/** Formato exacto `order:<uuid-v4>`; un único `:` (F01 §17). */
export const orderSourceReferenceSchema = z.string().regex(
  /^order:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "sourceReference debe tener el formato order:<uuid-v4>"
);

/** Tipos de dominio canónicos (T004). */
export interface ProductOrder {
  id: string;
  businessId: string;
  operationId: string;
  status: OrderStatus;
  customerKind: "CLIENT" | "GUEST";
  clientProfileId: string | null;
  customerAccountId: string | null;
  credentialId: string | null;
  saleId: string | null;
  checkoutId: string | null;
  currency: "ARS";
  requestedSnapshot: unknown;
  confirmedSnapshot: unknown | null;
  totalRequestedMinor: number;
  totalConfirmedMinor: number | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdByAccountId: string | null;
}

export interface OrderLine {
  id: string;
  businessId: string;
  orderId: string;
  position: number;
  sku: string;
  locationId: string | null;
  nameSnapshot: string;
  categorySnapshot: string;
  imageUrlSnapshot: string | null;
  quantity: number;
  unitPriceMinor: number;
  currency: "ARS";
  conditionsSnapshot: unknown;
  confirmedPriceMinor: number | null;
  confirmedQuantity: number | null;
  confirmedAt: string | null;
  revision: number;
}

/** Vista pública: sin stock exacto, ubicación, costos ni compromisos. */
export interface PublicProduct {
  sku: string;
  name: string;
  description: string;
  category: string;
  imageUrl: string | null;
  priceMinor: number;
  currency: "ARS";
  availability: "AVAILABLE";
  variants: Array<{ sku: string; name: string; priceMinor: number }>;
}

/**
 * Mapeo canónico código → statusCode (T002). El status real se emite en cada
 * `DomainError`; esta tabla es la referencia única para los códigos H06.
 */
export const orderErrorCodeStatus: Readonly<Record<string, number>> = {
  ORDER_NOT_FOUND: 404,
  ORDER_STATE_INVALID: 409,
  ORDER_NOT_OWNED: 404,
  INCOMPLETE_COMMITMENT_SET: 409,
  ORDER_CREDENTIAL_INVALID: 404,
  ORDER_CREDENTIAL_REVOKED: 404,
  MONEY_BLOCKS_CANCEL: 409,
  ORDER_EXCEPTION_NOT_AUTHORIZED: 403,
  ORDER_ALREADY_DELIVERED: 409,
  BUSINESS_NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_CONFLICT: 409,
  STALE_REVISION: 409,
  PRICE_CHANGED: 409,
  INSUFFICIENT_SELLABLE_STOCK: 409,
};
