import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../../../apps/api/src/lib/runtime.js";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { allocateMoney, createMoneyOperation, refundMoney } from "../../../apps/api/src/modules/money/commands.js";
import { getMoneyOperation } from "../../../apps/api/src/modules/money/queries.js";
import { createCheckout, resumeCheckout } from "../../../apps/api/src/modules/checkout/commands.js";
import { assertQaDatabase, seedBusiness, seedActor, openCash, op, createSellableItem, createProductSale } from "../support.js";

describe("D20 · devoluciones con evidencia, medio y linaje real (PostgreSQL)", () => {
  let owner: Actor, other: Actor, cashier: Actor;
  let cashSessionId: string;
  let item: { sku: string; locationId: string };
  const reason = "Devolución QA D20 documentada";
  const evidenceReference = "QA-REFUND-REAL-RECEIPT";
  const external = (method: "TRANSFER" | "CARD", amountMinor = 10000) => ({ method, amountMinor,
    ...(method === "TRANSFER" ? { accredited: true } : { outcome: "CONFIRMED" }), reference: "QA-ORIGINAL", evidenceReference: "QA-ORIGINAL-PROOF" });
  const payment = async (method: "TRANSFER" | "CARD" = "TRANSFER", amountMinor = 10000) =>
    (await createMoneyOperation(owner, { components: [external(method, amountMinor)] }, op())).data;
  const sale = () => createProductSale(owner, item.sku, item.locationId, 1, 10000);
  async function noFinancialWrites(operationId: string) {
    for (const table of ["money.money_operations", "cash.cash_movements", "money.money_allocations"]) {
      const rows = await database.client.unsafe(`select id from ${table} where operation_id=$1`, [operationId]);
      expect(rows, table).toHaveLength(0);
    }
  }
  beforeAll(async () => {
    await assertQaDatabase();
    owner = await seedActor(await seedBusiness("D20 corrective QA"), "OWNER", "D20 Owner");
    other = await seedActor(await seedBusiness("D20 other Business"), "OWNER", "D20 Other");
    cashier = await seedActor(owner.businessId, "RECEPTIONIST", "D20 Cashier");
    cashSessionId = (await openCash(owner)).cashSessionId;
    item = await createSellableItem(owner, `D20-${op().slice(0, 8)}`, 10000, 100);
  });

  it.each(["TRANSFER", "CARD"] as const)("%s rechaza evidencia ausente, vacía, corta sin escritura financiera", async (method) => {
    const original = await payment(method);
    for (const evidence of [undefined, "", "x", "  "]) {
      const id = op();
      await expect(refundMoney(owner, original.id, { amountMinor: 1000, reason, evidenceReference: evidence }, id))
        .rejects.toMatchObject({ code: "MONEY_EVIDENCE_REQUIRED" });
      await noFinancialWrites(id);
    }
  });

  it.each(["TRANSFER", "CARD"] as const)("%s conserva medio, evidencia y componente original en refund parcial y total remanente", async (method) => {
    const original = await payment(method);
    for (const amountMinor of [3000, 7000]) {
      const result = await refundMoney(owner, original.id, { amountMinor, reason, evidenceReference }, op());
      expect(result.data.components).toHaveLength(1);
      expect(result.data.components[0]).toMatchObject({ method, outcome: "CONFIRMED", amountMinor,
        externalReference: evidenceReference, evidenceReference, refundOfComponentId: original.components[0]!.id,
        accredited: method === "TRANSFER" ? true : null });
      expect(result.data.attributions).toHaveLength(1);
      expect(result.data.attributions[0]).toMatchObject({ originalAllocationId: null, amountMinor });
      const movements = await database.client`select id from cash.cash_movements where money_operation_id=${result.data.id}`;
      expect(movements).toHaveLength(0);
    }
    await expect(refundMoney(owner, original.id, { amountMinor: 1, reason, evidenceReference }, op()))
      .rejects.toMatchObject({ code: "REFUND_EXCEEDS_AVAILABLE" });
    expect((await getMoneyOperation(owner, original.id)).confirmedMinor).toBe(10000);
  });

  it("CASH exige comprobante genérico y caja vigente, sin referencia de terminal externa", async () => {
    const original = (await createMoneyOperation(owner, { cashSessionId, components: [{ method: "CASH", amountMinor: 3000 }] }, op())).data;
    const current = await openCash(owner);
    const result = await refundMoney(owner, original.id, { amountMinor: 1000, reason, evidenceReference: "QA-RECIBO-REINTEGRO-CASH", cashSessionId: current.cashSessionId }, op());
    const [movement] = await database.client`select cash_session_id, amount_minor::int amount, type from cash.cash_movements where money_operation_id=${result.data.id}`;
    expect(movement).toMatchObject({ cash_session_id: current.cashSessionId, amount: 1000, type: "EXPENSE" });
    expect(result.data.components[0]).toMatchObject({ method: "CASH", refundOfComponentId: original.components[0]!.id,
      externalReference: null, evidenceReference: "QA-RECIBO-REINTEGRO-CASH", accredited: null });
    for (const evidence of [undefined, "", "x"]) {
      const rejectedId = op();
      await expect(refundMoney(owner, original.id, { amountMinor: 1000, reason, evidenceReference: evidence, cashSessionId: current.cashSessionId }, rejectedId))
        .rejects.toMatchObject({ code: "MONEY_EVIDENCE_REQUIRED" });
      await noFinancialWrites(rejectedId);
    }
    const id = op();
    await expect(refundMoney(owner, original.id, { amountMinor: 1000, reason, evidenceReference: "QA-RECIBO-CASH", cashSessionId: op() }, id)).rejects.toBeDefined();
    await noFinancialWrites(id);
  });

  it("mixto parcial exige componentes; selección explícita respeta medio y evidencia por componente", async () => {
    const original = (await createMoneyOperation(owner, { cashSessionId, components: [
      { method: "CASH", amountMinor: 3000 }, external("TRANSFER", 4000), external("CARD", 3000)
    ] }, op())).data;
    const id = op();
    await expect(refundMoney(owner, original.id, { amountMinor: 1000, reason, evidenceReference }, id)).rejects.toMatchObject({ code: "CONFLICT" });
    await noFinancialWrites(id);
    const result = await refundMoney(owner, original.id, { amountMinor: 2000, reason, components: [
      { originalComponentId: original.components[1]!.id, amountMinor: 1500, reference: "BANK-REFUND-9", evidenceReference: "BANK-PROOF-9" },
      { originalComponentId: original.components[2]!.id, amountMinor: 500, reference: "TERM-REFUND-9", evidenceReference: "TERM-PROOF-9" }
    ] }, op());
    expect(result.data.components.map((component) => component.method)).toEqual(["TRANSFER", "CARD"]);
    expect(result.data.components.map((component) => component.evidenceReference)).toEqual(["BANK-PROOF-9", "TERM-PROOF-9"]);
  });

  it("mixto full reconstruye TODOS los remanentes sin prioridad CASH", async () => {
    const original = (await createMoneyOperation(owner, { cashSessionId, components: [
      { method: "CASH", amountMinor: 1000 }, external("TRANSFER", 2000), external("CARD", 3000)
    ] }, op())).data;
    const result = await refundMoney(owner, original.id, { amountMinor: 6000, reason, evidenceReference, cashSessionId }, op());
    expect(result.data.components.map((component) => [component.method, component.amountMinor])).toEqual([["CASH", 1000], ["TRANSFER", 2000], ["CARD", 3000]]);
  });

  it("evidencia por componente necesita tanto referencia real como prueba", async () => {
    const original = await payment();
    for (const evidence of [{ reference: "BANK-REFUND" }, { evidenceReference: "BANK-PROOF" }]) {
      const id = op();
      await expect(refundMoney(owner, original.id, { amountMinor: 1000, reason, components: [
        { originalComponentId: original.components[0]!.id, amountMinor: 1000, ...evidence }
      ] }, id)).rejects.toMatchObject({ code: "MONEY_EVIDENCE_REQUIRED" });
      await noFinancialWrites(id);
    }
  });

  it("límites acumulados por componente: no usar el remanente de otro componente", async () => {
    const original = (await createMoneyOperation(owner, { components: [external("CARD", 3000), external("CARD", 7000)] }, op())).data;
    const part = (amountMinor: number) => ({ amountMinor, reason, evidenceReference, components: [{ originalComponentId: original.components[0]!.id, amountMinor }] });
    await refundMoney(owner, original.id, part(2000), op());
    const id = op();
    await expect(refundMoney(owner, original.id, part(2000), id)).rejects.toMatchObject({ code: "CONFLICT" });
    await noFinancialWrites(id);
  });

  it("anticipo parcialmente asignado exige distribución y bloquea reasignar saldo ya devuelto", async () => {
    const original = await payment();
    const targetId = await sale();
    const allocated = await allocateMoney(owner, original.id, { targetType: "sale", targetId, amountMinor: 4000 }, op());
    const allocationId = allocated.data.allocations[0]!.id;
    const id = op();
    await expect(refundMoney(owner, original.id, { amountMinor: 8000, reason, evidenceReference }, id)).rejects.toMatchObject({ code: "CONFLICT" });
    await noFinancialWrites(id);
    const result = await refundMoney(owner, original.id, { amountMinor: 8000, reason, evidenceReference, attributions: [
      { originalAllocationId: allocationId, amountMinor: 2000 }, { amountMinor: 6000 }
    ] }, op());
    expect(result.data.attributions).toHaveLength(2);
    expect((await getMoneyOperation(owner, original.id)).availableMinor).toBe(0);
    await expect(allocateMoney(owner, original.id, { targetType: "sale", targetId, amountMinor: 1 }, op())).rejects.toMatchObject({ code: "MONEY_ALLOCATION_EXCEEDED" });
    const [preserved] = await database.client`select amount_minor::int amount from money.money_allocations where id=${allocationId}`;
    expect(preserved!.amount).toBe(4000);
  });

  it("dos destinos: distribución exacta y límites acumulados por allocation", async () => {
    const original = await payment();
    const first = await allocateMoney(owner, original.id, { targetType: "sale", targetId: await sale(), amountMinor: 4000 }, op());
    const second = await allocateMoney(owner, original.id, { targetType: "sale", targetId: await sale(), amountMinor: 6000 }, op());
    const firstId = first.data.allocations[0]!.id;
    const secondId = second.data.allocations.find((allocation) => allocation.id !== firstId)!.id;
    await expect(refundMoney(owner, original.id, { amountMinor: 1000, reason, evidenceReference }, op())).rejects.toMatchObject({ code: "CONFLICT" });
    await refundMoney(owner, original.id, { amountMinor: 3000, reason, evidenceReference,
      attributions: [{ originalAllocationId: firstId, amountMinor: 1000 }, { originalAllocationId: secondId, amountMinor: 2000 }] }, op());
    const id = op();
    await expect(refundMoney(owner, original.id, { amountMinor: 4000, reason, evidenceReference,
      attributions: [{ originalAllocationId: firstId, amountMinor: 4000 }] }, id)).rejects.toMatchObject({ code: "CONFLICT" });
    await noFinancialWrites(id);
  });

  it("única allocation sin remanente admite inferencia inequívoca", async () => {
    const original = await payment();
    const allocated = await allocateMoney(owner, original.id, { targetType: "sale", targetId: await sale(), amountMinor: 10000 }, op());
    const result = await refundMoney(owner, original.id, { amountMinor: 1000, reason, evidenceReference }, op());
    expect(result.data.attributions[0]).toMatchObject({ originalAllocationId: allocated.data.allocations[0]!.id, amountMinor: 1000 });
  });

  it("saldo no asignado tiene límite acumulado propio", async () => {
    const original = await payment();
    await allocateMoney(owner, original.id, { targetType: "sale", targetId: await sale(), amountMinor: 4000 }, op());
    await refundMoney(owner, original.id, { amountMinor: 5000, reason, evidenceReference, attributions: [{ amountMinor: 5000 }] }, op());
    const id = op();
    await expect(refundMoney(owner, original.id, { amountMinor: 2000, reason, evidenceReference, attributions: [{ amountMinor: 2000 }] }, id))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await noFinancialWrites(id);
  });

  it("rechaza sumas no exactas, duplicados y referencias ajenas sin efectos parciales", async () => {
    const original = await payment();
    const unrelated = await payment();
    const foreign = await allocateMoney(owner, unrelated.id, { targetType: "sale", targetId: await sale(), amountMinor: 1000 }, op());
    const componentId = original.components[0]!.id;
    for (const extra of [
      { components: [{ originalComponentId: unrelated.components[0]!.id, amountMinor: 1000 }] },
      { components: [{ originalComponentId: componentId, amountMinor: 500 }] },
      { components: [{ originalComponentId: componentId, amountMinor: 500 }, { originalComponentId: componentId, amountMinor: 500 }] },
      { attributions: [{ originalAllocationId: foreign.data.allocations[0]!.id, amountMinor: 1000 }] },
      { attributions: [{ amountMinor: 500 }, { amountMinor: 500 }] },
      { attributions: [{ amountMinor: 999 }] },
    ]) {
      const id = op();
      await expect(refundMoney(owner, original.id, { amountMinor: 1000, reason, evidenceReference, ...extra }, id)).rejects.toMatchObject({ code: "CONFLICT" });
      await noFinancialWrites(id);
    }
  });

  it("Business y autoridad: no confunde pagos por igualdad de importe", async () => {
    const first = await payment(), second = await payment();
    await refundMoney(owner, second.id, { amountMinor: 1000, reason, evidenceReference }, op());
    expect((await getMoneyOperation(owner, first.id)).refundedMinor).toBe(0);
    expect((await getMoneyOperation(owner, second.id)).refundedMinor).toBe(1000);
    for (const [actor, code] of [[other, "NOT_FOUND"], [cashier, "FORBIDDEN"]] as const) {
      const id = op();
      await expect(refundMoney(actor, first.id, { amountMinor: 1000, reason, evidenceReference }, id)).rejects.toMatchObject({ code });
      await noFinancialWrites(id);
    }
    const revoked = await seedActor(owner.businessId, "OWNER", "Revoked D20");
    await database.client`update iam.access_sessions set revoked_at=now(), revoked_reason='QA' where id=${revoked.accessSessionId}`;
    const id = op();
    await expect(refundMoney(revoked, first.id, { amountMinor: 1000, reason, evidenceReference }, id)).rejects.toMatchObject({ code: "SESSION_REVOKED" });
    await noFinancialWrites(id);
  });

  it("replay y carrera del mismo ID producen un solo refund/linaje", async () => {
    const original = await payment(), id = op();
    const body = { amountMinor: 2000, reason, evidenceReference };
    const results = await Promise.all([refundMoney(owner, original.id, body, id), refundMoney(owner, original.id, body, id)]);
    expect(results[0].data.id).toBe(results[1].data.id);
    expect(results.some((result) => result.replayed)).toBe(true);
    const attrs = await database.client`select id from money.refund_attributions where refund_id=${results[0].data.id}`;
    expect(attrs).toHaveLength(1);
  });

  it("concurrencia con IDs distintos no excede remanente", async () => {
    const original = await payment();
    const results = await Promise.allSettled([1, 2].map(() => refundMoney(owner, original.id, { amountMinor: 7000, reason, evidenceReference }, op())));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await getMoneyOperation(owner, original.id)).refundedMinor).toBe(7000);
  });

  it("concurrencia respeta el remanente de UN componente aunque quede dinero en otro", async () => {
    const original = (await createMoneyOperation(owner, { components: [external("CARD", 3000), external("CARD", 7000)] }, op())).data;
    const body = { amountMinor: 2500, reason, evidenceReference, components: [{ originalComponentId: original.components[0]!.id, amountMinor: 2500 }] };
    const results = await Promise.allSettled([refundMoney(owner, original.id, body, op()), refundMoney(owner, original.id, body, op())]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await getMoneyOperation(owner, original.id)).refundedMinor).toBe(2500);
  });

  it("concurrencia respeta UNA allocation aunque quede dinero en otro destino", async () => {
    const original = await payment();
    const allocated = await allocateMoney(owner, original.id, { targetType: "sale", targetId: await sale(), amountMinor: 4000 }, op());
    await allocateMoney(owner, original.id, { targetType: "sale", targetId: await sale(), amountMinor: 6000 }, op());
    const body = { amountMinor: 3000, reason, evidenceReference, attributions: [{ originalAllocationId: allocated.data.allocations[0]!.id, amountMinor: 3000 }] };
    const results = await Promise.allSettled([refundMoney(owner, original.id, body, op()), refundMoney(owner, original.id, body, op())]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("carrera allocate vs devolución de saldo no asignado no consume dos veces el mismo dinero", async () => {
    const original = await payment();
    await allocateMoney(owner, original.id, { targetType: "sale", targetId: await sale(), amountMinor: 4000 }, op());
    const targetId = await sale();
    const results = await Promise.allSettled([
      allocateMoney(owner, original.id, { targetType: "sale", targetId, amountMinor: 5000 }, op()),
      refundMoney(owner, original.id, { amountMinor: 5000, reason, evidenceReference, attributions: [{ amountMinor: 5000 }] }, op())
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [oracle] = await database.client`select
      (select coalesce(sum(amount_minor),0) from money.money_allocations where business_id=${owner.businessId} and money_operation_id=${original.id})
      +(select coalesce(sum(a.amount_minor),0) from money.refund_attributions a join money.money_operations r on r.business_id=a.business_id and r.id=a.refund_id
        where r.business_id=${owner.businessId} and r.refund_of_id=${original.id} and a.original_allocation_id is null) used`;
    expect(Number(oracle!.used)).toBe(9000);
    expect((await getMoneyOperation(owner, original.id)).availableMinor).toBe(1000);
  });

  it("límites enteros: máximo exacto, fracciones y sobrelímite rechazados", async () => {
    const original = await payment("TRANSFER", 1000000000);
    for (const amountMinor of [0, -1, 0.1, 1000000001]) {
      const id = op();
      await expect(refundMoney(owner, original.id, { amountMinor, reason, evidenceReference }, id)).rejects.toBeDefined();
      await noFinancialWrites(id);
    }
    const result = await refundMoney(owner, original.id, { amountMinor: 1000000000, reason, evidenceReference }, op());
    expect(result.data.confirmedMinor).toBe(1000000000);
  });

  it("guards SQL: linaje inmutable y FKs compuestas", async () => {
    const original = await payment();
    const result = await refundMoney(owner, original.id, { amountMinor: 1000, reason, evidenceReference }, op());
    await expect(database.client`update money.money_components set refund_of_component_id=null where id=${result.data.components[0]!.id}`).rejects.toMatchObject({ code: "23514" });
    await expect(database.client`delete from money.refund_attributions where refund_id=${result.data.id}`).rejects.toMatchObject({ code: "23514" });
    await expect(database.client`insert into money.refund_attributions(business_id,refund_id,amount_minor) values (${other.businessId},${result.data.id},1)`)
      .rejects.toMatchObject({ code: "23503" });
  });

  it("checkout REFUND no fabrica checkout:<id>: requiere y propaga evidencia externa real", async () => {
    const created = await createCheckout(owner, { saleId: await sale(), components: [external("TRANSFER")], deliver: false }, op());
    const checkoutId = String(created.data.id);
    // Incidencia de entrega real por ubicación desactivada; no mock financiero.
    await database.client`update inventory.locations set active=false where business_id=${owner.businessId} and id=${item.locationId}`;
    try {
      await resumeCheckout(owner, checkoutId, { resolution: "DELIVER", reason, expectedRevision: created.data.revision }, op());
    } finally {
      await database.client`update inventory.locations set active=true where business_id=${owner.businessId} and id=${item.locationId}`;
    }
    const [pending] = await database.client`select revision::int revision,status from checkout.checkouts where id=${checkoutId}`;
    expect(pending!.status).toBe("DELIVERY_PENDING");
    const body = { resolution: "REFUND", reason, expectedRevision: pending!.revision };
    const id = op();
    await expect(resumeCheckout(owner, checkoutId, body, id)).rejects.toMatchObject({ code: "MONEY_EVIDENCE_REQUIRED" });
    await noFinancialWrites(id);
    const result = await resumeCheckout(owner, checkoutId, { ...body, evidenceReference }, op());
    expect(result.data.status).toBe("RESOLVED");
    const [component] = await database.client`select c.method,c.evidence_reference,c.external_reference from money.money_components c
      join money.money_operations r on r.business_id=c.business_id and r.id=c.money_operation_id where r.refund_of_id=${String(created.data.moneyOperationId)}`;
    expect(component).toMatchObject({ method: "TRANSFER", evidence_reference: evidenceReference, external_reference: evidenceReference });
  });
});
