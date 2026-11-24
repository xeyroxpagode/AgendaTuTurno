import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import postgres from "postgres";
import { expect, it } from "vitest";
import { createCourse, scheduleSession } from "../../../apps/api/src/modules/courses/commands.js";
import { authenticateQaActor, QA_EMAILS } from "../../support/h07-h08-auth.js";
import { assertQaDatabase } from "../../support/h07-h08-seed.js";

it("QX-07: real course worker loss before commit and after commit before acknowledgement", async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
  await assertQaDatabase(sql);
  type Signal = { outcome: string; pid: number; semantic?: string; code?: string; replayed?: boolean };
  const start = (mode: string, operationId: string, sessionId: string) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/h07/faults/course-worker.mts", mode, operationId, sessionId], {
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    const exit = once(child, "exit");
    const signals: Signal[] = [];
    child.on("message", (message) => signals.push(message as Signal));
    const waitFor = async (outcome: string): Promise<Signal> => {
      await expect.poll(() => signals.find((signal) => signal.outcome === outcome), { timeout: 9000 }).toBeDefined();
      return signals.find((signal) => signal.outcome === outcome)!;
    };
    return { child, exit, waitFor };
  };
  const kill = async (worker: ReturnType<typeof start>) => {
    expect(worker.child.kill("SIGKILL")).toBe(true);
    const [code, signal] = await worker.exit;
    console.log("Worker terminated", { pid: worker.child.pid, code, signal });
    expect(code === null || code !== 0).toBe(true);
    expect(signal === "SIGKILL" || process.platform === "win32").toBe(true);
  };

  try {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const barber = await authenticateQaActor(QA_EMAILS.barber);
    const course = await createCourse(owner, { title: `Curso QA crash ${randomUUID()}` }, randomUUID());
    const [free] = await sql`select to_char(day,'YYYY-MM-DD') date from generate_series(current_date+90,current_date+250,interval '1 day') day
      where not exists (select 1 from availability.resource_allocations a where a.staff_member_id=${barber.staffMemberId}
        and a.local_date=day::date and a.status='ACTIVE') order by day limit 1`;
    const createSession = (localStart: string) => scheduleSession(owner, { courseId: course.data.id, instructorStaffMemberId: barber.staffMemberId,
      localDate: free!.date, localStart, durationMinutes: 30 }, randomUUID());
    const first = await createSession("11:00");
    const second = await createSession("11:30");
    const rolledBackId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`set local lock_timeout = '5s'`;
      await tx`lock table availability.resource_allocations in share mode`;
      console.log("Availability table locked");
      const [lock] = await tx`select pg_backend_pid() pid`;
      const worker = start("execute", rolledBackId, first.data.id);
      console.log("Course worker entered", await worker.waitFor("entered"));
      try {
        await expect.poll(async () => {
          const [row] = await sql`select count(*)::int n from pg_stat_activity where ${Number(lock?.pid)}=any(pg_blocking_pids(pid)) and query like '%insert into availability.resource_allocations%'`;
          return row?.n;
        }, { timeout: 5000 }).toBe(1);
        console.log("Course allocation waiting on independent PostgreSQL lock");
      } finally {
        await kill(worker);
      }
    });
    expect(await sql`select operation_id from system.operation_attempts where operation_id=${rolledBackId}`).toHaveLength(0);
    expect(await sql`select id from availability.resource_allocations where source_id=${first.data.id}`).toHaveLength(0);
    expect((await sql`select status from courses.course_sessions where id=${first.data.id}`)[0]?.status).toBe("SCHEDULED");
    const unknown = start("query", rolledBackId, first.data.id);
    expect((await unknown.waitFor("error")).code).toBe("NOT_FOUND");
    console.log("Pre-commit: original attempt absent, retry safe");
    await unknown.exit;
    const retry = start("execute", rolledBackId, first.data.id);
    expect((await retry.waitFor("result")).replayed).toBe(false);
    await retry.exit;
    expect(await sql`select id from availability.resource_allocations where source_id=${first.data.id} and status='ACTIVE'`).toHaveLength(1);

    const committedId = randomUUID();
    const paused = start("pause-after-commit", committedId, second.data.id);
    const committed = await paused.waitFor("committed");
    console.log("Post-commit: worker paused before acknowledgement", committed);
    expect(await sql`select id from availability.resource_allocations where source_id=${second.data.id} and status='ACTIVE'`).toHaveLength(1);
    await kill(paused);

    const replacement = start("query", committedId, second.data.id);
    const recovered = await replacement.waitFor("read");
    expect(recovered.pid).not.toBe(committed.pid);
    expect(recovered.semantic).toBe("SUCCEEDED");
    console.log("Recovered from a new worker", { pid: recovered.pid, status: recovered.semantic });
    await replacement.exit;
    const replay = start("execute", committedId, second.data.id);
    expect((await replay.waitFor("result")).replayed).toBe(true);
    await replay.exit;
    const conflict = start("execute", committedId, first.data.id);
    expect((await conflict.waitFor("error")).code).toBe("IDEMPOTENCY_CONFLICT");
    await conflict.exit;
    expect(await sql`select id from availability.resource_allocations where source_id=${second.data.id} and status='ACTIVE'`).toHaveLength(1);
    expect(await sql`select id from courses.course_session_events where operation_id=${committedId} and event_type='CONFIRMED'`).toHaveLength(1);
  } finally {
    await sql.end({ timeout: 4 });
  }
}, 60000);
