import { DomainError, sumChangeAmounts, sumConfirmedAmounts, type MoneyComponent, type MoneyOperationStatus } from "@youngkingz/contracts";
import type { Tx } from "../system/operations.js";
import { conflict, missing } from "../h05/domain.js";

/**
 * H05 · CAP-05-02 Money · CAP-05-03 Recovery · dominio.
 *
 * `MoneyOperation` es un hecho de DINERO REAL. Se registra una sola vez por
 * `operation_id` (D04). El dinero confirmado es la suma EXACTA de los
 * componentes CONFIRMED; una transferencia no acreditada o una tarjeta
 * IGNORADA no son dinero (D05/D06/F11/F13).
 */

export type MoneyOperationRow = {
  id: string;
  businessId: string;
  operationId: string;
  kind: "PAYMENT" | "REFUND";
  status: MoneyOperationStatus;
  saleId: string | null;
  obligationId: string | null;
  refundOfId: string | null;
  amountMinor: number;
  confirmedMinor: number;
  changeMinor: number;
  currency: string;
  payerName: string | null;
  receiverStaffMemberId: string | null;
  economicHolderName: string | null;
  note: string | null;
  revision: number;
  actorAccountId: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MoneyComponentRow = {
  id: string;
  businessId: string;
  moneyOperationId: string;
  position: number;
  method: "CASH" | "TRANSFER" | "CARD";
  outcome: "CONFIRMED" | "PENDING" | "UNKNOWN";
  amountMinor: number;
  tenderedMinor: number | null;
  changeMinor: number;
  accredited: boolean | null;
  externalReference: string | null;
  evidenceReference: string | null;
  currency: string;
  createdAt: string;
};

export async function loadMoneyOperation(tx: Tx, businessId: string, id: string, forUpdate = false): Promise<MoneyOperationRow> {
  const rows = await tx`
    select id, business_id "businessId", operation_id "operationId", kind::text kind, status::text status,
           sale_id "saleId", obligation_id "obligationId", refund_of_id "refundOfId",
           amount_minor::int "amountMinor", confirmed_minor::int "confirmedMinor", change_minor::int "changeMinor",
           currency, payer_name "payerName", receiver_staff_member_id "receiverStaffMemberId",
           economic_holder_name "economicHolderName", note, revision::int revision,
           actor_account_id "actorAccountId", resolved_at "resolvedAt", created_at "createdAt", updated_at "updatedAt"
      from money.money_operations
     where business_id = ${businessId} and id = ${id}
     ${forUpdate ? tx`for update` : tx``}`;
  const row = rows[0];
  if (!row) throw missing("esa operación de dinero");
  return row as unknown as MoneyOperationRow;
}

export async function loadMoneyOperationByOperationId(tx: Tx, businessId: string, operationId: string): Promise<MoneyOperationRow | null> {
  const rows = await tx`
    select id, business_id "businessId", operation_id "operationId", kind::text kind, status::text status,
           sale_id "saleId", obligation_id "obligationId", refund_of_id "refundOfId",
           amount_minor::int "amountMinor", confirmed_minor::int "confirmedMinor", change_minor::int "changeMinor",
           currency, payer_name "payerName", receiver_staff_member_id "receiverStaffMemberId",
           economic_holder_name "economicHolderName", note, revision::int revision,
           actor_account_id "actorAccountId", resolved_at "resolvedAt", created_at "createdAt", updated_at "updatedAt"
      from money.money_operations
     where business_id = ${businessId} and operation_id = ${operationId}`;
  const row = rows[0];
  return row ? (row as unknown as MoneyOperationRow) : null;
}

export async function loadComponents(tx: Tx, businessId: string, moneyOperationId: string): Promise<MoneyComponentRow[]> {
  const rows = await tx`
    select id, business_id "businessId", money_operation_id "moneyOperationId", position,
           method::text method, outcome::text outcome, amount_minor::int "amountMinor",
           tendered_minor::int "tenderedMinor", change_minor::int "changeMinor", accredited,
           external_reference "externalReference", evidence_reference "evidenceReference",
           currency, created_at "createdAt"
      from money.money_components
     where business_id = ${businessId} and money_operation_id = ${moneyOperationId}
     order by position`;
  return rows as unknown as MoneyComponentRow[];
}

/**
 * Resultado durable de un componente, derivado de SU resultado real.
 * Es la única fuente de verdad sobre si un componente aporta dinero.
 */
export function componentOutcome(component: Pick<MoneyComponent, "method" | "amountMinor"> & { accredited?: boolean; outcome?: "CONFIRMED" | "PENDING" | "UNKNOWN"; tenderedMinor?: number; changeMinor?: number }): "CONFIRMED" | "PENDING" | "UNKNOWN" {
  if (component.method === "CASH") return component.outcome ?? "CONFIRMED";
  if (component.method === "TRANSFER") return component.accredited ? "CONFIRMED" : "PENDING";
  return component.outcome === "UNKNOWN" ? "UNKNOWN" : "CONFIRMED";
}

/** Estado durable de la operación a partir de sus componentes. */
export function deriveOperationStatus(components: readonly MoneyComponent[]): MoneyOperationStatus {
  const outcomes = components.map((component) => componentOutcome(component));
  if (outcomes.some((outcome) => outcome === "UNKNOWN")) return "UNKNOWN";
  if (outcomes.every((outcome) => outcome === "CONFIRMED")) return "SUCCEEDED";
  return "PROCESSING";
}

/**
 * Snapshot consultable de una operación de dinero.
 * Expone el hecho real: nunca promete un resultado que el servidor no confirmó.
 */
export async function moneySnapshot(tx: Tx, businessId: string, id: string) {
  const operation = await loadMoneyOperation(tx, businessId, id);
  const components = await loadComponents(tx, businessId, id);
  const allocations = await tx`
    select id, target_type::text "targetType", target_id "targetId", amount_minor::int "amountMinor", created_at "createdAt"
      from money.money_allocations
     where business_id = ${businessId} and money_operation_id = ${id}
     order by created_at`;
  const refunded = await tx`
    select coalesce(sum(confirmed_minor),0)::int total
      from money.money_operations
     where business_id = ${businessId} and refund_of_id = ${id} and status = 'SUCCEEDED'`;
  const allocated = await tx`
    select coalesce(sum(amount_minor),0)::int total from money.money_allocations
     where business_id = ${businessId} and money_operation_id = ${id}`;
  return {
    id: operation.id,
    businessId: operation.businessId,
    operationId: operation.operationId,
    kind: operation.kind,
    status: operation.status,
    saleId: operation.saleId,
    obligationId: operation.obligationId,
    refundOfId: operation.refundOfId,
    amountMinor: operation.amountMinor,
    confirmedMinor: operation.confirmedMinor,
    availableMinor: operation.confirmedMinor - Number(allocated[0]?.total ?? 0),
    allocatedMinor: Number(allocated[0]?.total ?? 0),
    refundedMinor: Number(refunded[0]?.total ?? 0),
    changeMinor: operation.changeMinor,
    currency: operation.currency,
    payerName: operation.payerName,
    receiverStaffMemberId: operation.receiverStaffMemberId,
    economicHolderName: operation.economicHolderName,
    note: operation.note,
    revision: operation.revision,
    components: components.map((component) => ({
      id: component.id,
      method: component.method,
      outcome: component.outcome,
      amountMinor: component.amountMinor,
      tenderedMinor: component.tenderedMinor,
      changeMinor: component.changeMinor,
      accredited: component.accredited,
      externalReference: component.externalReference,
      evidenceReference: component.evidenceReference
    })),
    allocations: allocations as unknown as Array<{ id: string; targetType: string; targetId: string; amountMinor: number; createdAt: string }>,
    createdAt: new Date(String(operation.createdAt)).toISOString(),
    updatedAt: new Date(String(operation.updatedAt)).toISOString(),
    resolvedAt: operation.resolvedAt ? new Date(String(operation.resolvedAt)).toISOString() : null
  };
}

/**
 * Efectivo DISPONIBLE en el negocio: el saldo de un cobro es el dinero
 * confirmado menos lo ya aplicado. Nunca se aplica más de lo disponible
 * (B-DEC-06: "no aplicar más del disponible").
 */
export async function availableMinor(tx: Tx, businessId: string, moneyOperationId: string): Promise<number> {
  const operation = await loadMoneyOperation(tx, businessId, moneyOperationId);
  if (operation.confirmedMinor <= 0) {
    throw new DomainError("MONEY_NOT_CONFIRMED", "La operación todavía no tiene dinero confirmado", 409, { status: operation.status });
  }
  const [row] = await tx`
    select coalesce(sum(amount_minor),0)::int total from money.money_allocations
     where business_id = ${businessId} and money_operation_id = ${moneyOperationId}`;
  return operation.confirmedMinor - Number(row?.total ?? 0);
}

/** Confirma que el saldo pendiente de una venta es el esperado. */
export async function saleOutstandingMinor(tx: Tx, businessId: string, saleId: string): Promise<number> {
  const [sale] = await tx`select total_minor::int total, status::text status from sales.sales where business_id = ${businessId} and id = ${saleId}`;
  if (!sale) throw missing("esa venta");
  if (sale.status === "CANCELLED") throw conflict("La venta está anulada");
  const [paid] = await tx`
    select coalesce(sum(a.amount_minor),0)::int total
      from money.money_allocations a
      join money.money_operations m on m.business_id = a.business_id and m.id = a.money_operation_id
     where a.business_id = ${businessId} and a.target_type = 'SALE' and a.target_id = ${saleId} and m.status = 'SUCCEEDED'`;
  return Math.max(0, Number(sale.total) - Number(paid?.total ?? 0));
}

/**
 * Sesión de caja abierta de una caja física del Business (D19: una sesión
 * abierta por caja identificada).
 */
export async function openCashSession(tx: Tx, businessId: string, cashSessionId?: string | null): Promise<{ id: string; cashboxId: string } | null> {
  // El tercer argumento es el ID de la SESIÓN, no el de la caja física.
  const rows = cashSessionId
    ? await tx`select id, cashbox_id "cashboxId" from cash.cash_sessions where business_id = ${businessId} and id = ${cashSessionId} and status = 'OPEN'`
    : await tx`select id, cashbox_id "cashboxId" from cash.cash_sessions where business_id = ${businessId} and status = 'OPEN' order by opened_at desc limit 1`;
  const row = rows[0];
  return row ? { id: String(row.id), cashboxId: String(row.cashboxId) } : null;
}

export { sumChangeAmounts, sumConfirmedAmounts };
