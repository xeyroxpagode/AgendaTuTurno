import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";
import { database } from "../../../apps/api/src/lib/runtime.js";
import { assertQaDatabase, seedActor, seedBusiness } from "../support.js";

/**
 * ACC-02 / F40 · Recuperación REAL tras interrupción de proceso.
 *
 * El proceso que prepara el intento es reemplazado por otro distinto (PID
 * diferente) mediante SIGKILL. La durabilidad se comprueba en PostgreSQL, no
 * en la memoria del proceso original.
 */
describe("H05 crash recovery real (F40)", () => {
  let actor: Actor;
  let operationId: string;
  let reconciliationOperationId: string;
  let workerPath: string;
  const tsxCli = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");

  beforeAll(async () => {
    await assertQaDatabase();
    actor = await seedActor(await seedBusiness("H05 Crash QA"), "OWNER", "Recovery");
    operationId = randomUUID();
    reconciliationOperationId = randomUUID();
    workerPath = resolve(process.cwd(), "tests/h05/faults/recovery-worker.ts");
  });

  function workerArgs(mode: string, out: string, extra: Record<string, string> = {}): string[] {
    return [
      workerPath, "--mode", mode, "--out", out,
      "--operationId", operationId,
      "--moneyOperationId", extra.moneyOperationId ?? "",
      "--accountId", actor.accountId,
      "--personId", actor.personId,
      "--staffMemberId", actor.staffMemberId,
      "--businessId", actor.businessId,
      "--roleAssignmentId", actor.roleAssignmentId,
      "--accessSessionId", actor.accessSessionId,
      "--role", actor.role,
      "--reconciliationOperationId", reconciliationOperationId
    ];
  }

  async function runWorker(mode: string, out: string, extra: Record<string, string> = {}): Promise<Record<string, any>> {
    await unlink(out).catch(() => undefined);
    const child = spawn(process.execPath, [tsxCli, ...workerArgs(mode, out, extra)], {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number>((done) => child.on("exit", (value) => done(value ?? -1)));
    if (code !== 0) throw new Error(`Worker ${mode} falló (${code}): ${stderr}`);
    return JSON.parse(await readFile(out, "utf8"));
  }

  function startPrepareWorker(out: string): { child: ChildProcess; ready: Promise<Record<string, any>> } {
    const child = spawn(process.execPath, [tsxCli, ...workerArgs("prepare", out)], {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const ready = new Promise<Record<string, any>>((done, fail) => {
      const timer = setInterval(async () => {
        try { done(JSON.parse(await readFile(out, "utf8"))); clearInterval(timer); } catch { /* aún no escribió */ }
      }, 100);
      setTimeout(() => { clearInterval(timer); fail(new Error("El worker no preparó el intento a tiempo")); }, 30_000);
    });
    return { child, ready };
  }

  it("F40 · el intento sobrevive al kill del proceso y se reconcilia en uno nuevo", async () => {
    const preparedOut = resolve(process.cwd(), "artifacts/h05/acceptance/crash-prepared.json");
    await unlink(preparedOut).catch(() => undefined);
    const { child, ready } = startPrepareWorker(preparedOut);
    const prepared = await ready;
    expect(prepared.status).toBe("UNKNOWN");
    expect(prepared.confirmedMinor).toBe(0);

    // Durabilidad comprobada desde el coordinador, fuera del proceso que preparó.
    const [attemptRow] = await database.client`
      select status::text status, completed_at "completedAt" from system.operation_attempts
       where operation_id = ${operationId} and business_id = ${actor.businessId}`;
    expect(attemptRow).toBeTruthy();
    expect(["UNKNOWN", "STARTED"]).toContain(String(attemptRow!.status));

    child.kill("SIGKILL");
    await new Promise<void>((done) => child.on("exit", () => done()));

    const queryOut = resolve(process.cwd(), "artifacts/h05/acceptance/crash-query.json");
    const queried = await runWorker("query", queryOut);
    expect(queried.pid).not.toBe(prepared.pid); // proceso realmente distinto
    expect(["UNKNOWN", "STARTED"]).toContain(String(queried.attempt.status));
    expect(queried.attempt.operationId).toBe(operationId);

    const recoverOut = resolve(process.cwd(), "artifacts/h05/acceptance/crash-recovered.json");
    const recovered = await runWorker("recover", recoverOut, { moneyOperationId: prepared.moneyOperationId });
    expect(recovered.pid).not.toBe(prepared.pid);
    expect(recovered.status).toBe("SUCCEEDED");
    expect(recovered.confirmedMinor).toBe(3_000);

    const [finalAttempt] = await database.client`select status::text status from system.operation_attempts where operation_id = ${operationId}`;
    expect(String(finalAttempt!.status)).toBe("SUCCEEDED");
  }, 90_000);

  it("F40 · la reconciliación repetida no duplica dinero, allocations ni caja", async () => {
    const [money] = await database.client`
      select count(*)::int n from money.money_operations where business_id = ${actor.businessId}`;
    const [allocations] = await database.client`
      select count(*)::int n from money.money_allocations where business_id = ${actor.businessId}`;
    const [cash] = await database.client`
      select count(*)::int n from cash.cash_movements where business_id = ${actor.businessId}`;
    expect(Number(money!.n)).toBe(1);
    expect(Number(allocations!.n)).toBe(0);
    expect(Number(cash!.n)).toBe(0); // tarjeta nunca genera efectivo
  });

  it("F40 · replay con el mismo operation_id devuelve el resultado guardado", async () => {
    const out = resolve(process.cwd(), "artifacts/h05/acceptance/crash-query-repeat.json");
    const repeat = await runWorker("query", out);
    expect(repeat.attempt.status).toBe("SUCCEEDED");
    const [money] = await database.client`select count(*)::int n from money.money_operations where business_id = ${actor.businessId}`;
    expect(Number(money!.n)).toBe(1);
  });
});
