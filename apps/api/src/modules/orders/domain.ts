/**
 * H06 · Dominio de Orders.
 *
 * Dueño de: ProductOrder, OrderLine, snapshots, transiciones y de la
 * coordinación con H03/H04/H05. NO duplica inventario, IAM ni ledger
 * financiero: referencia hechos ajenos por `source_reference = order:<id>`.
 *
 * Reglas de bloqueo (T-09): 104 (operationId, en `executePrincipalOperation`)
 * → 404 (negocio, `lockBusiness`) → `FOR UPDATE` de la orden. Ninguna
 * primitiva H04/H05 puede invertir ese orden.
 */
import { randomUUID } from "node:crypto";
import {
  DomainError, MAX_ORDER_LINES, ORDER_SOURCE_PREFIX, type OrderStatus,
  type ProductOrder, type OrderLine, type Capability
} from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import type { Tx } from "../system/operations.js";
import { lockBusiness } from "../h05/domain.js";
import { validateOrderCredentialInTx } from "../client-auth/order-credential.js";

export { lockBusiness as lockOrderBusiness };

/** Derivación SERVER-SIDE de la referencia causal. Nunca viene del cliente. */
export function sourceReferenceOf(orderId: string): string {
  return `${ORDER_SOURCE_PREFIX}${orderId}`;
}

export function notFound(): DomainError {
  return new DomainError("ORDER_NOT_FOUND", "No encontramos ese pedido en este negocio", 404);
}

export function stateInvalid(message: string, details?: unknown): DomainError {
  return new DomainError("ORDER_STATE_INVALID", message, 409, details);
}

export function checkRevision(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new DomainError("STALE_REVISION", "El pedido cambió. Revisá los valores actuales antes de continuar.", 409, { currentVersion: actual });
  }
}

export type OrderPrincipal =
  | { kind: "STAFF"; actor: Actor }
  | { kind: "CLIENT"; businessId: string; accountId: string; clientProfileId: string }
  | { kind: "GUEST"; businessId: string; orderId: string; credentialToken: string };

export async function loadOrder(tx: Tx, businessId: string, id: string, forUpdate = false): Promise<ProductOrder> {
  const rows = await tx`
    select id, business_id "businessId", operation_id "operationId", status::text status,
           customer_kind "customerKind", client_profile_id "clientProfileId",
           customer_account_id "customerAccountId", credential_id "credentialId",
           sale_id "saleId", checkout_id "checkoutId", currency,
           requested_snapshot "requestedSnapshot", confirmed_snapshot "confirmedSnapshot",
           total_requested_minor "totalRequestedMinor", total_confirmed_minor "totalConfirmedMinor",
           rejection_reason "rejectionReason", cancellation_reason "cancellationReason",
           revision::int revision, created_at "createdAt", updated_at "updatedAt",
           created_by_account_id "createdByAccountId"
      from orders.product_orders
     where business_id = ${businessId} and id = ${id}
     ${forUpdate ? tx`for update` : tx``}`;
  const row = rows[0];
  if (!row) throw notFound();
  return row as unknown as ProductOrder;
}

export async function loadOrderLines(tx: Tx, businessId: string, orderId: string): Promise<OrderLine[]> {
  const rows = await tx`
    select id, business_id "businessId", order_id "orderId", position::int position,
           sku, location_id "locationId", name_snapshot "nameSnapshot",
           category_snapshot "categorySnapshot", image_url_snapshot "imageUrlSnapshot",
           quantity::int quantity, unit_price_minor "unitPriceMinor", currency,
           conditions_snapshot "conditionsSnapshot", confirmed_price_minor "confirmedPriceMinor",
           confirmed_quantity "confirmedQuantity", confirmed_at "confirmedAt", revision::int revision
      from orders.order_lines
     where business_id = ${businessId} and order_id = ${orderId}
     order by position`;
  return rows as unknown as OrderLine[];
}

export interface ResolvedPublicLine {
  sku: string;
  name: string;
  category: string;
  imageUrl: string | null;
  quantity: number;
  unitPriceMinor: number;
  conditions: Record<string, unknown>;
  /** Resuelto en servidor al confirmar; nunca expuesto en el catálogo público. */
  locationId?: string;
  currency: "ARS";
}

/**
 * Resuelve líneas del catálogo PUBLICABLE. No revela stock, ubicación ni
 * costos: verifica `active`, `published`, `use <> 'INTERNAL'` y precio vigente.
 */
export async function resolvePublicLines(
  tx: Tx,
  businessId: string,
  lines: ReadonlyArray<{ sku: string; quantity: number }>
): Promise<ResolvedPublicLine[]> {
  if (!lines.length || lines.length > MAX_ORDER_LINES) throw new DomainError("VALIDATION_ERROR", "El pedido requiere entre 1 y 50 líneas", 400);
  const result: ResolvedPublicLine[] = [];
  for (const line of lines) {
    const [item] = await tx`
      select sku, name, category, image_url "imageUrl", use::text use,
             active, published, price_minor::int "priceMinor"
        from inventory.items
       where business_id = ${businessId} and sku = ${line.sku}`;
    if (!item || !item.active || !item.published || item.use === "INTERNAL" || item.priceMinor === null) {
      throw new DomainError("ORDER_NOT_FOUND", `El producto ${line.sku} no está disponible para pedido`, 404);
    }
    result.push({
      sku: String(item.sku), name: String(item.name), category: String(item.category ?? ""),
      imageUrl: item.imageUrl === null ? null : String(item.imageUrl),
      quantity: line.quantity, unitPriceMinor: Number(item.priceMinor),
      conditions: {}, currency: "ARS"
    });
  }
  return result;
}

/** Elige una ubicación vendible con stock libre para confirmar la línea (Q13). */
export async function resolveVendibleLocation(tx: Tx, businessId: string, sku: string, quantity: number): Promise<string> {
  const locations = await tx`
    select l.id, l.active
      from inventory.locations l
      join inventory.positions p
        on p.business_id = l.business_id and p.location_id = l.id and p.sku = ${sku} and p.purpose = 'SALE'
     where l.business_id = ${businessId} and l.active
     order by l.id`;
  for (const location of locations) {
    const [c] = await tx`
      select coalesce(sum(quantity),0)::int committed
        from inventory.commitments
       where business_id = ${businessId} and sku = ${sku} and location_id = ${location.id} and state = 'ACTIVE'`;
    const [p] = await tx`
      select physical::int physical from inventory.positions
       where business_id = ${businessId} and sku = ${sku} and location_id = ${location.id} and purpose = 'SALE'`;
    if (Number(p?.physical ?? 0) - Number(c?.committed ?? 0) >= quantity) return String(location.id);
  }
  throw new DomainError("INSUFFICIENT_SELLABLE_STOCK", `No hay stock vendible suficiente para ${sku}`, 409, { sku, quantity });
}

export function requestedSnapshotOf(lines: readonly ResolvedPublicLine[], quotedTotalMinor: number) {
  return {
    version: 1,
    items: lines.map((line) => ({
      sku: line.sku, name: line.name, category: line.category, imageUrl: line.imageUrl,
      quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, currency: line.currency,
      conditions: line.conditions
    })),
    quotedTotalMinor
  };
}

export function confirmedSnapshotOf(lines: readonly OrderLine[]) {
  return {
    version: 1,
    items: lines.map((line) => ({
      sku: line.sku, locationId: line.locationId, name: line.nameSnapshot,
      category: line.categorySnapshot, quantity: line.confirmedQuantity ?? line.quantity,
      unitPriceMinor: line.confirmedPriceMinor ?? line.unitPriceMinor, currency: line.currency,
      conditions: line.conditionsSnapshot
    })),
    totalMinor: lines.reduce((sum, line) => sum + (line.confirmedPriceMinor ?? line.unitPriceMinor) * (line.confirmedQuantity ?? line.quantity), 0)
  };
}

export async function insertOrder(tx: Tx, input: {
  businessId: string;
  operationId: string;
  customerKind: "CLIENT" | "GUEST";
  clientProfileId: string | null;
  customerAccountId: string | null;
  credentialId: string | null;
  createdByAccountId: string | null;
  snapshot: unknown;
  totalRequestedMinor: number;
}): Promise<ProductOrder> {
  const [row] = await tx`
    insert into orders.product_orders(
      business_id, operation_id, status, customer_kind, client_profile_id,
      customer_account_id, credential_id, created_by_account_id, requested_snapshot, total_requested_minor)
    values (${input.businessId}, ${input.operationId}, 'REQUESTED', ${input.customerKind},
            ${input.clientProfileId}, ${input.customerAccountId}, ${input.credentialId},
            ${input.createdByAccountId}, ${JSON.stringify(input.snapshot)}::jsonb, ${input.totalRequestedMinor})
    returning id, status::text status, revision::int revision`;
  if (!row) throw new Error("No se pudo crear el pedido");
  return await loadOrder(tx, input.businessId, String(row.id));
}

export async function insertOrderLines(tx: Tx, businessId: string, orderId: string, lines: readonly ResolvedPublicLine[]): Promise<void> {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    await tx`
      insert into orders.order_lines(business_id, order_id, position, sku, name_snapshot,
        category_snapshot, image_url_snapshot, quantity, unit_price_minor, conditions_snapshot)
      values (${businessId}, ${orderId}, ${index + 1}, ${line.sku}, ${line.name},
        ${line.category}, ${line.imageUrl}, ${line.quantity}, ${line.unitPriceMinor},
        ${JSON.stringify(line.conditions)}::jsonb)`;
  }
}

export async function orderView(tx: Tx, businessId: string, id: string) {
  const order = await loadOrder(tx, businessId, id);
  const lines = await loadOrderLines(tx, businessId, id);
  return {
    id: order.id,
    businessId: order.businessId,
    status: order.status as OrderStatus,
    customerKind: order.customerKind,
    revision: order.revision,
    currency: order.currency,
    sourceReference: sourceReferenceOf(order.id),
    totalRequestedMinor: order.totalRequestedMinor,
    totalConfirmedMinor: order.totalConfirmedMinor,
    requestedSnapshot: order.requestedSnapshot,
    confirmedSnapshot: order.confirmedSnapshot,
    rejectionReason: order.rejectionReason,
    cancellationReason: order.cancellationReason,
    saleId: order.saleId,
    checkoutId: order.checkoutId,
    lines: lines.map((line) => ({
      id: line.id, position: line.position, sku: line.sku, locationId: line.locationId,
      name: line.nameSnapshot, quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      confirmedPriceMinor: line.confirmedPriceMinor,
      confirmedQuantity: line.confirmedQuantity
    })),
    createdAt: new Date(String(order.createdAt)).toISOString(),
    updatedAt: new Date(String(order.updatedAt)).toISOString()
  };
}

/**
 * Cliente registrado: vínculo `client_account_links` activo y verificado.
 * NUNCA se infiere por teléfono ni nombre (D08/Q28).
 */
export async function verifiedClientProfile(tx: Tx, businessId: string, accountId: string): Promise<string> {
  const [link] = await tx`
    select client_profile_id "clientProfileId"
      from clients.client_account_links
     where business_id = ${businessId} and account_id = ${accountId}
       and revoked_at is null and auth_method <> 'pending-u02'
     order by linked_at desc limit 1`;
  if (!link) throw new DomainError("ORDER_NOT_OWNED", "El cliente no está vinculado a este negocio", 404);
  return String(link.clientProfileId);
}

/** Autoridad de lectura/escritura sobre el recurso. Todo fallo ⇒ 404 (Q25/Q29). */
export async function assertOrderAccess(tx: Tx, principal: OrderPrincipal, orderId: string, expectedBusinessId?: string): Promise<ProductOrder> {
  if (principal.kind === "STAFF") {
    const order = await loadOrder(tx, principal.actor.businessId, orderId);
    if (expectedBusinessId && expectedBusinessId !== principal.actor.businessId) throw notFound();
    return order;
  }
  const businessId = principal.businessId;
  const order = await loadOrder(tx, businessId, orderId);
  if (principal.kind === "CLIENT") {
    if (order.customerKind !== "CLIENT" || order.clientProfileId !== principal.clientProfileId) throw notFound();
    return order;
  }
  if (order.customerKind !== "GUEST" || order.credentialId === null) throw notFound();
  // C01 §10.4: proofDigest comparado DENTRO de la Tx, antes de cualquier mutación.
  await validateOrderCredentialInTx(tx, businessId, orderId, principal.credentialToken);
  return order;
}

export function operationIds() {
  return {
    create: randomUUID(), confirm: randomUUID(), prepare: randomUUID(),
    ready: randomUUID(), sale: randomUUID(), checkout: randomUUID(), delivery: randomUUID()
  };
}

/** Auditoría de eventos H06 (actor puede ser nulo para invitado). */
export async function auditOrderEvent(tx: Tx, input: {
  businessId: string; actorAccountId?: string | null; operationId: string;
  action: string; capability: string; orderId: string;
  changes?: object; outcome?: string;
}) {
  await tx`
    insert into system.audit_events(business_id, actor_account_id, operation_id, action,
      capability, scope, resource_type, resource_id, outcome, changes)
    values (${input.businessId}, ${input.actorAccountId ?? null}, ${input.operationId}, ${input.action},
      ${input.capability}, ${JSON.stringify({ type: "BUSINESS", businessId: input.businessId })}::jsonb,
      'PRODUCT_ORDER', ${input.orderId}, ${input.outcome ?? "SUCCEEDED"}, ${JSON.stringify(input.changes ?? {})}::jsonb)`;
}

export async function auditWithActor(tx: Tx, actor: Actor, input: {
  operationId: string; action: string; capability: Capability; orderId: string;
  changes?: object; outcome?: string;
}) {
  await auditOrderEvent(tx, {
    businessId: actor.businessId, actorAccountId: actor.accountId,
    operationId: input.operationId, action: input.action, capability: input.capability,
    orderId: input.orderId, changes: input.changes, outcome: input.outcome
  });
}
