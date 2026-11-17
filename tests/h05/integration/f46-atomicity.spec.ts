import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { createCheckout } from "../../../apps/api/src/modules/checkout/commands.js";
import { allocateMoney, createMoneyOperation, refundMoney } from "../../../apps/api/src/modules/money/commands.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { assertQaDatabase, createProductSale, createSellableItem, openCash, op, seedActor, seedBusiness } from "../support.js";

/**
 * ACC-04 / F46 · Atomicidad DB y reconciliación de efectos externos.
 *
 * La inyección de fallo vive SOLO en QA (schema qa_faults) y se elimina al
 * finalizar. No existe ningún flag, endpoint ni ruta de fault injection en
 * código productivo.
 */
describe("H05 atomicidad y fallos inducidos (F46)", () => {
  let owner: Actor;
  let item: { sku: string; locationId: string };
  let cashSessionId: string;

  beforeAll(async () => {
    await assertQaDatabase();
    owner = await seedActor(await seedBusiness("H05 F46 QA"), "OWNER", "Dueño");
    item = await createSellableItem(owner, `F46-${randomUUID().slice(0, 6)}`, 4_000, 6);
    cashSessionId = (await openCash(owner)).cashSessionId;
    await database.client.unsafe(`
      create schema if not exists qa_faults;
      create table if not exists qa_faults.sentinel(operation_id uuid primary key);
      create or replace function qa_faults.stop_money() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from qa_faults.sentinel s where s.operation_id = new.operation_id) then
          raise exception 'QA fault injection: money insert blocked' using errcode = '23514';
        end if;
        return new;
      end $$;
      drop trigger if exists qa_stop_money on money.money_operations;
      create trigger qa_stop_money before insert on money.money_operations
        for each row execute function qa_faults.stop_money();
    `);
  });

  afterAll(async () => {
    await database.client.unsafe(`
      drop trigger if exists qa_stop_money on money.money_operations;
      drop function if exists qa_faults.stop_money();
      drop table if exists qa_faults.sentinel;
      drop schema if exists qa_faults cascade;
    `);
  });

  it("F46 · fallo antes del commit NO deja Sale, Money, Cash ni Commitment parciales", async () => {
    const operationId = op();
    const saleId = await createProductSale(owner, item.sku, item.locationId, 1, 4_000);
    await database.client`insert into qa_faults.sentinel(operation_id) values (${operationId})`;
    try {
      await expect(createCheckout(owner, {
        saleId,
        components: [{ method: "CASH", amountMinor: 4_000, changeMinor: 0 }],
        cashSessionId,
        deliver: true
      }, operationId)).rejects.toThrow();
    } finally {
      await database.client`delete from qa_faults.sentinel where operation_id = ${operationId}`;
    }

    const [sale] = await database.client`select status::text status from sales.sales where id = ${saleId}`;
    expect(String(sale!.status)).toBe("DRAFT"); // el checkout no confirmó la venta
    const [checkout] = await database.client`select id from checkout.checkouts where operation_id = ${operationId}`;
    expect(checkout).toBeUndefined();
    const [money] = await database.client`select id from money.money_operations where operation_id = ${operationId}`;
    expect(money).toBeUndefined();
    // El intento PERSISTE como evidencia durable del fallo probado (estado
    // FAILED), pero ningún efecto financiero/físico quedó registrado.
    const [attempt] = await database.client`select status::text status from system.operation_attempts where operation_id = ${operationId}`;
    expect(String(attempt!.status)).toBe("FAILED");
    const [movements] = await database.client`
      select count(*)::int n from cash.cash_movements where business_id = ${owner.businessId} and operation_id = ${operationId}`;
    expect(Number(movements!.n)).toBe(0);
    const [commitments] = await database.client`
      select count(*)::int n from inventory.commitments where business_id = ${owner.businessId} and operation_id = ${operationId}`;
    expect(Number(commitments!.n)).toBe(0);
  });

  it("F46 · 10 checkouts concurrentes sobre la última unidad: uno solo gana", async () => {
    const scarce = await createSellableItem(owner, `LAST-${randomUUID().slice(0, 6)}`, 4_000, 1);
    const saleIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      saleIds.push(await createProductSale(owner, scarce.sku, scarce.locationId, 1, 4_000));
    }
    const results = await Promise.allSettled(saleIds.map((saleId) => createCheckout(owner, {
      saleId,
      components: [{ method: "CARD", amountMinor: 4_000, outcome: "CONFIRMED", reference: `F46-T-${saleId.slice(0, 6)}`, evidenceReference: `F46-E-${saleId.slice(0, 6)}` }],
      deliver: true
    }, op())));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [position] = await database.client`
      select physical::int physical from inventory.positions
       where business_id = ${owner.businessId} and sku = ${scarce.sku} and purpose = 'SALE'`;
    expect(Number(position!.physical)).toBe(0);
    const [deliveries] = await database.client`
      select count(*)::int n from inventory.movements m
      join inventory.entries e on e.business_id = m.business_id and e.movement_id = m.id
     where m.business_id = ${owner.businessId} and m.kind = 'DELIVERY' and e.sku = ${scarce.sku}`;
    expect(Number(deliveries!.n)).toBe(1);
  });

  it("F46 · allocations concurrentes no superan el dinero confirmado", async () => {
    const money = await createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 5_000, outcome: "CONFIRMED", reference: "F46-ALLOC", evidenceReference: "F46-ALLOC-EV" }]
    }, op());
    const saleA = await createProductSale(owner, item.sku, item.locationId, 1, 4_000);
    const saleB = await createProductSale(owner, item.sku, item.locationId, 1, 4_000);
    const results = await Promise.allSettled([
      allocateMoney(owner, String(money.data.id), { targetType: "sale", targetId: saleA, amountMinor: 3_000 }, op()),
      allocateMoney(owner, String(money.data.id), { targetType: "sale", targetId: saleB, amountMinor: 3_000 }, op())
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [total] = await database.client`
      select coalesce(sum(amount_minor),0)::int n from money.money_allocations where money_operation_id = ${money.data.id}`;
    expect(Number(total!.n)).toBeLessThanOrEqual(5_000);
  });

  it("F46 · refunds concurrentes no superan el remanente", async () => {
    const original = await createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 5_000, outcome: "CONFIRMED", reference: "F46-REFUND", evidenceReference: "F46-REFUND-EV" }]
    }, op());
    const results = await Promise.allSettled([
      refundMoney(owner, String(original.data.id), { amountMinor: 3_000, reason: "Primer refund concurrente" }, op()),
      refundMoney(owner, String(original.data.id), { amountMinor: 3_000, reason: "Segundo refund concurrente" }, op())
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [total] = await database.client`
      select coalesce(sum(confirmed_minor),0)::int n from money.money_operations where refund_of_id = ${original.data.id} and status = 'SUCCEEDED'`;
    expect(Number(total!.n)).toBe(3_000);
  });
});
