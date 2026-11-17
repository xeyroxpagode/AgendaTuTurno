import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { createMoneyOperation } from "../../../apps/api/src/modules/money/commands.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { assertQaDatabase, createProductSale, createSellableItem, openCash, op, seedActor, seedBusiness } from "../support.js";

/**
 * F08 (cierre focalizado) · Un solo ingreso monetario y un solo CashMovement
 * coherente, comprobados con consultas INDEPENDIENTES a PostgreSQL.
 *
 * La prueba F08 original sólo contaba filas de money_operations; esta nueva
 * prueba conserva esa aserción y añade contenido, causalidad, actor, caja,
 * saldo y negativa con payload distinto.
 */
describe("H05 F08 cierre — efectivo e idempotencia de CashMovement", () => {
  let owner: Actor;
  let cashSessionId: string;
  let cashboxId: string;
  let saleId: string;
  let openingAmountMinor: number;

  beforeAll(async () => {
    await assertQaDatabase();
    owner = await seedActor(await seedBusiness("H05 F08 Closure"), "OWNER", "Dueño");
    const cash = await openCash(owner);
    cashSessionId = cash.cashSessionId;
    cashboxId = cash.cashboxId;
    const [session] = await database.client`
      select opening_amount_minor::int "openingAmountMinor" from cash.cash_sessions where id = ${cashSessionId}`;
    openingAmountMinor = Number(session!.openingAmountMinor);
    const item = await createSellableItem(owner, `F08-${randomUUID().slice(0, 6)}`, 6_000, 4);
    saleId = await createProductSale(owner, item.sku, item.locationId, 1, 6_000);
  });

  async function expectedCashMinor(): Promise<number> {
    const [row] = await database.client`
      select coalesce(sum(case when type in ('INCOME','SALE_CASH') then amount_minor else -amount_minor end),0)::int total
        from cash.cash_movements where business_id = ${owner.businessId} and cash_session_id = ${cashSessionId}`;
    return openingAmountMinor + Number(row!.total);
  }

  it("F08 · primer cobro y replay: una MoneyOperation, un CashMovement, sin duplicados", async () => {
    const operationId = op();
    const body = { saleId, cashSessionId, components: [{ method: "CASH", amountMinor: 6_000, tenderedMinor: 6_000, changeMinor: 0 }] };
    const beforeCash = await expectedCashMinor();

    const first = await createMoneyOperation(owner, body, operationId);
    expect(first.data.status).toBe("SUCCEEDED");
    expect(first.data.confirmedMinor).toBe(6_000);
    const moneyId = String(first.data.id);

    // --- Aserciones independientes tras el PRIMER cobro ---
    const moneyRows = await database.client`
      select id, status::text status, confirmed_minor::int "confirmedMinor", amount_minor::int "amountMinor",
             business_id "businessId", actor_account_id "actorAccountId", operation_id "operationId"
        from money.money_operations where operation_id = ${operationId}`;
    expect(moneyRows).toHaveLength(1);
    expect(String(moneyRows[0]!.status)).toBe("SUCCEEDED");
    expect(Number(moneyRows[0]!.confirmedMinor)).toBe(6_000);
    expect(Number(moneyRows[0]!.amountMinor)).toBe(6_000);
    expect(String(moneyRows[0]!.businessId)).toBe(owner.businessId);
    expect(String(moneyRows[0]!.actorAccountId)).toBe(owner.accountId);
    expect(String(moneyRows[0]!.operationId)).toBe(operationId);
    expect(String(moneyRows[0]!.id)).toBe(moneyId);

    const movements = await database.client`
      select id, type::text type, amount_minor::int "amountMinor", reason,
             business_id "businessId", cash_session_id "cashSessionId", money_operation_id "moneyOperationId",
             operation_id "operationId", actor_account_id "actorAccountId"
        from cash.cash_movements where money_operation_id = ${moneyId}`;
    expect(movements).toHaveLength(1);
    expect(String(movements[0]!.type)).toBe("SALE_CASH");
    expect(Number(movements[0]!.amountMinor)).toBe(6_000);
    expect(String(movements[0]!.businessId)).toBe(owner.businessId);
    expect(String(movements[0]!.cashSessionId)).toBe(cashSessionId);
    expect(String(movements[0]!.moneyOperationId)).toBe(moneyId);
    expect(String(movements[0]!.operationId)).toBe(operationId);
    expect(String(movements[0]!.actorAccountId)).toBe(owner.accountId);

    const [cashbox] = await database.client`
      select cashbox_id "cashboxId" from cash.cash_sessions where id = ${cashSessionId}`;
    expect(String(cashbox!.cashboxId)).toBe(cashboxId);
    expect(await expectedCashMinor()).toBe(beforeCash + 6_000);

    const allocations = await database.client`
      select id, target_type::text "targetType", target_id "targetId", amount_minor::int "amountMinor"
        from money.money_allocations where money_operation_id = ${moneyId}`;
    expect(allocations).toHaveLength(1);
    expect(String(allocations[0]!.targetType)).toBe("SALE");
    expect(String(allocations[0]!.targetId)).toBe(saleId);
    expect(Number(allocations[0]!.amountMinor)).toBe(6_000);

    // --- Replay con la MISMA clave y el MISMO payload ---
    const second = await createMoneyOperation(owner, body, operationId);
    expect(second.replayed).toBe(true);
    expect(String(second.data.id)).toBe(moneyId);

    const [moneyCount] = await database.client`select count(*)::int n from money.money_operations where operation_id = ${operationId}`;
    const [movementCount] = await database.client`select count(*)::int n from cash.cash_movements where money_operation_id = ${moneyId}`;
    const [allocationCount] = await database.client`select count(*)::int n from money.money_allocations where money_operation_id = ${moneyId}`;
    expect(Number(moneyCount!.n)).toBe(1);
    expect(Number(movementCount!.n)).toBe(1);
    expect(Number(allocationCount!.n)).toBe(1);
    expect(await expectedCashMinor()).toBe(beforeCash + 6_000); // exactamente una vez
  });

  it("F08 · la misma operation_id con payload distinto se rechaza sin efectos adicionales", async () => {
    const operationId = op();
    const body = { saleId, cashSessionId, components: [{ method: "CASH", amountMinor: 5_000, tenderedMinor: 5_000, changeMinor: 0 }] };
    await createMoneyOperation(owner, body, operationId);
    const beforeCash = await expectedCashMinor();
    const [moneyBefore] = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    const [movementsBefore] = await database.client`select count(*)::int n from cash.cash_movements where business_id = ${owner.businessId}`;

    await expect(createMoneyOperation(owner, {
      saleId, cashSessionId, components: [{ method: "CASH", amountMinor: 7_000, tenderedMinor: 7_000, changeMinor: 0 }]
    }, operationId)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const [moneyAfter] = await database.client`select count(*)::int n from money.money_operations where business_id = ${owner.businessId}`;
    const [movementsAfter] = await database.client`select count(*)::int n from cash.cash_movements where business_id = ${owner.businessId}`;
    expect(Number(moneyAfter!.n)).toBe(Number(moneyBefore!.n));
    expect(Number(movementsAfter!.n)).toBe(Number(movementsBefore!.n));
    expect(await expectedCashMinor()).toBe(beforeCash);
  });
});
