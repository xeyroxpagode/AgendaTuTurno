import { cashMovementInputSchema, closeCashSessionSchema, openCashSessionSchema, DomainError } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { audit, executeOperation } from "../system/operations.js";
import { checkRevision, conflict, lockBusiness, requireCapability } from "../h05/domain.js";
import { cashSnapshot, expectedCash, loadCashSession, resolveCashbox, unresolvedCashOperations } from "./domain.js";

/**
 * H05 · CAP-05-04 Cash · comandos.
 *
 * · abrir  → una sesión OPEN por caja física identificada, con fondo inicial.
 * · mover  → sólo efectivo real, sólo en sesión abierta, con actor real.
 * · cerrar → snapshot histórico inmutable; bloqueado ante UNKNOWN relevante
 *   (B-DEC-09); doble cierre rechazado; conteo obsoleto → STALE_REVISION.
 */

export async function openCashSession(actor: Actor, body: unknown, operationId: string) {
  requireCapability(actor, "cash.open");
  const input = openCashSessionSchema.parse(body);

  return executeOperation({ actor, operationId, command: "cash.session.open", payload: input }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const cashbox = await resolveCashbox(tx, actor, input.cashboxId, input.cashboxName);
    const [open] = await tx`
      select id from cash.cash_sessions
       where business_id = ${actor.businessId} and cashbox_id = ${cashbox.id} and status = 'OPEN'`;
    if (open) {
      throw new DomainError("CASH_SESSION_ALREADY_OPEN", "Esa caja ya tiene una sesión abierta", 409, { cashSessionId: String(open.id) });
    }
    const [row] = await tx`
      insert into cash.cash_sessions(business_id,cashbox_id,status,opened_by_account_id,opening_amount_minor,operation_id)
      values (${actor.businessId},${cashbox.id},'OPEN',${actor.accountId},${input.openingAmountMinor},${operationId})
      returning id`;
    if (!row) throw conflict("No pudimos abrir la sesión de caja");
    await audit(tx, {
      actor, operationId, action: "cash.session.open", capability: "cash.open",
      resourceType: "CASH_SESSION", resourceId: String(row.id),
      changes: { cashboxId: cashbox.id, cashboxName: cashbox.name, openingAmountMinor: input.openingAmountMinor }
    });
    return cashSnapshot(tx, actor.businessId, String(row.id));
  });
}

export async function createCashMovement(actor: Actor, body: unknown, operationId: string) {
  requireCapability(actor, "cash.movement.create");
  const input = cashMovementInputSchema.parse(body);

  return executeOperation({ actor, operationId, command: "cash.movement.create", payload: input }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const session = await loadCashSession(tx, actor.businessId, input.cashSessionId, true);
    if (session.status !== "OPEN") throw new DomainError("CASH_SESSION_CLOSED", "La sesión de caja está cerrada", 409);
    const [row] = await tx`
      insert into cash.cash_movements(business_id,cash_session_id,type,amount_minor,reason,money_operation_id,actor_account_id,operation_id)
      values (${actor.businessId},${input.cashSessionId},${input.type},${input.amountMinor},${input.reason},${input.moneyOperationId ?? null},${actor.accountId},${operationId})
      returning id`;
    if (!row) throw conflict("No pudimos registrar el movimiento de caja");
    await audit(tx, {
      actor, operationId, action: "cash.movement.create", capability: "cash.movement.create",
      resourceType: "CASH_SESSION", resourceId: input.cashSessionId,
      changes: { type: input.type, amountMinor: input.amountMinor, reason: input.reason }
    });
    return cashSnapshot(tx, actor.businessId, input.cashSessionId);
  });
}

export async function closeCashSession(actor: Actor, cashSessionId: string, body: unknown, operationId: string) {
  requireCapability(actor, "cash.close");
  const input = closeCashSessionSchema.parse(body);

  return executeOperation({ actor, operationId, command: "cash.session.close", payload: { cashSessionId, ...input } }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const session = await loadCashSession(tx, actor.businessId, cashSessionId, true);
    if (session.status === "CLOSED") throw new DomainError("CASH_SESSION_CLOSED", "La sesión de caja ya está cerrada", 409);
    checkRevision(session.revision, input.expectedRevision);

    // B-DEC-09: no se cierra con UNKNOWN relevante para el efectivo esperado.
    const unresolved = await unresolvedCashOperations(tx, actor.businessId);
    if (unresolved.length) {
      throw new DomainError("CASH_CLOSE_BLOCKED_UNKNOWN", "No se puede cerrar la caja mientras exista un cobro de efectivo sin confirmar", 409, {
        unresolved: unresolved.map((item) => ({ id: item.id, operationId: item.operationId, status: item.status }))
      });
    }

    const { expectedMinor, movements } = await expectedCash(tx, actor.businessId, session);
    const difference = input.countedAmountMinor - expectedMinor;
    if (difference !== 0 && (!input.reason || input.reason.trim().length < 3)) {
      throw new DomainError("VALIDATION_ERROR", "Una diferencia de caja exige un motivo explícito", 400);
    }

    const snapshot = {
      cashSessionId: session.id,
      cashboxId: session.cashboxId,
      openingAmountMinor: session.openingAmountMinor,
      expectedAmountMinor: expectedMinor,
      countedAmountMinor: input.countedAmountMinor,
      differenceMinor: difference,
      closedAt: new Date().toISOString(),
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

    const [row] = await tx`
      update cash.cash_sessions
         set status='CLOSED', closed_at=now(), closed_by_account_id=${actor.accountId},
             counted_amount_minor=${input.countedAmountMinor}, expected_amount_minor=${expectedMinor},
             difference_minor=${difference}, closure_reason=${input.reason ?? null},
             snapshot=${JSON.stringify(snapshot)}::jsonb, revision=revision+1, updated_at=now()
       where business_id = ${actor.businessId} and id = ${cashSessionId} and status = 'OPEN'
      returning id`;
    if (!row) throw conflict("La sesión de caja cambió concurrentemente");

    await audit(tx, {
      actor, operationId, action: "cash.session.close", capability: "cash.close",
      resourceType: "CASH_SESSION", resourceId: cashSessionId,
      changes: { expectedMinor: expectedMinor, countedMinor: input.countedAmountMinor, differenceMinor: difference, reason: input.reason ?? null }
    });
    return cashSnapshot(tx, actor.businessId, cashSessionId);
  });
}
