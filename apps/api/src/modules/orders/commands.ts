/**
 * H06 · Comandos comerciales.
 *
 * Siete comandos ordinarios (request/confirm/reject/cancel/prepare/ready/
 * deliver) + dos flujos diferenciados (excepción D22/Q42 y reemisión H03).
 * Ninguno crea un segundo ledger: inventario es H04, dinero es H05,
 * auditoría es H01 (`system.audit_events`).
 */
import { randomUUID } from "node:crypto";
import {
  DomainError, orderRequestInput, orderRevisionInput, orderRejectInput,
  orderCancelInput, orderPrepareInput, orderReadyInput, orderDeliverInput,
  orderExceptionInput, orderCredentialReissueInput,
  type Capability, type OrderStatus
} from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import {
  durableAttemptState, executeOperation, executePrincipalOperation,
  prepareDurableOperation, settleDurableOperation,
  type OperationPrincipal, type Tx
} from "../system/operations.js";
import { database } from "../../lib/runtime.js";
import { assertActorStillAuthorized, lockBusiness, requireCapability } from "../h05/domain.js";
import { confirmStockCommitments, releaseStockCommitments, type OrderAuthority } from "../inventory/commitments.js";
import { issueOpaqueToken } from "../../lib/security/opaque-token.js";
import { issueOrderCredentialTx, reissueOrderCredentialTx } from "../client-auth/order-credential.js";
import { createSale } from "../sales/commands.js";
import { createCheckout } from "../checkout/commands.js";
import {
  assertOrderAccess, auditOrderEvent, auditWithActor, checkRevision, confirmedSnapshotOf,
  insertOrder, insertOrderLines, loadOrder, loadOrderLines, lockOrderBusiness,
  orderView, requestedSnapshotOf, resolvePublicLines, resolveVendibleLocation,
  sourceReferenceOf, stateInvalid, verifiedClientProfile,
  type OrderPrincipal
} from "./domain.js";

function authorityFor(orderId: string, businessId: string, operationId: string, accountId: string, capability: OrderAuthority["capability"]): OrderAuthority {
  return {
    orderId, businessId, operationId,
    expectedSourceReference: sourceReferenceOf(orderId),
    actorAccountId: accountId, capability
  };
}

async function assertStaff(tx: Tx, actor: Actor, capability: Capability): Promise<void> {
  requireCapability(actor, capability);
  await assertActorStillAuthorized(tx, actor, capability);
}

/** Q29: todo acceso denegado por scope deja un evento DENIED inmutable. */
async function withDeniedAudit<T>(actor: Actor, operationId: string, capability: string, orderId: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) {
    if (error instanceof DomainError && ["ORDER_NOT_FOUND", "ORDER_NOT_OWNED", "ORDER_CREDENTIAL_INVALID", "ORDER_CREDENTIAL_REVOKED"].includes(error.code)) {
      await database.client.begin((tx) => auditOrderEvent(tx, {
        businessId: actor.businessId, actorAccountId: actor.accountId, operationId,
        action: "order.access.denied", capability, orderId,
        changes: { code: error.code }, outcome: "DENIED"
      }));
    }
    throw error;
  }
}

/* ─────────────────────────── order.request ─────────────────────────── */

export async function orderRequest(
  principal: OrderPrincipal,
  body: unknown,
  operationId: string
): Promise<{ data: Record<string, unknown>; replayed: boolean }> {
  const input = orderRequestInput.parse(body);
  // El borrador vive en el frontend: aquí ya hay envío confirmado (Q10).
  const tokenPair = principal.kind === "GUEST" ? issueOpaqueToken() : null;

  const operationPrincipal: OperationPrincipal =
    principal.kind === "STAFF"
      ? { kind: "STAFF", businessId: principal.actor.businessId, accountId: principal.actor.accountId }
      : principal.kind === "CLIENT"
        ? { kind: "CLIENT", businessId: principal.businessId, accountId: principal.accountId }
        : { kind: "GUEST_INTENT", businessId: principal.businessId, intentId: randomUUID(), proofDigest: tokenPair!.digest };

  const result = await executePrincipalOperation({
    operationId, command: "order.request", principal: operationPrincipal, payload: input
  }, async (tx) => {
    if (principal.kind === "STAFF") await assertStaff(tx, principal.actor, "orders.create");
    const businessId = operationPrincipal.businessId;
    const clientProfileId = principal.kind === "CLIENT"
      ? await verifiedClientProfile(tx, businessId, principal.accountId)
      : null;
    if (principal.kind === "CLIENT" && input.clientProfileId && input.clientProfileId !== clientProfileId) {
      throw new DomainError("ORDER_NOT_OWNED", "El perfil indicado no pertenece al cliente autenticado", 404);
    }

    const resolved = await resolvePublicLines(tx, businessId, input.lines);
    const total = resolved.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
    const order = await insertOrder(tx, {
      businessId, operationId,
      customerKind: principal.kind === "CLIENT" ? "CLIENT" : "GUEST",
      clientProfileId,
      customerAccountId: principal.kind === "CLIENT" ? principal.accountId : null,
      credentialId: null,
      createdByAccountId: principal.kind === "STAFF" ? principal.actor.accountId : null,
      snapshot: requestedSnapshotOf(resolved, total), totalRequestedMinor: total
    });
    await insertOrderLines(tx, businessId, order.id, resolved);

    let credentialId: string | null = null;
    if (principal.kind === "GUEST") {
      const credential = await issueOrderCredentialTx(tx, businessId, order.id, tokenPair!);
      credentialId = credential.credentialId;
      await tx`update orders.product_orders set credential_id=${credentialId} where business_id=${businessId} and id=${order.id}`;
    }
    await auditOrderEvent(tx, {
      businessId, actorAccountId: principal.kind === "STAFF" ? principal.actor.accountId : null,
      operationId, action: "order.requested", capability: "orders.create",
      orderId: order.id, changes: { customerKind: order.customerKind, lines: resolved.length, credentialId }
    });
    return await orderView(tx, businessId, order.id);
  });

  // El token de invitado NO se persiste en `operation_attempts.response_body`;
  // en un replay no se re-emite (el cliente ya lo recibió en la primera respuesta).
  const credential = tokenPair && !result.replayed
    ? { token: tokenPair.token, proofDigest: tokenPair.digest }
    : undefined;
  return { data: { ...result.data, ...(credential ? { credential } : {}) }, replayed: result.replayed };
}

/* ─────────────────────────── order.confirm (Q13) ────────────────────── */

export async function orderConfirm(actor: Actor, orderId: string, body: unknown, operationId: string) {
  const input = orderRevisionInput.parse(body);
  return await withDeniedAudit(actor, operationId, "orders.confirm", orderId, async () => {
  const result = await executeOperation({
    actor, operationId, command: "order.confirm", payload: { orderId, ...input }
  }, async (tx) => {
    await assertStaff(tx, actor, "orders.confirm");
    await lockOrderBusiness(tx, actor.businessId);
    const order = await loadOrder(tx, actor.businessId, orderId, true);
    checkRevision(order.revision, input.expectedRevision);
    if (order.status !== "REQUESTED") throw stateInvalid("Sólo se puede confirmar un pedido REQUESTED", { status: order.status });

    const lines = await loadOrderLines(tx, actor.businessId, orderId);
    if (!lines.length || lines.length > 50) throw stateInvalid("El pedido debe tener entre 1 y 50 líneas");

    // D15: revalidación de precio contra el catálogo vigente; informar o
    // rechazar, nunca contraoferta automática. Todo dentro de la misma Tx.
    for (const line of lines) {
      const [item] = await tx`select price_minor::int "priceMinor" from inventory.items where business_id=${actor.businessId} and sku=${line.sku}`;
      if (!item) throw new DomainError("ORDER_NOT_FOUND", `El artículo ${line.sku} ya no existe`, 404);
      if (Number(item.priceMinor) !== line.unitPriceMinor) {
        throw new DomainError("PRICE_CHANGED", `El precio de ${line.sku} cambió`, 409, {
          sku: line.sku, requested: line.unitPriceMinor, current: Number(item.priceMinor)
        });
      }
    }
    // El catálogo público no revela ubicaciones: se resuelven aquí, antes de
    // fijar confirmed_at, por lo que `guard_confirmed_line` no se activa.
    for (const line of lines) {
      if (line.locationId) continue;
      const locationId = await resolveVendibleLocation(tx, actor.businessId, line.sku, line.quantity);
      await tx`update orders.order_lines set location_id=${locationId}, revision=revision+1 where business_id=${actor.businessId} and id=${line.id}`;
      line.locationId = locationId;
    }

    const sourceReference = sourceReferenceOf(order.id);
    const commitments = await confirmStockCommitments(
      tx, actor, operationId,
      lines.map((line) => ({
        sku: line.sku, locationId: line.locationId!, purpose: "SALE" as const,
        quantity: line.quantity, sourceReference
      })),
      { kind: "ORDER", orderAuth: authorityFor(order.id, actor.businessId, order.operationId, actor.accountId, "orders.confirm") }
    );

    const [complete] = await tx`select orders.assert_complete_lines(${order.id},${actor.businessId}) as ok`;
    if (!complete?.ok) throw new DomainError("INCOMPLETE_COMMITMENT_SET", "El conjunto de compromisos quedó incompleto", 409);

    for (const line of lines) {
      await tx`
        update orders.order_lines
           set confirmed_price_minor=${line.unitPriceMinor}, confirmed_quantity=${line.quantity},
               confirmed_at=now(), revision=revision+1
         where business_id=${actor.businessId} and id=${line.id}`;
    }
    const snapshot = confirmedSnapshotOf(lines);
    await tx`
      update orders.product_orders
         set status='CONFIRMED', confirmed_snapshot=${JSON.stringify(snapshot)}::jsonb,
             total_confirmed_minor=${snapshot.totalMinor}, revision=revision+1, updated_at=now()
       where business_id=${actor.businessId} and id=${order.id}`;
    await auditWithActor(tx, actor, {
      operationId, action: "order.confirmed", capability: "orders.confirm", orderId: order.id,
      changes: { fromStatus: "REQUESTED", toStatus: "CONFIRMED", commitments: commitments.length, totalMinor: snapshot.totalMinor }
    });
    return await orderView(tx, actor.businessId, order.id);
  });
  return result;
  });
}

/* ─────────────────────────── transiciones simples ──────────────────── */

async function simpleTransition(
  actor: Actor, orderId: string, input: { expectedRevision: number } & Record<string, unknown>, operationId: string,
  capability: Capability, from: OrderStatus, to: OrderStatus, action: string,
  extra: (tx: Tx, order: Awaited<ReturnType<typeof loadOrder>>, input: { expectedRevision: number } & Record<string, unknown>) => Promise<object>,
  rejectionReason?: string
): Promise<{ data: Record<string, unknown>; replayed: boolean }> {
  return executeOperation({
    actor, operationId, command: `order.${action.replace("order.", "")}`, payload: { orderId, ...input }
  }, async (tx) => {
    await assertStaff(tx, actor, capability);
    await lockOrderBusiness(tx, actor.businessId);
    const order = await loadOrder(tx, actor.businessId, orderId, true);
    checkRevision(order.revision, input.expectedRevision);
    if (order.status !== from) throw stateInvalid(`El pedido debe estar en ${from}`, { status: order.status });
    const changes = await extra(tx, order, input);
    if (rejectionReason !== undefined) {
      await tx`
        update orders.product_orders
           set status=${to}, rejection_reason=${rejectionReason}, revision=revision+1, updated_at=now()
         where business_id=${actor.businessId} and id=${orderId}`;
    } else {
      await tx`
        update orders.product_orders set status=${to}, revision=revision+1, updated_at=now()
         where business_id=${actor.businessId} and id=${orderId}`;
    }
    await auditWithActor(tx, actor, {
      operationId, action, capability, orderId,
      changes: { ...changes, fromStatus: from, toStatus: to }
    });
    return await orderView(tx, actor.businessId, orderId);
  });
}

export async function orderReject(actor: Actor, orderId: string, body: unknown, operationId: string) {
  const input = orderRejectInput.parse(body);
  return simpleTransition(actor, orderId, input, operationId, "orders.reject", "REQUESTED", "REJECTED", "order.rejected",
    async () => ({ reason: input.reason }), input.reason);
}

export async function orderPrepare(actor: Actor, orderId: string, body: unknown, operationId: string) {
  const input = orderPrepareInput.parse(body);
  return simpleTransition(actor, orderId, input, operationId, "orders.prepare", "CONFIRMED", "PREPARING", "order.prepared",
    async () => ({ checklist: input.checklist ?? [] }));
}

export async function orderReady(actor: Actor, orderId: string, body: unknown, operationId: string) {
  const input = orderReadyInput.parse(body);
  return simpleTransition(actor, orderId, input, operationId, "orders.ready", "PREPARING", "READY", "order.ready",
    async (tx, order) => {
      const lines = await loadOrderLines(tx, actor.businessId, order.id);
      const verified = new Map(input.verifiedLines.map((line) => [line.sku, line.quantity]));
      const missing = lines.filter((line) => verified.get(line.sku) !== (line.confirmedQuantity ?? line.quantity));
      if (missing.length) {
        throw new DomainError("INCOMPLETE_COMMITMENT_SET", "Faltan líneas verificadas para declarar READY", 409, {
          missing: missing.map((line) => ({ sku: line.sku, quantity: line.confirmedQuantity ?? line.quantity }))
        });
      }
      if (input.missing?.length) {
        await auditWithActor(tx, actor, {
          operationId, action: "order.incident.missing", capability: "orders.ready", orderId: order.id,
          changes: { kind: "MISSING_LINES", missing: input.missing }
        });
      }
      return { verifiedLines: input.verifiedLines.length };
    });
}

/* ─────────────────────────── order.cancel ──────────────────────────── */

export async function orderCancel(principal: OrderPrincipal, orderId: string, body: unknown, operationId: string) {
  const input = orderCancelInput.parse(body);
  const actor = principal.kind === "STAFF" ? principal.actor : null;
  const businessId = principal.kind === "STAFF" ? principal.actor.businessId : principal.businessId;
  const capability: Capability = "orders.cancel";
  const operationPrincipal: OperationPrincipal = principal.kind === "STAFF"
    ? { kind: "STAFF", businessId: principal.actor.businessId, accountId: principal.actor.accountId }
    : principal.kind === "CLIENT"
      ? { kind: "CLIENT", businessId: principal.businessId, accountId: principal.accountId }
      : { kind: "GUEST_INTENT", businessId: principal.businessId, intentId: orderId, proofDigest: "" };
  const result = await executePrincipalOperation({
    operationId, command: "order.cancel", principal: operationPrincipal,
    payload: { orderId, ...input }
  }, async (tx) => {
    if (actor) await assertStaff(tx, actor, capability);
    await lockOrderBusiness(tx, businessId);
    const order = await assertOrderAccess(tx, principal, orderId);
    checkRevision(order.revision, input.expectedRevision);
    const postConfirmed = ["CONFIRMED", "PREPARING", "READY"].includes(order.status);
    if (postConfirmed && actor) {
      await assertStaff(tx, actor, "orders.cancel_confirmed");
    } else if (postConfirmed) {
      throw new DomainError("ORDER_NOT_OWNED", "Sólo el negocio puede cancelar un pedido confirmado", 403);
    }
    if (order.status !== "REQUESTED" && !postConfirmed) throw stateInvalid("No se puede cancelar este pedido", { status: order.status });
    if (order.checkoutId || order.saleId) {
      throw new DomainError("MONEY_BLOCKS_CANCEL", "El pedido ya tiene cobro o entrega iniciada", 409);
    }
    if (postConfirmed) {
      const rows = await tx`select id from inventory.commitments where business_id=${businessId} and source_reference=${sourceReferenceOf(order.id)} and state='ACTIVE'`;
      if (rows.length) {
        await releaseStockCommitments(tx, actor!, rows.map((row) => String(row.id)), order.operationId,
          { kind: "ORDER", orderAuth: authorityFor(order.id, businessId, order.operationId, actor!.accountId, "orders.cancel_confirmed") });
      }
    }
    await tx`
      update orders.product_orders set status='CANCELLED', cancellation_reason=${input.reason},
        revision=revision+1, updated_at=now()
       where business_id=${businessId} and id=${orderId}`;
    await auditOrderEvent(tx, {
      businessId, actorAccountId: actor?.accountId ?? null, operationId,
      action: "order.cancelled", capability: postConfirmed ? "orders.cancel_confirmed" : "orders.cancel",
      orderId, changes: { fromStatus: order.status, toStatus: "CANCELLED", reason: input.reason }
    });
    return await orderView(tx, businessId, orderId);
  });
  return result;
}

/* ─────────────────────────── order.deliver ─────────────────────────── */

/**
 * G01 / Q41/Q43 · Recuperación de hechos causales tras un crash.
 * `order.pickup_prepared` persiste los operationIds de fase ANTES de invocar
 * H05. Si el proceso muere entre Sale y Checkout, el reintento con el MISMO
 * operationId debe reutilizar el `saleId`/`checkoutId` ya persistidos en
 * `operation_attempts.response_body`, nunca crear una segunda Sale.
 */
async function recoverDeliveryFacts(businessId: string, operationId: string): Promise<{ saleId: string | null; checkoutId: string | null }> {
  const [prepared] = await database.client`
    select changes from system.audit_events
     where business_id = ${businessId} and operation_id = ${operationId}
       and action = 'order.pickup_prepared'
     order by occurred_at desc limit 1`;
  const changes = (prepared?.changes ?? {}) as { saleOperationId?: string; checkoutOperationId?: string };
  async function bodyOf(phaseOpId?: string): Promise<Record<string, unknown> | null> {
    if (!phaseOpId) return null;
    const [attempt] = await database.client`
      select response_body from system.operation_attempts
       where business_id = ${businessId} and operation_id = ${phaseOpId}`;
    return (attempt?.response_body ?? null) as Record<string, unknown> | null;
  }
  const saleBody = await bodyOf(changes.saleOperationId);
  const checkoutBody = await bodyOf(changes.checkoutOperationId);
  return {
    saleId: saleBody && typeof saleBody.saleId === "string" ? saleBody.saleId : null,
    checkoutId: checkoutBody && typeof checkoutBody.id === "string" ? checkoutBody.id : null
  };
}

async function latestDeliveryMovement(tx: Tx, businessId: string, orderId: string): Promise<string | null> {
  const rows = await tx`
    select id from inventory.movements
     where business_id=${businessId} and kind='DELIVERY' and source_reference=${sourceReferenceOf(orderId)}
     order by created_at desc limit 1`;
  return rows.length ? String(rows[0]!.id) : null;
}

/**
 * Entrega = SECUENCIA de operaciones durables, no una Tx ACID extremo a
 * extremo (X-11/P0-1). Cada fase tiene su propio operationId v4. Los IDs de
 * Sale y Checkout se auditan ANTES de invocar H05 y se reutilizan en un
 * reintento, de modo que nunca hay doble cobro ni doble entrega.
 */
export async function orderDeliver(actor: Actor, orderId: string, body: unknown, operationId: string) {
  const input = orderDeliverInput.parse(body);
  requireCapability(actor, "orders.deliver");
  requireCapability(actor, "checkout.create");

  // Replay: si la operación ya terminó, devolver el resultado durable.
  try {
    const previous = await durableAttemptState(operationId, actor);
    if (previous.semantic === "SUCCEEDED" && previous.responseBody) {
      return { data: previous.responseBody as Record<string, unknown>, replayed: true };
    }
  } catch (error) {
    if (!(error instanceof DomainError && error.code === "NOT_FOUND")) throw error;
  }

  const phaseIds = {
    sale: randomUUID(), checkout: randomUUID(), delivery: randomUUID()
  };
  const deliverPayload = { orderId, expectedRevision: input.expectedRevision, receiver: input.receiver };
  // Frontera de preparación: el intento durable existe ANTES del primer
  // evento de auditoría (FK `audit_events_operation_id_fkey`) y antes de
  // invocar a H05. Un crash posterior deja un intento recuperable.
  await prepareDurableOperation({
    operationId, command: "order.deliver", actor, payload: deliverPayload
  });
  const current = await database.client.begin(async (tx) => {
    await assertStaff(tx, actor, "orders.deliver");
    return await loadOrder(tx, actor.businessId, orderId);
  });
  checkRevision(current.revision, input.expectedRevision);
  if (current.status !== "READY") throw stateInvalid("El pedido debe estar READY para retirarlo", { status: current.status });

  // Hechos causales previstos, auditados ANTES de invocar H05 (X-11).
  await database.client.begin(async (tx) => {
    await auditWithActor(tx, actor, {
      operationId, action: "order.pickup_prepared", capability: "orders.deliver", orderId,
      changes: { saleOperationId: phaseIds.sale, checkoutOperationId: phaseIds.checkout, deliveryOperationId: phaseIds.delivery }
    });
  });

  const confirmed = current.confirmedSnapshot as { items?: Array<{ sku: string; locationId: string | null; name: string; quantity: number; unitPriceMinor: number }> } | null;
  if (!confirmed?.items?.length) throw stateInvalid("El pedido no tiene un snapshot confirmado");

  const recovered = await recoverDeliveryFacts(actor.businessId, operationId);
  let saleId = current.saleId ?? recovered.saleId;
  if (saleId && saleId !== current.saleId) {
    await database.client`update orders.product_orders set sale_id=${saleId} where business_id=${actor.businessId} and id=${orderId} and sale_id is null`;
  }
  if (!saleId) {
    const sale = await createSale(actor, {
      lines: confirmed.items.map((line) => ({
        kind: "PRODUCT" as const, sku: line.sku,
        locationId: line.locationId ?? undefined,
        name: line.name, quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor, discountMinor: 0
      })),
      note: `Order ${orderId}`
    }, phaseIds.sale, { confirmedOrderId: orderId });
    saleId = String(sale.data.saleId);
    await database.client`update orders.product_orders set sale_id=${saleId} where business_id=${actor.businessId} and id=${orderId} and sale_id is null`;
  }

  let checkoutId = current.checkoutId ?? recovered.checkoutId;
  if (checkoutId && checkoutId !== current.checkoutId) {
    await database.client`update orders.product_orders set checkout_id=${checkoutId} where business_id=${actor.businessId} and id=${orderId} and checkout_id is null`;
  }
  if (!checkoutId) {
    const checkout = await createCheckout(actor, {
      saleId,
      components: input.components,
      cashSessionId: input.cashSessionId,
      payerName: input.receiver.name,
      deliver: true
    }, phaseIds.checkout, {
      sourceReference: sourceReferenceOf(orderId),
      reuseCommitments: true
    });
    checkoutId = String(checkout.data.id);
    await database.client`update orders.product_orders set checkout_id=${checkoutId} where business_id=${actor.businessId} and id=${orderId} and checkout_id is null`;
  }

  const checkoutSnap = await database.client.begin(async (tx) => {
    const [row] = await tx`
      select id, status::text status, total_minor::int "totalMinor", confirmed_minor::int "confirmedMinor",
             money_operation_id "moneyOperationId"
        from checkout.checkouts where business_id=${actor.businessId} and id=${checkoutId}`;
    return row;
  });
  const [money] = await database.client`
    select status::text status from money.money_operations
     where business_id=${actor.businessId} and id=${checkoutSnap?.moneyOperationId ?? "00000000-0000-4000-8000-000000000000"}`;

  if (String(money?.status ?? "") !== "SUCCEEDED" || String(checkoutSnap?.status) !== "DELIVERED") {
    await database.client.begin(async (tx) => {
      await auditWithActor(tx, actor, {
        operationId, action: "order.incident.money_unknown", capability: "orders.deliver", orderId,
        outcome: "UNKNOWN",
        changes: {
          kind: "MONEY_UNKNOWN", moneyOperationId: checkoutSnap?.moneyOperationId ?? null,
          checkoutStatus: checkoutSnap?.status ?? null, reason: "Cobertura monetaria no confirmada"
        }
      });
    });
    await database.client`
      update system.operation_attempts set status='UNKNOWN', completed_at=null
       where operation_id=${operationId} and business_id=${actor.businessId} and status='STARTED'`;
    return {
      data: {
        orderId, status: "READY" as OrderStatus, incident: "MONEY_UNKNOWN",
        saleId, checkoutId, checkout: { status: checkoutSnap?.status ?? null, balance: "PENDING" }
      },
      replayed: false
    };
  }

  // Transición final durable sobre el intento ya preparado.
  const result = await settleDurableOperation({
    actor, operationId, command: "order.deliver", payload: deliverPayload,
    handler: async (tx) => {
    await assertStaff(tx, actor, "orders.deliver");
    await lockOrderBusiness(tx, actor.businessId);
    const order = await loadOrder(tx, actor.businessId, orderId, true);
    checkRevision(order.revision, input.expectedRevision);
    if (order.status !== "READY") throw stateInvalid("El pedido ya no está READY", { status: order.status });
    if (!order.saleId || !order.checkoutId) throw stateInvalid("Faltan los hechos causales de Sale/Checkout");

    const [saleOk] = await tx`select orders.assert_single_sale(${orderId},${actor.businessId}) as ok`;
    const [deliveryOk] = await tx`select orders.assert_single_delivery(${orderId},${actor.businessId}) as ok`;
    if (!saleOk?.ok) throw stateInvalid("No hay una Sale única vinculada al pedido");
    if (!deliveryOk?.ok) throw stateInvalid("No hay un único movimiento físico de entrega");
    const movementId = await latestDeliveryMovement(tx, actor.businessId, orderId);
    if (!movementId) throw stateInvalid("No se encontró el comprobante de entrega física");

    await tx`
      update orders.product_orders set status='DELIVERED', revision=revision+1, updated_at=now()
       where business_id=${actor.businessId} and id=${orderId}`;
    await auditWithActor(tx, actor, {
      operationId, action: input.receiver.kind === "THIRD_PARTY" ? "order.delivered_to_third_party" : "order.delivered",
      capability: "orders.deliver", orderId,
      changes: {
        fromStatus: "READY", toStatus: "DELIVERED", receiverKind: input.receiver.kind,
        receiverName: input.receiver.name, verificationMethod: input.receiver.verificationMethod,
        saleId: order.saleId, checkoutId: order.checkoutId, deliveryMovementId: movementId,
        moneyOperationId: checkoutSnap?.moneyOperationId ?? null
      }
    });
    return {
      orderId, status: "DELIVERED" as const, saleId: order.saleId, checkoutId: order.checkoutId,
      movementId, checkout: {
        status: String(checkoutSnap?.status), balance: "SETTLED",
        totalMinor: Number(checkoutSnap?.totalMinor ?? 0), confirmedMinor: Number(checkoutSnap?.confirmedMinor ?? 0)
      }
    };
    }
  });
  return result;
}

/* ───────────────────── excepción D22 / Q42 (fuera de los 7) ────────── */

export async function resolveD22Exception(actor: Actor, orderId: string, body: unknown, operationId: string) {
  const input = orderExceptionInput.parse(body);
  if (actor.role !== "OWNER") throw new DomainError("ORDER_EXCEPTION_NOT_AUTHORIZED", "La excepción D22 exige autoridad OWNER", 403);
  requireCapability(actor, "orders.exception.resolve");
  requireCapability(actor, "operations.resolve");

  return executeOperation({
    actor, operationId, command: "order.incident.exception_d22",
    payload: { orderId, ...input }
  }, async (tx) => {
    await assertStaff(tx, actor, "orders.exception.resolve");
    await lockOrderBusiness(tx, actor.businessId);
    const order = await loadOrder(tx, actor.businessId, orderId, true);
    checkRevision(order.revision, input.expectedRevision);
    if (order.status !== "READY") throw stateInvalid("La excepción D22 exige un pedido READY", { status: order.status });

    const movementId = await latestDeliveryMovement(tx, actor.businessId, orderId);
    if (!movementId) throw stateInvalid("La excepción exige un hecho físico H04 real", { required: "inventory.movements.DELIVERY" });
    if (!order.saleId || !order.checkoutId) throw stateInvalid("Faltan Sale y Checkout reales");
    const [money] = await tx`
      select id, status::text status, confirmed_minor::int "confirmedMinor"
        from money.money_operations
       where business_id=${actor.businessId} and id=(select money_operation_id from checkout.checkouts where business_id=${actor.businessId} and id=${order.checkoutId})`;
    if (!money || !["UNKNOWN", "PROVEN_FAILED"].includes(String(money.status))) {
      throw stateInvalid("La excepción exige dinero en UNKNOWN o PROVEN_FAILED", { status: money?.status ?? null });
    }
    // Auditoría inmutable: autorización verificable + ambos hechos reales.
    // NO se marca Money SUCCEEDED, NO se compensa UNKNOWN_AMOUNT a cero.
    await auditWithActor(tx, actor, {
      operationId, action: "order.incident.exception_d22", capability: "orders.exception.resolve",
      orderId, outcome: "UNKNOWN",
      changes: {
        kind: "EXCEPTION_D22", status: "OPEN", reason: input.reason,
        evidenceReference: input.evidenceReference, authorizedBy: actor.accountId,
        authorityAccountId: actor.accountId, deliveryMovementId: movementId,
        moneyOperationId: String(money.id), saleId: order.saleId, checkoutId: order.checkoutId
      }
    });
    return {
      orderId, status: order.status, incident: "EXCEPTION_D22",
      deliveryMovementId: movementId, moneyOperationId: String(money.id),
      moneyStatus: String(money.status), authorizedBy: actor.accountId
    };
  });
}

/* ─────────────────────── reemisión de credencial ───────────────────── */

export async function reissueCredential(actor: Actor, orderId: string, body: unknown, operationId: string) {
  const input = orderCredentialReissueInput.parse(body);
  requireCapability(actor, "orders.credential.reissue");
  // El token se genera FUERA del resultado durable: nunca se persiste en
  // `operation_attempts.response_body` ni se registra en auditoría.
  const tokenPair = issueOpaqueToken();
  const result = await executeOperation({
    actor, operationId, command: "order.credential.reissue", payload: { orderId, ...input }
  }, async (tx) => {
    await assertStaff(tx, actor, "orders.credential.reissue");
    const order = await loadOrder(tx, actor.businessId, orderId);
    if (order.customerKind !== "GUEST") throw stateInvalid("Sólo los pedidos invitado tienen credencial");
    const fresh = await reissueOrderCredentialTx(tx, actor.businessId, orderId, input.reason, tokenPair);
    await auditWithActor(tx, actor, {
      operationId, action: "order.credential.reissued", capability: "orders.credential.reissue",
      orderId, changes: { credentialId: fresh.credentialId, generation: fresh.generation, reason: input.reason }
    });
    return { credentialId: fresh.credentialId, generation: fresh.generation };
  });
  return { data: { ...result.data, ...(result.replayed ? {} : { credential: { token: tokenPair.token } }) }, replayed: result.replayed };
}
