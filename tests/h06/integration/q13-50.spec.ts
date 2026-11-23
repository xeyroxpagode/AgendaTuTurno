import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { orderConfirm, orderRequest } from "../../../apps/api/src/modules/orders/commands.js";
import { createMovement, updateItem } from "../../../apps/api/src/modules/inventory/commands.js";
import { assertQaDatabase, createSellableItem, expectCode, op, seedActor, seedBusiness, sqlCount } from "../support.js";

beforeAll(async () => { await assertQaDatabase(); });

const TOTAL = 50;

async function seed50(failLine?: number) {
  const businessId = await seedBusiness();
  const actor = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
  const items = [];
  for (let index = 0; index < TOTAL; index++) {
    items.push(await createSellableItem(actor, `Q13${randomUUID().slice(0, 6)}${index}`, 1000 + index, 10));
  }
  const created = await orderRequest({ kind: "STAFF", actor }, {
    businessId, lines: items.map((item) => ({ sku: item.sku, quantity: 1 }))
  }, op());
  const orderId = String((created.data as { id: string }).id);
  if (failLine) {
    const target = items[failLine - 1]!;
    const [current] = await database.client`select revision::int revision from inventory.items where business_id=${businessId} and sku=${target.sku}`;
    await updateItem(actor, target.itemId, {
      expectedRevision: Number(current!.revision),
      name: `Artículo ${target.sku}`, description: "", category: "", use: "SALE",
      priceMinor: 9999, costMinor: 0, imageUrl: null
    }, op());
  }
  return { businessId, actor, items, orderId };
}

describe("G01 / Q13 — 50 líneas reales", () => {
  it("50 líneas sin fallo ⇒ CONFIRMED, 50 compromisos ACTIVOS, 0 Sale/Money/movimiento", async () => {
    const { businessId, actor, orderId } = await seed50();
    const result = await orderConfirm(actor, orderId, { expectedRevision: 1 }, op());
    expect((result.data as { status: string }).status).toBe("CONFIRMED");
    expect(await sqlCount("select count(*)::int n from inventory.commitments where source_reference=$1 and state='ACTIVE'", [`order:${orderId}`])).toBe(TOTAL);
    expect(await sqlCount("select count(*)::int n from sales.sales where business_id=$1", [businessId])).toBe(0);
    expect(await sqlCount("select count(*)::int n from money.money_operations where business_id=$1", [businessId])).toBe(0);
    expect(await sqlCount("select count(*)::int n from inventory.movements where source_reference=$1", [`order:${orderId}`])).toBe(0);
    const [complete] = await database.client`select orders.assert_complete_lines(${orderId},${businessId}) ok`;
    expect(Boolean(complete!.ok)).toBe(true);
  });

  it("Q13 fallo en línea 2 ⇒ REQUESTED + 0 compromisos nuevos + sin REJECTED", async () => {
    const { businessId, actor, orderId } = await seed50(2);
    await expectCode(orderConfirm(actor, orderId, { expectedRevision: 1 }, op()), "PRICE_CHANGED");
    expect(await sqlCount("select count(*)::int n from inventory.commitments where source_reference=$1", [`order:${orderId}`])).toBe(0);
    expect(await sqlCount("select status='REQUESTED' n from orders.product_orders where id=$1", [orderId])).toBe(1);
    expect(await sqlCount("select count(*)::int n from orders.order_transitions where \"orderId\"=$1 and \"toStatus\"='REJECTED'", [orderId])).toBe(0);
    expect(await sqlCount("select count(*)::int n from sales.sales where business_id=$1", [businessId])).toBe(0);
  });

  it("Q13 fallo en línea 50 ⇒ REQUESTED + 0 compromisos nuevos + sin REJECTED", async () => {
    const { actor, orderId } = await seed50(50);
    await expectCode(orderConfirm(actor, orderId, { expectedRevision: 1 }, op()), "PRICE_CHANGED");
    expect(await sqlCount("select count(*)::int n from inventory.commitments where source_reference=$1", [`order:${orderId}`])).toBe(0);
    expect(await sqlCount("select status='REQUESTED' n from orders.product_orders where id=$1", [orderId])).toBe(1);
    expect(await sqlCount("select count(*)::int n from orders.order_transitions where \"orderId\"=$1 and \"toStatus\"='REJECTED'", [orderId])).toBe(0);
  });

  it("FC-03: falla física real de stock en línea 2 ⇒ rollback íntegro de 50 líneas", async () => {
    const { businessId, actor, items, orderId } = await seed50();
    const target = items[1]!;
    // Consumir físicamente TODO el stock del SKU de la línea 2 antes de confirmar.
    await createMovement(actor, {
      kind: "LOSS",
      lines: [{ sku: target.sku, locationId: target.locationId, purpose: "SALE", quantity: 10 }],
      reason: "Falla física controlada FC-03",
      effectiveAt: new Date().toISOString()
    }, op());
    expect(await sqlCount("select physical from inventory.positions where business_id=$1 and sku=$2", [businessId, target.sku])).toBe(0);

    await expectCode(orderConfirm(actor, orderId, { expectedRevision: 1 }, op()), "INSUFFICIENT_SELLABLE_STOCK");
    expect(await sqlCount("select status='REQUESTED' n from orders.product_orders where id=$1", [orderId])).toBe(1);
    expect(await sqlCount("select count(*)::int n from inventory.commitments where source_reference=$1", [`order:${orderId}`])).toBe(0);
    expect(await sqlCount("select count(*)::int n from sales.sales where business_id=$1", [businessId])).toBe(0);
    expect(await sqlCount("select count(*)::int n from money.money_operations where business_id=$1", [businessId])).toBe(0);
    expect(await sqlCount("select count(*)::int n from inventory.movements where source_reference=$1", [`order:${orderId}`])).toBe(0);
    expect(await sqlCount("select count(*)::int n from orders.order_transitions where \"orderId\"=$1 and \"toStatus\"='REJECTED'", [orderId])).toBe(0);
    expect(await sqlCount("select count(*)::int n from orders.order_lines where order_id=$1", [orderId])).toBe(50);
  });

  it("FC-03: falla física real de stock en línea 50 ⇒ rollback íntegro de 50 líneas", async () => {
    const { businessId, actor, items, orderId } = await seed50();
    const target = items[49]!;
    await createMovement(actor, {
      kind: "LOSS",
      lines: [{ sku: target.sku, locationId: target.locationId, purpose: "SALE", quantity: 10 }],
      reason: "Falla física controlada FC-03 tardía",
      effectiveAt: new Date().toISOString()
    }, op());
    await expectCode(orderConfirm(actor, orderId, { expectedRevision: 1 }, op()), "INSUFFICIENT_SELLABLE_STOCK");
    expect(await sqlCount("select status='REQUESTED' n from orders.product_orders where id=$1", [orderId])).toBe(1);
    expect(await sqlCount("select count(*)::int n from inventory.commitments where source_reference=$1", [`order:${orderId}`])).toBe(0);
    expect(await sqlCount("select count(*)::int n from sales.sales where business_id=$1", [businessId])).toBe(0);
    expect(await sqlCount("select count(*)::int n from money.money_operations where business_id=$1", [businessId])).toBe(0);
  });

  it("Q14/Q07: dos confirmaciones concurrentes sobre 50 líneas ⇒ una ganadora", async () => {
    const { actor, orderId } = await seed50();
    const results = await Promise.allSettled([
      orderConfirm(actor, orderId, { expectedRevision: 1 }, op()),
      orderConfirm(actor, orderId, { expectedRevision: 1 }, op())
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await sqlCount("select count(*)::int n from inventory.commitments where source_reference=$1 and state='ACTIVE'", [`order:${orderId}`])).toBe(TOTAL);
  });
});
