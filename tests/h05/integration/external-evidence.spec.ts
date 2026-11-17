import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { createMoneyOperation } from "../../../apps/api/src/modules/money/commands.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { assertQaDatabase, op, seedActor, seedBusiness } from "../support.js";

/**
 * ACC-01 / F12 / F10 · Un medio externo SOLO se confirma con evidencia real.
 * Verifica rechazo Y ausencia de efectos financieros, no sólo el código de error.
 */
describe("H05 evidencia de pagos externos (ACC-01)", () => {
  let owner: Actor;
  beforeAll(async () => {
    await assertQaDatabase();
    owner = await seedActor(await seedBusiness("H05 Evidencia QA"), "OWNER", "Dueño");
  });

  async function countMoney() {
    const [row] = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    return Number(row!.n);
  }

  it("F12 · tarjeta CONFIRMED sin referencia ni evidencia es rechazada sin crear dinero", async () => {
    const before = await countMoney();
    await expect(createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 5_000, outcome: "CONFIRMED" }]
    }, op())).rejects.toThrow();
    expect(await countMoney()).toBe(before);
  });

  it("F12 · tarjeta CONFIRMED con referencia pero sin evidencia es rechazada", async () => {
    const before = await countMoney();
    await expect(createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 5_000, outcome: "CONFIRMED", reference: "TERM-123" }]
    }, op())).rejects.toThrow();
    expect(await countMoney()).toBe(before);
  });

  it("F13 · omitir el outcome NUNCA confirma: queda UNKNOWN recuperable", async () => {
    const result = await createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 5_000 }]
    }, op());
    expect(result.data.status).toBe("UNKNOWN");
    expect(result.data.confirmedMinor).toBe(0);
    const [row] = await database.client`select status::text status from system.operation_attempts where operation_id = ${result.data.operationId}`;
    expect(["UNKNOWN", "STARTED"]).toContain(String(row!.status));
  });

  it("F10 · transferencia acreditada sin evidencia es rechazada", async () => {
    const before = await countMoney();
    await expect(createMoneyOperation(owner, {
      components: [{ method: "TRANSFER", amountMinor: 5_000, accredited: true, reference: "BANK-1" }]
    }, op())).rejects.toThrow();
    expect(await countMoney()).toBe(before);
  });

  it("F12 · datos sensibles de tarjeta (PAN/CVV) son rechazados por el esquema estricto", async () => {
    const before = await countMoney();
    await expect(createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 5_000, outcome: "CONFIRMED", reference: "T", evidenceReference: "E", pan: "4111111111111111" }]
    }, op())).rejects.toThrow();
    expect(await countMoney()).toBe(before);
  });

  it("F12 · tarjeta confirmada con evidencia persiste referencia/evidencia y NINGÚN PAN", async () => {
    const result = await createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 7_000, outcome: "CONFIRMED", reference: "TERM-OK-1", evidenceReference: "TICKET-OK-1" }]
    }, op());
    expect(result.data.status).toBe("SUCCEEDED");
    const [component] = await database.client`
      select external_reference "externalReference", evidence_reference "evidenceReference", to_jsonb(c) row
        from money.money_components c where money_operation_id = ${result.data.id}`;
    expect(String(component!.externalReference)).toBe("TERM-OK-1");
    expect(String(component!.evidenceReference)).toBe("TICKET-OK-1");
    const serialized = JSON.stringify(component!.row).toLowerCase();
    expect(serialized).not.toContain("pan");
    expect(serialized).not.toContain("cvv");
  });

  it("F10/F14 · pago externo confirmado NO genera CashMovement de efectivo", async () => {
    const result = await createMoneyOperation(owner, {
      components: [
        { method: "CARD", amountMinor: 3_000, outcome: "CONFIRMED", reference: "TERM-MIX", evidenceReference: "TICKET-MIX" },
        { method: "TRANSFER", amountMinor: 2_000, accredited: true, reference: "BANK-MIX", evidenceReference: "EV-BANK-MIX" }
      ]
    }, op());
    expect(result.data.confirmedMinor).toBe(5_000);
    const movements = await database.client`select id from cash.cash_movements where money_operation_id = ${result.data.id}`;
    expect(movements).toHaveLength(0);
  });
});
