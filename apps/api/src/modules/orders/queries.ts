/**
 * H06 · Consultas con scope. Defense-in-depth: TODA query lleva
 * `WHERE business_id = ...`; RLS no tiene policies y NO es la mitigación
 * primaria (C01 §6.7). El catálogo público expone sólo datos publicables:
 * sin stock exacto, ubicación, costos ni compromisos (CAP-06-01).
 */
import { DomainError, orderQuerySchema, type PublicProduct } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { database } from "../../lib/runtime.js";
import type { Tx } from "../system/operations.js";
import { assertOrderAccess, loadOrder, loadOrderLines, notFound, orderView, verifiedClientProfile, type OrderPrincipal } from "./domain.js";
import { resolveOrderCredential } from "../client-auth/order-credential.js";

/** Lectura consistente sobre una única transacción de postgres.js. */
async function read<T>(handler: (tx: Tx) => Promise<T>): Promise<T> {
  return await database.client.begin(handler) as T;
}

/* ─────────────────────────── catálogo público ──────────────────────── */

export async function publicCatalog(businessId: string, query: { sku?: string; cursor?: string; limit: number }) {
  const rows = await database.client`
    select sku, name, description, category, image_url "imageUrl", price_minor::int "priceMinor", parent_id "parentId"
      from inventory.items
     where business_id = ${businessId} and active and published and use <> 'INTERNAL'
       and price_minor is not null
       and (${query.sku ?? null}::text is null or sku = ${query.sku ?? null})
       and (${query.cursor ?? null}::text is null or sku > ${query.cursor ?? null})
     order by sku limit ${query.limit + 1}`;
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const items: PublicProduct[] = page.map((row) => ({
    sku: String(row.sku), name: String(row.name), description: String(row.description ?? ""),
    category: String(row.category ?? ""), imageUrl: row.imageUrl === null ? null : String(row.imageUrl),
    priceMinor: Number(row.priceMinor), currency: "ARS", availability: "AVAILABLE", variants: []
  }));
  const skus = items.map((item) => item.sku);
  if (skus.length) {
    const variants = await database.client`
      select parent_id "parentId", sku, name, price_minor::int "priceMinor"
        from inventory.items
       where business_id = ${businessId} and active and published and use <> 'INTERNAL'
         and price_minor is not null and parent_id::text = any(${skus})
       order by sku`;
    for (const variant of variants) {
      const parent = items.find((item) => item.sku === String(variant.parentId));
      parent?.variants.push({ sku: String(variant.sku), name: String(variant.name), priceMinor: Number(variant.priceMinor) });
    }
  }
  return { items, nextCursor: hasMore ? items.at(-1)?.sku ?? null : null };
}

export async function publicProduct(businessId: string, sku: string): Promise<PublicProduct> {
  const [row] = await database.client`
    select sku, name, description, category, image_url "imageUrl", price_minor::int "priceMinor"
      from inventory.items
     where business_id = ${businessId} and sku = ${sku} and active and published
       and use <> 'INTERNAL' and price_minor is not null`;
  if (!row) throw new DomainError("ORDER_NOT_FOUND", "Producto no disponible", 404);
  return {
    sku: String(row.sku), name: String(row.name), description: String(row.description ?? ""),
    category: String(row.category ?? ""), imageUrl: row.imageUrl === null ? null : String(row.imageUrl),
    priceMinor: Number(row.priceMinor), currency: "ARS", availability: "AVAILABLE", variants: []
  };
}

/* ─────────────────────────── bandeja staff ─────────────────────────── */

function decodeCursor(cursor?: string): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [createdAt, id] = decoded.split("|");
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch { return null; }
}

export async function staffOrders(actor: Actor, rawQuery: unknown) {
  const query = orderQuerySchema.parse(rawQuery);
  const cursor = decodeCursor(query.cursor);
  const rows = await database.client`
    select id, created_at "createdAt"
      from orders.product_orders
     where business_id = ${actor.businessId}
       and (${query.status}::text = 'ALL' or status = ${query.status})
       and (${query.customerKind}::text = 'ALL' or customer_kind = ${query.customerKind})
       and (${query.from ?? null}::timestamptz is null or created_at >= ${query.from ?? null})
       and (${query.to ?? null}::timestamptz is null or created_at <= ${query.to ?? null})
       and (${cursor?.createdAt ?? null}::timestamptz is null
            or (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
     order by created_at desc, id desc limit ${query.limit + 1}`;
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const items = await read(async (tx) => {
    const result = [];
    for (const row of page) result.push(await orderView(tx, actor.businessId, String(row.id)));
    return result;
  });
  const last = page.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? Buffer.from(`${String(last.createdAt)}|${String(last.id)}`).toString("base64url") : null
  };
}

export async function staffOrderDetail(actor: Actor, id: string) {
  return await read((tx) => orderView(tx, actor.businessId, id));
}

/** Historial, incidencias y comprobante: vistas sobre `audit_events`, sin tabla propia. */
export async function orderHistory(actor: Actor, id: string) {
  return await read(async (tx) => {
    await loadOrder(tx, actor.businessId, id);
    const [transitions, incidents, receipts] = await Promise.all([
      tx`select * from orders.order_transitions where "orderId" = ${id} and business_id = ${actor.businessId} order by occurred_at desc`,
      tx`select * from orders.order_incidents where "orderId" = ${id} and business_id = ${actor.businessId} order by "createdAt" desc`,
      tx`select * from orders.order_delivery_receipts where "orderId" = ${id} and business_id = ${actor.businessId} order by "createdAt" desc`
    ]);
    return { transitions, incidents, receipts };
  });
}

/* ─────────────────────────── accesos privados ──────────────────────── */

export async function guestOrderTracking(token: string, businessId: string, orderId: string) {
  return await database.client.begin(async (tx) => {
    await resolveOrderCredential(token, businessId, orderId, tx);
    const principal: OrderPrincipal = { kind: "GUEST", businessId, orderId, credentialToken: token };
    await assertOrderAccess(tx, principal, orderId);
    const order = await loadOrder(tx, businessId, orderId);
    return {
      id: order.id, status: order.status, revision: order.revision,
      totalRequestedMinor: order.totalRequestedMinor, totalConfirmedMinor: order.totalConfirmedMinor,
      lines: (await loadOrderLines(tx, businessId, orderId)).map((line) => ({
        sku: line.sku, name: line.nameSnapshot, quantity: line.quantity,
        confirmedQuantity: line.confirmedQuantity
      }))
    };
  });
}

export async function clientOrders(accountId: string, businessId: string, rawQuery: unknown) {
  const query = orderQuerySchema.parse(rawQuery);
  return await read(async (tx) => {
    const clientProfileId = await verifiedClientProfile(tx, businessId, accountId);
    const rows = await tx`
      select id from orders.product_orders
       where business_id = ${businessId} and customer_kind = 'CLIENT' and client_profile_id = ${clientProfileId}
         and (${query.status}::text = 'ALL' or status = ${query.status})
       order by created_at desc, id desc limit ${query.limit}`;
    const items = [];
    for (const row of rows) items.push(await orderView(tx, businessId, String(row.id)));
    return { items, nextCursor: null };
  });
}

export async function orderOperationState(operationId: string, actor?: Actor, token?: string, businessId?: string, orderId?: string) {
  if (actor) {
    const rows = await database.client`
      select operation_id "operationId", status::text status, response_status "responseStatus",
             response_body "responseBody", error_code "errorCode", completed_at "completedAt"
        from system.operation_attempts
       where business_id = ${actor.businessId} and operation_id = ${operationId}`;
    const row = rows[0];
    if (!row) throw notFound();
    return row;
  }
  if (!token || !businessId || !orderId) throw notFound();
  return await database.client.begin(async (tx) => {
    await resolveOrderCredential(token, businessId, orderId, tx);
    const rows = await tx`
      select operation_id "operationId", status::text status, response_status "responseStatus",
             response_body "responseBody", error_code "errorCode", completed_at "completedAt"
        from system.operation_attempts
       where business_id = ${businessId} and operation_id = ${operationId}`;
    const row = rows[0];
    if (!row) throw notFound();
    return row;
  });
}
