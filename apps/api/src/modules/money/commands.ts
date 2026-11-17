import { z } from "zod";
import {
  DomainError, moneyAllocationInputSchema, moneyOperationInputSchema, moneyReconciliationInputSchema,
  moneyRefundInputSchema, moneyResolutionInputSchema,
  sumChangeAmounts, sumComponentAmounts, sumConfirmedAmounts,
  type MoneyComponent
} from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { audit, executeDurableAttempt, executeOperation, prepareDurableOperation, type Tx } from "../system/operations.js";
import {
  assertActorStillAuthorized, conflict, lockBusiness, missing, requireCapability
} from "../h05/domain.js";
import {
  componentOutcome, deriveOperationStatus, loadComponents, loadMoneyOperation,
  loadMoneyOperationByOperationId, moneySnapshot, openCashSession, saleOutstandingMinor
} from "./domain.js";

/**
 * H05 · CAP-05-02 Money + CAP-05-03 Recovery · comandos.
 *
 * Dos caminos, según la atomicidad real del cobro (C01.8):
 *
 *  · ATÓMICO — todos los componentes son CONFIRMED (efectivo, transferencia
 *    acreditada, tarjeta confirmada). El hecho de dinero, sus asignaciones y
 *    sus movimientos de caja se escriben en UNA transacción.
 *
 *  · DURABLE — algún componente no está confirmado (transferencia sin
 *    acreditar, tarjeta con resultado no comprobable). El intento se prepara
 *    y COMMITEA antes de cualquier efecto externo (Frontera de Preparación);
 *    el hecho de negocio se registra después (Frontera de Resultado) y el
 *    intento queda `PROCESSING`/`UNKNOWN`, NUNCA degradado a fallo.
 *
 * Reglas que este módulo no puede violar:
 *  · el dinero confirmado se registra UNA sola vez (D04);
 *  · asignar dinero existente NO genera dinero nuevo (D10/D18);
 *  · un refund es un hecho NUEVO que conserva el original (D14/D25);
 *  · sólo el efectivo real genera movimiento de caja (D08);
 *  · un UNKNOWN nunca se resuelve a FAILED por timeout (D20).
 */

type ConfirmedPortion = {
  confirmedMinor: number;
  changeMinor: number;
  cashTenderedMinor: number;
};

function portionOf(components: readonly MoneyComponent[]): ConfirmedPortion {
  let confirmedMinor = 0;
  let changeMinor = 0;
  let cashTenderedMinor = 0;
  for (const component of components) {
    if (componentOutcome(component) !== "CONFIRMED") continue;
    confirmedMinor += component.amountMinor;
    if (component.method === "CASH") {
      changeMinor += component.changeMinor;
      cashTenderedMinor += component.tenderedMinor ?? component.amountMinor;
    }
  }
  return { confirmedMinor, changeMinor, cashTenderedMinor };
}

/* ───────────────────────────── alta de cobro ───────────────────────────── */

export async function createMoneyOperation(actor: Actor, body: unknown, operationId: string) {
  requireCapability(actor, "money.create");
  const input = moneyOperationInputSchema.parse(body);
  const status = deriveOperationStatus(input.components);

  if (status === "SUCCEEDED") {
    return executeOperation({ actor, operationId, command: "money.create", payload: input }, async (tx) => {
      await lockBusiness(tx, actor.businessId);
      await assertActorStillAuthorized(tx, actor, "money.create");
      const moneyOperationId = await insertMoneyOperation(tx, actor, operationId, input, "SUCCEEDED");
      await applyConfirmedPortion(tx, actor, operationId, moneyOperationId, input.components, input);
      await audit(tx, {
        actor, operationId, action: "money.create", capability: "money.create",
        resourceType: "MONEY_OPERATION", resourceId: moneyOperationId,
        changes: { amountMinor: sumComponentAmounts(input.components), confirmedMinor: sumConfirmedAmounts(input.components), methods: input.components.map((component) => component.method) }
      });
      return moneySnapshot(tx, actor.businessId, moneyOperationId);
    });
  }

  // Camino durable: la frontera de preparación COMMITEA el intento antes de
  // que exista cualquier efecto externo.
  await prepareDurableOperation({
    operationId, command: "money.create", actor, payload: input,
    attemptStatus: status === "UNKNOWN" ? "UNKNOWN" : "STARTED"
  });
  return executeDurableAttempt({
    operationId, command: "money.create", actor, payload: input,
    attemptStatus: status === "UNKNOWN" ? "UNKNOWN" : "STARTED",
    handler: async (tx) => {
      await lockBusiness(tx, actor.businessId);
      const existing = await loadMoneyOperationByOperationId(tx, actor.businessId, operationId);
      if (existing) return moneySnapshot(tx, actor.businessId, existing.id);
      const moneyOperationId = await insertMoneyOperation(tx, actor, operationId, input, status);
      await applyConfirmedPortion(tx, actor, operationId, moneyOperationId, input.components, input);
      await audit(tx, {
        actor, operationId, action: "money.create", capability: "money.create",
        resourceType: "MONEY_OPERATION", resourceId: moneyOperationId,
        changes: { amountMinor: sumComponentAmounts(input.components), confirmedMinor: sumConfirmedAmounts(input.components), status }
      });
      return moneySnapshot(tx, actor.businessId, moneyOperationId);
    }
  });
}

/** Inserta la MoneyOperation y su desglose por medio. */
export async function insertMoneyOperation(
  tx: Tx, actor: Actor, operationId: string,
  input: z.infer<typeof moneyOperationInputSchema>,
  status: "PROCESSING" | "SUCCEEDED" | "PROVEN_FAILED" | "UNKNOWN"
): Promise<string> {
  const amountMinor = sumComponentAmounts(input.components);
  const confirmedMinor = sumConfirmedAmounts(input.components);
  const changeMinor = sumChangeAmounts(input.components);
  const [row] = await tx`
    insert into money.money_operations(business_id,operation_id,kind,status,sale_id,obligation_id,amount_minor,confirmed_minor,change_minor,currency,payer_name,receiver_staff_member_id,economic_holder_name,note,actor_account_id)
    values (${actor.businessId},${operationId},${input.kind},${status},${input.saleId ?? null},${input.obligationId ?? null},
            ${amountMinor},${confirmedMinor},${changeMinor},'ARS',${input.payerName ?? null},${input.receiverStaffMemberId ?? null},
            ${input.economicHolderName ?? null},${input.note ?? null},${actor.accountId})
    returning id`;
  if (!row) throw conflict("No pudimos registrar la operación de dinero");

  let position = 1;
  for (const component of input.components) {
    const outcome = componentOutcome(component);
    const tendered = component.method === "CASH" ? (component.tenderedMinor ?? component.amountMinor) : null;
    await tx`
      insert into money.money_components(business_id,money_operation_id,position,method,outcome,amount_minor,tendered_minor,change_minor,accredited,external_reference,evidence_reference,currency)
      values (${actor.businessId},${row.id},${position},${component.method},${outcome},${component.amountMinor},${tendered},
              ${component.method === "CASH" ? component.changeMinor : 0},
              ${component.method === "TRANSFER" ? component.accredited : null},
              ${component.method !== "CASH" ? component.reference ?? null : null},
              ${component.method !== "CASH" ? component.evidenceReference ?? null : null},'ARS')`;
    position += 1;
  }
  return String(row.id);
}

/**
 * Aplica el dinero YA CONFIRMADO: asignaciones y movimientos de caja.
 *
 * · sólo el efectivo real genera `CashMovement` (D08);
 * · la asignación a una venta nunca excede el saldo pendiente de la venta;
 * · el excedente NO se pierde: queda como saldo aplicable (adelanto) en la
 *   operación de dinero (B-DEC-05/F41).
 */
export async function applyConfirmedPortion(
  tx: Tx, actor: Actor, operationId: string, moneyOperationId: string,
  components: readonly MoneyComponent[],
  target: { saleId?: string | undefined; obligationId?: string | undefined; cashSessionId?: string | undefined }
): Promise<void> {
  const portion = portionOf(components);
  if (portion.confirmedMinor <= 0) return;

  const [allocated] = await tx`
    select coalesce(sum(amount_minor),0)::int total from money.money_allocations
     where business_id = ${actor.businessId} and money_operation_id = ${moneyOperationId}`;
  const available = portion.confirmedMinor - Number(allocated?.total ?? 0);
  if (available <= 0) return;

  if (target.saleId) {
    const outstanding = await saleOutstandingMinor(tx, actor.businessId, target.saleId);
    const amount = Math.min(available, outstanding);
    if (amount > 0) {
      await tx`
        insert into money.money_allocations(business_id,money_operation_id,target_type,target_id,amount_minor,actor_account_id,operation_id)
        values (${actor.businessId},${moneyOperationId},'SALE',${target.saleId},${amount},${actor.accountId},${operationId})`;
    }
  } else if (target.obligationId) {
    const amount = await obligationPayableMinor(tx, actor, target.obligationId, available);
    if (amount > 0) {
      await tx`
        insert into money.money_allocations(business_id,money_operation_id,target_type,target_id,amount_minor,actor_account_id,operation_id)
        values (${actor.businessId},${moneyOperationId},'OBLIGATION',${target.obligationId},${amount},${actor.accountId},${operationId})`;
      await tx`
        insert into obligations.obligation_payments(business_id,obligation_id,money_operation_id,amount_minor,kind,actor_account_id,operation_id)
        values (${actor.businessId},${target.obligationId},${moneyOperationId},${amount},'PAYMENT',${actor.accountId},${operationId})`;
      await refreshObligationStatus(tx, actor, target.obligationId);
    }
  }

  if (portion.cashTenderedMinor > 0) {
    const session = await resolveCashSession(tx, actor, target.cashSessionId);
    await tx`
      insert into cash.cash_movements(business_id,cash_session_id,type,amount_minor,reason,money_operation_id,actor_account_id,operation_id)
      values (${actor.businessId},${session.id},'SALE_CASH',${portion.cashTenderedMinor},'Cobro en efectivo',${moneyOperationId},${actor.accountId},${operationId})`;
    if (portion.changeMinor > 0) {
      await tx`
        insert into cash.cash_movements(business_id,cash_session_id,type,amount_minor,reason,money_operation_id,actor_account_id,operation_id)
        values (${actor.businessId},${session.id},'CHANGE',${portion.changeMinor},'Vuelto entregado al cliente',${moneyOperationId},${actor.accountId},${operationId})`;
    }
  }
}

/** Sesión de caja abierta donde impacta el efectivo real. */
async function resolveCashSession(tx: Tx, actor: Actor, cashSessionId?: string | undefined): Promise<{ id: string; cashboxId: string }> {
  const session = await openCashSession(tx, actor.businessId, cashSessionId ?? null);
  if (!session) {
    throw new DomainError("CASH_SESSION_REQUIRED", "No hay una sesión de caja abierta para registrar el efectivo", 409);
  }
  if (cashSessionId) {
    const [row] = await tx`select id, status::text status from cash.cash_sessions where business_id = ${actor.businessId} and id = ${cashSessionId}`;
    if (!row) throw missing("esa sesión de caja");
    if (row.status !== "OPEN") throw new DomainError("CASH_SESSION_CLOSED", "La sesión de caja está cerrada", 409);
  }
  return session;
}

/** Importe pagable de una obligación (nunca mayor al saldo pendiente). */
async function obligationPayableMinor(tx: Tx, actor: Actor, obligationId: string, available: number): Promise<number> {
  const [obligation] = await tx`
    select id, amount_minor::int "amountMinor", amount_state::text "amountState", status::text status
      from obligations.expense_obligations
     where business_id = ${actor.businessId} and id = ${obligationId}
     for update`;
  if (!obligation) throw missing("esa obligación");
  if (obligation.status === "SETTLED") throw new DomainError("OBLIGATION_ALREADY_SETTLED", "La obligación ya está saldada", 409);
  if (obligation.status === "CANCELLED") throw conflict("La obligación está cancelada");
  const [paid] = await tx`
    select coalesce(sum(amount_minor),0)::int total from obligations.obligation_payments
     where business_id = ${actor.businessId} and obligation_id = ${obligationId}`;
  const settled = Number(paid?.total ?? 0);
  if (obligation.amountMinor === null) return available; // importe desconocido: pago parcial admisible
  return Math.max(0, Math.min(available, Number(obligation.amountMinor) - settled));
}

/** Recalcula el estado DERIVADO de la obligación (no es un saldo canónico). */
export async function refreshObligationStatus(tx: Tx, actor: Actor, obligationId: string): Promise<void> {
  const [obligation] = await tx`
    select amount_minor::int "amountMinor", amount_state::text "amountState", status::text status
      from obligations.expense_obligations
     where business_id = ${actor.businessId} and id = ${obligationId} for update`;
  if (!obligation) throw missing("esa obligación");
  if (obligation.status === "CANCELLED" || obligation.status === "SETTLED") return;
  const [paid] = await tx`
    select coalesce(sum(amount_minor),0)::int total from obligations.obligation_payments
     where business_id = ${actor.businessId} and obligation_id = ${obligationId}`;
  const settled = Number(paid?.total ?? 0);
  const amount = obligation.amountMinor;
  let status: "OPEN" | "PARTIAL" | "SETTLED" = "OPEN";
  if (amount === null) status = settled > 0 ? "PARTIAL" : "OPEN";
  else if (settled <= 0) status = "OPEN";
  else if (settled >= amount) status = "SETTLED";
  else status = "PARTIAL";
  await tx`
    update obligations.expense_obligations set status=${status}, revision=revision+1, updated_at=now()
     where business_id = ${actor.businessId} and id = ${obligationId}`;
}

/* ─────────────────────────── asignación de dinero ───────────────────────── */

export async function allocateMoney(actor: Actor, moneyOperationId: string, body: unknown, operationId: string) {
  requireCapability(actor, "money.allocate");
  const input = moneyAllocationInputSchema.parse(body);

  return executeOperation({ actor, operationId, command: "money.allocate", payload: { moneyOperationId, ...input } }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const operation = await loadMoneyOperation(tx, actor.businessId, moneyOperationId, true);
    if (operation.confirmedMinor <= 0) {
      throw new DomainError("MONEY_NOT_CONFIRMED", "La operación no tiene dinero confirmado para asignar", 409, { status: operation.status });
    }
    const [allocated] = await tx`
      select coalesce(sum(amount_minor),0)::int total from money.money_allocations
       where business_id = ${actor.businessId} and money_operation_id = ${moneyOperationId}`;
    const available = operation.confirmedMinor - Number(allocated?.total ?? 0);
    if (input.amountMinor > available) {
      throw new DomainError("MONEY_ALLOCATION_EXCEEDED", "La asignación excede el dinero confirmado disponible", 409, { availableMinor: available });
    }

    if (input.targetType === "sale") {
      const outstanding = await saleOutstandingMinor(tx, actor.businessId, input.targetId);
      if (input.amountMinor > outstanding) {
        throw new DomainError("MONEY_ALLOCATION_EXCEEDED", "La asignación excede el saldo pendiente de la venta", 409, { outstandingMinor: outstanding });
      }
      await tx`
        insert into money.money_allocations(business_id,money_operation_id,target_type,target_id,amount_minor,actor_account_id,operation_id)
        values (${actor.businessId},${moneyOperationId},'SALE',${input.targetId},${input.amountMinor},${actor.accountId},${operationId})`;
    } else {
      const payable = await obligationPayableMinor(tx, actor, input.targetId, input.amountMinor);
      if (payable < input.amountMinor) {
        throw new DomainError("OBLIGATION_PAYMENT_EXCEEDS", "El pago excede el saldo pendiente de la obligación", 409, { payableMinor: payable });
      }
      await tx`
        insert into money.money_allocations(business_id,money_operation_id,target_type,target_id,amount_minor,actor_account_id,operation_id)
        values (${actor.businessId},${moneyOperationId},'OBLIGATION',${input.targetId},${input.amountMinor},${actor.accountId},${operationId})`;
      await tx`
        insert into obligations.obligation_payments(business_id,obligation_id,money_operation_id,amount_minor,kind,actor_account_id,operation_id)
        values (${actor.businessId},${input.targetId},${moneyOperationId},${input.amountMinor},'PAYMENT',${actor.accountId},${operationId})`;
      await refreshObligationStatus(tx, actor, input.targetId);
    }

    await audit(tx, {
      actor, operationId, action: "money.allocate", capability: "money.allocate",
      resourceType: "MONEY_OPERATION", resourceId: moneyOperationId,
      changes: { targetType: input.targetType, targetId: input.targetId, amountMinor: input.amountMinor }
    });
    return moneySnapshot(tx, actor.businessId, moneyOperationId);
  });
}

/* ─────────────────────────────────── refund ─────────────────────────────── */

export async function refundMoney(actor: Actor, moneyOperationId: string, body: unknown, operationId: string) {
  requireCapability(actor, "money.refund");
  const input = moneyRefundInputSchema.parse(body);

  return executeOperation({ actor, operationId, command: "money.refund", payload: { moneyOperationId, ...input } }, async (tx) =>
    performRefund(tx, actor, moneyOperationId, input, operationId)
  );
}

/**
 * Refund (hecho monetario NUEVO) sobre un cobro original.
 *
 * Se expone por separado para que el orquestador de Checkout pueda
 * ejecutarlo dentro de SU transacción, sin abrir un segundo intento con el
 * mismo `operation_id`.
 */
export async function performRefund(
  tx: Tx, actor: Actor, moneyOperationId: string, input: z.infer<typeof moneyRefundInputSchema>, operationId: string
) {
  await lockBusiness(tx, actor.businessId);
  await assertActorStillAuthorized(tx, actor, "money.refund");
  const original = await loadMoneyOperation(tx, actor.businessId, moneyOperationId, true);
  if (original.kind !== "PAYMENT") throw conflict("Sólo un cobro puede ser reembolsado");
  if (original.status !== "SUCCEEDED") {
    throw new DomainError("MONEY_NOT_CONFIRMED", "El cobro original no está confirmado", 409, { status: original.status });
  }
  const [refunded] = await tx`
    select coalesce(sum(confirmed_minor),0)::int total from money.money_operations
     where business_id = ${actor.businessId} and refund_of_id = ${original.id} and status = 'SUCCEEDED'`;
  const available = original.confirmedMinor - Number(refunded?.total ?? 0);
  if (input.amountMinor > available) {
    throw new DomainError("REFUND_EXCEEDS_AVAILABLE", "El refund excede el importe disponible para devolver", 409, { availableMinor: available });
  }

  // El refund respeta el medio efectivamente utilizado (B-DEC-02).
  const components = await loadComponents(tx, actor.businessId, original.id);
  const originalCash = components
    .filter((component) => component.method === "CASH" && component.outcome === "CONFIRMED")
    .reduce((total, component) => total + component.amountMinor, 0);
  const alreadyCashRefunded = await tx`
    select coalesce(sum(c.amount_minor),0)::int total
      from money.money_operations r
      join money.money_components c on c.business_id = r.business_id and c.money_operation_id = r.id
     where r.business_id = ${actor.businessId} and r.refund_of_id = ${original.id}
       and r.status = 'SUCCEEDED' and c.method = 'CASH' and c.outcome = 'CONFIRMED'`;
  const cashAvailable = Math.max(0, originalCash - Number(alreadyCashRefunded[0]?.total ?? 0));
  const cashPart = Math.min(input.amountMinor, cashAvailable);
  const externalPart = input.amountMinor - cashPart;

  const refundComponents: MoneyComponent[] = [];
  if (cashPart > 0) {
    refundComponents.push({ method: "CASH", amountMinor: cashPart, tenderedMinor: cashPart, changeMinor: 0, outcome: "CONFIRMED" });
  }
  if (externalPart > 0) {
    refundComponents.push({
      method: "CARD", amountMinor: externalPart, outcome: "CONFIRMED",
      reference: input.evidenceReference, evidenceReference: input.evidenceReference
    });
  }

  const amountMinor = refundComponents.reduce((total, component) => total + component.amountMinor, 0);
  const [row] = await tx`
    insert into money.money_operations(business_id,operation_id,kind,status,refund_of_id,amount_minor,confirmed_minor,change_minor,currency,note,actor_account_id)
    values (${actor.businessId},${operationId},'REFUND','SUCCEEDED',${original.id},${amountMinor},${amountMinor},0,'ARS',${input.reason},${actor.accountId})
    returning id`;
  if (!row) throw conflict("No pudimos registrar el refund");

  let position = 1;
  for (const component of refundComponents) {
    await tx`
      insert into money.money_components(business_id,money_operation_id,position,method,outcome,amount_minor,tendered_minor,change_minor,accredited,external_reference,evidence_reference,currency)
      values (${actor.businessId},${row.id},${position},${component.method},'CONFIRMED',${component.amountMinor},
              ${component.method === "CASH" ? (component.tenderedMinor ?? component.amountMinor) : null},
              0,${component.method === "TRANSFER" ? component.accredited : null},
              ${component.method !== "CASH" ? component.reference ?? null : null},
              ${component.method !== "CASH" ? component.evidenceReference ?? null : null},'ARS')`;
    position += 1;
  }

  // El efectivo del refund sale de la CAJA VIGENTE. La caja histórica de
  // origen no se modifica nunca (F19, B-DEC-02).
  if (cashPart > 0) {
    const session = await resolveCashSession(tx, actor, input.cashSessionId);
    await tx`
      insert into cash.cash_movements(business_id,cash_session_id,type,amount_minor,reason,money_operation_id,actor_account_id,operation_id)
      values (${actor.businessId},${session.id},'EXPENSE',${cashPart},${`Refund autorizado: ${input.reason}`},${row.id},${actor.accountId},${operationId})`;
  }

  await audit(tx, {
    actor, operationId, action: "money.refund", capability: "money.refund",
    resourceType: "MONEY_OPERATION", resourceId: String(row.id),
    changes: { refundOfId: original.id, amountMinor, cashPart, externalPart, reason: input.reason }
  });
  return moneySnapshot(tx, actor.businessId, String(row.id));
}

/* ───────────────────── resolución manual de UNKNOWN ─────────────────────── */

/**
 * Procedimiento de reconciliación manual autorizada (B01.5).
 *
 * NUNCA se dispara por timeout: exige `operations.resolve`, evidencia y un
 * veredicto explícito. El intento original se conserva y su estado se
 * consolida con la evidencia aportada.
 */
export async function resolveMoneyOperation(actor: Actor, moneyOperationId: string, body: unknown, operationId: string) {
  requireCapability(actor, "operations.resolve");
  const input = moneyResolutionInputSchema.parse(body);

  return executeOperation({ actor, operationId, command: "money.resolve", payload: { moneyOperationId, ...input } }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const operation = await loadMoneyOperation(tx, actor.businessId, moneyOperationId, true);
    if (operation.status === "SUCCEEDED") throw conflict("La operación ya está confirmada");
    if (operation.status === "PROVEN_FAILED") throw conflict("La operación ya tiene un fallo probado");

    const components = await loadComponents(tx, actor.businessId, moneyOperationId);
    const pending = components.filter((component) => component.outcome !== "CONFIRMED");
    if (!pending.length) throw conflict("La operación no tiene componentes sin confirmar");

    if (input.outcome === "PROVEN_FAILED") {
      await tx`
        update money.money_operations
           set status='PROVEN_FAILED', confirmed_minor=0, resolved_at=now(), resolved_by_account_id=${actor.accountId}, revision=revision+1, updated_at=now()
         where business_id = ${actor.businessId} and id = ${moneyOperationId}`;
      await tx`
        update system.operation_attempts set status='FAILED', response_status=409, error_code='PROVEN_FAILED', completed_at=now()
         where operation_id = ${operation.operationId} and business_id = ${actor.businessId}`;
      await audit(tx, {
        actor, operationId, action: "money.resolve_failed", capability: "operations.resolve",
        resourceType: "MONEY_OPERATION", resourceId: moneyOperationId,
        changes: { evidence: input.evidenceReference }
      });
      return moneySnapshot(tx, actor.businessId, moneyOperationId);
    }

    // SUCCEEDED con evidencia: los componentes pendientes quedan CONFIRMED.
    for (const component of pending) {
      if (component.method === "TRANSFER") {
        await tx`
          update money.money_components
             set outcome='CONFIRMED', accredited=true, external_reference=coalesce(external_reference, ${input.evidenceReference}), evidence_reference=${input.evidenceReference}
           where business_id = ${actor.businessId} and id = ${component.id}`;
      } else {
        await tx`
          update money.money_components
             set outcome='CONFIRMED', external_reference=coalesce(external_reference, ${input.evidenceReference}), evidence_reference=${input.evidenceReference}
           where business_id = ${actor.businessId} and id = ${component.id}`;
      }
    }
    const updated = await loadComponents(tx, actor.businessId, moneyOperationId);
    const confirmedMinor = updated
      .filter((component) => component.outcome === "CONFIRMED")
      .reduce((total, component) => total + component.amountMinor, 0);
    await tx`
      update money.money_operations
         set status='SUCCEEDED', confirmed_minor=${confirmedMinor}, resolved_at=now(), resolved_by_account_id=${actor.accountId}, revision=revision+1, updated_at=now()
       where business_id = ${actor.businessId} and id = ${moneyOperationId}`;

    const snapshot = await moneySnapshot(tx, actor.businessId, moneyOperationId);
    await tx`
      update system.operation_attempts set status='SUCCEEDED', response_status=200, response_body=${JSON.stringify(snapshot)}::jsonb, completed_at=now()
       where operation_id = ${operation.operationId} and business_id = ${actor.businessId}`;

    // El dinero recién confirmado se aplica a su destino con las MISMAS
    // reglas que el cobro original.
    const newlyConfirmed = pending.map((component) => ({
      method: component.method,
      amountMinor: component.amountMinor,
      tenderedMinor: component.tenderedMinor ?? undefined,
      changeMinor: component.changeMinor,
      accredited: component.accredited ?? undefined,
      outcome: component.outcome === "UNKNOWN" ? ("CONFIRMED" as const) : component.outcome,
      reference: component.externalReference ?? input.evidenceReference,
      evidenceReference: input.evidenceReference
    } as MoneyComponent));
    await applyConfirmedPortion(tx, actor, operationId, moneyOperationId, newlyConfirmed, {
      saleId: operation.saleId ?? undefined,
      obligationId: operation.obligationId ?? undefined
    });

    await audit(tx, {
      actor, operationId, action: "money.resolve_succeeded", capability: "operations.resolve",
      resourceType: "MONEY_OPERATION", resourceId: moneyOperationId,
      changes: { evidence: input.evidenceReference, confirmedMinor }
    });
    return moneySnapshot(tx, actor.businessId, moneyOperationId);
  });
}

/* ─────────────────────────────── reconciliación ────────────────────────── */

export async function reconcileMoney(actor: Actor, body: unknown, operationId: string) {
  requireCapability(actor, "money.reconcile");
  const input = moneyReconciliationInputSchema.parse(body);

  return executeOperation({ actor, operationId, command: "money.reconcile", payload: input }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const [session] = await tx`
      select id, opening_amount_minor::int "openingAmountMinor", status::text status
        from cash.cash_sessions where business_id = ${actor.businessId} and id = ${input.cashSessionId}`;
    if (!session) throw missing("esa sesión de caja");
    if (session.status !== "OPEN") throw new DomainError("CASH_SESSION_CLOSED", "La sesión de caja está cerrada", 409);

    const [movements] = await tx`
      select coalesce(sum(case when type in ('INCOME','SALE_CASH') then amount_minor else -amount_minor end),0)::int total
        from cash.cash_movements where business_id = ${actor.businessId} and cash_session_id = ${input.cashSessionId}`;
    const expected = Number(session.openingAmountMinor) + Number(movements?.total ?? 0);
    if (expected !== input.expectedAmountMinor) {
      throw new DomainError("STALE_REVISION", "El efectivo esperado cambió. Revisá el estado actual de la caja.", 409, { currentExpectedMinor: expected });
    }
    const difference = input.observedAmountMinor - input.expectedAmountMinor;
    const [row] = await tx`
      insert into money.money_reconciliations(business_id,cash_session_id,expected_amount_minor,observed_amount_minor,difference_minor,reason,actor_account_id,operation_id)
      values (${actor.businessId},${input.cashSessionId},${input.expectedAmountMinor},${input.observedAmountMinor},${difference},${input.reason},${actor.accountId},${operationId})
      returning id, difference_minor::int "differenceMinor", created_at "createdAt"`;
    await audit(tx, {
      actor, operationId, action: "money.reconcile", capability: "money.reconcile",
      resourceType: "CASH_SESSION", resourceId: input.cashSessionId,
      changes: { expectedMinor: input.expectedAmountMinor, observedMinor: input.observedAmountMinor, differenceMinor: difference, reason: input.reason }
    });
    return { reconciliationId: String(row!.id), expectedAmountMinor: input.expectedAmountMinor, observedAmountMinor: input.observedAmountMinor, differenceMinor: difference, createdAt: new Date(row!.createdAt as Date).toISOString() };
  });
}
