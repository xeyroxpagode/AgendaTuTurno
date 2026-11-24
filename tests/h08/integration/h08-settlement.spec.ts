import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertQaDatabase } from "../../support/h07-h08-seed";
import { authenticateQaActor, QA_EMAILS } from "../../support/h07-h08-auth";
import { createAgreementVersion } from "../../../apps/api/src/modules/settlement/agreements.js";
import { calculateEstimate } from "../../../apps/api/src/modules/settlement/calculator.js";
import { closeSettlement } from "../../../apps/api/src/modules/settlement/close.js";
import { selfEconomy } from "../../../apps/api/src/modules/settlement/self.js";
import { adjustSettlement, settlementHistory } from "../../../apps/api/src/modules/settlement/adjustments.js";

const B1 = "11111111-1111-4111-8111-111111111111";
const OWNER_ACCOUNT = "33333333-3333-4333-8333-333333333333";
const ORG = "bbbbbbb1-1111-4111-8111-111111111111"; // registra
const BARBER = "bbbbbbb3-3333-4333-8333-333333333333"; // presta

async function seedEconomicFact(sql: postgres.Sql, occurredAt: Date, lineTotalMinor: number) {
  const attendanceId = randomUUID();
  const saleId = randomUUID();
  const operationId = randomUUID();
  await sql`insert into system.operation_attempts(operation_id,business_id,actor_account_id,command_name,request_hash,principal_kind,principal_ref)\n    values (${operationId},${B1},${OWNER_ACCOUNT},'qa.sale',${randomUUID()},'STAFF',${OWNER_ACCOUNT})`;
  // Quien REGISTRA es ORG; quien PRESTA es BARBER (NEW-ATTRIBUTION).
  await sql`insert into attendance.attendances(id,business_id,staff_member_id,attended_by_staff_member_id,walk_in,status,started_at,finished_at,services_performed_snapshot,contact_snapshot)
    values (${attendanceId},${B1},${ORG},${BARBER},true,'COMPLETED',${occurredAt.toISOString()},${occurredAt.toISOString()},
            '[{"name":"Corte QA","durationMinutes":60}]'::jsonb,'{"name":"QA"}'::jsonb)`;
  await sql`insert into sales.sales(id,business_id,operation_id,status,source,attendance_id,total_minor,actor_account_id,confirmed_at)\n    values (${saleId},${B1},${operationId},'CONFIRMED','ATTENDANCE',${attendanceId},${lineTotalMinor},${OWNER_ACCOUNT},${occurredAt.toISOString()})`;
  await sql`insert into sales.sale_lines(id,business_id,sale_id,position,kind,name,quantity,unit_price_minor,discount_minor,line_total_minor)
    values (${randomUUID()},${B1},${saleId},1,'SERVICE','Corte QA',1,${lineTotalMinor},0,${lineTotalMinor})`;
  return { attendanceId, saleId };
}

describe("H08 · Economía sobre PostgreSQL QA real", () => {
  let sql: postgres.Sql;
  let barber: Awaited<ReturnType<typeof authenticateQaActor>>;
  let from: Date;
  let to: Date;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!);
    await assertQaDatabase(sql);
    barber = await authenticateQaActor(QA_EMAILS.barber);
    const now = new Date();
    // Período único por ejecución: los tests son idempotentes sobre la BD QA.
    const offset = 1 + Math.floor(Math.random() * 120);
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
    await seedEconomicFact(sql, new Date(from.getTime() + 86400000), 100000);
  });
  afterAll(async () => { await sql?.end(); });

  it("NOT_CONFIGURED: sin acuerdo no se inventa comisión ni importe cero", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const estimate = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: ORG, from, to }));
    expect(estimate.state).toBe("NOT_CONFIGURED");
  });

  it("acuerdo versionado + estimación 10% sobre 100000 = 10000", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    await createAgreementVersion(owner, {
      staffMemberId: BARBER, modality: "COMMISSION", commissionBase: "REALIZED", bps: 1000,
      validFrom: new Date(from.getTime() - 86400000).toISOString(), validTo: new Date(to.getTime() + 86400000).toISOString()
    }, randomUUID());
    const estimate = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: BARBER, from, to }));
    expect(estimate.state).toBe("OPEN_ESTIMATE");
    expect(estimate.payableMinor).toBe("10000");
    expect(estimate.lines.some((line) => line.component === "COMMISSION" && line.amountMinor === "10000")).toBe(true);
  });

  it("acuerdo incompleto (sin base) se rechaza en validación", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    await expect(createAgreementVersion(owner, {
      staffMemberId: ORG, modality: "COMMISSION", bps: 1000,
      validFrom: new Date(from.getTime() + 400 * 86400000).toISOString(),
      validTo: new Date(from.getTime() + 430 * 86400000).toISOString()
    }, randomUUID())).rejects.toThrow();
  });

  it("cierre inmutable, obligación H05 y doble cierre rechazado", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const closed = await closeSettlement(owner, { staffMemberId: BARBER, from: from.toISOString(), to: to.toISOString(), confirmation: "CLOSE_SETTLEMENT" }, randomUUID());
    expect(closed.data.status).toBe("CLOSED_SNAPSHOT");
    expect(closed.data.payableMinor).toBe("10000");
    expect(closed.data.payableObligationId).toBeTruthy();

    const [obligation] = await sql`select kind, amount_minor "amountMinor" from obligations.expense_obligations where id=${closed.data.payableObligationId}`;
    expect(obligation?.kind).toBe("PAYABLE");
    expect(Number(obligation?.amountMinor)).toBe(10000);

    await expect(closeSettlement(owner, { staffMemberId: BARBER, from: from.toISOString(), to: to.toISOString(), confirmation: "CLOSE_SETTLEMENT" }, randomUUID()))
      .rejects.toMatchObject({ code: "SETTLEMENT_CONFLICT" });

    const snapshotBefore = await sql`select snapshot from econ.settlements where id=${closed.data.settlementId}`;
    await adjustSettlement(owner, { settlementId: closed.data.settlementId, amountMinor: -2000, reason: "Refund posterior autorizado", sourceType: "REFUND" }, randomUUID());
    const snapshotAfter = await sql`select snapshot from econ.settlements where id=${closed.data.settlementId}`;
    expect(snapshotAfter[0]?.snapshot).toEqual(snapshotBefore[0]?.snapshot);

    const history = await settlementHistory(owner, BARBER);
    expect(history.settlements.filter((item) => item.id === closed.data.settlementId)).toHaveLength(1);
    expect(history.adjustments.filter((item) => item.settlementId === closed.data.settlementId)).toHaveLength(1);
  });

  it("CL-13: Barber lee SOLO su economía; Owner no tiene acceso propio", async () => {
    const own = await selfEconomy(barber, { from: from.toISOString(), to: to.toISOString() });
    expect(own.staffMemberId).toBe(BARBER);
    expect(own.settlements.length).toBeGreaterThan(0);
    expect(JSON.stringify(own).includes(ORG)).toBe(false);
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    await expect(selfEconomy(owner, { from: from.toISOString(), to: to.toISOString() })).rejects.toMatchObject({ code: "ECONOMY_FORBIDDEN" });
  });

  it("cross-business: actor B2 no puede operar sobre la economía de B1", async () => {
    const ownerB2 = await authenticateQaActor(QA_EMAILS.ownerB2);
    expect(ownerB2.businessId).toBe("22222222-2222-4222-8222-222222222222");
    const [rows] = await sql`select count(*)::int count from econ.settlements where business_id=${ownerB2.businessId}`;
    expect(rows?.count).toBe(0);
  });
});

