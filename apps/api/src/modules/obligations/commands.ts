import {
  createObligationSchema, payObligationSchema, settleObligationSchema, updateObligationSchema, DomainError
} from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { audit, executeOperation } from "../system/operations.js";
import { checkRevision, conflict, lockBusiness, missing, requireCapability } from "../h05/domain.js";
import { loadObligation, obligationSnapshot, settledMinor } from "./domain.js";
import { refreshObligationStatus } from "../money/commands.js";

/**
 * H05 · CAP-05-05 Obligations · comandos.
 *
 * · crear   → PAYABLE/RECEIVABLE con importe conocido o desconocido.
 * · editar  → cambio cuantitativo autorizado y trazado, con motivo.
 * · pagar   → pago PARCIAL o total contra una MoneyOperation EXISTENTE.
 * · liquidar→ settlement vinculado a dinero real.
 *
 * La recepción física de H04 NO crea deuda ni pago: este módulo sólo actúa
 * sobre hechos comerciales explícitos (B01.7.10 / F30).
 */

export async function createObligation(actor: Actor, body: unknown, operationId: string) {
  requireCapability(actor, "obligations.manage");
  const input = createObligationSchema.parse(body);

  return executeOperation({ actor, operationId, command: "obligation.create", payload: input }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const amountMinor = input.amountMinor ?? null;
    const amountState = amountMinor === null ? "UNKNOWN_AMOUNT" : "KNOWN";
    const [row] = await tx`
      insert into obligations.expense_obligations(business_id,operation_id,kind,title,counterparty_name,amount_minor,amount_state,currency,due_date,note,actor_account_id)
      values (${actor.businessId},${operationId},${input.kind},${input.title},${input.counterpartyName},${amountMinor},${amountState},'ARS',${input.dueDate ?? null},${input.note ?? null},${actor.accountId})
      returning id`;
    if (!row) throw conflict("No pudimos registrar la obligación");
    await audit(tx, {
      actor, operationId, action: "obligation.create", capability: "obligations.manage",
      resourceType: "OBLIGATION", resourceId: String(row.id),
      changes: { kind: input.kind, amountMinor, amountState, counterpartyName: input.counterpartyName }
    });
    return obligationSnapshot(tx, actor.businessId, String(row.id));
  });
}

export async function updateObligation(actor: Actor, obligationId: string, body: unknown, operationId: string) {
  requireCapability(actor, "obligations.manage");
  const input = updateObligationSchema.parse(body);

  return executeOperation({ actor, operationId, command: "obligation.update", payload: { obligationId, ...input } }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const obligation = await loadObligation(tx, actor.businessId, obligationId, true);
    if (obligation.status === "CANCELLED") throw conflict("La obligación está cancelada");
    checkRevision(obligation.revision, input.expectedRevision);

    const settled = await settledMinor(tx, actor.businessId, obligationId);
    const nextAmount = input.amountMinor === undefined ? obligation.amountMinor : input.amountMinor;
    const nextState = nextAmount === null ? "UNKNOWN_AMOUNT" : "KNOWN";
    if (nextAmount !== null && settled > nextAmount) {
      throw new DomainError("OBLIGATION_PAYMENT_EXCEEDS", "El importe no puede quedar por debajo de lo ya pagado", 409, { settledMinor: settled });
    }
    // Una obligación con importe desconocido que ya recibió pagos conserva el
    // hecho: no se "reabre" a cero.
    if (nextAmount === null && settled > 0 && input.amountMinor === undefined) {
      throw conflict("No se puede volver a un importe desconocido una obligación que ya tiene pagos");
    }

    const [row] = await tx`
      update obligations.expense_obligations
         set title=coalesce(${input.title ?? null}, title),
             counterparty_name=coalesce(${input.counterpartyName ?? null}, counterparty_name),
             amount_minor=${nextAmount}, amount_state=${nextState},
             due_date=coalesce(${input.dueDate ?? null}, due_date),
             revision=revision+1, updated_at=now()
       where business_id = ${actor.businessId} and id = ${obligationId}
      returning id`;
    if (!row) throw conflict("La obligación cambió concurrentemente");
    await refreshObligationStatus(tx, actor, obligationId);

    await audit(tx, {
      actor, operationId, action: "obligation.update", capability: "obligations.manage",
      resourceType: "OBLIGATION", resourceId: obligationId,
      changes: { reason: input.reason, beforeAmountMinor: obligation.amountMinor, afterAmountMinor: nextAmount }
    });
    return obligationSnapshot(tx, actor.businessId, obligationId);
  });
}

export async function payObligation(actor: Actor, obligationId: string, body: unknown, operationId: string) {
  requireCapability(actor, "obligations.pay");
  const input = payObligationSchema.parse(body);

  return executeOperation({ actor, operationId, command: "obligation.pay", payload: { obligationId, ...input } }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const obligation = await loadObligation(tx, actor.businessId, obligationId, true);
    if (obligation.status === "CANCELLED") throw conflict("La obligación está cancelada");
    if (obligation.status === "SETTLED") throw new DomainError("OBLIGATION_ALREADY_SETTLED", "La obligación ya está saldada", 409);

    // El pago NUNCA inventa dinero: consume una MoneyOperation existente.
    const [money] = await tx`
      select id, confirmed_minor::int "confirmedMinor", status::text status
        from money.money_operations
       where business_id = ${actor.businessId} and id = ${input.moneyOperationId}`;
    if (!money) throw missing("esa operación de dinero");
    if (money.status !== "SUCCEEDED" || Number(money.confirmedMinor) <= 0) {
      throw new DomainError("MONEY_NOT_CONFIRMED", "La operación de dinero no tiene dinero confirmado", 409, { status: money.status });
    }
    const [allocated] = await tx`
      select coalesce(sum(amount_minor),0)::int total from money.money_allocations
       where business_id = ${actor.businessId} and money_operation_id = ${input.moneyOperationId}`;
    const available = Number(money.confirmedMinor) - Number(allocated?.total ?? 0);
    if (input.amountMinor > available) {
      throw new DomainError("MONEY_ALLOCATION_EXCEEDED", "El pago excede el dinero disponible de la operación", 409, { availableMinor: available });
    }

    const settled = await settledMinor(tx, actor.businessId, obligationId);
    if (obligation.amountMinor !== null && settled + input.amountMinor > obligation.amountMinor) {
      throw new DomainError("OBLIGATION_PAYMENT_EXCEEDS", "El pago excede el importe pendiente de la obligación", 409, {
        pendingMinor: obligation.amountMinor - settled
      });
    }

    await tx`
      insert into money.money_allocations(business_id,money_operation_id,target_type,target_id,amount_minor,actor_account_id,operation_id)
      values (${actor.businessId},${input.moneyOperationId},'OBLIGATION',${obligationId},${input.amountMinor},${actor.accountId},${operationId})`;
    await tx`
      insert into obligations.obligation_payments(business_id,obligation_id,money_operation_id,amount_minor,kind,actor_account_id,operation_id)
      values (${actor.businessId},${obligationId},${input.moneyOperationId},${input.amountMinor},'PAYMENT',${actor.accountId},${operationId})`;
    await refreshObligationStatus(tx, actor, obligationId);

    await audit(tx, {
      actor, operationId, action: "obligation.pay", capability: "obligations.pay",
      resourceType: "OBLIGATION", resourceId: obligationId,
      changes: { moneyOperationId: input.moneyOperationId, amountMinor: input.amountMinor }
    });
    return obligationSnapshot(tx, actor.businessId, obligationId);
  });
}

export async function settleObligation(actor: Actor, obligationId: string, body: unknown, operationId: string) {
  requireCapability(actor, "obligations.settle");
  const input = settleObligationSchema.parse(body);

  return executeOperation({ actor, operationId, command: "obligation.settle", payload: { obligationId, ...input } }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const obligation = await loadObligation(tx, actor.businessId, obligationId, true);
    if (obligation.status === "CANCELLED") throw conflict("La obligación está cancelada");
    if (obligation.status === "SETTLED") throw new DomainError("OBLIGATION_ALREADY_SETTLED", "La obligación ya está saldada", 409);
    if (obligation.amountMinor === null) {
      throw new DomainError("OBLIGATION_AMOUNT_UNKNOWN", "No se puede liquidar una obligación de importe desconocido", 409);
    }

    const settled = await settledMinor(tx, actor.businessId, obligationId);
    const pending = obligation.amountMinor - settled;
    if (pending <= 0) throw new DomainError("OBLIGATION_ALREADY_SETTLED", "La obligación ya está saldada", 409);

    const [money] = await tx`
      select id, confirmed_minor::int "confirmedMinor", status::text status
        from money.money_operations
       where business_id = ${actor.businessId} and id = ${input.moneyOperationId}`;
    if (!money) throw missing("esa operación de dinero");
    if (money.status !== "SUCCEEDED" || Number(money.confirmedMinor) <= 0) {
      throw new DomainError("MONEY_NOT_CONFIRMED", "La operación de dinero no tiene dinero confirmado", 409, { status: money.status });
    }
    const [allocated] = await tx`
      select coalesce(sum(amount_minor),0)::int total from money.money_allocations
       where business_id = ${actor.businessId} and money_operation_id = ${input.moneyOperationId}`;
    const available = Number(money.confirmedMinor) - Number(allocated?.total ?? 0);
    if (available < pending) {
      throw new DomainError("MONEY_ALLOCATION_EXCEEDED", "El dinero disponible no cubre el saldo pendiente", 409, { availableMinor: available, pendingMinor: pending });
    }

    await tx`
      insert into money.money_allocations(business_id,money_operation_id,target_type,target_id,amount_minor,actor_account_id,operation_id)
      values (${actor.businessId},${input.moneyOperationId},'OBLIGATION',${obligationId},${pending},${actor.accountId},${operationId})`;
    await tx`
      insert into obligations.obligation_payments(business_id,obligation_id,money_operation_id,amount_minor,kind,actor_account_id,operation_id)
      values (${actor.businessId},${obligationId},${input.moneyOperationId},${pending},'SETTLEMENT',${actor.accountId},${operationId})`;
    await tx`
      update obligations.expense_obligations set status='SETTLED', revision=revision+1, updated_at=now()
       where business_id = ${actor.businessId} and id = ${obligationId}`;

    await audit(tx, {
      actor, operationId, action: "obligation.settle", capability: "obligations.settle",
      resourceType: "OBLIGATION", resourceId: obligationId,
      changes: { moneyOperationId: input.moneyOperationId, amountMinor: pending, reason: input.reason }
    });
    return obligationSnapshot(tx, actor.businessId, obligationId);
  });
}
