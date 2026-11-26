import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertQaDatabase } from "../../support/h07-h08-seed";
import { authenticateQaActor, QA_EMAILS } from "../../support/h07-h08-auth";
import { createAgreementVersion, agreementVersions } from "../../../apps/api/src/modules/settlement/agreements.js";
import { calculateEstimate } from "../../../apps/api/src/modules/settlement/calculator.js";
import { closeSettlement } from "../../../apps/api/src/modules/settlement/close.js";
import { listObligations } from "../../../apps/api/src/modules/obligations/queries.js";
import { createObligation, payObligation } from "../../../apps/api/src/modules/obligations/commands.js";
import { issueGrant, revokeGrant } from "../../../apps/api/src/modules/team/service.js";
import { lockBusiness } from "../../../apps/api/src/modules/h05/domain.js";
import { createMoneyOperation, refundMoney } from "../../../apps/api/src/modules/money/commands.js";
import { selfEconomy } from "../../../apps/api/src/modules/settlement/self.js";
import { adjustSettlement, settlementHistory } from "../../../apps/api/src/modules/settlement/adjustments.js";

const B1 = "11111111-1111-4111-8111-111111111111";
const OWNER_ACCOUNT = "33333333-3333-4333-8333-333333333333";
const ORG = "bbbbbbb1-1111-4111-8111-111111111111"; // registra
const BARBER = "bbbbbbb3-3333-4333-8333-333333333333"; // presta

async function freePeriod(sql: postgres.Sql, year: number, length: "days" | "month", days = 1) {
  const start = new Date(Date.UTC(year, 0, 1)).toISOString();
  const size = length === "month" ? "1 month" : `${days} days`;
  const padding = length === "month" ? "1 day" : "0 days";
  const [row] = await sql`
    select candidate "from", candidate+${size}::interval "to"
    from generate_series(${start}::timestamptz, ${start}::timestamptz+interval '30 years', ${size}::interval*2) candidate
    where not exists (
      select 1 from econ.agreement_versions v join econ.agreements a on a.business_id=v.business_id and a.id=v.agreement_id
       where a.business_id=${B1} and a.staff_member_id=${BARBER}
         and v.valid_from<candidate+${size}::interval+${padding}::interval
         and v.valid_to>candidate-${padding}::interval
    ) and not exists (
      select 1 from attendance.attendances a where a.business_id=${B1} and a.attended_by_staff_member_id=${BARBER}
       and a.started_at>=candidate and a.started_at<candidate+${size}::interval
    ) order by candidate limit 1`;
  if (!row) throw new Error(`No free QA test period from ${year}`);
  return { from: new Date(row.from), to: new Date(row.to) };
}

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
    ({ from, to } = await freePeriod(sql, 2028, "month"));
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

  it("listado de versiones por profesional (regresión del 500 detectado en navegador)", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const versions = await agreementVersions(owner, BARBER);
    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((version) => version.status === "ACTIVE" || version.status === "CANCELLED")).toBe(true);
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
    const estimate = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: BARBER, from, to }));
    const request = { staffMemberId: BARBER, from: from.toISOString(), to: to.toISOString(), confirmation: "CLOSE_SETTLEMENT", expectedFingerprint: estimate.sourceFingerprint };
    await expect(closeSettlement(owner, { ...request, expectedFingerprint: "0".repeat(64) }, randomUUID()))
      .rejects.toMatchObject({ code: "ESTIMATE_CHANGED" });
    const closed = await closeSettlement(owner, request, randomUUID());
    expect(closed.data.status).toBe("CLOSED_SNAPSHOT");
    expect(closed.data.payableMinor).toBe("10000");
    expect(closed.data.payableObligationId).toBeTruthy();

    const [obligation] = await sql`select kind, amount_minor "amountMinor" from obligations.expense_obligations where id=${closed.data.payableObligationId}`;
    expect(obligation?.kind).toBe("PAYABLE");
    expect(Number(obligation?.amountMinor)).toBe(10000);

    await expect(closeSettlement(owner, request, randomUUID()))
      .rejects.toMatchObject({ code: "SETTLEMENT_CONFLICT" });

    const snapshotBefore = await sql`select snapshot from econ.settlements where id=${closed.data.settlementId}`;
    await adjustSettlement(owner, { settlementId: closed.data.settlementId, amountMinor: -2000, reason: "Corrección manual posterior autorizada", sourceType: "MANUAL" }, randomUUID());
    const snapshotAfter = await sql`select snapshot from econ.settlements where id=${closed.data.settlementId}`;
    expect(snapshotAfter[0]?.snapshot).toEqual(snapshotBefore[0]?.snapshot);

    const history = await settlementHistory(owner, BARBER);
    expect(history.settlements.filter((item) => item.id === closed.data.settlementId)).toHaveLength(1);
    expect(history.adjustments.filter((item) => item.settlementId === closed.data.settlementId)).toHaveLength(1);
  });

  it("mixed close persists independent canonical obligations, exact large values and replay", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const { from: start, to: end } = await freePeriod(sql, 2042, "days");
    const period = { staffMemberId: BARBER, from: start.toISOString(), to: end.toISOString() };
    const agreement = await createAgreementVersion(owner, {
      staffMemberId: BARBER, modality: "MIXED", fixedAmountMinor: 2_500_000_001, rentAmountMinor: 45_000,
      periodCadence: { unit: "DAYS", interval: 1, anchorDate: period.from.slice(0, 10) },
      validFrom: period.from, validTo: period.to
    }, randomUUID());
    const estimate = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: BARBER, from: start, to: end }));
    expect(estimate.agreementVersions).toEqual([{ id: agreement.data.id, termsHash: agreement.data.termsHash }]);
    expect(estimate.payableMinor).toBe("2500000001");
    expect(estimate.receivableMinor).toBe("45000");

    const operationId = randomUUID();
    const request = { ...period, confirmation: "CLOSE_SETTLEMENT", expectedFingerprint: estimate.sourceFingerprint };
    const closed = await closeSettlement(owner, request, operationId);
    const replay = await closeSettlement(owner, request, operationId);
    expect(replay.replayed).toBe(true);
    expect(replay.data).toEqual(closed.data);

    const obligations = await sql`select id, kind, amount_minor::text amount from obligations.expense_obligations where operation_id=${operationId} order by kind`;
    expect([...obligations]).toEqual([
      { id: closed.data.payableObligationId, kind: "PAYABLE", amount: "2500000001" },
      { id: closed.data.receivableObligationId, kind: "RECEIVABLE", amount: "45000" }
    ]);
    const listed = await listObligations(owner, { kind: "PAYABLE", status: "OPEN", limit: 100 });
    expect(listed.find((row) => (row as { id?: string }).id === closed.data.payableObligationId)?.amountMinor).toBe(2_500_000_001);

    for (const amountMinor of [1_000_000_000, 1_000_000_000, 500_000_001]) {
      const payment = await createMoneyOperation(owner, {
        components: [{ method: "TRANSFER", amountMinor, accredited: true, reference: randomUUID(), evidenceReference: "Acreditación QA G02-R" }]
      }, randomUUID());
      const moneyOperationId = (payment.data as { id: string }).id;
      await payObligation(owner, closed.data.payableObligationId!, { moneyOperationId, amountMinor }, randomUUID());
    }
    const settled = await listObligations(owner, { kind: "PAYABLE", status: "SETTLED", limit: 100 });
    expect(settled.find((row) => (row as { id?: string }).id === closed.data.payableObligationId)?.settledMinor).toBe(2_500_000_001);
  });

  it("Q08-27/29: a confirmed refund can adjust its original settlement once", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const { from, to } = await freePeriod(sql, 2180, "days");
    const period = { staffMemberId: BARBER, from: from.toISOString(), to: to.toISOString() };
    await createAgreementVersion(owner, {
      staffMemberId: BARBER, modality: "COMMISSION", commissionBase: "REALIZED", bps: 1000,
      validFrom: period.from, validTo: period.to
    }, randomUUID());
    const { saleId } = await seedEconomicFact(sql, from, 10000);
    const recordPayment = (linkedSaleId?: string) => createMoneyOperation(owner, {
      ...(linkedSaleId ? { saleId: linkedSaleId } : {}),
      components: [{ method: "TRANSFER", amountMinor: 10000, accredited: true, reference: randomUUID(), evidenceReference: "QA G02-R" }]
    }, randomUUID());
    const payment = await recordPayment(saleId);
    const unrelatedPayment = await recordPayment();
    const estimate = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: BARBER, from, to }));
    const { data: closed } = await closeSettlement(owner, {
      ...period, confirmation: "CLOSE_SETTLEMENT", expectedFingerprint: estimate.sourceFingerprint
    }, randomUUID());
    expect(closed.payableMinor).toBe("1000");
    const readSnapshot = async () => {
      const [row] = await sql`select snapshot, total_payable_minor::text from econ.settlements where id=${closed.settlementId}`;
      return row;
    };
    const original = await readSnapshot();
    const refund = (id: string) => refundMoney(owner, id, {
      amountMinor: 3000, reason: "Reintegro parcial QA G02-R", evidenceReference: randomUUID()
    }, randomUUID());
    const linked = await refund((payment.data as { id: string }).id);
    const unrelated = await refund((unrelatedPayment.data as { id: string }).id);
    const request = {
      settlementId: closed.settlementId, amountMinor: -300, kind: "PAYABLE",
      reason: "Comisión correspondiente al reintegro", sourceType: "REFUND", sourceId: linked.data.id
    };
    await expect(adjustSettlement(owner, { ...request, sourceId: unrelated.data.id }, randomUUID()))
      .rejects.toMatchObject({ code: "ADJUSTMENT_INVALID" });
    await expect(adjustSettlement(owner, { ...request, amountMinor: 300 }, randomUUID()))
      .rejects.toMatchObject({ code: "ADJUSTMENT_INVALID" });
    const operationId = randomUUID();
    const adjusted = await adjustSettlement(owner, request, operationId);
    await expect(adjustSettlement(owner, request, operationId))
      .resolves.toMatchObject({ replayed: true, data: adjusted.data });
    await expect(adjustSettlement(owner, request, randomUUID()))
      .rejects.toMatchObject({ code: "ADJUSTMENT_INVALID" });
    expect(await readSnapshot()).toEqual(original);
    const [obligation] = await sql`select amount_minor::text, status from obligations.expense_obligations where id=${closed.payableObligationId}`;
    expect(obligation).toEqual({ amount_minor: "700", status: "OPEN" });
    const history = await settlementHistory(owner, BARBER);
    expect(history.adjustments.filter((item) => item.settlementId === closed.settlementId))
      .toMatchObject([{ sourceId: linked.data.id, kind: "PAYABLE", amountMinor: "-300" }]);
  });

  it("Q08-22: recalculates settlement after a new sale and closes exactly once", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const { from, to } = await freePeriod(sql, 2100, "days");
    const period = { staffMemberId: BARBER, from: from.toISOString(), to: to.toISOString() };
    await createAgreementVersion(owner, {
      staffMemberId: BARBER, modality: "COMMISSION", commissionBase: "REALIZED", bps: 1000,
      validFrom: period.from, validTo: period.to
    }, randomUUID());
    const preview = () => sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: BARBER, from, to }));
    const reviewed = await preview();
    expect(reviewed.payableMinor).toBe("0");
    const { saleId } = await seedEconomicFact(sql, from, 10000);
    const request = { ...period, confirmation: "CLOSE_SETTLEMENT", expectedFingerprint: reviewed.sourceFingerprint };
    await expect(closeSettlement(owner, request, randomUUID())).rejects.toMatchObject({ code: "ESTIMATE_CHANGED" });
    const previous = await sql`select id from econ.settlements where business_id=${B1} and staff_member_id=${BARBER} and period_start=${period.from}`;
    expect(previous).toHaveLength(0);
    const current = await preview();
    expect(current.sourceFingerprint).not.toBe(reviewed.sourceFingerprint);
    expect(current.payableMinor).toBe("1000");
    const refreshed = { ...request, expectedFingerprint: current.sourceFingerprint };
    const closes = await Promise.allSettled([
      closeSettlement(owner, refreshed, randomUUID()),
      closeSettlement(owner, refreshed, randomUUID())
    ]);
    expect(closes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(closes.filter((result) => result.status === "rejected")[0]?.reason).toMatchObject({ code: "SETTLEMENT_CONFLICT" });
    const sources = await sql`select amount_minor::text from econ.settlement_sources where business_id=${B1} and source_id=${saleId}`;
    expect([...sources]).toEqual([{ amount_minor: "1000" }]);
  });

  it("Q08-14: sale before and after a version boundary uses its own rate and version", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const { from, to } = await freePeriod(sql, 2150, "days", 2);
    const middle = new Date(from.getTime() + 86400000);
    const version = (validFrom: Date, validTo: Date, bps: number) => createAgreementVersion(owner, {
      staffMemberId: BARBER, modality: "COMMISSION", commissionBase: "REALIZED", bps,
      validFrom: validFrom.toISOString(), validTo: validTo.toISOString()
    }, randomUUID());
    const early = await version(from, middle, 1000);
    const late = await version(middle, to, 1500);
    const first = await seedEconomicFact(sql, from, 10000);
    const second = await seedEconomicFact(sql, middle, 10000);
    const result = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: BARBER, from, to }));
    expect(result.state).toBe("OPEN_ESTIMATE");
    expect(result.payableMinor).toBe("2500");
    expect(result.lines).toMatchObject([
      { sourceId: first.saleId, amountMinor: "1000", versionId: early.data.id },
      { sourceId: second.saleId, amountMinor: "1500", versionId: late.data.id }
    ]);
  });

  it.each([
    { description: "fixed starts mid-period", before: [null, null], after: [50000, null], gap: false, payable: null },
    { description: "rent starts mid-period", before: [null, null], after: [null, 50000], gap: false, payable: null },
    { description: "fixed ends mid-period", before: [50000, null], after: [null, null], gap: false, payable: null },
    { description: "fixed amount changes mid-period", before: [50000, null], after: [60000, null], gap: false, payable: null },
    { description: "fixed changes to rent mid-period", before: [50000, null], after: [null, 50000], gap: false, payable: null },
    { description: "identical terms with a gap", before: [50000, null], after: [50000, null], gap: true, payable: null },
    { description: "identical adjacent terms", before: [50000, null], after: [50000, null], gap: false, payable: "50000" }
  ])("E-14: $description", async ({ before, after, gap, payable }) => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const { from, to } = await freePeriod(sql, 2410, "days", 4);
    const change = new Date(from.getTime() + 2 * 86400000);
    const createVersion = (start: Date, end: Date, [fixed, rent]: Array<number | null>) => createAgreementVersion(owner, {
      staffMemberId: BARBER,
      ...(fixed != null ? { modality: "FIXED", fixedAmountMinor: fixed }
        : rent != null ? { modality: "CHAIR_RENT", rentAmountMinor: rent }
        : { modality: "COMMISSION", commissionBase: "REALIZED", bps: 1000 }),
      ...(fixed != null || rent != null ? { periodCadence: { unit: "DAYS", interval: 4, anchorDate: from.toISOString().slice(0, 10) } } : {}),
      validFrom: start.toISOString(), validTo: end.toISOString()
    }, randomUUID());
    await createVersion(from, change, before);
    await createVersion(gap ? new Date(change.getTime() + 86400000) : change, to, after);
    const estimate = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: BARBER, from, to }));
    if (payable === null) {
      expect(estimate.state).toBe("NOT_CONFIGURED");
      await expect(closeSettlement(owner, {
        staffMemberId: BARBER, from: from.toISOString(), to: to.toISOString(),
        confirmation: "CLOSE_SETTLEMENT", expectedFingerprint: estimate.sourceFingerprint
      }, randomUUID())).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
      expect(await sql`select id from econ.settlements where business_id=${B1} and period_start=${from.toISOString()}`).toHaveLength(0);
    } else {
      expect(estimate.state).toBe("OPEN_ESTIMATE");
      expect(estimate.payableMinor).toBe(payable);
      expect(estimate.lines).toHaveLength(1);
      expect(estimate.agreementVersions).toHaveLength(2);
    }
  });

  it("QX-03: payment and grant revocation serialize in both orders", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const recipient = await authenticateQaActor(QA_EMAILS.reception);
    const issue = () => issueGrant(owner, recipient.staffMemberId, {
      roleAssignmentId: recipient.roleAssignmentId, capability: "obligations.pay"
    }, randomUUID());
    const fixture = async () => {
      const obligation = await createObligation(owner, { title: "Pago QA", counterpartyName: "QA", kind: "PAYABLE", amountMinor: 1000 }, randomUUID());
      const payment = await createMoneyOperation(owner, {
        components: [{ method: "TRANSFER", amountMinor: 1000, accredited: true, reference: randomUUID(), evidenceReference: "Transferencia QA" }]
      }, randomUUID());
      return { obligationId: obligation.data.id, moneyOperationId: payment.data.id };
    };
    const firstGrant = await issue();
    const beforeRevoke = await authenticateQaActor(QA_EMAILS.reception);
    const first = await fixture();
    const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
    const waitForWaiter = async (blockingPid: number) => {
      await expect.poll(async () => {
        const [waiting] = await observer`select count(*)::int n from pg_stat_activity where ${blockingPid} = any(pg_blocking_pids(pid))`;
        return waiting?.n ?? 0;
      }, { timeout: 5000 }).toBeGreaterThan(0);
    };
    try {
      let firstResult: Promise<unknown> | undefined;
      await sql.begin(async (tx) => {
        await lockBusiness(tx as never, B1);
        const [blocker] = await tx`select pg_backend_pid() pid`;
        firstResult = payObligation(beforeRevoke, first.obligationId, { moneyOperationId: first.moneyOperationId, amountMinor: 1000 }, randomUUID())
          .catch((error: unknown) => error);
        await waitForWaiter(Number(blocker?.pid));
        await revokeGrant(owner, firstGrant.data.id, randomUUID());
      });
      expect(await firstResult).toMatchObject({ code: "FORBIDDEN" });
      const [noPayment] = await observer`select count(*)::int n from obligations.obligation_payments where obligation_id=${first.obligationId}`;
      expect(noPayment?.n).toBe(0);

      const secondGrant = await issue();
      const authorized = await authenticateQaActor(QA_EMAILS.reception);
      const second = await fixture();
      let secondResult: Promise<unknown> | undefined;
      let revokeResult: Promise<unknown> | undefined;
      await sql.begin(async (tx) => {
        await tx`select id from obligations.expense_obligations where id=${second.obligationId} for update`;
        const [blocker] = await tx`select pg_backend_pid() pid`;
        secondResult = payObligation(authorized, second.obligationId, { moneyOperationId: second.moneyOperationId, amountMinor: 1000 }, randomUUID())
          .catch((error: unknown) => error);
        await waitForWaiter(Number(blocker?.pid));
        const [paymentWaiter] = await observer`select pid from pg_stat_activity where ${Number(blocker?.pid)} = any(pg_blocking_pids(pid))`;
        revokeResult = revokeGrant(owner, secondGrant.data.id, randomUUID()).catch((error: unknown) => error);
        await waitForWaiter(Number(paymentWaiter?.pid));
      });
      expect(await secondResult).toMatchObject({ data: { status: "SETTLED" } });
      expect(await revokeResult).toMatchObject({ data: { id: secondGrant.data.id } });
      const [once] = await observer`select count(*)::int n from obligations.obligation_payments where obligation_id=${second.obligationId}`;
      expect(once?.n).toBe(1);
    } finally {
      await observer.end();
    }
  });

  it("CL-13: Barber lee SOLO su economía; Owner no tiene acceso propio", async () => {
    const own = await selfEconomy(barber, { from: from.toISOString(), to: to.toISOString() });
    expect(own.staffMemberId).toBe(BARBER);
    expect(own.settlements.length).toBeGreaterThan(0);
    expect(JSON.stringify(own).includes(ORG)).toBe(false);
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    await expect(selfEconomy(owner, { from: from.toISOString(), to: to.toISOString() })).rejects.toMatchObject({ code: "ECONOMY_FORBIDDEN" });
  });

  it("P0 EGM: COLLECTED descuenta refunds por refund_of_id y calcula POR VENTA (sin prorrateo)", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const { from: p0From, to: p0To } = await freePeriod(sql, 2090, "month");
    await createAgreementVersion(owner, {
      staffMemberId: BARBER, modality: "COMMISSION", commissionBase: "COLLECTED", bps: 1000,
      validFrom: new Date(p0From.getTime() - 86400000).toISOString(),
      validTo: new Date(p0To.getTime() + 86400000).toISOString()
    }, randomUUID());

    const attendanceId = randomUUID(); const saleId = randomUUID(); const saleOp = randomUUID();
    const occurred = new Date(p0From.getTime() + 86400000);
    await sql`insert into system.operation_attempts(operation_id,business_id,actor_account_id,command_name,request_hash,principal_kind,principal_ref)
      values (${saleOp},${B1},${OWNER_ACCOUNT},'qa.sale-p0',${randomUUID()},'STAFF',${OWNER_ACCOUNT})`;
    await sql`insert into attendance.attendances(id,business_id,staff_member_id,attended_by_staff_member_id,walk_in,status,started_at,finished_at,services_performed_snapshot,contact_snapshot)
      values (${attendanceId},${B1},${ORG},${BARBER},true,'COMPLETED',${occurred.toISOString()},${occurred.toISOString()},'[]'::jsonb,'{"name":"QA"}'::jsonb)`;
    await sql`insert into sales.sales(id,business_id,operation_id,status,source,attendance_id,total_minor,actor_account_id,confirmed_at)
      values (${saleId},${B1},${saleOp},'CONFIRMED','ATTENDANCE',${attendanceId},20000,${OWNER_ACCOUNT},${occurred.toISOString()})`;
    for (const [position, total] of [[1, 10000], [2, 10000]]) {
      await sql`insert into sales.sale_lines(id,business_id,sale_id,position,kind,name,quantity,unit_price_minor,discount_minor,line_total_minor)
        values (${randomUUID()},${B1},${saleId},${position},'SERVICE','Servicio QA',1,${total},0,${total})`;
    }
    // Cobro parcial de 5000 y refund de 2000 vinculado por refund_of_id (H05 real).
    const payment = await createMoneyOperation(owner, {
      saleId, components: [{ method: "CARD", amountMinor: 5000, outcome: "CONFIRMED", reference: "D20-H08-PAYMENT", evidenceReference: "D20-H08-PAYMENT-EVIDENCE" }]
    }, randomUUID());
    await refundMoney(owner, payment.data.id, {
      amountMinor: 2000, reason: "Reintegro causal con linaje canónico", evidenceReference: "D20-H08-REFUND-EVIDENCE"
    }, randomUUID());

    const estimate = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId: BARBER, from: p0From, to: p0To }));
    // Base = 5000 cobrado - 2000 devuelto = 3000, comisión 10% = 300.
    // Sin el correctivo sería 5000 por línea = 10000 base / 1000 comisión.
    expect(estimate.payableMinor).toBe("300");
  });

  it("cross-business: actor B2 no puede operar sobre la economía de B1", async () => {
    const ownerB2 = await authenticateQaActor(QA_EMAILS.ownerB2);
    expect(ownerB2.businessId).toBe("22222222-2222-4222-8222-222222222222");
    const [rows] = await sql`select count(*)::int count from econ.settlements where business_id=${ownerB2.businessId}`;
    expect(rows?.count).toBe(0);
  });
});

