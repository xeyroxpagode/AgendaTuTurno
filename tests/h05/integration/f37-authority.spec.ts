import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { createCheckout, resumeCheckout } from "../../../apps/api/src/modules/checkout/commands.js";
import { confirmStockCommitments, deliverStockCommitments, type CheckoutAuthority } from "../../../apps/api/src/modules/inventory/commitments.js";
import * as inventory from "../../../apps/api/src/modules/inventory/commands.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { assertQaDatabase, createProductSale, createSellableItem, openCash, op, seedActor, seedBusiness } from "../support.js";

/**
 * ACC-03 / F37 · Autoridad comercial restringida.
 *
 * Positivo: checkout.create sin inventory.operate general ejecuta la entrega.
 * Negativas: se INTENTAN operaciones arbitrarias y se comprueba SU RECHAZO y
 * la AUSENCIA de efectos físicos/financieros indebidos.
 */
describe("H05 F37 autoridad restringida Checkout/H04", () => {
  let owner: Actor;
  let cashier: Actor;
  let other: Actor;
  let item: { sku: string; locationId: string };
  let cashSessionId: string;
  let marker: string;

  beforeAll(async () => {
    await assertQaDatabase();
    const businessId = await seedBusiness("H05 F37 QA");
    owner = await seedActor(businessId, "OWNER", "Dueño");
    // Persona de caja: NO tiene inventory.operate NI inventory.adjust.
    cashier = await seedActor(businessId, "RECEPTIONIST", "Cajera", {
      withoutCapabilities: ["inventory.operate", "inventory.adjust"]
    });
    other = await seedActor(await seedBusiness("H05 F37 Otro"), "OWNER", "Otro");
    item = await createSellableItem(owner, `F37-${randomUUID().slice(0, 6)}`, 5_000, 30);
    cashSessionId = (await openCash(owner)).cashSessionId;
    marker = randomUUID();
  });

  async function forbiddenMovementsCount() {
    const [row] = await database.client`
      select count(*)::int n from inventory.movements
       where business_id = ${owner.businessId} and kind in ('LOSS','ADJUSTMENT','CONSUMPTION') and reason = ${marker}`;
    return Number(row!.n);
  }

  it("positivo · checkout.create sin inventory.operate entrega stock y conserva auditoría del actor real", async () => {
    expect(cashier.capabilities.has("inventory.operate")).toBe(false);
    expect(cashier.capabilities.has("inventory.adjust")).toBe(false);
    const saleId = await createProductSale(owner, item.sku, item.locationId, 1, 5_000);
    const result = await createCheckout(cashier, {
      saleId,
      components: [{ method: "CASH", amountMinor: 5_000, changeMinor: 0 }],
      cashSessionId,
      deliver: true
    }, op());
    expect(result.data.status).toBe("DELIVERED");
    const [movement] = await database.client`
      select m.actor_account_id "actorAccountId", m.kind::text kind
        from inventory.movements m
        join inventory.entries e on e.business_id = m.business_id and e.movement_id = m.id
       where m.business_id = ${owner.businessId} and m.kind = 'DELIVERY' and e.sku = ${item.sku}
       order by m.created_at desc limit 1`;
    expect(String(movement!.actorAccountId)).toBe(cashier.accountId);
    expect(String(movement!.kind)).toBe("DELIVERY");
  });

  it("negativa · la cajera NO puede crear pérdida, ajuste ni recepción arbitraria", async () => {
    const before = await forbiddenMovementsCount();
    const body = {
      lines: [{ sku: item.sku, locationId: item.locationId, purpose: "SALE" as const, quantity: 1 }],
      reason: marker,
      effectiveAt: new Date().toISOString()
    };
    await expect(inventory.createMovement(cashier, { ...body, kind: "LOSS" }, op())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(inventory.createMovement(cashier, { ...body, kind: "OPENING" }, op())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(inventory.createMovement(cashier, { ...body, kind: "RECEIPT" }, op())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await forbiddenMovementsCount()).toBe(before);
  });

  it("negativa · la cajera NO puede corregir un movimiento físico (inventory.adjust)", async () => {
    const movement = await inventory.createMovement(owner, {
      kind: "RECEIPT",
      lines: [{ sku: item.sku, locationId: item.locationId, purpose: "SALE", quantity: 1 }],
      reason: marker,
      effectiveAt: new Date().toISOString()
    }, op());
    await expect(inventory.correctMovement(cashier, String(movement.data.movementId), { reason: marker }, op()))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const [corrections] = await database.client`
      select count(*)::int n from inventory.movements
       where business_id = ${owner.businessId} and kind = 'CORRECTION' and corrects_id = ${movement.data.movementId}`;
    expect(Number(corrections!.n)).toBe(0);
  });

  it("negativa · consumo sin causa comercial es rechazado por la propia regla H04", async () => {
    const before = await forbiddenMovementsCount();
    await expect(inventory.consume(cashier, {
      sku: item.sku,
      locationId: item.locationId,
      purpose: "SALE",
      quantity: 1,
      usedByStaffMemberId: cashier.staffMemberId,
      effectiveAt: new Date().toISOString(),
      reason: marker
    }, op())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await forbiddenMovementsCount()).toBe(before);
  });

  it("negativa · checkoutAuth falsificado, ajeno y reutilizado es rechazado", async () => {
    const saleId = await createProductSale(owner, item.sku, item.locationId, 1, 5_000);
    const prepared = await createCheckout(owner, {
      saleId,
      components: [{ method: "CARD", amountMinor: 5_000, outcome: "CONFIRMED", reference: "F37-TERM", evidenceReference: "F37-EVIDENCE" }],
      deliver: false
    }, op());
    const [row] = await database.client`select operation_id "operationId", source_reference "sourceReference" from checkout.checkouts where id = ${prepared.data.id}`;
    const valid: CheckoutAuthority = {
      checkoutId: String(prepared.data.id), businessId: owner.businessId,
      operationId: String(row!.operationId), sourceReference: String(row!.sourceReference), actorAccountId: owner.accountId
    };

    // Falsificado: checkout inexistente.
    await expect(confirmStockCommitments(database.client as never, owner, randomUUID(), [{
      sku: item.sku, locationId: item.locationId, purpose: "SALE", quantity: 1, sourceReference: `checkout:${randomUUID()}`
    }], { kind: "CHECKOUT", checkoutAuth: { ...valid, checkoutId: randomUUID() } }))
      .rejects.toMatchObject({ code: "CHECKOUT_AUTH_INVALID" });

    // Otro Business con IDs conocidos.
    await expect(confirmStockCommitments(database.client as never, other, valid.operationId, [{
      sku: item.sku, locationId: item.locationId, purpose: "SALE", quantity: 1, sourceReference: valid.sourceReference
    }], { kind: "CHECKOUT", checkoutAuth: { ...valid, businessId: other.businessId, actorAccountId: other.accountId } }))
      .rejects.toMatchObject({ code: "CHECKOUT_AUTH_INVALID" });

    // SKU distinto al de la venta autorizada.
    await expect(confirmStockCommitments(database.client as never, owner, valid.operationId, [{
      sku: "SKU-NO-AUTORIZADO", locationId: item.locationId, purpose: "SALE", quantity: 1, sourceReference: valid.sourceReference
    }], { kind: "CHECKOUT", checkoutAuth: valid })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Cantidad superior a la línea autorizada.
    await expect(confirmStockCommitments(database.client as never, owner, valid.operationId, [{
      sku: item.sku, locationId: item.locationId, purpose: "SALE", quantity: 99, sourceReference: valid.sourceReference
    }], { kind: "CHECKOUT", checkoutAuth: valid })).rejects.toMatchObject({ code: "DELIVERY_QUANTITY_MISMATCH" });

    // Reutilización para otra referencia causal.
    await expect(confirmStockCommitments(database.client as never, owner, valid.operationId, [{
      sku: item.sku, locationId: item.locationId, purpose: "SALE", quantity: 1, sourceReference: `checkout:${randomUUID()}`
    }], { kind: "CHECKOUT", checkoutAuth: { ...valid, sourceReference: `checkout:${randomUUID()}` } }))
      .rejects.toMatchObject({ code: "CHECKOUT_AUTH_INVALID" });
  });

  it("negativa · actor revocado no puede reanudar la entrega", async () => {
    const revoked = await seedActor(owner.businessId, "RECEPTIONIST", "Revocada");
    await database.client`update iam.access_sessions set revoked_at = now(), revoked_reason = 'F37_TEST' where id = ${revoked.accessSessionId}`;
    const saleId = await createProductSale(owner, item.sku, item.locationId, 1, 5_000);
    const prepared = await createCheckout(owner, {
      saleId, components: [{ method: "CASH", amountMinor: 5_000, changeMinor: 0 }], cashSessionId, deliver: false
    }, op());
    const [checkout] = await database.client`select revision::int revision from checkout.checkouts where id = ${prepared.data.id}`;
    await expect(resumeCheckout(revoked, String(prepared.data.id), {
      resolution: "DELIVER", reason: "Intento con sesión revocada", expectedRevision: Number(checkout!.revision)
    }, op())).rejects.toMatchObject({ code: "SESSION_REVOKED" });
    const [status] = await database.client`select status::text status from checkout.checkouts where id = ${prepared.data.id}`;
    expect(String(status!.status)).not.toBe("DELIVERED");
  });

  it("negativa · entrega duplicada queda impedida tras un checkout entregado", async () => {
    const saleId = await createProductSale(owner, item.sku, item.locationId, 1, 5_000);
    const result = await createCheckout(cashier, {
      saleId, components: [{ method: "CASH", amountMinor: 5_000, changeMinor: 0 }], cashSessionId, deliver: true
    }, op());
    const [checkout] = await database.client`select source_reference "sourceReference" from checkout.checkouts where id = ${result.data.id}`;
    const commitments = await database.client`select id from inventory.commitments where business_id = ${owner.businessId} and source_reference = ${checkout!.sourceReference}`;
    const authority: CheckoutAuthority = {
      checkoutId: String(result.data.id), businessId: owner.businessId,
      operationId: String(result.data.operationId), sourceReference: String(checkout!.sourceReference), actorAccountId: cashier.accountId
    };
    await expect(database.client.begin((tx) => deliverStockCommitments(
      tx as never, cashier, commitments.map((c) => String(c.id)), String(result.data.operationId), { kind: "CHECKOUT", checkoutAuth: authority }
    ))).rejects.toMatchObject({ code: "DELIVERY_DUPLICATED" });
    const [deliveries] = await database.client`
      select count(*)::int n from inventory.movements m
      join inventory.entries e on e.business_id = m.business_id and e.movement_id = m.id
     where m.business_id = ${owner.businessId} and m.kind = 'DELIVERY' and m.source_reference = ${checkout!.sourceReference}`;
    expect(Number(deliveries!.n)).toBe(1);
  });
});
