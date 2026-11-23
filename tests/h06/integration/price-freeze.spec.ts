import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { orderRequest, orderConfirm, orderPrepare, orderReady, orderDeliver } from "../../../apps/api/src/modules/orders/commands.js";
import { createSale } from "../../../apps/api/src/modules/sales/commands.js";
import { assertQaDatabase, createSellableItem, expectCode, openCash, op, seedActor, seedBusiness } from "../support.js";

beforeAll(async () => { await assertQaDatabase(); });

describe("G01 / CORRECTIVO P0 — D16 precio confirmado congelado", () => {
  it("precio A confirmado + catálogo cambiado a B ⇒ Sale/Money registran A, sin repricing", async () => {
    const businessId = await seedBusiness();
    const actor = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
    const item = await createSellableItem(actor, `FRZ-${randomUUID().slice(0, 6)}`, 4000, 5);
    const cashSessionId = await openCash(actor);

    const created = await orderRequest({ kind: "STAFF", actor }, {
      businessId, lines: [{ sku: item.sku, quantity: 1 }]
    }, op());
    const orderId = String((created.data as { id: string }).id);
    await orderConfirm(actor, orderId, { expectedRevision: 1 }, op());

    // Cambio de precio PÚBLICO después de CONFIRMED (D16: no debe repriciar).
    const [current] = await database.client`select revision::int revision from inventory.items where business_id=${businessId} and sku=${item.sku}`;
    const { updateItem } = await import("../../../apps/api/src/modules/inventory/commands.js");
    await updateItem(actor, item.itemId, {
      expectedRevision: Number(current!.revision),
      name: `Artículo ${item.sku}`, description: "", category: "", use: "SALE",
      priceMinor: 9000, costMinor: 0, imageUrl: null
    }, op());
    const [changed] = await database.client`select price_minor::int "priceMinor" from inventory.items where business_id=${businessId} and sku=${item.sku}`;
    expect(Number(changed!.priceMinor)).toBe(9000);

    await orderPrepare(actor, orderId, { expectedRevision: 2 }, op());
    await orderReady(actor, orderId, { expectedRevision: 3, verifiedLines: [{ sku: item.sku, quantity: 1 }] }, op());
    const delivered = await orderDeliver(actor, orderId, {
      expectedRevision: 4,
      receiver: { kind: "CUSTOMER", name: "Retiro QA", verificationMethod: "DOCUMENT" },
      components: [{ method: "CASH", amountMinor: 4000, outcome: "CONFIRMED" }],
      cashSessionId
    }, op());
    expect((delivered.data as { status: string }).status).toBe("DELIVERED");

    const [sale] = await database.client`
      select s.id, s.total_minor::int "totalMinor", l.unit_price_minor::int "unitPriceMinor"
        from sales.sales s join sales.sale_lines l on l.business_id=s.business_id and l.sale_id=s.id
       where s.business_id=${businessId} and s.id=(select sale_id from orders.product_orders where id=${orderId})`;
    expect(Number(sale!.unitPriceMinor)).toBe(4000);
    expect(Number(sale!.totalMinor)).toBe(4000);
    const [money] = await database.client`
      select coalesce(sum(a.amount_minor),0)::int total
        from money.money_allocations a
        join money.money_operations m on m.business_id=a.business_id and m.id=a.money_operation_id
       where a.business_id=${businessId} and a.target_id=${sale!.id} and m.status='SUCCEEDED'`;
    expect(Number(money!.total)).toBe(4000);
  });

  it("checkout ordinario H05 SIGUE rechazando precio manipulado (sin bypass general)", async () => {
    const businessId = await seedBusiness();
    const actor = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
    const item = await createSellableItem(actor, `ORD-${randomUUID().slice(0, 6)}`, 5000, 3);
    await expectCode(createSale(actor, {
      lines: [{ kind: "PRODUCT", sku: item.sku, locationId: item.locationId, name: "Manipulado", quantity: 1, unitPriceMinor: 1, discountMinor: 0 }]
    }, op()), "PRICE_CHANGED");
  });
});
