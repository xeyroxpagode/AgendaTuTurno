import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { createMoneyOperation } from "../../../apps/api/src/modules/money/commands.js";
import {
  createObligation, payObligation, settleObligation, updateObligation
} from "../../../apps/api/src/modules/obligations/commands.js";
import { createMovement } from "../../../apps/api/src/modules/inventory/commands.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { assertQaDatabase, createSellableItem, op, seedActor, seedBusiness } from "../support.js";

/** H05 · CAP-05-05 Obligations · escenarios F28–F30. */
describe("H05 Obligations (F28–F30)", () => {
  let owner: Actor;
  let item: { sku: string; locationId: string };

  beforeAll(async () => {
    await assertQaDatabase();
    const businessId = await seedBusiness("H05 Obligations QA");
    owner = await seedActor(businessId, "OWNER", "Dueño");
    item = await createSellableItem(owner, `OBL-${Date.now().toString().slice(-6)}`, 5_000, 3);
  });

  it("F28 · importe desconocido NO es cero ni saldado", async () => {
    const result = await createObligation(owner, {
      kind: "PAYABLE", title: "Servicio sin presupuesto", counterpartyName: "Proveedor X"
    }, op());
    expect(result.data.amountState).toBe("UNKNOWN_AMOUNT");
    expect(result.data.amountMinor).toBeNull();
    expect(result.data.balanceMinor).toBeNull();
    expect(result.data.status).toBe("OPEN");
    await expect(settleObligation(owner, String(result.data.id), {
      moneyOperationId: "00000000-0000-0000-0000-000000000000", reason: "Intento inválido"
    }, op())).rejects.toMatchObject({ code: "OBLIGATION_AMOUNT_UNKNOWN" });
  });

  it("F29 · pagos parciales no exceden el importe y dejan saldo remanente", async () => {
    const obligation = await createObligation(owner, {
      kind: "PAYABLE", title: "Factura de luz", counterpartyName: "Compañía", amountMinor: 10_000
    }, op());
    const money = await createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 10_000, outcome: "CONFIRMED", reference: "PAY-OBL", evidenceReference: "EV-PAY-OBL" }]
    }, op());
    const partial = await payObligation(owner, String(obligation.data.id), {
      moneyOperationId: String(money.data.id), amountMinor: 4_000
    }, op());
    expect(partial.data.status).toBe("PARTIAL");
    expect(partial.data.balanceMinor).toBe(6_000);
    await expect(payObligation(owner, String(obligation.data.id), {
      moneyOperationId: String(money.data.id), amountMinor: 8_000
    }, op())).rejects.toMatchObject({ code: "MONEY_ALLOCATION_EXCEEDED" });
    const settled = await settleObligation(owner, String(obligation.data.id), {
      moneyOperationId: String(money.data.id), reason: "Cobertura total con la misma operación"
    }, op());
    expect(settled.data.status).toBe("SETTLED");
    expect(settled.data.balanceMinor).toBe(0);
  });

  it("F30 · recepción física H04 NO crea deuda saldada ni pago", async () => {
    const beforeObligations = await database.client`select count(*)::int n from obligations.expense_obligations where business_id = ${owner.businessId}`;
    const beforePayments = await database.client`select count(*)::int n from obligations.obligation_payments where business_id = ${owner.businessId}`;
    await createMovement(owner, {
      kind: "RECEIPT",
      lines: [{ sku: item.sku, locationId: item.locationId, purpose: "SALE", quantity: 1 }],
      reason: "Recepción física documentada",
      effectiveAt: new Date().toISOString()
    }, op());
    const afterObligations = await database.client`select count(*)::int n from obligations.expense_obligations where business_id = ${owner.businessId}`;
    const afterPayments = await database.client`select count(*)::int n from obligations.obligation_payments where business_id = ${owner.businessId}`;
    expect(afterObligations[0]!.n).toBe(beforeObligations[0]!.n);
    expect(afterPayments[0]!.n).toBe(beforePayments[0]!.n);
  });

  it("cambio cuantitativo exige motivo y es trazable", async () => {
    const obligation = await createObligation(owner, {
      kind: "RECEIVABLE", title: "Cobro pendiente", counterpartyName: "Cliente", amountMinor: 3_000
    }, op());
    await expect(updateObligation(owner, String(obligation.data.id), {
      expectedRevision: 1, amountMinor: 4_000, reason: "x"
    }, op())).rejects.toThrow();
    const updated = await updateObligation(owner, String(obligation.data.id), {
      expectedRevision: 1, amountMinor: 4_000, reason: "Ajuste autorizado del presupuesto"
    }, op());
    expect(updated.data.amountMinor).toBe(4_000);
    expect(updated.data.revision).toBeGreaterThan(1);
  });
});
