import { randomInt, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertQaDatabase } from "../../support/h07-h08-seed";
import { authenticateQaActor, QA_EMAILS } from "../../support/h07-h08-auth";
import { createAgreementVersion } from "../../../apps/api/src/modules/settlement/agreements.js";
import { eligibleSources } from "../../../apps/api/src/modules/settlement/attribution.js";
import { calculateEstimate } from "../../../apps/api/src/modules/settlement/calculator.js";

const B1 = "11111111-1111-4111-8111-111111111111";
const OWNER_ACCOUNT = "33333333-3333-4333-8333-333333333333";
const BARBER = "bbbbbbb3-3333-4333-8333-333333333333";

async function freePeriod(sql: postgres.Sql, year: number, days = 1) {
  const start = new Date(Date.UTC(year, 0, 1)).toISOString();
  const [row] = await sql`
    select candidate "from", candidate+${`${days + 1} days`}::interval "to"
    from generate_series(${start}::timestamptz, ${start}::timestamptz+interval '30 years', interval '90 days') candidate
    where not exists (
      select 1 from econ.agreement_versions v join econ.agreements a on a.business_id=v.business_id and a.id=v.agreement_id
       where a.business_id=${B1} and a.staff_member_id=${BARBER}
         and v.valid_from<candidate+${`${days + 1} days`}::interval and v.valid_to>candidate-${`${days} days`}::interval
    ) order by candidate limit 1`;
  if (!row) throw new Error(`Sin período QA libre desde ${year}`);
  return { from: new Date(row.from), to: new Date(row.to) };
}

async function seedFact(sql: postgres.Sql, occurredAt: Date, netMinor: number, status = "COMPLETED", discountMinor = 0) {
  const attendanceId = randomUUID();
  const saleId = randomUUID();
  const operationId = randomUUID();
  await sql`insert into system.operation_attempts(operation_id,business_id,actor_account_id,command_name,request_hash,principal_kind,principal_ref)
    values (${operationId},${B1},${OWNER_ACCOUNT},'qa.gap',${randomUUID()},'STAFF',${OWNER_ACCOUNT})`;
  await sql`insert into attendance.attendances(id,business_id,staff_member_id,attended_by_staff_member_id,walk_in,status,started_at,finished_at,services_performed_snapshot,contact_snapshot)
    values (${attendanceId},${B1},${BARBER},${BARBER},true,${status},${occurredAt.toISOString()},${occurredAt.toISOString()},
            '[]'::jsonb,'{"name":"QA"}'::jsonb)`;
  await sql`insert into sales.sales(id,business_id,operation_id,status,source,attendance_id,total_minor,actor_account_id,confirmed_at)
    values (${saleId},${B1},${operationId},'CONFIRMED','ATTENDANCE',${attendanceId},${netMinor},${OWNER_ACCOUNT},${occurredAt.toISOString()})`;
  await sql`insert into sales.sale_lines(id,business_id,sale_id,position,kind,name,quantity,unit_price_minor,discount_minor,line_total_minor)
    values (${randomUUID()},${B1},${saleId},1,'SERVICE','Corte QA',1,${netMinor + discountMinor},${discountMinor},${netMinor})`;
  return { saleId, attendanceId, operationId };
}

describe("H08 — oráculos contractuales pendientes sobre PostgreSQL QA real", () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!);
    await assertQaDatabase(sql);
  });
  afterAll(async () => { await sql?.end(); });

  it("Q08-05: versiones superpuestas se rechazan (AGREEMENT_OVERLAP)", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const { from, to } = await freePeriod(sql, 2170, 2);
    const input = { staffMemberId: BARBER, modality: "COMMISSION", commissionBase: "REALIZED", bps: 1000,
      validFrom: from.toISOString(), validTo: to.toISOString() };
    await createAgreementVersion(owner, input, randomUUID());
    await expect(createAgreementVersion(owner, input, randomUUID()))
      .rejects.toMatchObject({ code: "AGREEMENT_OVERLAP" });
    const [count] = await sql`select count(*)::int n from econ.agreement_versions v
      join econ.agreements a on a.business_id=v.business_id and a.id=v.agreement_id
      where a.business_id=${B1} and a.staff_member_id=${BARBER} and v.valid_from=${from.toISOString()}`;
    expect(count?.n).toBe(1);
  });

  it("Q08-08: prestación cancelada o no-show no genera comisión", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const { from, to } = await freePeriod(sql, 2180, 2);
    await createAgreementVersion(owner, { staffMemberId: BARBER, modality: "COMMISSION",
      commissionBase: "REALIZED", bps: 1000, validFrom: from.toISOString(), validTo: to.toISOString() }, randomUUID());
    // H03/H05 no registran "NO_SHOW": la prestación no realizada queda
    // INTERRUPTED/PARTIAL, y la reserva cancelada no genera Attendance completada.
    await seedFact(sql, new Date(from.getTime() + 3600000), 10000, "INTERRUPTED");
    await seedFact(sql, new Date(from.getTime() + 7200000), 10000, "PARTIAL");
    const sources = await sql.begin((tx) => eligibleSources(tx as never, B1, BARBER, from, to));
    expect(sources).toEqual([]);
    const estimate = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: BARBER, from, to }));
    expect(estimate.payableMinor).toBe("0");
  });

  it("Q08-10: dinero UNKNOWN no es cobro confirmado", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const { from, to } = await freePeriod(sql, 2190, 2);
    await createAgreementVersion(owner, { staffMemberId: BARBER, modality: "COMMISSION",
      commissionBase: "COLLECTED", bps: 1000, validFrom: from.toISOString(), validTo: to.toISOString() }, randomUUID());
    const { saleId } = await seedFact(sql, new Date(from.getTime() + 3600000), 10000);
    const operationId = randomUUID();
    await sql`insert into system.operation_attempts(operation_id,business_id,actor_account_id,command_name,request_hash,principal_kind,principal_ref)
      values (${operationId},${B1},${OWNER_ACCOUNT},'qa.unknown',${randomUUID()},'STAFF',${OWNER_ACCOUNT})`;
    await sql`insert into money.money_operations(id,business_id,operation_id,kind,status,sale_id,amount_minor,currency,actor_account_id)
      values (${operationId},${B1},${operationId},'PAYMENT','UNKNOWN',${saleId},10000,'ARS',${OWNER_ACCOUNT})`;
    await sql`insert into money.money_allocations(id,business_id,money_operation_id,target_type,target_id,amount_minor,actor_account_id,operation_id)
      values (${randomUUID()},${B1},${operationId},'SALE',${saleId},10000,${OWNER_ACCOUNT},${operationId})`;
    const estimate = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: BARBER, from, to }));
    expect(estimate.payableMinor).toBe("0");
    expect(estimate.lines[0]?.collectedOperations ?? []).toEqual([]);
    expect((await sql`select id from money.money_operations where id=${operationId} and status='UNKNOWN'`)).toHaveLength(1);
  });

  it("Q08-12: reintento de atribución no duplica fuentes", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const { from, to } = await freePeriod(sql, 2200, 2);
    await createAgreementVersion(owner, { staffMemberId: BARBER, modality: "COMMISSION",
      commissionBase: "REALIZED", bps: 1000, validFrom: from.toISOString(), validTo: to.toISOString() }, randomUUID());
    const { saleId } = await seedFact(sql, new Date(from.getTime() + 3600000), 10000);
    const first = await sql.begin((tx) => eligibleSources(tx as never, B1, BARBER, from, to));
    const second = await sql.begin((tx) => eligibleSources(tx as never, B1, BARBER, from, to));
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first[0]?.sourceId).toBe(saleId);
  });

  it("Q08-16 / NEW-17: descuento de línea ya está neteado en la base y no se duplica", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const { from, to } = await freePeriod(sql, 2210, 2);
    await createAgreementVersion(owner, { staffMemberId: BARBER, modality: "COMMISSION",
      commissionBase: "REALIZED", bps: 1000, validFrom: from.toISOString(), validTo: to.toISOString() }, randomUUID());
    const { saleId } = await seedFact(sql, new Date(from.getTime() + 3600000), 8000, "COMPLETED", 2000);
    const [source] = await sql.begin((tx) => eligibleSources(tx as never, B1, BARBER, from, to));
    expect(source.sourceId).toBe(saleId);
    expect(source.lineTotalMinor).toBe(8000n);
    expect(source.commissionMinor).toBe(800n);
    const estimate = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: BARBER, from, to }));
    expect(estimate.payableMinor).toBe("800");
  });

  it("NEW-15: una misma fuente no puede liquidarse en dos intervalos", async () => {
    const base = new Date(Date.UTC(3000 + randomInt(0, 900), randomInt(0, 10), 1 + randomInt(0, 20)));
    const from = base;
    const to = new Date(base.getTime() + 86400000);
    const other = { from: new Date(base.getTime() + 2 * 86400000), to: new Date(base.getTime() + 3 * 86400000) };
    const make = async (start: Date, end: Date) => {
      const [row] = await sql`insert into econ.settlements(business_id,staff_member_id,period_start,period_end,terms_hash,source_fingerprint,total_payable_minor,total_receivable_minor,snapshot,closed_by_account_id)
        values (${B1},${BARBER},${start.toISOString()},${end.toISOString()},'t','f',0,0,'{}'::jsonb,${OWNER_ACCOUNT}) returning id`;
      return row.id as string;
    };
    const first = await make(from, to);
    const second = await make(other.from, other.to);
    const sourceId = randomUUID();
    await sql`insert into econ.settlement_sources(business_id,settlement_id,source_type,source_id,component,amount_minor)
      values (${B1},${first},'SALE',${sourceId},'COMMISSION',100)`;
    await expect(sql`insert into econ.settlement_sources(business_id,settlement_id,source_type,source_id,component,amount_minor)
      values (${B1},${second},'SALE',${sourceId},'COMMISSION',100)`).rejects.toMatchObject({ code: "23505" });
  });
});
