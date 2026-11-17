import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { createMoneyOperation } from "../../../apps/api/src/modules/money/commands.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { assertQaDatabase, createProductSale, createSellableItem, openCash, op, seedActor, seedBusiness } from "../support.js";

/**
 * F14 (cierre focalizado) · En UNA SOLA operación mixta:
 *   efectivo $3.000 = 300.000 unidades menores,
 *   transferencia acreditada $2.000 = 200.000,
 *   tarjeta confirmada $1.000 = 100.000.
 * Total 600.000 unidades menores = $6.000.
 *
 * Sólo la porción efectiva puede afectar `cash.cash_movements`.
 */
describe("H05 F14 cierre — pago mixto y efecto exclusivo del efectivo", () => {
  let owner: Actor;
  let cashSessionId: string;
  let saleId: string;
  let openingAmountMinor: number;

  beforeAll(async () => {
    await assertQaDatabase();
    owner = await seedActor(await seedBusiness("H05 F14 Closure"), "OWNER", "Dueño");
    const cash = await openCash(owner);
    cashSessionId = cash.cashSessionId;
    const [session] = await database.client`select opening_amount_minor::int "openingAmountMinor" from cash.cash_sessions where id = ${cashSessionId}`;
    openingAmountMinor = Number(session!.openingAmountMinor);
    const item = await createSellableItem(owner, `F14-${randomUUID().slice(0, 6)}`, 600_000, 4);
    saleId = await createProductSale(owner, item.sku, item.locationId, 1, 600_000);
  });

  async function expectedCashMinor(): Promise<number> {
    const [row] = await database.client`
      select coalesce(sum(case when type in ('INCOME','SALE_CASH') then amount_minor else -amount_minor end),0)::int total
        from cash.cash_movements where business_id = ${owner.businessId} and cash_session_id = ${cashSessionId}`;
    return openingAmountMinor + Number(row!.total);
  }

  const mixedComponents = () => ([
    { method: "CASH" as const, amountMinor: 300_000, tenderedMinor: 300_000, changeMinor: 0 },
    { method: "TRANSFER" as const, amountMinor: 200_000, accredited: true, reference: "F14-BANK-REF", evidenceReference: "F14-BANK-EVIDENCE" },
    { method: "CARD" as const, amountMinor: 100_000, outcome: "CONFIRMED" as const, reference: "F14-TERM-REF", evidenceReference: "F14-TERM-EVIDENCE" }
  ]);

  it("F14 · total exacto, componentes identificados y SOLO efectivo en caja", async () => {
    const operationId = op();
    const before = await expectedCashMinor();
    const result = await createMoneyOperation(owner, {
      saleId, cashSessionId, components: mixedComponents()
    }, operationId);
    expect(result.data.status).toBe("SUCCEEDED");
    expect(result.data.amountMinor).toBe(600_000);
    expect(result.data.confirmedMinor).toBe(600_000);
    const moneyId = String(result.data.id);

    const components = await database.client`
      select method::text method, outcome::text outcome, amount_minor::int "amountMinor",
             external_reference "externalReference", evidence_reference "evidenceReference"
        from money.money_components where money_operation_id = ${moneyId} order by position`;
    expect(components).toHaveLength(3);
    expect(components.map((c) => [String(c.method), Number(c.amountMinor)])).toEqual([
      ["CASH", 300_000], ["TRANSFER", 200_000], ["CARD", 100_000]
    ]);
    expect(String(components[1]!.evidenceReference)).toBe("F14-BANK-EVIDENCE");
    expect(String(components[2]!.evidenceReference)).toBe("F14-TERM-EVIDENCE");

    const [alloc] = await database.client`
      select target_type::text "targetType", target_id "targetId", amount_minor::int "amountMinor"
        from money.money_allocations where money_operation_id = ${moneyId}`;
    expect(String(alloc!.targetType)).toBe("SALE");
    expect(String(alloc!.targetId)).toBe(saleId);
    expect(Number(alloc!.amountMinor)).toBe(600_000);

    const cashMovements = await database.client`
      select type::text type, amount_minor::int "amountMinor", money_operation_id "moneyOperationId",
             cash_session_id "cashSessionId", business_id "businessId", operation_id "operationId"
        from cash.cash_movements where money_operation_id = ${moneyId}`;
    expect(cashMovements).toHaveLength(1);
    expect(String(cashMovements[0]!.type)).toBe("SALE_CASH");
    expect(Number(cashMovements[0]!.amountMinor)).toBe(300_000); // NO 600.000
    expect(String(cashMovements[0]!.cashSessionId)).toBe(cashSessionId);
    expect(String(cashMovements[0]!.businessId)).toBe(owner.businessId);
    expect(String(cashMovements[0]!.operationId)).toBe(operationId);
    expect(await expectedCashMinor()).toBe(before + 300_000);

    // No existe ningún movimiento de caja imputable a los componentes externos.
    const [externalCash] = await database.client`
      select count(*)::int n from cash.cash_movements
       where business_id = ${owner.businessId} and operation_id = ${operationId}
         and type in ('SALE_CASH','CHANGE') and amount_minor <> 300000`;
    expect(Number(externalCash!.n)).toBe(0);

    // Replay: ningún componente, allocation ni movimiento se duplica.
    const replay = await createMoneyOperation(owner, { saleId, cashSessionId, components: mixedComponents() }, operationId);
    expect(replay.replayed).toBe(true);
    const [componentCount] = await database.client`select count(*)::int n from money.money_components where money_operation_id = ${moneyId}`;
    const [allocationCount] = await database.client`select count(*)::int n from money.money_allocations where money_operation_id = ${moneyId}`;
    const [movementCount] = await database.client`select count(*)::int n from cash.cash_movements where money_operation_id = ${moneyId}`;
    expect(Number(componentCount!.n)).toBe(3);
    expect(Number(allocationCount!.n)).toBe(1);
    expect(Number(movementCount!.n)).toBe(1);
    expect(await expectedCashMinor()).toBe(before + 300_000);
  });

  it("F14 · componente externo UNKNOWN NO se convierte en dinero acreditado", async () => {
    const before = await expectedCashMinor();
    const result = await createMoneyOperation(owner, {
      saleId,
      cashSessionId,
      components: [
        { method: "CASH", amountMinor: 300_000, tenderedMinor: 300_000, changeMinor: 0 },
        { method: "CARD", amountMinor: 100_000, outcome: "UNKNOWN" }
      ]
    }, op());
    expect(result.data.status).toBe("UNKNOWN");
    expect(result.data.confirmedMinor).toBe(300_000);
    const components = await database.client`
      select method::text method, outcome::text outcome, amount_minor::int "amountMinor"
        from money.money_components where money_operation_id = ${result.data.id} order by position`;
    expect(String(components[1]!.outcome)).toBe("UNKNOWN");
    const cashMovements = await database.client`select id from cash.cash_movements where money_operation_id = ${result.data.id}`;
    expect(cashMovements).toHaveLength(1);
    expect(await expectedCashMinor()).toBe(before + 300_000);
  });
});
