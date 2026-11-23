import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { orderRequest, orderConfirm, orderPrepare, orderReady, resolveD22Exception } from "../../../apps/api/src/modules/orders/commands.js";
import { createSale } from "../../../apps/api/src/modules/sales/commands.js";
import { createCheckout } from "../../../apps/api/src/modules/checkout/commands.js";
import { deliverStockCommitments } from "../../../apps/api/src/modules/inventory/commitments.js";
import { issueCheckoutAuthority } from "../../../apps/api/src/modules/checkout/domain.js";
import { loadCheckout } from "../../../apps/api/src/modules/checkout/domain.js";
import { audit, prepareDurableOperation, settleDurableOperation } from "../../../apps/api/src/modules/system/operations.js";
import { assertQaDatabase, createSellableItem, expectCode, op, seedActor, seedBusiness, sqlCount } from "../support.js";

beforeAll(async () => { await assertQaDatabase(); });

describe("G01 / D22-Q42 â€” excepciÃ³n autorizada con hecho fÃ­sico real", () => {
  it("Owner con autoridad registra incidencia; Money permanece UNKNOWN; RecepciÃ³n sin grant es rechazada", async () => {
    const businessId = await seedBusiness();
    const owner = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
    const reception = await seedActor(businessId, "RECEPTIONIST", `Rec-${randomUUID().slice(0, 6)}`);
    const item = await createSellableItem(owner, `D22-${randomUUID().slice(0, 6)}`, 6000, 3);

    const created = await orderRequest({ kind: "STAFF", actor: owner }, {
      businessId, lines: [{ sku: item.sku, quantity: 1 }]
    }, op());
    const orderId = String((created.data as { id: string }).id);
    await orderConfirm(owner, orderId, { expectedRevision: 1 }, op());
    await orderPrepare(owner, orderId, { expectedRevision: 2 }, op());
    await orderReady(owner, orderId, { expectedRevision: 3, verifiedLines: [{ sku: item.sku, quantity: 1 }] }, op());

    const sale = await createSale(owner, {
      lines: [{ kind: "PRODUCT", sku: item.sku, locationId: item.locationId, name: "Venta D22", quantity: 1, unitPriceMinor: 6000, discountMinor: 0 }]
    }, op(), { confirmedOrderId: orderId });
    const saleId = String(sale.data.saleId);
    await database.client`update orders.product_orders set sale_id=${saleId} where id=${orderId}`;

    // Dinero observable como UNKNOWN (resultado externo no comprobable).
    const checkout = await createCheckout(owner, {
      saleId,
      components: [{ method: "CARD", amountMinor: 6000, outcome: "UNKNOWN" }],
      deliver: false
    }, op(), { sourceReference: `order:${orderId}`, reuseCommitments: true });
    const checkoutId = String(checkout.data.id);
    await database.client`update orders.product_orders set checkout_id=${checkoutId} where id=${orderId}`;

    // Hecho fÃ­sico REAL (H04) con operationId de entrega propio.
    const deliveryOpId = op();
    await prepareDurableOperation({ operationId: deliveryOpId, command: "checkout.delivery", actor: owner, payload: { checkoutId } });
    await settleDurableOperation({
      operationId: deliveryOpId, command: "checkout.delivery", actor: owner, payload: { checkoutId },
      handler: async (tx) => {
        const row = await loadCheckout(tx, businessId, checkoutId, true);
        const auth = issueCheckoutAuthority({ id: row.id, businessId, operationId: row.operationId, sourceReference: row.sourceReference }, owner);
        const commitments = await tx`select id from inventory.commitments where business_id=${businessId} and source_reference=${`order:${orderId}`} and state='ACTIVE'`;
        await deliverStockCommitments(tx, owner, commitments.map((c) => String(c.id)), deliveryOpId, { kind: "CHECKOUT", checkoutAuth: auth });
        await audit(tx, {
          actor: owner, operationId: deliveryOpId, action: "checkout.delivery",
          capability: "checkout.create", resourceType: "CHECKOUT", resourceId: checkoutId
        });
        return { delivered: true };
      }
    });
    expect(await sqlCount("select count(*)::int n from inventory.movements where kind='DELIVERY' and source_reference=$1", [`order:${orderId}`])).toBe(1);

    await expectCode(
      resolveD22Exception(reception, orderId, { expectedRevision: 4, reason: "Sin autoridad", evidenceReference: "EVID-D22-NEG" }, op()),
      "ORDER_EXCEPTION_NOT_AUTHORIZED"
    );

    const result = await resolveD22Exception(owner, orderId, {
      expectedRevision: 4, reason: "Entrega fÃ­sica comprobada, dinero en conciliaciÃ³n", evidenceReference: `order:${orderId}:money`
    }, op());
    expect((result.data as { incident: string }).incident).toBe("EXCEPTION_D22");

    const [auditRow] = await database.client`
      select count(*)::int n, max(changes->>'authorizedBy') "authorizedBy"
        from system.audit_events
       where business_id=${businessId} and resource_id=${orderId} and action='order.incident.exception_d22'`;
    expect(Number(auditRow!.n)).toBe(1);
    expect(String(auditRow!.authorizedBy)).toBe(owner.accountId);
    expect(await sqlCount("select status='UNKNOWN' n from money.money_operations where business_id=$1", [businessId])).toBe(1);
    expect(await sqlCount("select status='SUCCEEDED' n from money.money_operations where business_id=$1", [businessId])).toBe(0);
    expect(await sqlCount("select status='READY' n from orders.product_orders where id=$1", [orderId])).toBe(1);
  });
});
