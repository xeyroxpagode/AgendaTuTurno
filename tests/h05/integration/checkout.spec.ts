import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { createCheckout, resumeCheckout } from "../../../apps/api/src/modules/checkout/commands.js";
import { getCheckout } from "../../../apps/api/src/modules/checkout/queries.js";
import { createProductSale, assertQaDatabase, openCash, op, seedActor, seedBusiness, createSellableItem } from "../support.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { confirmStockCommitments, deliverStockCommitment, deliverStockCommitments } from "../../../apps/api/src/modules/inventory/commitments.js";

/**
 * H05 · CAP-05-06 Checkout + H04 · escenarios F31–F38, F40, F46.
 * Incluye F37: separación de autoridad (checkout.create sin inventory.operate).
 */
describe("H05 Checkout e integración H04 (F31–F38, F40, F46)", () => {
  let owner: Actor;
  let cashier: Actor; // checkout.create SIN inventory.operate
  let barber: Actor;
  let other: Actor;
  let stockItem: { sku: string; locationId: string };
  let cashSessionId: string;

  beforeAll(async () => {
    await assertQaDatabase();
    const businessId = await seedBusiness("H05 Checkout QA");
    owner = await seedActor(businessId, "OWNER", "Dueño");
    cashier = await seedActor(businessId, "RECEPTIONIST", "Cajera", { withoutCapabilities: ["inventory.operate"] });
    barber = await seedActor(businessId, "BARBER", "Barbero");
    other = await seedActor(await seedBusiness("H05 Checkout Otro"), "OWNER", "Otro negocio");
    stockItem = await createSellableItem(owner, `CHK-${randomUUID().slice(0, 6)}`, 8_000, 50);
    cashSessionId = (await openCash(owner)).cashSessionId;
  });

  async function pay(saleId: string, actor = cashier, amount = 8_000, deliver = true) {
    return createCheckout(actor, {
      saleId,
      components: [{ method: "CASH", amountMinor: amount, changeMinor: 0 }],
      cashSessionId,
      deliver
    }, op());
  }

  it("F31 · venta sin stock disponible es rechazada SIN cobrar", async () => {
    const before = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    const scarce = await createSellableItem(owner, `SCARCE-${randomUUID().slice(0, 6)}`, 8_000, 1);
    const saleId = await createProductSale(owner, scarce.sku, scarce.locationId, 5, 8_000);
    await expect(pay(saleId, owner, 40_000)).rejects.toMatchObject({ code: "CONFLICT" });
    const after = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("F32/F46 · última unidad disputada: uno vende, el otro CONFLICT", async () => {
    const last = await createSellableItem(owner, `LAST-${randomUUID().slice(0, 6)}`, 8_000, 1);
    const saleA = await createProductSale(owner, last.sku, last.locationId, 1, 8_000);
    const saleB = await createProductSale(owner, last.sku, last.locationId, 1, 8_000);
    const results = await Promise.allSettled([
      createCheckout(cashier, { saleId: saleA, components: [{ method: "CASH", amountMinor: 8_000, changeMinor: 0 }], cashSessionId }, op()),
      createCheckout(cashier, { saleId: saleB, components: [{ method: "CASH", amountMinor: 8_000, changeMinor: 0 }], cashSessionId }, op())
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [position] = await database.client`select physical::int physical from inventory.positions where business_id = ${owner.businessId} and sku = ${last.sku} and purpose = 'SALE'`;
    expect(Number(position!.physical)).toBe(0);
    const movements = await database.client`
      select count(*)::int n from inventory.movements m
      join inventory.entries e on e.business_id = m.business_id and e.movement_id = m.id
     where m.business_id = ${owner.businessId} and m.kind = 'DELIVERY' and e.sku = ${last.sku}`;
    expect(Number(movements[0]!.n)).toBe(1);
  });

  it("F33 · dinero confirmado + entrega fallida = incidencia recuperable", async () => {
    const saleId = await createProductSale(owner, stockItem.sku, stockItem.locationId, 1, 8_000);
    const prepaid = await pay(saleId, owner, 8_000, false);
    expect(prepaid.data.status).toBe("MONEY_CONFIRMED");
    const checkoutId = String(prepaid.data.id);
    const moneyId = String(prepaid.data.moneyOperationId);

    await database.client`update inventory.locations set active = false where business_id = ${owner.businessId} and id = ${stockItem.locationId}`;
    let [current] = await database.client`select revision::int revision from checkout.checkouts where id = ${checkoutId}`;
    await resumeCheckout(owner, checkoutId, { resolution: "DELIVER", reason: "Ubicación inactiva al intentar entregar", expectedRevision: Number(current!.revision) }, op());
    let [checkout] = await database.client`select status::text status, incident_reason "incidentReason" from checkout.checkouts where id = ${checkoutId}`;
    expect(checkout!.status).toBe("DELIVERY_PENDING");
    expect(checkout!.incidentReason).toBeTruthy();

    const noFake = await database.client`
      select count(*)::int n from inventory.movements m
       where m.business_id = ${owner.businessId} and m.kind = 'DELIVERY' and m.operation_id = ${prepaid.data.operationId}`;
    expect(Number(noFake[0]!.n)).toBe(0);
    const [stillConfirmed] = await database.client`select status::text status from money.money_operations where id = ${moneyId}`;
    expect(stillConfirmed!.status).toBe("SUCCEEDED");

    await database.client`update inventory.locations set active = true where business_id = ${owner.businessId} and id = ${stockItem.locationId}`;
    [current] = await database.client`select revision::int revision from checkout.checkouts where id = ${checkoutId}`;
    const resumed = await resumeCheckout(owner, checkoutId, { resolution: "DELIVER", reason: "Ubicación reactivada", expectedRevision: Number(current!.revision) }, op());
    expect(resumed.data.status).toBe("DELIVERED");
    const [moneyCount] = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId} and refund_of_id = ${moneyId}`;
    expect(Number(moneyCount!.n)).toBe(0);
  });

  it("F34 · sesión revocada antes del commit: nada se confirma", async () => {
    const revoked = await seedActor(owner.businessId, "RECEPTIONIST", "Revocada");
    await database.client`update iam.access_sessions set revoked_at = now(), revoked_reason = 'REVOKE_TEST' where id = ${revoked.accessSessionId}`;
    const before = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    const saleId = await createProductSale(owner, stockItem.sku, stockItem.locationId, 1, 8_000);
    await expect(pay(saleId, revoked)).rejects.toMatchObject({ code: "SESSION_REVOKED" });
    const after = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("F37 · operador con checkout.create SIN inventory.operate ejecuta entrega por frontera interna", async () => {
    expect(cashier.capabilities.has("inventory.operate")).toBe(false);
    const saleId = await createProductSale(owner, stockItem.sku, stockItem.locationId, 1, 8_000);
    const result = await pay(saleId, cashier);
    expect(result.data.status).toBe("DELIVERED");
    const [movement] = await database.client`
      select m.id, m.actor_account_id "actorAccountId", m.kind::text kind
        from inventory.movements m
        join inventory.entries e on e.business_id = m.business_id and e.movement_id = m.id
       where m.business_id = ${owner.businessId} and m.kind = 'DELIVERY' and e.sku = ${stockItem.sku}
       order by m.created_at desc limit 1`;
    expect(movement!.actorAccountId).toBe(cashier.accountId);
    const arbitraries = await database.client`
      select count(*)::int n from inventory.movements
       where business_id = ${owner.businessId} and kind in ('LOSS','ADJUSTMENT') and operation_id = ${result.data.operationId}`;
    expect(Number(arbitraries[0]!.n)).toBe(0);
  });

  it("F37 · autoridad de checkout falsificada / ajena / con otro SKU es rechazada", async () => {
    const forged = {
      checkoutId: randomUUID(), businessId: owner.businessId, operationId: op(),
      sourceReference: "checkout:forged", actorAccountId: owner.accountId
    };
    await expect(confirmStockCommitments(database.client as never, owner, forged.operationId, [{
      sku: stockItem.sku, locationId: stockItem.locationId, purpose: "SALE", quantity: 1, sourceReference: forged.sourceReference
    }], { kind: "CHECKOUT", checkoutAuth: forged })).rejects.toMatchObject({ code: "CHECKOUT_AUTH_INVALID" });

    const saleId = await createProductSale(owner, stockItem.sku, stockItem.locationId, 1, 8_000);
    const prepared = await pay(saleId, owner, 8_000, false);
    const [checkout] = await database.client`select operation_id "operationId", source_reference "sourceReference" from checkout.checkouts where id = ${prepared.data.id}`;
    const authority = {
      checkoutId: String(prepared.data.id), businessId: other.businessId,
      operationId: String(checkout!.operationId), sourceReference: String(checkout!.sourceReference),
      actorAccountId: other.accountId
    };
    await expect(confirmStockCommitments(database.client as never, other, authority.operationId, [{
      sku: stockItem.sku, locationId: stockItem.locationId, purpose: "SALE", quantity: 1, sourceReference: authority.sourceReference
    }], { kind: "CHECKOUT", checkoutAuth: authority })).rejects.toMatchObject({ code: "CHECKOUT_AUTH_INVALID" });

    const commitments = await database.client`select id from inventory.commitments where business_id = ${owner.businessId} and source_reference = ${String(checkout!.sourceReference)} and state = 'ACTIVE'`;
    const commitmentId = String(commitments[0]!.id);
    await expect(deliverStockCommitment(database.client as never, owner, commitmentId, String(checkout!.operationId), 99, {
      kind: "CHECKOUT", checkoutAuth: {
        checkoutId: String(prepared.data.id), businessId: owner.businessId,
        operationId: String(checkout!.operationId), sourceReference: String(checkout!.sourceReference), actorAccountId: owner.accountId
      }
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("F37 · entrega duplicada no crea un segundo movimiento", async () => {
    const saleId = await createProductSale(owner, stockItem.sku, stockItem.locationId, 1, 8_000);
    const result = await pay(saleId, cashier);
    const [checkout] = await database.client`select source_reference "sourceReference" from checkout.checkouts where id = ${result.data.id}`;
    const commitments = await database.client`select id from inventory.commitments where business_id = ${owner.businessId} and source_reference = ${String(checkout!.sourceReference)}`;
    const ids = commitments.map((row) => String(row.id));
    const authority = {
      checkoutId: String(result.data.id), businessId: owner.businessId,
      operationId: String(result.data.operationId), sourceReference: String(checkout!.sourceReference),
      actorAccountId: cashier.accountId
    };
    await expect(database.client.begin(async (tx) =>
      deliverStockCommitments(tx as never, cashier, ids, String(result.data.operationId), { kind: "CHECKOUT", checkoutAuth: authority })
    )).rejects.toMatchObject({ code: "DELIVERY_DUPLICATED" });
    const deliveries = await database.client`
      select count(*)::int n from inventory.movements m
      join inventory.entries e on e.business_id = m.business_id and e.movement_id = m.id
     where m.business_id = ${owner.businessId} and m.kind = 'DELIVERY' and e.sku = ${stockItem.sku}
       and m.source_reference = ${String(checkout!.sourceReference)}`;
    expect(Number(deliveries[0]!.n)).toBe(1);
  });

  it("F38 · otro Business no puede leer ni operar este checkout", async () => {
    const saleId = await createProductSale(owner, stockItem.sku, stockItem.locationId, 1, 8_000);
    const result = await pay(saleId, owner);
    await expect(getCheckout(other, String(result.data.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(pay(saleId, other)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("BARBER sin checkout.create no puede ejecutar checkout", async () => {
    const saleId = await createProductSale(owner, stockItem.sku, stockItem.locationId, 1, 8_000);
    await expect(pay(saleId, barber)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
