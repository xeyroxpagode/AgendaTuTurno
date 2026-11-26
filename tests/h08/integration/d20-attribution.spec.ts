import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { authenticateQaActor, QA_EMAILS } from "../../support/h07-h08-auth.js";
import { assertQaDatabase } from "../../support/h07-h08-seed.js";
import { createAgreementVersion } from "../../../apps/api/src/modules/settlement/agreements.js";
import { calculateEstimate } from "../../../apps/api/src/modules/settlement/calculator.js";
import { eligibleSources } from "../../../apps/api/src/modules/settlement/attribution.js";
import { allocateMoney, createMoneyOperation, refundMoney } from "../../../apps/api/src/modules/money/commands.js";

const sql = database.client;
const professional = "bbbbbbb3-3333-4333-8333-333333333333";
let owner: Awaited<ReturnType<typeof authenticateQaActor>>;

// INSERTs prepare isolated economic fixtures, not productive refund resolution.
async function fixture(totals: number[]) {
  const [period] = await sql`
    select candidate "from", candidate+interval '1 day' "to"
    from generate_series('2450-01-01'::timestamptz,'2480-01-01'::timestamptz,interval '3 days') candidate
    where not exists (
      select 1 from econ.agreement_versions v join econ.agreements a on a.business_id=v.business_id and a.id=v.agreement_id
      where a.business_id=${owner.businessId} and a.staff_member_id=${professional}
        and v.valid_from<candidate+interval '1 day' and v.valid_to>candidate
    ) order by candidate limit 1`;
  if (!period) throw new Error("No free isolated D20 period");
  const from = new Date(period.from), to = new Date(period.to);
  await createAgreementVersion(owner, { staffMemberId: professional, modality: "COMMISSION", commissionBase: "COLLECTED", bps: 1000, validFrom: from.toISOString(), validTo: to.toISOString() }, randomUUID());
  const sales: string[] = [];
  for (const total of totals) {
    const attendance = randomUUID(), sale = randomUUID(), op = randomUUID();
    const occurred = new Date(from.getTime() + 3600000).toISOString();
    await sql`insert into system.operation_attempts(operation_id,business_id,actor_account_id,command_name,request_hash,principal_kind,principal_ref)
      values (${op},${owner.businessId},${owner.accountId},'qa.d20.sale',${randomUUID()},'STAFF',${owner.accountId})`;
    await sql`insert into attendance.attendances(id,business_id,staff_member_id,attended_by_staff_member_id,walk_in,status,started_at,finished_at,services_performed_snapshot,contact_snapshot)
      values (${attendance},${owner.businessId},${owner.staffMemberId},${professional},true,'COMPLETED',${occurred},${occurred},'[]'::jsonb,'{"name":"QA"}'::jsonb)`;
    await sql`insert into sales.sales(id,business_id,operation_id,status,source,attendance_id,total_minor,actor_account_id,confirmed_at)
      values (${sale},${owner.businessId},${op},'CONFIRMED','ATTENDANCE',${attendance},${total},${owner.accountId},${occurred})`;
    await sql`insert into sales.sale_lines(business_id,sale_id,position,kind,name,quantity,unit_price_minor,discount_minor,line_total_minor)
      values (${owner.businessId},${sale},1,'SERVICE','D20 QA',1,${total},0,${total})`;
    sales.push(sale);
  }
  return { from, to, sales };
}

async function payment(amount: number) {
  return (await createMoneyOperation(owner, { components: [{ method: "CARD", amountMinor: amount, outcome: "CONFIRMED", reference: `TERM-${randomUUID()}`, evidenceReference: `EV-${randomUUID()}` }] }, randomUUID())).data;
}

async function allocation(paymentId: string, saleId: string, amount: number) {
  await allocateMoney(owner, paymentId, { targetType: "sale", targetId: saleId, amountMinor: amount }, randomUUID());
  const [row] = await sql`select id from money.money_allocations where business_id=${owner.businessId} and money_operation_id=${paymentId} and target_type='SALE' and target_id=${saleId} order by created_at desc limit 1`;
  return String(row!.id);
}

async function sources(period: Awaited<ReturnType<typeof fixture>>) {
  return sql.begin((tx) => eligibleSources(tx as never, owner.businessId, professional, period.from, period.to));
}

async function historicalCase(marker: string) {
  const [row] = await sql`select r.id refund_id,origin.id payment_id,
    min(a.started_at)-interval '1 hour' "from",min(a.started_at)+interval '23 hours' "to"
    from money.money_operations r join money.money_operations origin on origin.business_id=r.business_id and origin.id=r.refund_of_id
    join money.money_allocations ma on ma.business_id=origin.business_id and ma.money_operation_id=origin.id and ma.target_type='SALE'
    join sales.sales s on s.business_id=ma.business_id and s.id=ma.target_id
    join attendance.attendances a on a.business_id=s.business_id and a.id=s.attendance_id
    where r.business_id=${owner.businessId} and r.note=${marker} and r.kind='REFUND'
    group by r.id,origin.id order by r.id limit 1`;
  if (!row) throw new Error("Run tests/h08/d20-legacy-seed.mts BEFORE applying the D20 migration to a new isolated QA database");
  return { refund: String(row.refund_id), payment: String(row.payment_id), from: new Date(row.from), to: new Date(row.to), sales: [] as string[] };
}

describe("D20 · atribución económica explícita sobre PostgreSQL QA", () => {
  beforeAll(async () => { await assertQaDatabase(sql); owner = await authenticateQaActor(QA_EMAILS.owner); });

  it("anticipo parcial: devolución explícita de saldo y venta conserva base exacta", async () => {
    const period = await fixture([10000]);
    const original = await payment(10000);
    const allocated = await allocation(original.id, period.sales[0]!, 4000);
    const result = await refundMoney(owner, original.id, { amountMinor: 8000, reason: "D20 reintegro con destinos", evidenceReference: "QA-REFUND-8000", attributions: [{ amountMinor: 6000 }, { originalAllocationId: allocated, amountMinor: 2000 }] }, randomUUID());
    const [source] = await sources(period);
    expect(source!.baseMinor).toBe(2000n);
    expect(source!.commissionMinor).toBe(200n);
    expect(source!.refundOperations).toEqual([result.data.id]);
    const [oracle] = await sql`select sum(amount_minor)::text amount from money.refund_attributions where refund_id=${result.data.id}`;
    expect(oracle!.amount).toBe("8000");
  });

  it("dos ventas: sólo se descuenta la allocation seleccionada, sin prorrateo", async () => {
    const period = await fixture([10000, 10000]);
    const original = await payment(10000);
    const first = await allocation(original.id, period.sales[0]!, 4000);
    await allocation(original.id, period.sales[1]!, 6000);
    await refundMoney(owner, original.id, { amountMinor: 3000, reason: "D20 destino único explícito", evidenceReference: "QA-REFUND-3000", attributions: [{ originalAllocationId: first, amountMinor: 3000 }] }, randomUUID());
    const rows = await sources(period);
    expect(rows.find((s) => s.saleId === period.sales[0])!.baseMinor).toBe(1000n);
    expect(rows.find((s) => s.saleId === period.sales[1])!.baseMinor).toBe(6000n);
    expect(rows.reduce((n, s) => n + s.baseMinor, 0n)).toBe(7000n);
  });

  it("dos pagos iguales: refund no afecta la venta ni huella del pago ajeno", async () => {
    const period = await fixture([10000, 10000]);
    const first = await payment(10000), second = await payment(10000);
    await allocation(first.id, period.sales[0]!, 10000);
    const target = await allocation(second.id, period.sales[1]!, 10000);
    await refundMoney(owner, second.id, { amountMinor: 3000, reason: "D20 identidad no importe", evidenceReference: "QA-SECOND-IDENTITY", attributions: [{ originalAllocationId: target, amountMinor: 3000 }] }, randomUUID());
    const rows = await sources(period);
    expect(rows.find((s) => s.saleId === period.sales[0])!.baseMinor).toBe(10000n);
    expect(rows.find((s) => s.saleId === period.sales[0])!.refundOperations).toEqual([]);
    expect(rows.find((s) => s.saleId === period.sales[1])!.baseMinor).toBe(7000n);
  });

  it("múltiples refunds parciales conservan el total y cambian la huella causal", async () => {
    const period = await fixture([10000]);
    const original = await payment(10000), target = await allocation(original.id, period.sales[0]!, 10000);
    const snapshotsBefore = await sql`select id,snapshot::text snapshot from econ.settlements where business_id=${owner.businessId} order by id`;
    const before = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: professional, from: period.from, to: period.to }));
    for (const amount of [1000, 2000]) await refundMoney(owner, original.id, { amountMinor: amount, reason: "D20 parciales sucesivas", evidenceReference: `QA-PARTIAL-${amount}`, attributions: [{ originalAllocationId: target, amountMinor: amount }] }, randomUUID());
    const after = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: professional, from: period.from, to: period.to }));
    expect(after.payableMinor).toBe("700");
    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
    expect((await sources(period))[0]!.refundOperations).toHaveLength(2);
    const snapshotsAfter = await sql`select id,snapshot::text snapshot from econ.settlements where business_id=${owner.businessId} order by id`;
    expect(snapshotsAfter).toEqual(snapshotsBefore);
  });

  it("histórico de anticipo parcial ambiguo es UNKNOWN de atribución, no cero ni Money.UNKNOWN", async () => {
    const period = await historicalCase("D20-LEGACY-PARTIAL");
    await expect(sources(period)).rejects.toMatchObject({ code: "SETTLEMENT_CONFLICT", details: { attributionState: "UNKNOWN", refundIds: [period.refund] } });
    const [persisted] = await sql`select status from money.money_operations where id=${period.refund}`;
    expect(persisted!.status).toBe("SUCCEEDED");
  });

  it("histórico multiventa ambiguo no permite estimación definitiva ni cambia hechos", async () => {
    const period = await historicalCase("D20-LEGACY-MULTI");
    const before = await sql`select row_to_json(m)::text snapshot from money.money_operations m where id=${period.payment}`;
    await expect(sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: professional, from: period.from, to: period.to }))).rejects.toMatchObject({ code: "SETTLEMENT_CONFLICT", details: { attributionState: "UNKNOWN" } });
    const after = await sql`select row_to_json(m)::text snapshot from money.money_operations m where id=${period.payment}`;
    expect(after).toEqual(before);
  });

  it("sale_id inicial con excedente no acredita a qué destino se devolvió el dinero", async () => {
    const period = await historicalCase("D20-LEGACY-LINKED-EXCESS");
    const [fact] = await sql`select sale_id,confirmed_minor::text amount from money.money_operations where id=${period.payment}`;
    expect(fact!.sale_id).not.toBeNull();
    expect(fact!.amount).toBe("20000");
    await expect(sources(period)).rejects.toMatchObject({ code: "SETTLEMENT_CONFLICT", details: { attributionState: "UNKNOWN", refundIds: [period.refund] } });
  });
});
