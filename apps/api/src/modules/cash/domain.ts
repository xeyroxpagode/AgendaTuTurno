import { DomainError, expectedCashMinor, type CashMovementType, type CashSnapshot } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import type { Tx } from "../system/operations.js";
import { missing } from "../h05/domain.js";

/**
 * H05 · CAP-05-04 Cash · dominio.
 *
 * La caja es una CAJA FÍSICA IDENTIFICADA (D19/B-DEC-07), no una sesión de
 * login. Una caja identificada admite UNA sesión abierta a la vez.
 *
 * Sólo el efectivo real afecta el efectivo esperado (D08): una transferencia
 * o una tarjeta nunca generan `CashMovement`.
 */

export type CashSessionRow = {
  id: string;
  businessId: string;
  cashboxId: string;
  status: "OPEN" | "CLOSED";
  openedByAccountId: string;
  openedAt: string;
  openingAmountMinor: number;
  closedAt: string | null;
  closedByAccountId: string | null;
  countedAmountMinor: number | null;
  expectedAmountMinor: number | null;
  differenceMinor: number | null;
  closureReason: string | null;
  snapshot: unknown;
  revision: number;
  operationId: string;
  createdAt: string;
  updatedAt: string;
};

export type CashMovementRow = {
  id: string;
  businessId: string;
  cashSessionId: string;
  type: CashMovementType;
  amountMinor: number;
  reason: string;
  moneyOperationId: string | null;
  actorAccountId: string;
  operationId: string;
  createdAt: string;
};

export async function loadCashSession(tx: Tx, businessId: string, id: string, forUpdate = false): Promise<CashSessionRow> {
  const rows = await tx`
    select id, business_id "businessId", cashbox_id "cashboxId", status::text status,
           opened_by_account_id "openedByAccountId", opened_at "openedAt",
           opening_amount_minor::int "openingAmountMinor", closed_at "closedAt",
           closed_by_account_id "closedByAccountId", counted_amount_minor::int "countedAmountMinor",
           expected_amount_minor::int "expectedAmountMinor", difference_minor::int "differenceMinor",
           closure_reason "closureReason", snapshot, revision::int revision, operation_id "operationId",
           created_at "createdAt", updated_at "updatedAt"
      from cash.cash_sessions
     where business_id = ${businessId} and id = ${id}
     ${forUpdate ? tx`for update` : tx``}`;
  const row = rows[0];
  if (!row) throw missing("esa sesión de caja");
  return row as unknown as CashSessionRow;
}

export async function listCashMovements(tx: Tx, businessId: string, cashSessionId: string): Promise<CashMovementRow[]> {
  const rows = await tx`
    select id, business_id "businessId", cash_session_id "cashSessionId", type::text type,
           amount_minor::int "amountMinor", reason, money_operation_id "moneyOperationId",
           actor_account_id "actorAccountId", operation_id "operationId", created_at "createdAt"
      from cash.cash_movements
     where business_id = ${businessId} and cash_session_id = ${cashSessionId}
     order by created_at, id`;
  return rows as unknown as CashMovementRow[];
}

/**
 * Caja física del Business. Si no se indica, se resuelve (o se crea una
 * sola vez) la caja ordinaria del local: la identidad explícita siempre
 * queda persistida.
 */
export async function resolveCashbox(tx: Tx, actor: Actor, cashboxId?: string | undefined, cashboxName?: string | undefined): Promise<{ id: string; name: string }> {
  if (cashboxId) {
    const [row] = await tx`select id, name from cash.cashboxes where business_id = ${actor.businessId} and id = ${cashboxId}`;
    if (!row) throw missing("esa caja");
    const [active] = await tx`select active from cash.cashboxes where business_id = ${actor.businessId} and id = ${cashboxId}`;
    if (active && !active.active) throw new DomainError("CONFLICT", "La caja está desactivada", 409);
    return { id: String(row.id), name: String(row.name) };
  }
  const name = cashboxName?.trim() || "Caja principal";
  const [existing] = await tx`select id, name from cash.cashboxes where business_id = ${actor.businessId} and name = ${name}`;
  if (existing) return { id: String(existing.id), name: String(existing.name) };
  const [created] = await tx`
    insert into cash.cashboxes(business_id,name) values (${actor.businessId},${name})
    on conflict (business_id,name) do update set name = excluded.name
    returning id, name`;
  return { id: String(created!.id), name: String(created!.name) };
}

/** Efectivo esperado de la sesión: fondo inicial + movimientos reales. */
export async function expectedCash(tx: Tx, businessId: string, session: CashSessionRow): Promise<{ expectedMinor: number; movements: CashMovementRow[] }> {
  const movements = await listCashMovements(tx, businessId, session.id);
  return { expectedMinor: expectedCashMinor(session.openingAmountMinor, movements), movements };
}

/**
 * Snapshot histórico de la sesión. Tras el cierre es INMUTABLE (D09): la
 * base de datos lo garantiza con trigger.
 */
export async function cashSnapshot(tx: Tx, businessId: string, sessionId: string): Promise<CashSnapshot> {
  const session = await loadCashSession(tx, businessId, sessionId);
  const { expectedMinor, movements } = await expectedCash(tx, businessId, session);
  return {
    cashSessionId: session.id,
    businessId: session.businessId,
    cashboxId: session.cashboxId,
    status: session.status,
    openedAt: new Date(String(session.openedAt)).toISOString(),
    openedByAccountId: session.openedByAccountId,
    openingAmountMinor: session.openingAmountMinor,
    movementTotalMinor: expectedMinor - session.openingAmountMinor,
    expectedAmountMinor: expectedMinor,
    countedAmountMinor: session.countedAmountMinor,
    differenceMinor: session.differenceMinor,
    closedAt: session.closedAt ? new Date(String(session.closedAt)).toISOString() : null,
    closedByAccountId: session.closedByAccountId,
    reason: session.closureReason,
    revision: session.revision,
    movements: movements.map((movement) => ({
      id: movement.id,
      type: movement.type,
      amountMinor: movement.amountMinor,
      reason: movement.reason,
      actorAccountId: movement.actorAccountId,
      moneyOperationId: movement.moneyOperationId,
      createdAt: new Date(String(movement.createdAt)).toISOString()
    }))
  };
}

/**
 * Operaciones de dinero SIN resolver que afectan al efectivo esperado.
 *
 * B-DEC-09 / D20: una caja no se cierra mientras exista una operación
 * UNKNOWN relevante para su efectivo esperado. La condición es precisa:
 * una operación con un componente de EFECTIVO NO CONFIRMADO. El intento
 * original se conserva y se resuelve con evidencia (nunca por timeout).
 */
export async function unresolvedCashOperations(tx: Tx, businessId: string): Promise<Array<{ id: string; operationId: string; status: string }>> {
  const rows = await tx`
    select m.id, m.operation_id "operationId", m.status::text status
      from money.money_operations m
     where m.business_id = ${businessId}
       and m.status in ('UNKNOWN','PROCESSING')
       and exists (
         select 1 from money.money_components c
          where c.business_id = m.business_id
            and c.money_operation_id = m.id
            and c.method = 'CASH'
            and c.outcome <> 'CONFIRMED'
       )
     order by m.created_at`;
  return rows as unknown as Array<{ id: string; operationId: string; status: string }>;
}
