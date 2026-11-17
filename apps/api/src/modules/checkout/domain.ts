import { DomainError, type CheckoutStatus } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import type { Tx } from "../system/operations.js";
import type { CheckoutAuthority } from "../inventory/commitments.js";
import { missing } from "../h05/domain.js";

/**
 * H05 · CAP-05-06 Checkout · dominio.
 *
 * Checkout es una COORDINACIÓN RECUPERABLE entre Sale, Money, Cash e
 * Inventory. No es un ledger monetario ni de stock (D13): no guarda saldos
 * propios, sólo DERIVA su estado de los hechos que coordina.
 */

export type CheckoutRow = {
  id: string;
  businessId: string;
  operationId: string;
  saleId: string;
  moneyOperationId: string | null;
  cashSessionId: string | null;
  status: CheckoutStatus;
  totalMinor: number;
  confirmedMinor: number;
  sourceReference: string;
  incidentReason: string | null;
  revision: number;
  actorAccountId: string;
  createdAt: string;
  updatedAt: string;
};

export async function loadCheckout(tx: Tx, businessId: string, id: string, forUpdate = false): Promise<CheckoutRow> {
  const rows = await tx`
    select id, business_id "businessId", operation_id "operationId", sale_id "saleId",
           money_operation_id "moneyOperationId", cash_session_id "cashSessionId", status::text status,
           total_minor::int "totalMinor", confirmed_minor::int "confirmedMinor",
           source_reference "sourceReference", incident_reason "incidentReason",
           revision::int revision, actor_account_id "actorAccountId",
           created_at "createdAt", updated_at "updatedAt"
      from checkout.checkouts
     where business_id = ${businessId} and id = ${id}
     ${forUpdate ? tx`for update` : tx``}`;
  const row = rows[0];
  if (!row) throw missing("ese checkout");
  return row as unknown as CheckoutRow;
}

/** Líneas de producto de la venta, agregadas por (sku, ubicación). */
export async function productLinesOf(tx: Tx, businessId: string, saleId: string): Promise<Array<{ sku: string; locationId: string; quantity: number }>> {
  const rows = await tx`
    select sku, location_id "locationId", sum(quantity)::int quantity
      from sales.sale_lines
     where business_id = ${businessId} and sale_id = ${saleId} and kind = 'PRODUCT' and superseded_at is null
     group by sku, location_id
     order by sku, location_id`;
  return rows as unknown as Array<{ sku: string; locationId: string; quantity: number }>;
}

/**
 * Emite la autoridad de ejecución del checkout. La autoridad es un dato de
 * SERVIDOR: se revalida contra PostgreSQL dentro de la transacción que
 * invoca la primitiva H04 (`inventory/commitments.ts`).
 */
export function issueCheckoutAuthority(checkout: { id: string; businessId: string; operationId: string; sourceReference: string }, actor: Actor): CheckoutAuthority {
  return {
    checkoutId: checkout.id,
    businessId: checkout.businessId,
    operationId: checkout.operationId,
    sourceReference: checkout.sourceReference,
    actorAccountId: actor.accountId
  };
}

/** Snapshot consultable del checkout: hechos reales, nunca promesas. */
export async function checkoutSnapshot(tx: Tx, businessId: string, id: string) {
  const checkout = await loadCheckout(tx, businessId, id);
  const [sale] = await tx`select total_minor::int "totalMinor", status::text status from sales.sales where business_id = ${businessId} and id = ${checkout.saleId}`;
  const [settled] = await tx`
    select coalesce(sum(a.amount_minor),0)::int total
      from money.money_allocations a
      join money.money_operations m on m.business_id = a.business_id and m.id = a.money_operation_id
     where a.business_id = ${businessId} and a.target_type = 'SALE' and a.target_id = ${checkout.saleId} and m.status = 'SUCCEEDED'`;
  const settledMinor = Number(settled?.total ?? 0);
  const balance = settledMinor <= 0 ? "PENDING" : settledMinor >= checkout.totalMinor ? "SETTLED" : "PARTIAL";
  return {
    id: checkout.id,
    businessId: checkout.businessId,
    saleId: checkout.saleId,
    moneyOperationId: checkout.moneyOperationId,
    cashSessionId: checkout.cashSessionId,
    status: checkout.status,
    totalMinor: checkout.totalMinor,
    confirmedMinor: checkout.confirmedMinor,
    balance,
    operationId: checkout.operationId,
    sourceReference: checkout.sourceReference,
    revision: checkout.revision,
    incidentReason: checkout.incidentReason,
    saleStatus: sale ? String(sale.status) : null,
    createdAt: new Date(String(checkout.createdAt)).toISOString(),
    updatedAt: new Date(String(checkout.updatedAt)).toISOString()
  };
}

/** Un checkout con entrega pendiente exige un motivo (F33). */
export function assertIncidentReason(reason: string): void {
  if (reason.trim().length < 3) {
    throw new DomainError("VALIDATION_ERROR", "La incidencia de entrega exige un motivo", 400);
  }
}
