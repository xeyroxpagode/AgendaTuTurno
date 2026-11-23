import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { orderRequest, orderReject, orderConfirm, orderCancel } from "../../../apps/api/src/modules/orders/commands.js";
import { assertQaDatabase, createSellableItem, op, seedActor, seedBusiness, sqlCount } from "../support.js";

beforeAll(async () => { await assertQaDatabase(); });

describe("G01 — estados terminales por comando", () => {
  it("order.reject desde REQUESTED con motivo", async () => {
    const businessId = await seedBusiness();
    const actor = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
    const item = await createSellableItem(actor, `REJ-${randomUUID().slice(0, 6)}`, 1000, 2);
    const created = await orderRequest({ kind: "STAFF", actor }, {
      businessId, lines: [{ sku: item.sku, quantity: 1 }]
    }, op());
    const orderId = String((created.data as { id: string }).id);
    const result = await orderReject(actor, orderId, { expectedRevision: 1, reason: "Rechazo QA" }, op());
    expect((result.data as { status: string }).status).toBe("REJECTED");
    expect(await sqlCount("select count(*)::int n from orders.order_transitions where \"orderId\"=$1 and \"toStatus\"='REJECTED'", [orderId])).toBe(1);
  });

  it("order.cancel desde CONFIRMED libera compromisos", async () => {
    const businessId = await seedBusiness();
    const actor = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
    const item = await createSellableItem(actor, `CAN-${randomUUID().slice(0, 6)}`, 1000, 2);
    const created = await orderRequest({ kind: "STAFF", actor }, {
      businessId, lines: [{ sku: item.sku, quantity: 1 }]
    }, op());
    const orderId = String((created.data as { id: string }).id);
    await orderConfirm(actor, orderId, { expectedRevision: 1 }, op());
    const result = await orderCancel({ kind: "STAFF", actor }, orderId, { expectedRevision: 2, reason: "Cancelación QA" }, op());
    expect((result.data as { status: string }).status).toBe("CANCELLED");
    expect(await sqlCount("select count(*)::int n from inventory.commitments where source_reference=$1 and state='RELEASED'", [`order:${orderId}`])).toBe(1);
  });
});
