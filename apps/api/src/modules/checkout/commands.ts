import { randomUUID } from "node:crypto";
import { DomainError, createCheckoutSchema, resumeCheckoutSchema, sumConfirmedAmounts, type MoneyComponent } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { audit, executeOperation, prepareDurableOperation, settleDurableOperation } from "../system/operations.js";
import { database } from "../../lib/runtime.js";
import { assertActorStillAuthorized, checkRevision, conflict, lockBusiness, missing, requireCapability } from "../h05/domain.js";
import { checkoutSnapshot, issueCheckoutAuthority, loadCheckout, productLinesOf } from "./domain.js";
import { applyConfirmedPortion, assertExternalEvidence, insertMoneyOperation, performRefund } from "../money/commands.js";
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

/**
 * Parámetros INTERNOS server-to-server (T-05/T-08, CORR-04). Nunca se leen
 * del body HTTP: `sourceReference` se deriva en servidor desde un pedido
 * validado y `reuseCommitments` se decide por la existencia de compromisos
 * ACTIVOS de ese pedido, jamás por un flag del cliente.
 */
export type CheckoutInternal = {
  sourceReference?: string;
  reuseCommitments?: boolean;
};

/** Igualdad agregada (sku, location_id, sum(quantity)) sin segunda reserva. */
async function assertReusedCommitments(
  tx: Parameters<typeof productLinesOf>[0],
  businessId: string,
  sourceReference: string,
  productLines: Array<{ sku: string; locationId: string; quantity: number }>
): Promise<string[]> {
  const rows = await tx`
    select id, sku, location_id "locationId", quantity::int quantity
      from inventory.commitments
     where business_id = ${businessId} and source_reference = ${sourceReference}
       and state = 'ACTIVE' for update`;
  const actual = new Map<string, number>();
  for (const row of rows) {
    const key = `${String(row.sku)}|${String(row.locationId)}`;
    actual.set(key, (actual.get(key) ?? 0) + Number(row.quantity));
  }
  const expected = new Map<string, number>();
  for (const line of productLines) {
    const key = `${line.sku}|${line.locationId}`;
    expected.set(key, (expected.get(key) ?? 0) + line.quantity);
  }
  if (actual.size !== expected.size) throw new DomainError("DELIVERY_SKU_MISMATCH", "Los compromisos no coinciden con las líneas de la venta", 409);
  for (const [key, quantity] of expected) {
    if (actual.get(key) !== quantity) throw new DomainError("DELIVERY_QUANTITY_MISMATCH", "La cantidad comprometida no coincide con la venta", 409);
  }
  return rows.map((row) => String(row.id));
}

export async function createCheckout(actor: Actor, body: unknown, operationId: string, internal?: CheckoutInternal) {
  requireCapability(actor, "checkout.create");
  const input = createCheckoutSchema.parse(body);
  assertExternalEvidence(input.components as MoneyComponent[]);
  const checkoutId = randomUUID();
  // Origen de verdad del sourceReference: servidor. El valor interno sólo
  // puede ser una referencia `order:<uuid-v4>`; nunca viene del request HTTP.
  const supplied = internal?.sourceReference;
  if (supplied !== undefined && !/^order:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied)) {
    throw new DomainError("VALIDATION_ERROR", "sourceReference interno inválido", 400);
  }

  const prepared = await executeOperation({
    actor, operationId, command: "checkout.create",
    payload: { ...input, checkoutId, internal: internal ?? null }
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
    const sourceReference = supplied ?? `checkout:${checkoutId}`;
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
    // H06 (reuseCommitments=true): NO se reserva de nuevo; se valida la
    // igualdad agregada de los compromisos ACTIVOS del pedido (T-05/T-43).
    const productLines = await productLinesOf(tx, actor.businessId, input.saleId);
    let commitmentIds: string[] = [];
    if (productLines.length) {
      if (internal?.reuseCommitments && supplied) {
        commitmentIds = await assertReusedCommitments(tx, actor.businessId, supplied, productLines);
      } else {
        const authority = issueCheckoutAuthority({
          id: checkoutId, businessId: actor.businessId, operationId, sourceReference
        }, actor);
        const commitments = await confirmStockCommitments(tx, actor, operationId, productLines.map((line) => ({
          sku: line.sku, locationId: line.locationId, purpose: "SALE", quantity: line.quantity, sourceReference
        })), { kind: "CHECKOUT", checkoutAuth: authority });
        commitmentIds = commitments.map((commitment) => commitment.commitmentId);
      }
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

  // 4 · Entrega física: efecto POSTERIOR, pero SÓLO con cobertura monetaria.
  // D16/F31: un checkout ordinario no se entrega si el dinero externo no fue
  // confirmado. La reserva queda activa y el checkout permanece UNKNOWN para
  // su recuperación por el mismo operation_id.
  const moneyFullyConfirmed = prepared.data.moneyStatus === "SUCCEEDED" && prepared.data.confirmedMinor >= prepared.data.totalMinor;
  if (input.deliver && moneyFullyConfirmed && prepared.data.commitmentIds.length) {
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
    // Un fallo de autoridad NO es una incidencia de entrega: debe propagarse.
    // Convertirlo en DELIVERY_PENDING permitiría que un actor revocado escriba
    // auditoría y modifique el checkout (F34/F37).
    if (error instanceof DomainError && ["SESSION_REVOKED", "FORBIDDEN", "CHECKOUT_AUTH_INVALID", "COMMITMENT_BUSINESS_MISMATCH"].includes(error.code)) {
      throw error;
    }
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
    // F34/F37: la autoridad se revalida DENTRO de la transacción. Una sesión
    // revocada o una capability retirada no debe escribir auditoría ni
    // modificar el checkout, aunque el Actor en memoria conserve la capability.
    await assertActorStillAuthorized(tx, actor, input.resolution === "REFUND" ? "money.refund" : "checkout.resume");
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
    if (input.resolution === "DELIVER") {
      const [money] = await tx`
        select status::text status, confirmed_minor::int "confirmedMinor"
          from money.money_operations
         where business_id = ${actor.businessId} and id = ${checkout.moneyOperationId}`;
      if (!money || String(money.status) !== "SUCCEEDED" || Number(money.confirmedMinor) < checkout.totalMinor) {
        throw new DomainError("MONEY_NOT_CONFIRMED", "No se puede entregar sin cobertura monetaria confirmada", 409, {
          confirmedMinor: Number(money?.confirmedMinor ?? 0), requiredMinor: checkout.totalMinor
        });
      }
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
