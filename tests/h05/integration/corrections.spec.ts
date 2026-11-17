import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { createCorrection } from "../../../apps/api/src/modules/corrections/commands.js";
import { listCorrections } from "../../../apps/api/src/modules/corrections/queries.js";
import { createMoneyOperation } from "../../../apps/api/src/modules/money/commands.js";
import { createSale, confirmSale } from "../../../apps/api/src/modules/sales/commands.js";
import { createMovement } from "../../../apps/api/src/modules/inventory/commands.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { assertQaDatabase, createSellableItem, openCash, op, seedActor, seedBusiness } from "../support.js";

/** H05 · CAP-05-07 Corrections · F14/D14/D26 y separación de dominios. */
describe("H05 Correcciones (D14/D26)", () => {
  let owner: Actor;
  let item: { sku: string; locationId: string };

  beforeAll(async () => {
    await assertQaDatabase();
    const businessId = await seedBusiness("H05 Corrections QA");
    owner = await seedActor(businessId, "OWNER", "Dueño");
    item = await createSellableItem(owner, `COR-${Date.now().toString().slice(-6)}`, 6_000, 10);
    await openCash(owner);
  });

  it("corrección comercial conserva el original y registra before/after", async () => {
    const sale = await createSale(owner, {
      lines: [{ kind: "PRODUCT", sku: item.sku, locationId: item.locationId, name: "Producto", quantity: 1, unitPriceMinor: 6_000, discountMinor: 0 }]
    }, op());
    await confirmSale(owner, String(sale.data.saleId), { expectedRevision: sale.data.revision, acceptPriceChanges: false }, op());
    const correction = await createCorrection(owner, {
      type: "COMMERCIAL", targetType: "SALE", targetId: String(sale.data.saleId),
      reason: "Se cobró el precio equivocado",
      lines: [{ kind: "PRODUCT", sku: item.sku, locationId: item.locationId, name: "Producto corregido", quantity: 2, unitPriceMinor: 6_000, discountMinor: 0 }]
    }, op());
    expect(correction.data.totalMinor).toBe(12_000);
    const rows = await database.client`
      select id, superseded_at "supersededAt", unit_price_minor::int "unitPriceMinor"
        from sales.sale_lines where business_id = ${owner.businessId} and sale_id = ${sale.data.saleId} order by revision`;
    expect(rows).toHaveLength(2);
    expect(String(rows[0]!.supersededAt)).not.toBe("null");
  });

  it("corrección monetaria NO genera dinero nuevo ni toca stock", async () => {
    const money = await createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 3_000, outcome: "CONFIRMED", reference: "COR-MONEY", evidenceReference: "EV-COR-MONEY" }]
    }, op());
    const [positionBefore] = await database.client`select physical::int physical from inventory.positions where business_id = ${owner.businessId} and sku = ${item.sku} and purpose = 'SALE'`;
    const before = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    const result = await createCorrection(owner, {
      type: "MONETARY", targetType: "MONEY_OPERATION", targetId: String(money.data.id),
      reason: "Se corrigió la referencia del comprobante", evidenceReference: "COMP-999"
    }, op());
    expect(result.data.correctionId).toBeTruthy();
    const after = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    expect(after[0]!.n).toBe(before[0]!.n);
    const [positionAfter] = await database.client`select physical::int physical from inventory.positions where business_id = ${owner.businessId} and sku = ${item.sku} and purpose = 'SALE'`;
    expect(positionAfter!.physical).toBe(positionBefore!.physical);
  });

  it("corrección de caja registra movimiento real en sesión abierta", async () => {
    const [session] = await database.client`select id from cash.cash_sessions where business_id = ${owner.businessId} and status = 'OPEN' limit 1`;
    const result = await createCorrection(owner, {
      type: "CASH", targetType: "CASH_SESSION", targetId: String(session!.id),
      reason: "Diferencia de vuelto revisada", amountMinor: 300, direction: "EXPENSE"
    }, op());
    expect(result.data.correctionId).toBeTruthy();
    const movements = await database.client`select id from cash.cash_movements where correction_id = ${result.data.correctionId}`;
    expect(movements).toHaveLength(1);
  });

  it("corrección física delega en H04 y NO genera dinero", async () => {
    const movement = await createMovement(owner, {
      kind: "RECEIPT", lines: [{ sku: item.sku, locationId: item.locationId, purpose: "SALE", quantity: 2 }],
      reason: "Recepción que se corrigió después", effectiveAt: new Date().toISOString()
    }, op());
    const before = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    const result = await createCorrection(owner, {
      type: "PHYSICAL", targetType: "INVENTORY_MOVEMENT", targetId: String(movement.data.movementId),
      reason: "Recepción registrada dos unidades de más"
    }, op());
    expect(result.data.movementId).toBeTruthy();
    const after = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("motivo obligatorio e historial consultable", async () => {
    await expect(createCorrection(owner, {
      type: "MONETARY", targetType: "MONEY_OPERATION", targetId: "00000000-0000-0000-0000-000000000000",
      reason: "x"
    }, op())).rejects.toThrow();
    const corrections = await listCorrections(owner, { type: "ALL", limit: 50 });
    expect(corrections.length).toBeGreaterThanOrEqual(3);
    expect(corrections.every((correction) => String(correction.reason).length >= 3)).toBe(true);
  });
});
