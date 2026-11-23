import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { durableAttemptState } from "../../../apps/api/src/modules/system/operations.js";
import {
  orderRequest, orderConfirm, orderPrepare, orderReady, orderDeliver,
  orderCancel, resolveD22Exception
} from "../../../apps/api/src/modules/orders/commands.js";
import { assertQaDatabase, createSellableItem, expectCode, openCash, op, seedActor, seedBusiness, sqlCount } from "../support.js";

beforeAll(async () => { await assertQaDatabase(); });

async function readyOrder(quantity = 1) {
  const businessId = await seedBusiness();
  const actor = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
  const item = await createSellableItem(actor, `ADV-${randomUUID().slice(0, 6)}`, 4000, 10);
  const cashSessionId = await openCash(actor);
  const created = await orderRequest({ kind: "STAFF", actor }, {
    businessId, lines: [{ sku: item.sku, quantity }]
  }, op());
  const orderId = String((created.data as { id: string }).id);
  await orderConfirm(actor, orderId, { expectedRevision: 1 }, op());
  await orderPrepare(actor, orderId, { expectedRevision: 2 }, op());
  await orderReady(actor, orderId, { expectedRevision: 3, verifiedLines: [{ sku: item.sku, quantity }] }, op());
  return { businessId, actor, item, cashSessionId, orderId };
}

describe("F01 / WP-9 — oráculos adversariales H06", () => {
  it("Q14: dos confirmaciones concurrentes sobre la última unidad ⇒ una ganadora", async () => {
    const businessId = await seedBusiness();
    const actor = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
    // Una sola unidad disponible: la segunda confirmación no puede reservar.
    const item = await createSellableItem(actor, `UNI-${randomUUID().slice(0, 6)}`, 4000, 1);
    const created = await orderRequest({ kind: "STAFF", actor }, {
      businessId, lines: [{ sku: item.sku, quantity: 1 }]
    }, op());
    const orderId = String((created.data as { id: string }).id);
    const results = await Promise.allSettled([
      orderConfirm(actor, orderId, { expectedRevision: 1 }, op()),
      orderConfirm(actor, orderId, { expectedRevision: 1 }, op())
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await sqlCount("select count(*)::int n from inventory.commitments where source_reference=$1", [`order:${orderId}`])).toBe(1);
  });

  it("Q32/Q33: doble cancelación concurrente ⇒ una ganadora", async () => {
    const businessId = await seedBusiness();
    const actor = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
    const item = await createSellableItem(actor, `CAN-${randomUUID().slice(0, 6)}`, 1000, 2);
    const created = await orderRequest({ kind: "STAFF", actor }, {
      businessId, lines: [{ sku: item.sku, quantity: 1 }]
    }, op());
    const orderId = String((created.data as { id: string }).id);
    const results = await Promise.allSettled([
      orderCancel({ kind: "STAFF", actor }, orderId, { expectedRevision: 1, reason: "Primera cancelación" }, op()),
      orderCancel({ kind: "STAFF", actor }, orderId, { expectedRevision: 1, reason: "Segunda cancelación" }, op())
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await sqlCount("select count(*)::int n from orders.order_transitions where \"orderId\"=$1 and \"toStatus\"='CANCELLED'", [orderId])).toBe(1);
  });

  it("Q41/Q43: dinero CARD UNKNOWN ⇒ pedido sigue READY, sin movimiento y operación durable UNKNOWN", async () => {
    const { actor, orderId, businessId } = await readyOrder();
    const operationId = op();
    const result = await orderDeliver(actor, orderId, {
      expectedRevision: 4,
      receiver: { kind: "CUSTOMER", name: "Retiro QA", verificationMethod: "DOCUMENT" },
      components: [{ method: "CARD", amountMinor: 4000, outcome: "UNKNOWN" }]
    }, operationId);
    expect((result.data as { incident: string }).incident).toBe("MONEY_UNKNOWN");
    expect((result.data as { status: string }).status).toBe("READY");
    expect(await sqlCount("select count(*)::int n from inventory.movements where source_reference=$1", [`order:${orderId}`])).toBe(0);
    const state = await durableAttemptState(operationId, actor);
    expect(state.semantic).toBe("UNKNOWN");
    expect(await sqlCount("select count(*)::int n from orders.order_delivery_receipts where \"orderId\"=$1", [orderId])).toBe(0);
    void businessId;
  });

  it("Q42 negativo: sin autoridad OWNER/exception no se habilita la excepción D22", async () => {
    const businessId = await seedBusiness();
    const reception = await seedActor(businessId, "RECEPTIONIST", `Rec-${randomUUID().slice(0, 6)}`);
    await expectCode(
      resolveD22Exception(reception, randomUUID(), { expectedRevision: 1, reason: "Sin autoridad", evidenceReference: "EVID-123" }, op()),
      "ORDER_EXCEPTION_NOT_AUTHORIZED"
    );
  });

  it("Q30: BARBER no recibe ninguna capability orders.*", async () => {
    const businessId = await seedBusiness();
    const barber = await seedActor(businessId, "BARBER", `Barber-${randomUUID().slice(0, 6)}`);
    expect([...barber.capabilities].filter((cap) => cap.startsWith("orders."))).toEqual([]);
    await expectCode(orderConfirm(barber, randomUUID(), { expectedRevision: 1 }, op()), "FORBIDDEN");
  });

  it("Q46: sesión revocada ⇒ SESSION_REVOKED y ninguna mutación", async () => {
    const { actor, orderId } = await readyOrder();
    await database.client`update iam.access_sessions set revoked_at=now() where id=${actor.accessSessionId}`;
    await expectCode(orderConfirm(actor, orderId, { expectedRevision: 4 }, op()), "SESSION_REVOKED");
    expect(await sqlCount("select count(*)::int n from orders.product_orders where id=$1 and status='CONFIRMED'", [orderId])).toBe(0);
  });

  it("Q39 negativo: guard_delivered rechaza DELIVERED sin dinero SUCCEEDED", async () => {
    const { actor, orderId } = await readyOrder();
    const created = await orderDeliver(actor, orderId, {
      expectedRevision: 4,
      receiver: { kind: "CUSTOMER", name: "Retiro QA", verificationMethod: "DOCUMENT" },
      components: [{ method: "CARD", amountMinor: 4000, outcome: "UNKNOWN" }]
    }, op());
    expect((created.data as { incident: string }).incident).toBe("MONEY_UNKNOWN");
    // Intento directo de forzar el estado comercial: el trigger DB lo rechaza.
    let blocked = false;
    try {
      await database.client`update orders.product_orders set status='DELIVERED', revision=revision+1 where id=${orderId} and status='READY'`;
    } catch { blocked = true; }
    expect(blocked).toBe(true);
  });
});
