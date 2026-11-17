import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import {
  allocateMoney, createMoneyOperation, refundMoney, resolveMoneyOperation, reconcileMoney
} from "../../../apps/api/src/modules/money/commands.js";
import { createSale } from "../../../apps/api/src/modules/sales/commands.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { durableAttemptState } from "../../../apps/api/src/modules/system/operations.js";
import { assertQaDatabase, createSellableItem, openCash, op, seedActor, seedBusiness } from "../support.js";

/**
 * H05 · CAP-05-02 Money + CAP-05-03 Recovery · escenarios F08–F19, F36, F40, F41.
 */
describe("H05 Money y Recovery (F08–F19, F36, F40, F41)", () => {
  let owner: Actor;
  let receptionist: Actor;
  let cashSessionId: string;
  let saleId: string;

  beforeAll(async () => {
    await assertQaDatabase();
    const businessId = await seedBusiness("H05 Money QA");
    owner = await seedActor(businessId, "OWNER", "Dueño");
    receptionist = await seedActor(businessId, "RECEPTIONIST", "Cajera");
    const cash = await openCash(owner);
    cashSessionId = cash.cashSessionId;
    const item = await createSellableItem(owner, `MONEY-${randomUUID().slice(0, 6)}`, 10_000, 20);
    const sale = await createSale(owner, {
      lines: [{
        kind: "PRODUCT", sku: item.sku,
        locationId: item.locationId, name: "Saldo de prueba", quantity: 1, unitPriceMinor: 10_000, discountMinor: 0
      }]
    }, op());
    saleId = String(sale.data.saleId);
  });

  it("F08 · cobro efectivo se registra una sola vez", async () => {
    const operationId = op();
    const body = { cashSessionId, components: [{ method: "CASH", amountMinor: 10_000, changeMinor: 0 }] };
    const first = await createMoneyOperation(owner, body, operationId);
    const second = await createMoneyOperation(owner, body, operationId);
    expect(first.data.status).toBe("SUCCEEDED");
    expect(second.replayed).toBe(true);
    const rows = await database.client`select id from money.money_operations where operation_id = ${operationId}`;
    expect(rows).toHaveLength(1);
  });

  it("F09 · vuelto ligado al cobro: efectivo neto exacto", async () => {
    const result = await createMoneyOperation(owner, {
      cashSessionId,
      components: [{ method: "CASH", amountMinor: 8_000, tenderedMinor: 10_000, changeMinor: 2_000 }]
    }, op());
    expect(result.data.changeMinor).toBe(2_000);
    expect(result.data.confirmedMinor).toBe(8_000);
    const movements = await database.client`
      select type::text type, amount_minor::int "amountMinor" from cash.cash_movements
       where money_operation_id = ${result.data.id} order by type`;
    expect(movements.map((m) => m.type)).toEqual(["CHANGE", "SALE_CASH"]);
    expect(movements.reduce((sum, m) => sum + (m.type === "SALE_CASH" ? m.amountMinor : -m.amountMinor), 0)).toBe(8_000);
  });

  it("F10/F11 · transferencia acreditada cuenta; no acreditada no es dinero", async () => {
    const accredited = await createMoneyOperation(owner, {
      components: [{ method: "TRANSFER", amountMinor: 5_000, accredited: true, reference: "TR-123" }]
    }, op());
    expect(accredited.data.status).toBe("SUCCEEDED");
    expect(accredited.data.confirmedMinor).toBe(5_000);

    const pending = await createMoneyOperation(owner, {
      components: [{ method: "TRANSFER", amountMinor: 5_000, accredited: false }]
    }, op());
    expect(pending.data.status).toBe("PROCESSING");
    expect(pending.data.confirmedMinor).toBe(0);
    const movements = await database.client`select id from cash.cash_movements where money_operation_id = ${pending.data.id}`;
    expect(movements).toHaveLength(0);
  });

  it("F12/F13 · tarjeta confirmada cuenta; UNKNOWN no se degrada a FAILED", async () => {
    const confirmed = await createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 4_000, outcome: "CONFIRMED", reference: "TERM-9" }]
    }, op());
    expect(confirmed.data.status).toBe("SUCCEEDED");

    const unknown = await createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 4_000, outcome: "UNKNOWN" }]
    }, op());
    expect(unknown.data.status).toBe("UNKNOWN");
    expect(unknown.data.confirmedMinor).toBe(0);
    const attempt = await durableAttemptState(unknown.data.operationId, owner);
    expect(attempt.semantic).toBe("UNKNOWN");
    const resolved = await resolveMoneyOperation(owner, String(unknown.data.id), {
      outcome: "SUCCEEDED", evidenceReference: "Comprobante terminal 12345"
    }, op());
    expect(resolved.data.status).toBe("SUCCEEDED");
    expect(resolved.data.confirmedMinor).toBe(4_000);
  });

  it("F14 · cobro mixto con desglose exacto", async () => {
    const result = await createMoneyOperation(owner, {
      cashSessionId,
      components: [
        { method: "CASH", amountMinor: 3_000, changeMinor: 0 },
        { method: "TRANSFER", amountMinor: 2_000, accredited: true, reference: "MIX-1" },
        { method: "CARD", amountMinor: 1_000, outcome: "CONFIRMED", reference: "MIX-2" }
      ]
    }, op());
    expect(result.data.components).toHaveLength(3);
    expect(result.data.confirmedMinor).toBe(6_000);
    expect(result.data.amountMinor).toBe(6_000);
  });

  it("F15 · cobro parcial deja saldo PARTIAL derivado", async () => {
    const money = await createMoneyOperation(owner, {
      cashSessionId, saleId, components: [{ method: "CASH", amountMinor: 5_000, changeMinor: 0 }]
    }, op());
    const [row] = await database.client`
      select coalesce(sum(a.amount_minor),0)::int settled from money.money_allocations a
       where a.target_id = ${saleId} and a.target_type = 'SALE'`;
    expect(Number(row!.settled)).toBeGreaterThanOrEqual(5_000);
    expect(money.data.allocatedMinor).toBe(5_000);
  });

  it("F16 · anticipo se aplica después sin generar dinero nuevo", async () => {
    const advance = await createMoneyOperation(owner, {
      cashSessionId, components: [{ method: "CASH", amountMinor: 6_000, changeMinor: 0 }]
    }, op());
    const before = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    await allocateMoney(owner, String(advance.data.id), { targetType: "sale", targetId: saleId, amountMinor: 4_000 }, op());
    const after = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    expect(after[0]!.n).toBe(before[0]!.n);
    const snapshot = await database.client`select coalesce(sum(amount_minor),0)::int "allocatedMinor" from money.money_allocations where money_operation_id = ${advance.data.id}`;
    expect(Number(snapshot[0]!.allocatedMinor)).toBe(4_000);
  });

  it("F17 · carrera concurrente con el mismo operation_id: un solo efecto", async () => {
    const operationId = op();
    const body = { components: [{ method: "CARD", amountMinor: 1_000, outcome: "CONFIRMED", reference: "RACE" }] };
    const results = await Promise.allSettled([
      createMoneyOperation(owner, body, operationId),
      createMoneyOperation(owner, body, operationId)
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const rows = await database.client`select id from money.money_operations where operation_id = ${operationId}`;
    expect(rows).toHaveLength(1);
  });

  it("F18 · refund es un hecho NUEVO y conserva el original", async () => {
    const original = await createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 10_000, outcome: "CONFIRMED", reference: "REF-ORIG" }]
    }, op());
    const refund = await refundMoney(owner, String(original.data.id), {
      amountMinor: 4_000, reason: "Producto con defecto", evidenceReference: "REFPROOF-1"
    }, op());
    expect(refund.data.kind).toBe("REFUND");
    expect(refund.data.refundOfId).toBe(original.data.id);
    const preserved = await database.client`select confirmed_minor::int "confirmedMinor" from money.money_operations where id = ${original.data.id}`;
    expect(Number(preserved[0]!.confirmedMinor)).toBe(10_000);
    await expect(refundMoney(owner, String(original.data.id), {
      amountMinor: 8_000, reason: "Segundo refund excedente"
    }, op())).rejects.toMatchObject({ code: "REFUND_EXCEEDS_AVAILABLE" });
  });

  it("F19 · refund desde caja histórica cerrada: operación nueva, caja inmutable", async () => {
    const historical = await openCash(owner);
    const charge = await createMoneyOperation(owner, {
      cashSessionId: historical.cashSessionId,
      components: [{ method: "CASH", amountMinor: 7_000, changeMinor: 0 }]
    }, op());
    const { closeCashSession } = await import("../../../apps/api/src/modules/cash/commands.js");
    const [session] = await database.client`select revision::int revision from cash.cash_sessions where id = ${historical.cashSessionId}`;
    await closeCashSession(owner, historical.cashSessionId, { countedAmountMinor: 17_000, expectedRevision: Number(session!.revision) }, op());
    const current = await openCash(owner);
    const refund = await refundMoney(owner, String(charge.data.id), {
      amountMinor: 2_000, reason: "Devolución autorizada", cashSessionId: current.cashSessionId
    }, op());
    expect(refund.data.id).not.toBe(charge.data.id);
    const closed = await database.client`select status::text status from cash.cash_sessions where id = ${historical.cashSessionId}`;
    expect(closed[0]!.status).toBe("CLOSED");
  });

  it("F36 · RECEPTIONIST sin grant no puede hacer refund", async () => {
    const charge = await createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 1_000, outcome: "CONFIRMED", reference: "DENIED" }]
    }, op());
    await expect(refundMoney(receptionist, String(charge.data.id), {
      amountMinor: 500, reason: "Intento no autorizado"
    }, op())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("F40 · intento durable sobrevive y es recuperable por operation_id", async () => {
    const operationId = op();
    const result = await createMoneyOperation(owner, {
      components: [{ method: "TRANSFER", amountMinor: 3_000, accredited: false }]
    }, operationId);
    const attempt = await durableAttemptState(operationId, owner);
    expect(attempt.operationId).toBe(operationId);
    expect(["PREPARED", "UNKNOWN"]).toContain(attempt.semantic);
    expect(attempt.completedAt).toBeNull();
    await resolveMoneyOperation(owner, String(result.data.id), {
      outcome: "PROVEN_FAILED", evidenceReference: "Transferencia rechazada por el banco"
    }, op());
    const final = await durableAttemptState(operationId, owner);
    expect(final.semantic).toBe("FAILED");
  });

  it("F41 · sobrepago: excedente queda como saldo aplicable, no se pierde", async () => {
    const money = await createMoneyOperation(owner, {
      cashSessionId, components: [{ method: "CASH", amountMinor: 12_000, changeMinor: 0 }]
    }, op());
    expect(money.data.confirmedMinor).toBe(12_000);
    expect(money.data.allocatedMinor).toBe(0);
    expect(money.data.availableMinor).toBe(12_000);
  });

  it("conciliación registra la diferencia con motivo", async () => {
    const [session] = await database.client`
      select opening_amount_minor::int "openingAmountMinor",
             coalesce(sum(case when m.type in ('INCOME','SALE_CASH') then m.amount_minor else -m.amount_minor end),0)::int movements
        from cash.cash_sessions s
        left join cash.cash_movements m on m.business_id = s.business_id and m.cash_session_id = s.id
       where s.business_id = ${owner.businessId} and s.id = ${cashSessionId}
       group by s.opening_amount_minor`;
    const expected = Number(session!.openingAmountMinor) + Number(session!.movements);
    const result = await reconcileMoney(owner, {
      cashSessionId, expectedAmountMinor: expected, observedAmountMinor: expected + 500,
      reason: "Diferencia por vuelto no registrado"
    }, op());
    expect(result.data.differenceMinor).toBe(500);
  });
});
