import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { createSale, confirmSale, cancelSale } from "../../../apps/api/src/modules/sales/commands.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import {
  assertQaDatabase, createSellableItem, createTerminalAttendance, op, seedActor, seedBusiness
} from "../support.js";

/**
 * H05 · CAP-05-01 Sales · escenarios F01–F07 y F39.
 * Ejecutado sobre PostgreSQL QA aislado.
 */
describe("H05 Sales (F01–F07, F39)", () => {
  let owner: Actor;
  let receptionist: Actor;
  let item: { sku: string; locationId: string };

  beforeAll(async () => {
    await assertQaDatabase();
    const businessId = await seedBusiness("H05 Sales QA");
    owner = await seedActor(businessId, "OWNER", "Dueño");
    receptionist = await seedActor(businessId, "RECEPTIONIST", "Recepción");
    item = await createSellableItem(owner, `SALE-${randomUUID().slice(0, 6)}`, 8_000, 10);
  });

  it("F01 · venta desde Attendance COMPLETED con snapshot de precios", async () => {
    const attendanceId = await createTerminalAttendance(owner, "COMPLETED", 12_000);
    const result = await createSale(owner, { attendanceId, lines: [] }, op());
    expect(result.data.status).toBe("DRAFT");
    expect(result.data.source).toBe("ATTENDANCE");
    expect(result.data.lines).toHaveLength(1);
    expect(result.data.lines[0]).toMatchObject({ name: "Corte QA", unitPriceMinor: 12_000, currency: "ARS" });
    await confirmSale(owner, String(result.data.saleId), { expectedRevision: result.data.revision, acceptPriceChanges: false }, op());
    const [row] = await database.client`select status::text status from sales.sales where id = ${result.data.saleId}`;
    expect(row!.status).toBe("CONFIRMED");
  });

  it("F02 · Attendance PARTIAL genera saldo PARTIAL only si hay cobro parcial", async () => {
    const attendanceId = await createTerminalAttendance(owner, "PARTIAL", 9_000);
    const result = await createSale(owner, { attendanceId, lines: [] }, op());
    expect(result.data.balance).toBe("PENDING"); // el saldo es DERIVADO del dinero, no del estado de la atención
    expect(result.data.totalMinor).toBe(9_000);
  });

  it("F03 · walk-in documentado no crea Reservation ni CLIENT", async () => {
    const before = await database.client`select (select count(*)::int from booking.reservations) r, (select count(*)::int from clients.client_profiles) c`;
    const result = await createSale(owner, {
      contactSnapshot: { name: "Cliente Walk-in", phone: "1155551111" },
      lines: [{ kind: "PRODUCT", sku: item.sku, locationId: item.locationId, name: "Producto", quantity: 1, unitPriceMinor: 8_000, discountMinor: 0 }]
    }, op());
    expect(result.data.source).toBe("WALK_IN");
    expect(result.data.attendanceId).toBeNull();
    const after = await database.client`select (select count(*)::int from booking.reservations) r, (select count(*)::int from clients.client_profiles) c`;
    expect(after[0]!.r).toBe(before[0]!.r);
    expect(after[0]!.c).toBe(before[0]!.c);
  });

  it("F04 · doble confirmación con el mismo operation_id hace replay", async () => {
    const operationId = op();
    const first = await createSale(owner, {
      contactSnapshot: { name: "Replay", phone: "1155552222" },
      lines: [{ kind: "PRODUCT", sku: item.sku, locationId: item.locationId, name: "Producto", quantity: 1, unitPriceMinor: 8_000, discountMinor: 0 }]
    }, operationId);
    const second = await createSale(owner, {
      contactSnapshot: { name: "Replay", phone: "1155552222" },
      lines: [{ kind: "PRODUCT", sku: item.sku, locationId: item.locationId, name: "Producto", quantity: 1, unitPriceMinor: 8_000, discountMinor: 0 }]
    }, operationId);
    expect(second.replayed).toBe(true);
    expect(second.data.saleId).toBe(first.data.saleId);
    const rows = await database.client`select id from sales.sales where operation_id = ${operationId}`;
    expect(rows).toHaveLength(1);
  });

  it("F05 · venta directa de producto snapshota el precio vigente", async () => {
    const result = await createSale(owner, {
      lines: [{ kind: "PRODUCT", sku: item.sku, locationId: item.locationId, name: "Producto", quantity: 2, unitPriceMinor: 8_000, discountMinor: 0 }]
    }, op());
    expect(result.data.source).toBe("DIRECT");
    expect(result.data.totalMinor).toBe(16_000);
    expect(result.data.lines[0]).toMatchObject({ unitPriceMinor: 8_000, lineTotalMinor: 16_000, currency: "ARS" });
  });

  it("F06 · venta mixta servicio + producto en UNA sola sale", async () => {
    const attendanceId = await createTerminalAttendance(owner, "COMPLETED", 12_000);
    const result = await createSale(owner, {
      attendanceId,
      lines: [{ kind: "PRODUCT", sku: item.sku, locationId: item.locationId, name: "Producto", quantity: 1, unitPriceMinor: 8_000, discountMinor: 0 }]
    }, op());
    expect(result.data.lines).toHaveLength(2);
    expect(result.data.lines.map((line) => line.kind).sort()).toEqual(["PRODUCT", "SERVICE"]);
    expect(result.data.totalMinor).toBe(20_000);
  });

  it("F07 · descuento sin capability y descuento excedente son rechazados", async () => {
    const line = { kind: "PRODUCT" as const, sku: item.sku, locationId: item.locationId, name: "Producto", quantity: 1, unitPriceMinor: 8_000, discountMinor: 500, discountReason: "Descuento autorizado" };
    await expect(createSale(receptionist, { lines: [line] }, op())).rejects.toMatchObject({ code: "DISCOUNT_NOT_AUTHORIZED" });
    const authorized = await seedActor(receptionist.businessId, "RECEPTIONIST", "Descuentos", { extraCapabilities: ["sales.discount"] });
    await expect(createSale(authorized, {
      lines: [{ ...line, quantity: 1, unitPriceMinor: 100, discountMinor: 200 }]
    }, op())).rejects.toThrow();
  });

  it("F39 · cambiar el precio del catálogo NO reescribe la venta confirmada", async () => {
    const sale = await createSale(owner, {
      lines: [{ kind: "PRODUCT", sku: item.sku, locationId: item.locationId, name: "Producto", quantity: 1, unitPriceMinor: 8_000, discountMinor: 0 }]
    }, op());
    await confirmSale(owner, String(sale.data.saleId), { expectedRevision: sale.data.revision, acceptPriceChanges: false }, op());
    await database.client`update inventory.items set price_minor = 99999 where business_id = ${owner.businessId} and sku = ${item.sku}`;
    const lines = await database.client`select unit_price_minor::int "unitPriceMinor" from sales.sale_lines where business_id = ${owner.businessId} and sale_id = ${sale.data.saleId} and superseded_at is null`;
    expect(lines[0]!.unitPriceMinor).toBe(8_000);
    await database.client`update inventory.items set price_minor = 8000 where business_id = ${owner.businessId} and sku = ${item.sku}`;
  });

  it("anulación exige motivo y conserva la venta original", async () => {
    const sale = await createSale(owner, {
      lines: [{ kind: "PRODUCT", sku: item.sku, locationId: item.locationId, name: "Producto", quantity: 1, unitPriceMinor: 8_000, discountMinor: 0 }]
    }, op());
    await confirmSale(owner, String(sale.data.saleId), { expectedRevision: sale.data.revision, acceptPriceChanges: false }, op());
    const [current] = await database.client`select revision::int revision from sales.sales where id = ${sale.data.saleId}`;
    await expect(cancelSale(owner, String(sale.data.saleId), { reason: "x", expectedRevision: Number(current!.revision) }, op())).rejects.toThrow();
    const result = await cancelSale(owner, String(sale.data.saleId), { reason: "Error de carga del cliente", expectedRevision: Number(current!.revision) }, op());
    expect(result.data.status).toBe("CANCELLED");
    const rows = await database.client`select id from sales.sales where id = ${sale.data.saleId}`;
    expect(rows).toHaveLength(1);
  });
});
