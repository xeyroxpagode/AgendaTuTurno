import { spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import postgres from "postgres";
import { expect, it } from "vitest";
import { createAgreementVersion } from "../../../apps/api/src/modules/settlement/agreements.js";
import { calculateEstimate } from "../../../apps/api/src/modules/settlement/calculator.js";
import { authenticateQaActor, QA_EMAILS } from "../../support/h07-h08-auth.js";
import { assertQaDatabase } from "../../support/h07-h08-seed.js";

const B1 = "11111111-1111-4111-8111-111111111111";
const OWNER_ACCOUNT = "33333333-3333-4333-8333-333333333333";
const OWNER_STAFF = "bbbbbbb1-1111-4111-8111-111111111111";
const RECEPTION = "bbbbbbb2-2222-4222-8222-222222222222";
const BARBER = "bbbbbbb3-3333-4333-8333-333333333333";

type Signal = { outcome: string; pid: number; semantic?: string; code?: string; replayed?: boolean };

it("QX-08: real settlement worker loss before commit and after commit before acknowledgement", async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
  await assertQaDatabase(sql);
  const start = (mode: string, operationId: string, payload: unknown) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/h08/faults/settlement-worker.mts", mode, operationId, JSON.stringify(payload)], {
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    const exit = once(child, "exit");
    const signals: Signal[] = [];
    child.on("message", (message) => signals.push(message as Signal));
    const waitFor = async (outcome: string): Promise<Signal> => {
      await expect.poll(() => signals.find((signal) => signal.outcome === outcome), { timeout: 12000 }).toBeDefined();
      return signals.find((signal) => signal.outcome === outcome)!;
    };
    return { child, exit, waitFor };
  };
  const kill = async (worker: ReturnType<typeof start>) => {
    expect(worker.child.kill("SIGKILL")).toBe(true);
    const [code, signal] = await worker.exit;
    expect(code === null || code !== 0).toBe(true);
    expect(signal === "SIGKILL" || process.platform === "win32").toBe(true);
  };

  try {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const year = 3200 + randomInt(0, 40);
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Date.UTC(year, 0, 3));
    const occurredAt = new Date(Date.UTC(year, 0, 2));
    const from2 = new Date(Date.UTC(year, 1, 1));
    const to2 = new Date(Date.UTC(year, 1, 3));
    const occurredAt2 = new Date(Date.UTC(year, 1, 2));
    const seed = async (staffMemberId: string, start: Date, end: Date, when: Date) => {
      await createAgreementVersion(owner, {
        staffMemberId, modality: "COMMISSION", commissionBase: "REALIZED", bps: 1000,
        validFrom: start.toISOString(), validTo: end.toISOString()
      }, randomUUID());
      const attendanceId = randomUUID();
      const saleId = randomUUID();
      const operationId = randomUUID();
      await sql`insert into system.operation_attempts(operation_id,business_id,actor_account_id,command_name,request_hash,principal_kind,principal_ref)
        values (${operationId},${B1},${OWNER_ACCOUNT},'qa.crash',${randomUUID()},'STAFF',${OWNER_ACCOUNT})`;
      await sql`insert into attendance.attendances(id,business_id,staff_member_id,attended_by_staff_member_id,walk_in,status,started_at,finished_at,services_performed_snapshot,contact_snapshot)
        values (${attendanceId},${B1},${OWNER_STAFF},${staffMemberId},true,'COMPLETED',${when.toISOString()},${when.toISOString()},
                '[]'::jsonb,'{"name":"QA"}'::jsonb)`;
      await sql`insert into sales.sales(id,business_id,operation_id,status,source,attendance_id,total_minor,actor_account_id,confirmed_at)
        values (${saleId},${B1},${operationId},'CONFIRMED','ATTENDANCE',${attendanceId},10000,${OWNER_ACCOUNT},${when.toISOString()})`;
      await sql`insert into sales.sale_lines(id,business_id,sale_id,position,kind,name,quantity,unit_price_minor,discount_minor,line_total_minor)
        values (${randomUUID()},${B1},${saleId},1,'SERVICE','Corte QA',1,10000,0,10000)`;
      const estimate = await sql.begin((tx) => calculateEstimate(tx as never, owner, { staffMemberId, from: start, to: end }));
      expect(estimate.state).toBe("OPEN_ESTIMATE");
      return { staffMemberId, from: start.toISOString(), to: end.toISOString(),
        confirmation: "CLOSE_SETTLEMENT", expectedFingerprint: estimate.sourceFingerprint };
    };
    const payload = await seed(BARBER, from, to, occurredAt);
    const receptionPayload = await seed(RECEPTION, from2, to2, occurredAt2);

    const rolledBackId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`set local lock_timeout = '5s'`;
      await tx`lock table system.operation_attempts in share mode`;
      const [lock] = await tx`select pg_backend_pid() pid`;
      const worker = start("execute", rolledBackId, payload);
      await worker.waitFor("entered");
      await expect.poll(async () => {
        const [row] = await sql`select count(*)::int n from pg_stat_activity
          where ${Number(lock?.pid)}=any(pg_blocking_pids(pid)) and query like '%insert into system.operation_attempts%'`;
        return row?.n;
      }, { timeout: 6000 }).toBe(1);
      await kill(worker);
    });
    expect(await sql`select operation_id from system.operation_attempts where operation_id=${rolledBackId}`).toHaveLength(0);
    expect(await sql`select id from econ.settlements where business_id=${B1} and staff_member_id=${BARBER} and period_start=${from.toISOString()}`).toHaveLength(0);
    const retryQuery = start("query", rolledBackId, payload);
    expect((await retryQuery.waitFor("error")).code).toBe("NOT_FOUND");
    await retryQuery.exit;
    const retry = start("execute", rolledBackId, payload);
    expect((await retry.waitFor("result")).replayed).toBe(false);
    await retry.exit;
    expect(await sql`select id from econ.settlements where business_id=${B1} and staff_member_id=${BARBER} and period_start=${from.toISOString()}`).toHaveLength(1);

    const committedId = randomUUID();
    const paused = start("pause-after-commit", committedId, receptionPayload);
    const committed = await paused.waitFor("committed");
    const [closed] = await sql`select id, payable_obligation_id from econ.settlements
      where business_id=${B1} and staff_member_id=${RECEPTION} and period_start=${receptionPayload.from}`;
    expect(closed).toBeDefined();
    expect(await sql`select id from obligations.expense_obligations where id=${closed!.payable_obligation_id}`).toHaveLength(1);
    await kill(paused);
    const recovered = start("query", committedId, receptionPayload);
    const read = await recovered.waitFor("read");
    expect(read.pid).not.toBe(committed.pid);
    expect(read.semantic).toBe("SUCCEEDED");
    await recovered.exit;
    const replay = start("execute", committedId, receptionPayload);
    expect((await replay.waitFor("result")).replayed).toBe(true);
    await replay.exit;
    const conflict = start("execute", committedId, payload);
    expect((await conflict.waitFor("error")).code).toBe("IDEMPOTENCY_CONFLICT");
    await conflict.exit;
    expect(await sql`select id from econ.settlements where business_id=${B1} and staff_member_id=${RECEPTION} and period_start=${receptionPayload.from}`).toHaveLength(1);
  } finally {
    await sql.end({ timeout: 4 });
  }
}, 120000);
