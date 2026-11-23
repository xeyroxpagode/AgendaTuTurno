import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { orderRequest, orderConfirm, orderPrepare, orderReady, orderDeliver, reissueCredential } from "../../../apps/api/src/modules/orders/commands.js";
import { guestOrderTracking, staffOrderDetail } from "../../../apps/api/src/modules/orders/queries.js";
import { assertQaDatabase, createSellableItem, expectCode, openCash, op, seedActor, seedBusiness, sqlCount } from "../support.js";

beforeAll(async () => { await assertQaDatabase(); });

describe("F01 / WP-9 — oráculos SQL de H06 sobre QA aislada", () => {
  it("Q36/Q39: recorrido completo REQUESTED→DELIVERED con una Sale y un movimiento", async () => {
    const businessId = await seedBusiness();
    const actor = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
    const item = await createSellableItem(actor, `RET-${randomUUID().slice(0, 6)}`, 5000, 10);
    const cashSessionId = await openCash(actor);

    const created = await orderRequest(
      { kind: "STAFF", actor },
      { businessId, lines: [{ sku: item.sku, quantity: 2 }], contact: { name: "Ana Retiro" } },
      op()
    );
    const orderId = String((created.data as { id: string }).id);
    expect((created.data as { status: string }).status).toBe("REQUESTED");
    expect(await sqlCount("select count(*)::int n from inventory.commitments where source_reference=$1", [`order:${orderId}`])).toBe(0);

    const confirmed = await orderConfirm(actor, orderId, { expectedRevision: 1 }, op());
    expect((confirmed.data as { status: string }).status).toBe("CONFIRMED");
    expect(await sqlCount("select count(*)::int n from inventory.commitments where source_reference=$1 and state='ACTIVE'", [`order:${orderId}`])).toBe(1);

    await orderPrepare(actor, orderId, { expectedRevision: 2, checklist: [{ sku: item.sku, done: true }] }, op());
    await orderReady(actor, orderId, { expectedRevision: 3, verifiedLines: [{ sku: item.sku, quantity: 2 }] }, op());
    expect(await sqlCount("select count(*)::int n from inventory.movements where source_reference=$1", [`order:${orderId}`])).toBe(0);

    const delivered = await orderDeliver(actor, orderId, {
      expectedRevision: 4,
      receiver: { kind: "CUSTOMER", name: "Ana Retiro", verificationMethod: "DOCUMENT" },
      components: [{ method: "CASH", amountMinor: 10000, outcome: "CONFIRMED" }],
      cashSessionId
    }, op());
    expect((delivered.data as { status: string }).status).toBe("DELIVERED");

    const [[sale], [delivery], [singleSale], [singleDelivery], [receipt]] = await Promise.all([
      database.client`select count(*)::int n from sales.sales where source='DIRECT' and id=(select sale_id from orders.product_orders where id=${orderId})`,
      database.client`select count(*)::int n from inventory.movements where kind='DELIVERY' and source_reference=${`order:${orderId}`}`,
      database.client`select orders.assert_single_sale(${orderId},${businessId}) ok`,
      database.client`select orders.assert_single_delivery(${orderId},${businessId}) ok`,
      database.client`select count(*)::int n from orders.order_delivery_receipts where "orderId"=${orderId}`
    ]);
    expect(Number(sale!.n)).toBe(1);
    expect(Number(delivery!.n)).toBe(1);
    expect(Boolean(singleSale!.ok)).toBe(true);
    expect(Boolean(singleDelivery!.ok)).toBe(true);
    expect(Number(receipt!.n)).toBe(1);
  });

  it("Q13: fallo en una línea revierte todos los compromisos y NO marca REJECTED", async () => {
    const businessId = await seedBusiness();
    const actor = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
    const good = await createSellableItem(actor, `OK-${randomUUID().slice(0, 6)}`, 5000, 10);
    const short = await createSellableItem(actor, `NO-${randomUUID().slice(0, 6)}`, 3000, 10);
    // Consumir físicamente todo el stock del segundo SKU antes de confirmar.
    const { createMovement } = await import("../../../apps/api/src/modules/inventory/commands.js");
    await createMovement(actor, {
      kind: "LOSS",
      lines: [{ sku: short.sku, locationId: short.locationId, purpose: "SALE", quantity: 10 }],
      reason: "Inducir fallo controlado Q13",
      effectiveAt: new Date().toISOString()
    }, op());

    const created = await orderRequest({ kind: "STAFF", actor }, {
      businessId,
      lines: [{ sku: good.sku, quantity: 1 }, { sku: short.sku, quantity: 1 }]
    }, op());
    const orderId = String((created.data as { id: string }).id);
    await expectCode(orderConfirm(actor, orderId, { expectedRevision: 1 }, op()), "INSUFFICIENT_SELLABLE_STOCK");

    const [order, commitments, confirmedEvents, rejected] = await Promise.all([
      database.client`select status::text status, revision::int revision from orders.product_orders where id=${orderId}`,
      database.client`select count(*)::int n from inventory.commitments where source_reference=${`order:${orderId}`}`,
      database.client`select count(*)::int n from orders.order_transitions where "orderId"=${orderId} and "toStatus"='CONFIRMED'`,
      database.client`select count(*)::int n from orders.order_transitions where "orderId"=${orderId} and "toStatus"='REJECTED'`
    ]);
    expect(String(order[0]!.status)).toBe("REQUESTED");
    expect(Number(order[0]!.revision)).toBe(1);
    expect(Number(commitments[0]!.n)).toBe(0);
    expect(Number(confirmedEvents[0]!.n)).toBe(0);
    expect(Number(rejected[0]!.n)).toBe(0);
  });

  it("Q25/Q26/Q27: credencial invitada privada, reemisión y revocación", async () => {
    const businessId = await seedBusiness();
    const owner = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
    const item = await createSellableItem(owner, `GUE-${randomUUID().slice(0, 6)}`, 7000, 5);

    const created = await orderRequest(
      { kind: "GUEST", businessId, orderId: "", credentialToken: "" },
      { businessId, lines: [{ sku: item.sku, quantity: 1 }] },
      op()
    );
    const orderId = String((created.data as { id: string }).id);
    const token = String((created.data as { credential: { token: string } }).credential.token);

    expect((await guestOrderTracking(token, businessId, orderId)).status).toBe("REQUESTED");
    await expectCode(guestOrderTracking("invalid-token-with-length-123456789", businessId, orderId), "ORDER_CREDENTIAL_INVALID");

    const reissued = await reissueCredential(owner, orderId, { reason: "Credencial extraviada en QA" }, op());
    const newToken = String((reissued.data as { credential: { token: string } }).credential.token);
    expect(newToken).not.toBe(token);
    await expectCode(guestOrderTracking(token, businessId, orderId), "ORDER_CREDENTIAL_REVOKED");
    expect((await guestOrderTracking(newToken, businessId, orderId)).status).toBe("REQUESTED");
  });

  it("Q29: UUID de otro negocio ⇒ 404 + evento DENIED; sin fuga de scope", async () => {
    const businessA = await seedBusiness("QA A");
    const businessB = await seedBusiness("QA B");
    const ownerA = await seedActor(businessA, "OWNER", "OwnerA");
    const ownerB = await seedActor(businessB, "OWNER", "OwnerB");
    const item = await createSellableItem(ownerA, `ISO-${randomUUID().slice(0, 6)}`, 1000, 2);
    const created = await orderRequest({ kind: "STAFF", actor: ownerA }, {
      businessId: businessA, lines: [{ sku: item.sku, quantity: 1 }]
    }, op());
    const orderId = String((created.data as { id: string }).id);

    await expectCode(orderConfirm(ownerB, orderId, { expectedRevision: 1 }, op()), "ORDER_NOT_FOUND");
    await expectCode(staffOrderDetail(ownerB, orderId), "ORDER_NOT_FOUND");
    const denied = await database.client`
      select count(*)::int n from system.audit_events
       where business_id=${businessB} and resource_id=${orderId} and outcome='DENIED'`;
    expect(Number(denied[0]!.n)).toBeGreaterThanOrEqual(1);
  });
});
