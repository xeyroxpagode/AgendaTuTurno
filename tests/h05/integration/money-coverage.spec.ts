import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { createCheckout, resumeCheckout } from "../../../apps/api/src/modules/checkout/commands.js";
import { resolveMoneyOperation } from "../../../apps/api/src/modules/money/commands.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { assertQaDatabase, createProductSale, createSellableItem, op, seedActor, seedBusiness } from "../support.js";

/**
 * D16 / F31 / F33 · Ninguna entrega física sin cobertura monetaria confirmada.
 * Defecto P0 descubierto durante la aceptación adversarial: un checkout con
 * tarjeta UNKNOWN pasaba a DELIVERED con confirmed_minor = 0.
 */
describe("H05 cobertura monetaria obligatoria (D16)", () => {
  let owner: Actor;
  let item: { sku: string; locationId: string };

  beforeAll(async () => {
    await assertQaDatabase();
    owner = await seedActor(await seedBusiness("H05 Cobertura QA"), "OWNER", "Dueño");
    item = await createSellableItem(owner, `COV-${randomUUID().slice(0, 6)}`, 6_000, 10);
  });

  it("UNKNOWN no entrega: reserva activa, checkout UNKNOWN, sin InventoryMovement", async () => {
    const saleId = await createProductSale(owner, item.sku, item.locationId, 1, 6_000);
    const result = await createCheckout(owner, {
      saleId,
      components: [{ method: "CARD", amountMinor: 6_000, outcome: "UNKNOWN" }],
      deliver: true
    }, op());
    expect(result.data.status).toBe("UNKNOWN");
    expect(result.data.confirmedMinor).toBe(0);
    const [movements] = await database.client`
      select count(*)::int n from inventory.movements m
      join inventory.entries e on e.business_id = m.business_id and e.movement_id = m.id
     where m.business_id = ${owner.businessId} and m.kind = 'DELIVERY' and e.sku = ${item.sku}`;
    expect(Number(movements!.n)).toBe(0);
    const [commitment] = await database.client`
      select state::text state from inventory.commitments where business_id = ${owner.businessId} and source_reference = ${result.data.sourceReference}`;
    expect(String(commitment!.state)).toBe("ACTIVE");
  });

  it("reanudar entrega con dinero aún no confirmado es rechazado sin escribir", async () => {
    const saleId = await createProductSale(owner, item.sku, item.locationId, 1, 6_000);
    const created = await createCheckout(owner, {
      saleId, components: [{ method: "CARD", amountMinor: 6_000, outcome: "UNKNOWN" }], deliver: false
    }, op());
    // Se fuerza la incidencia para ejercer la ruta de reanudación.
    await database.client`update checkout.checkouts set status='DELIVERY_PENDING', incident_reason='Incidente de QA' where id = ${created.data.id}`;
    const [checkout] = await database.client`select revision::int revision from checkout.checkouts where id = ${created.data.id}`;
    await expect(resumeCheckout(owner, String(created.data.id), {
      resolution: "DELIVER", reason: "Intento antes de confirmar dinero", expectedRevision: Number(checkout!.revision)
    }, op())).rejects.toMatchObject({ code: "MONEY_NOT_CONFIRMED" });
    const [status] = await database.client`select status::text status from checkout.checkouts where id = ${created.data.id}`;
    expect(String(status!.status)).toBe("DELIVERY_PENDING");
  });

  it("tras resolver el intento con evidencia SÍ se puede entregar, sin segundo cobro", async () => {
    const saleId = await createProductSale(owner, item.sku, item.locationId, 1, 6_000);
    const created = await createCheckout(owner, {
      saleId, components: [{ method: "CARD", amountMinor: 6_000, outcome: "UNKNOWN" }], deliver: false
    }, op());
    const before = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    await resolveMoneyOperation(owner, String(created.data.moneyOperationId), {
      outcome: "SUCCEEDED", evidenceReference: "CUPON-TERMINAL-CONFIRMADO"
    }, op());
    const [checkout] = await database.client`select revision::int revision from checkout.checkouts where id = ${created.data.id}`;
    const resumed = await resumeCheckout(owner, String(created.data.id), {
      resolution: "DELIVER", reason: "Dinero confirmado con evidencia", expectedRevision: Number(checkout!.revision)
    }, op());
    expect(resumed.data.status).toBe("DELIVERED");
    const after = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
  });
});
