import { randomUUID } from "node:crypto";
import { DomainError, createCheckoutSchema, resumeCheckoutSchema, sumConfirmedAmounts, type MoneyComponent } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { audit, executeOperation, prepareDurableOperation, settleDurableOperation } from "../system/operations.js";
import { database } from "../../lib/runtime.js";
import { assertActorStillAuthorized, checkRevision, conflict, lockBusiness, missing, requireCapability } from "../h05/domain.js";
import { checkoutSnapshot, issueCheckoutAuthority, loadCheckout, productLinesOf } from "./domain.js";
import { applyConfirmedPortion, insertMoneyOperation, performRefund } from "../money/commands.js";
import { deriveOperationStatus } from "../money/domain.js";
import { confirmStockCommitments, deliverStockCommitments } from "../inventory/commitments.js";

/**
 * H05 · CAP-05-06 Checkout · orquestador.
 *
 * Orden de la coordinación (C01.9):
 *   Sale → Money → Cash (cuando corresponda) → InventoryCommitment → Entrega
 *
 * LÍMITES DE ATOMICIDAD (respetados, no maquillados):
 *  · Venta + dinero + efectivo + RESERVA de stock son atómicos: una sola
 *    transacción. Si el stock no alcanza, NO se cobra nada (F31/F32).
 *  · La ENTREGA FÍSICA es un efecto POSTERIOR: si falla después de que el
 *    dinero quedó confirmado, se preservan AMBOS hechos y se abre una
 *    INCIDENCIA RECUPERABLE (F33). Nunca un `InventoryMovement` falso,
 *    nunca un refund automático, nunca un cobro duplicado.
 *  · La reanudación usa SIEMPRE el `operation_id` original: no se crea un
 *    nuevo intento para recuperar un cobro incierto.
 *
 * AUTORIDAD (D24/F37): el operador necesita `checkout.create`. NO necesita
 * `inventory.operate` general: la ejecución física la realiza la frontera
 * interna H05→H04 con la autoridad del checkout validado, conservando el
 * actor real para auditoría.
 */

export async function createCheckout(actor: Actor, body: unknown, operationId: string) {
  requireCapability(actor, "checkout.create");
  const input = createCheckoutSchema.parse(body);
  const checkoutId = randomUUID();

  const prepared = await executeOperation({
    actor, operationId, command: "checkout.create",
    payload: { ...input, checkoutId }
  }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    await assertActorStillAuthorized(tx, actor, "checkout.create");

    // 1 · Venta: debe existir, ser del mismo Business y estar CONFIRMABLE.
    const [sale] = await tx`
      select id, status::text status, total_minor::int "totalMinor", revision::int revision, source::text source
        from sales.sales where business_id = ${actor.businessId} and id = ${input.saleId} for update`;
    if (!sale) throw missing("esa venta");
    if (sale.status === "CANCELLED") throw conflict("La venta está anulada");
    if (sale.status === "DRAFT") {
      await tx`
        update sales.sales set status='CONFIRMED', confirmed_at=now(), revision=revision+1, updated_at=now()
         where business_id = ${actor.businessId} and id = ${input.saleId} and status = 'DRAFT'`;
      const [confirmed] = await tx`select status::text status from sales.sales where business_id = ${actor.businessId} and id = ${input.saleId}`;
      if (String(confirmed?.status) !== "CONFIRMED") throw conflict("La venta cambió concurrentemente");
    }
    const totalMinor = Number(sale.totalMinor);
    if (totalMinor <= 0) throw new DomainError("SALE_LINE_INVALID", "La venta no tiene importe", 409);

    // 2 · Dinero: se registra UNA sola vez con el operation_id del checkout.
    const components = input.components as MoneyComponent[];
    const moneyStatus = deriveOperationStatus(components);
    const confirmedMinor = sumConfirmedAmounts(components);
    const sourceReference = `checkout:${checkoutId}`;
    const [checkout] = await tx`
      insert into checkout.checkouts(id,business_id,operation_id,sale_id,status,total_minor,confirmed_minor,source_reference,actor_account_id)
      values (${checkoutId},${actor.businessId},${operationId},${input.saleId},'PENDING',${totalMinor},${confirmedMinor},${sourceReference},${actor.accountId})
      returning id`;
    if (!checkout) throw conflict("No pudimos registrar el checkout");

    const moneyOperationId = await insertMoneyOperation(tx, actor, operationId, {
      kind: "PAYMENT",
      saleId: input.saleId,
      cashSessionId: input.cashSessionId,
      components,
      payerName: input.payerName,
      receiverStaffMemberId: input.receiverStaffMemberId,
      economicHolderName: input.economicHolderName,
      note: input.note
    }, moneyStatus === "SUCCEEDED" ? "SUCCEEDED" : moneyStatus);
    await applyConfirmedPortion(tx, actor, operationId, moneyOperationId, components, {
      saleId: input.saleId,
      cashSessionId: input.cashSessionId
    });

    // 3 · Reserva física: dentro de la MISMA transacción que el dinero. Si el
    // stock no alcanza, esta transacción se revierte y no se cobró nada.
    const productLines = await productLinesOf(tx, actor.businessId, input.saleId);
    let commitmentIds: string[] = [];
    if (productLines.length) {
      const authority = issueCheckoutAuthority({
        id: checkoutId, businessId: actor.businessId, operationId, sourceReference
      }, actor);
      const commitments = await confirmStockCommitments(tx, actor, operationId, productLines.map((line) => ({
        sku: line.sku, locationId: line.locationId, purpose: "SALE", quantity: line.quantity, sourceReference
      })), { kind: "CHECKOUT", checkoutAuth: authority });
      commitmentIds = commitments.map((commitment) => commitment.commitmentId);
    }

    const nextStatus = confirmedMinor >= totalMinor
      ? (productLines.length ? "MONEY_CONFIRMED" : "DELIVERED")
      : (confirmedMinor > 0 ? "MONEY_CONFIRMED" : (moneyStatus === "UNKNOWN" ? "UNKNOWN" : "MONEY_CONFIRMED"));
    await tx`
      update checkout.checkouts
         set status=${nextStatus}, money_operation_id=${moneyOperationId}, cash_session_id=${input.cashSessionId ?? null},
             confirmed_minor=${confirmedMinor}, revision=revision+1, updated_at=now()
       where business_id = ${actor.businessId} and id = ${checkoutId}`;

    await audit(tx, {
      actor, operationId, action: "checkout.create", capability: "checkout.create",
      resourceType: "CHECKOUT", resourceId: checkoutId,
      changes: { saleId: input.saleId, totalMinor, confirmedMinor, moneyStatus, deliver: input.deliver, productLines: productLines.length }
    });

    return { checkoutId, moneyOperationId, commitmentIds, status: nextStatus, totalMinor, confirmedMinor, operationId, moneyStatus };
  });

  // S33: el estado durable del intento refleja el resultado REAL del cobro,
  // no el éxito local del comando de checkout. Un cobro externo UNKNOWN no
  // puede presentarse como SUCCEEDED por el solo hecho de que el checkout
  // haya persistido sus hechos locales.
  if (prepared.data.moneyStatus !== "SUCCEEDED") {
    const durableStatus = prepared.data.moneyStatus === "UNKNOWN" ? "UNKNOWN" : "STARTED";
    await database.client`
      update system.operation_attempts
         set status = ${durableStatus}, completed_at = null
       where operation_id = ${operationId} and business_id = ${actor.businessId} and status = 'SUCCEEDED'`;
  }

  // 4 · Entrega física: efecto POSTERIOR. Un fallo NO borra el dinero: abre
  // una incidencia recuperable (F33).
  if (input.deliver && prepared.data.commitmentIds.length) {
    await attemptDelivery(actor, prepared.data.checkoutId, prepared.data.commitmentIds);
  }

  const snapshot = await database.client.begin(async (tx) => checkoutSnapshot(tx, actor.businessId, prepared.data.checkoutId));
  return { data: snapshot, replayed: prepared.replayed };
}

/**
 * Entrega física del checkout. Es una transacción propia: si falla, el
 * dinero confirmado y la venta permanecen, y el checkout queda en
 * DELIVERY_PENDING con el motivo de la incidencia.
 */
async function attemptDelivery(actor: Actor, checkoutId: string, commitmentIds: string[]): Promise<{ delivered: boolean; reason?: string }> {
  // La entrega física es un EFECTO POSTERIOR con su propio intento durable.
  // No reutiliza el `operation_id` del cobro: H04 exige que el movimiento
  // físico se appende a un intento que siga STARTED (trigger `project_entry`).
  const deliveryOperationId = randomUUID();
  const command = "checkout.delivery";
  const payload = { checkoutId, commitmentIds };
  try {
    await prepareDurableOperation({ operationId: deliveryOperationId, command, actor, payload });
    await settleDurableOperation({
      operationId: deliveryOperationId, command, actor, payload,
      handler: async (tx) => {
        await lockBusiness(tx, actor.businessId);
        const checkout = await loadCheckout(tx, actor.businessId, checkoutId, true);
        const authority = issueCheckoutAuthority({
          id: checkout.id, businessId: actor.businessId, operationId: checkout.operationId, sourceReference: checkout.sourceReference
        }, actor);
        const result = await deliverStockCommitments(tx, actor, commitmentIds, deliveryOperationId, { kind: "CHECKOUT", checkoutAuth: authority });
        await tx`
          update checkout.checkouts set status='DELIVERED', incident_reason=null, revision=revision+1, updated_at=now()
           where business_id = ${actor.businessId} and id = ${checkoutId}`;
        await audit(tx, {
          actor, operationId: deliveryOperationId, action: "checkout.delivered", capability: "checkout.create",
          resourceType: "CHECKOUT", resourceId: checkoutId, changes: { commitmentIds, movementId: result.movementId }
        });
        return { movementId: result.movementId };
      }
    });
    return { delivered: true };
  } catch (error) {
    const reason = error instanceof DomainError ? error.message : "La entrega física no pudo confirmarse";
    await database.client.begin(async (tx) => {
      await tx`
        update checkout.checkouts set status='DELIVERY_PENDING', incident_reason=${reason}, revision=revision+1, updated_at=now()
         where business_id = ${actor.businessId} and id = ${checkoutId}`;
      await audit(tx, {
        actor, operationId: deliveryOperationId, action: "checkout.delivery_pending", capability: "checkout.create",
        resourceType: "CHECKOUT", resourceId: checkoutId, outcome: "UNKNOWN", changes: { reason }
      });
    });
    return { delivered: false, reason };
  }
}

/**
 * Reanudación de una incidencia (WP-05-T03).
 *
 * · DELIVER → reintenta la entrega física. NO vuelve a cobrar.
 * · REFUND  → refund explícito y autorizado (hecho monetario nuevo).
 *
 * Ninguna otra acción existe: no hay refund automático ni cobro automático.
 */
export async function resumeCheckout(actor: Actor, checkoutId: string, body: unknown, operationId: string) {
  const input = resumeCheckoutSchema.parse(body);
  requireCapability(actor, input.resolution === "REFUND" ? "money.refund" : "checkout.resume");

  const result = await executeOperation({
    actor, operationId, command: "checkout.resume",
    payload: { checkoutId, ...input }
  }, async (tx) => {
    await lockBusiness(tx, actor.businessId);
    const checkout = await loadCheckout(tx, actor.businessId, checkoutId, true);
    checkRevision(checkout.revision, input.expectedRevision);
    if (checkout.status === "DELIVERED") throw new DomainError("CHECKOUT_ALREADY_DELIVERED", "El checkout ya fue entregado", 409);
    if (checkout.status === "RESOLVED") throw conflict("El checkout ya fue resuelto");
    // Un anticipo (deliver:false) queda MONEY_CONFIRMED y se entrega después;
    // una incidencia queda DELIVERY_PENDING. Ambas estados admiten DELIVER.
    const deliveryAllowed = checkout.status === "DELIVERY_PENDING" || checkout.status === "MONEY_CONFIRMED";
    if (!deliveryAllowed || (input.resolution === "REFUND" && checkout.status !== "DELIVERY_PENDING")) {
      throw new DomainError("CHECKOUT_RESOLUTION_NOT_ALLOWED", "Este checkout no admite esa resolución en su estado actual", 409, { status: checkout.status });
    }
    await audit(tx, {
      actor, operationId, action: "checkout.resume", capability: input.resolution === "REFUND" ? "money.refund" : "checkout.resume",
      resourceType: "CHECKOUT", resourceId: checkoutId, changes: { resolution: input.resolution, reason: input.reason }
    });
    if (input.resolution === "REFUND") {
      if (!checkout.moneyOperationId) throw conflict("El checkout no tiene una operación de dinero que reembolsar");
      await performRefund(tx, actor, checkout.moneyOperationId, {
        amountMinor: checkout.confirmedMinor,
        reason: input.reason,
        evidenceReference: `checkout:${checkoutId}`
      }, operationId);
      await tx`
        update checkout.checkouts set status='RESOLVED', incident_reason=null, revision=revision+1, updated_at=now()
         where business_id = ${actor.businessId} and id = ${checkoutId}`;
    }
    return {
      checkoutId,
      resolution: input.resolution,
      moneyOperationId: checkout.moneyOperationId,
      confirmedMinor: checkout.confirmedMinor,
      sourceReference: checkout.sourceReference,
      operationId: checkout.operationId
    };
  });

  if (result.data.resolution === "DELIVER") {
    const rows = await database.client`
      select id from inventory.commitments
       where business_id = ${actor.businessId} and source_reference = ${result.data.sourceReference}
         and state = 'ACTIVE' order by id`;
    const ids = (rows as unknown as Array<{ id: string }>).map((row) => String(row.id));
    if (!ids.length) throw conflict("No hay compromisos activos para entregar");
    await attemptDelivery(actor, checkoutId, ids);
  }

  const snapshot = await database.client.begin(async (tx) => checkoutSnapshot(tx, actor.businessId, checkoutId));
  return { data: snapshot, replayed: result.replayed };
}
