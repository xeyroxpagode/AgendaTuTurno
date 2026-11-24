import { DomainError, deriveObligationBalance, type ObligationStatus } from "@youngkingz/contracts";
import type { Tx } from "../system/operations.js";
import { missing } from "../h05/domain.js";

/**
 * H05 · CAP-05-05 Obligations · dominio.
 *
 * Una obligación es un GASTO o una OBLIGACIÓN: lo que el negocio debe
 * (PAYABLE) o lo que se le debe (RECEIVABLE). Su importe puede ser
 * CONOCIDO o DESCONOCIDO; lo desconocido NO es cero (D22/F28).
 *
 * El saldo es DERIVADO de `obligations.obligation_payments`; no existe un
 * saldo canónico editable en paralelo.
 */

export type ObligationRow = {
  id: string;
  businessId: string;
  operationId: string;
  kind: "PAYABLE" | "RECEIVABLE";
  title: string;
  counterpartyName: string;
  amountMinor: number | null;
  amountState: "KNOWN" | "UNKNOWN_AMOUNT";
  currency: string;
  dueDate: string | null;
  status: ObligationStatus;
  revision: number;
  note: string | null;
  cancelledAt: string | null;
  actorAccountId: string;
  createdAt: string;
  updatedAt: string;
};

export async function loadObligation(tx: Tx, businessId: string, id: string, forUpdate = false): Promise<ObligationRow> {
  const rows = await tx`
    select id, business_id "businessId", operation_id "operationId", kind::text kind, title,
           counterparty_name "counterpartyName", amount_minor "amountMinor",
           amount_state::text "amountState", currency, due_date "dueDate", status::text status,
           revision::int revision, note, cancelled_at "cancelledAt",
           actor_account_id "actorAccountId", created_at "createdAt", updated_at "updatedAt"
      from obligations.expense_obligations
     where business_id = ${businessId} and id = ${id}
     ${forUpdate ? tx`for update` : tx``}`;
  const row = rows[0];
  if (!row) throw missing("esa obligación");
  return { ...row, amountMinor: row.amountMinor === null ? null : exactMinor(row.amountMinor) } as unknown as ObligationRow;
}

export function exactMinor(value: unknown): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new DomainError("ADJUSTMENT_INVALID", "El saldo excede el rango admitido por Obligaciones.", 409);
  return amount;
}

export async function obligationPaymentScope(tx: Tx, businessId: string, obligationId: string) {
  const [obligation] = await tx`
    select to_jsonb(o)->>'settlement_id' "settlementId" from obligations.expense_obligations o
    where o.business_id=${businessId} and o.id=${obligationId}`;
  if (!obligation) throw missing("esa obligación");
  if (!obligation.settlementId) return undefined;
  const [settlement] = await tx`select staff_member_id "staffMemberId" from econ.settlements
    where business_id=${businessId} and id=${obligation.settlementId}`;
  if (!settlement) throw missing("esa liquidación");
  return { staffMemberId: String(settlement.staffMemberId) };
}

export async function settledMinor(tx: Tx, businessId: string, obligationId: string): Promise<number> {
  const [row] = await tx`
    select coalesce(sum(amount_minor),0)::text total
      from obligations.obligation_payments
     where business_id = ${businessId} and obligation_id = ${obligationId}`;
  return exactMinor(row?.total ?? 0);
}

/** Snapshot de la obligación con saldo DERIVADO. */
export async function obligationSnapshot(tx: Tx, businessId: string, id: string) {
  const obligation = await loadObligation(tx, businessId, id);
  const settled = await settledMinor(tx, businessId, id);
  const balance = deriveObligationBalance(obligation.amountMinor, settled);
  const payments = await tx`
    select id, money_operation_id "moneyOperationId", amount_minor::int "amountMinor",
           kind::text kind, actor_account_id "actorAccountId", created_at "createdAt"
      from obligations.obligation_payments
     where business_id = ${businessId} and obligation_id = ${id}
     order by created_at`;
  return {
    id: obligation.id,
    businessId: obligation.businessId,
    operationId: obligation.operationId,
    kind: obligation.kind,
    title: obligation.title,
    counterpartyName: obligation.counterpartyName,
    amountMinor: obligation.amountMinor,
    amountState: obligation.amountState,
    balanceMinor: balance.balanceMinor,
    settledMinor: settled,
    status: balance.status,
    currency: obligation.currency,
    dueDate: obligation.dueDate,
    revision: obligation.revision,
    note: obligation.note,
    cancelledAt: obligation.cancelledAt ? new Date(String(obligation.cancelledAt)).toISOString() : null,
    createdAt: new Date(String(obligation.createdAt)).toISOString(),
    updatedAt: new Date(String(obligation.updatedAt)).toISOString(),
    payments: payments as unknown as Array<{ id: string; moneyOperationId: string; amountMinor: number; kind: string; actorAccountId: string; createdAt: string }>
  };
}

/**
 * Una obligación de importe desconocido NO puede marcarse como saldada
 * (D22): el servidor lo impide además del trigger de base de datos.
 */
export function assertNotSettledWithUnknownAmount(amountMinor: number | null, status: ObligationStatus): void {
  if (amountMinor === null && status === "SETTLED") {
    throw new DomainError("OBLIGATION_AMOUNT_UNKNOWN", "Una obligación de importe desconocido no puede marcarse como saldada", 409);
  }
}
