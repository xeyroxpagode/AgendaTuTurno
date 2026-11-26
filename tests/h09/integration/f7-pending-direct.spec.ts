/**
 * F7 · Certificación directa de escenarios pendientes del runner.
 * No depende del runner: API de dominio + PostgreSQL QA real + GoTrue real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commercial, ownerSummary } from "../../../apps/api/src/modules/reporting/blocks.js";
import { resolveInterval } from "../../../apps/api/src/modules/reporting/dto.js";
import { ACCOUNT_OWNER, QA_EMAILS, authenticateQaActor, qaSql, seedAttempt } from "../support/f2.js";

const B1 = "11111111-1111-4111-8111-111111111111";
const OP_FROM = "f7000000-0000-4000-8000-000000000001";
const OP_TO = "f7000000-0000-4000-8000-000000000002";

describe("F7 · Q09-02/04/15/46 por evidencia directa", () => {
  let sql: Awaited<ReturnType<typeof qaSql>>;
  let owner: Awaited<ReturnType<typeof authenticateQaActor>>;

  beforeAll(async () => {
    sql = await qaSql();
    owner = await authenticateQaActor(QA_EMAILS.owner);
    await seedAttempt(sql, OP_FROM, B1, ACCOUNT_OWNER, "f7.boundary.from", "2035-02-01T03:00:00.000Z");
    await seedAttempt(sql, OP_TO, B1, ACCOUNT_OWNER, "f7.boundary.to", "2035-02-02T03:00:00.000Z");
    await sql`
      insert into money.money_operations
        (business_id, operation_id, kind, status, amount_minor, confirmed_minor, currency, actor_account_id, created_at, resolved_at)
      values
        (${B1}, ${OP_FROM}, 'PAYMENT', 'SUCCEEDED', 100, 100, 'ARS', ${ACCOUNT_OWNER}, '2035-02-01T03:00:00.000Z', '2035-02-01T03:00:00.000Z'),
        (${B1}, ${OP_TO}, 'PAYMENT', 'SUCCEEDED', 100, 100, 'ARS', ${ACCOUNT_OWNER}, '2035-02-02T03:00:00.000Z', '2035-02-02T03:00:00.000Z')
      on conflict (operation_id) do nothing`;
  });
  afterAll(async () => {
    await sql`delete from money.money_operations where operation_id in (${OP_FROM}::uuid,${OP_TO}::uuid)`;
    await sql`delete from system.operation_attempts where operation_id in (${OP_FROM}::uuid,${OP_TO}::uuid)`;
    await sql.end();
  });

  it("Q09-02: jornada sin actividad produce ZERO real, no dato simulado", async () => {
    const body = await ownerSummary(owner, { date: "2035-01-01" });
    expect(body.collectedToday.state).toBe("ZERO");
    expect(body.collectedToday.data?.count).toBe(0);
    expect(body.shiftsToday.state).toBe("SUCCESS");
  });

  it("Q09-04: límite [desde,hasta) cuenta el hecho en from y excluye el de to", async () => {
    const first = await ownerSummary(owner, { date: "2035-02-01" });
    const second = await ownerSummary(owner, { date: "2035-02-02" });
    expect(first.collectedToday.data?.count).toBe(1);
    expect(second.collectedToday.data?.count).toBe(1); // el hecho de to pertenece a la jornada siguiente
    const [oracle] = await sql`select
      count(*) filter (where operation_id=${OP_FROM}::uuid and resolved_at >= '2035-02-01T03:00:00Z' and resolved_at < '2035-02-02T03:00:00Z') "inFirst",
      count(*) filter (where operation_id=${OP_TO}::uuid and resolved_at >= '2035-02-01T03:00:00Z' and resolved_at < '2035-02-02T03:00:00Z') "inSecond"
      from money.money_operations where operation_id in (${OP_FROM}::uuid,${OP_TO}::uuid)`;
    expect(Number(oracle!.inFirst)).toBe(1);
    expect(Number(oracle!.inSecond)).toBe(0);
  });

  it("Q09-15: sin sesión de caja en la ventana, cash es NOT_CONFIGURED", async () => {
    const body = await commercial(owner, { from: "2035-01-01", to: "2035-01-02" });
    expect(body.cash.state).toBe("NOT_CONFIGURED");
    expect(body.cash.completeness).toBe("NOT_CONFIGURED");
  });

  it("Q09-46: DST real con Business IANA produce jornadas de 23 y 25 horas", () => {
    const context = { timezone: "America/New_York", today: "2026-03-08", asOf: "2026-03-08T12:00:00.000Z" };
    const spring = resolveInterval(context, "2026-03-08", "2026-03-09");
    const fall = resolveInterval({ ...context, today: "2026-11-01", asOf: "2026-11-01T12:00:00.000Z" }, "2026-11-01", "2026-11-02");
    expect((spring.toInstant.getTime() - spring.fromInstant.getTime()) / 3_600_000).toBe(23);
    expect((fall.toInstant.getTime() - fall.fromInstant.getTime()) / 3_600_000).toBe(25);
  });
});
