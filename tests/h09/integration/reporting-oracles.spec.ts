import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { authorizationService } from "../../../apps/api/src/modules/iam/authorization.js";
import { commercial, history, interventions, operational, ownerSummary } from "../../../apps/api/src/modules/reporting/blocks.js";
import { decodeHistoryCursor } from "../../../apps/api/src/modules/reporting/dto.js";

const QA_PASSWORD = "QaTestPass2026!x";
const QA_EMAILS = {
  owner: "owner-qa@youngkingz.local",
  reception: "reception-qa@youngkingz.local",
  barber: "barber-qa@youngkingz.local"
};

async function assertQaDatabase(sql: postgres.Sql): Promise<void> {
  const [{ current_database: name }] = await sql`select current_database()` as unknown as Array<{ current_database: string }>;
  if (!/^youngkingz_h0[78]_/.test(String(name))) throw new Error(`BLOQUEADO: base ${name} no es QA aislada`);
}

/** Autenticación REAL contra GoTrue local, sin fabricar Actors. */
async function authenticateQaActor(email: string) {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: QA_PASSWORD });
  if (error || !data.session?.access_token) throw new Error(`No se pudo autenticar a ${email}`);
  const request = { headers: { authorization: `Bearer ${data.session.access_token}` } } as unknown as FastifyRequest;
  return authorizationService.authenticate(request);
}

const B1 = "11111111-1111-4111-8111-111111111111";
const FROM = "2026-11-24";
const TO = "2026-11-25";
const fromInstant = new Date(`${FROM}T00:00:00.000Z`);
const toInstant = new Date(`${TO}T00:00:00.000Z`);

/** Oráculos independientes: SQL directo, sin helpers ni queries de Reporting. */
async function oracle(sql: postgres.Sql) {
  const m01 = (await sql`
    select coalesce(sum(confirmed_minor),0)::text total from money.money_operations
    where business_id=${B1} and kind='PAYMENT' and status='SUCCEEDED'
      and coalesce(resolved_at,created_at) >= ${fromInstant} and coalesce(resolved_at,created_at) < ${toInstant}`)[0]!;
  const m02 = (await sql`
    select count(distinct operation_id)::int count from money.money_operations
    where business_id=${B1} and kind='PAYMENT' and status='SUCCEEDED'
      and coalesce(resolved_at,created_at) >= ${fromInstant} and coalesce(resolved_at,created_at) < ${toInstant}`)[0]!;
  const m04 = await sql`
    select c.method method, coalesce(sum(c.amount_minor),0)::text minor, count(*)::int count
    from money.money_components c join money.money_operations m on m.business_id=c.business_id and m.id=c.money_operation_id
    where c.business_id=${B1} and c.outcome='CONFIRMED' and m.kind='PAYMENT' and m.status='SUCCEEDED'
      and coalesce(m.resolved_at,m.created_at) >= ${fromInstant} and coalesce(m.resolved_at,m.created_at) < ${toInstant}
    group by c.method order by c.method`;
  const m07 = (await sql`
    select count(*) filter (where r.status='CONFIRMED' and a.id is null)::int confirmed,
           count(*) filter (where r.status='CONFIRMED' and a.id is not null)::int attended,
           count(*) filter (where r.status='CANCELLED')::int cancelled,
           count(*) filter (where r.status='NO_SHOW')::int "noShow"
    from booking.reservations r
    left join attendance.attendances a on a.business_id=r.business_id and a.reservation_id=r.id
      and a.status in ('COMPLETED','PARTIAL','INTERRUPTED')
    where r.business_id=${B1} and r.business_local_date>=${FROM}::date and r.business_local_date<${TO}::date`)[0]!;
  const m08 = (await sql`
    select count(*)::int count from attendance.attendances
    where business_id=${B1} and status in ('COMPLETED','PARTIAL','INTERRUPTED')
      and started_at>=${fromInstant} and started_at<${toInstant}`)[0]!;
  const m11 = await sql`
    select o.kind::text kind, count(*) filter (where o.due_date < (now() at time zone 'America/Argentina/Buenos_Aires')::date)::int overdue
    from obligations.expense_obligations o
    where o.business_id=${B1} and o.status in ('OPEN','PARTIAL') group by o.kind order by o.kind`;
  return { m01, m02, m04, m07, m08, m11 };
}

describe("H09 · Reporting sobre PostgreSQL QA real", () => {
  let sql: postgres.Sql;
  let owner: Awaited<ReturnType<typeof authenticateQaActor>>;
  let reception: Awaited<ReturnType<typeof authenticateQaActor>>;
  let barber: Awaited<ReturnType<typeof authenticateQaActor>>;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!);
    await assertQaDatabase(sql);
    owner = await authenticateQaActor(QA_EMAILS.owner);
    reception = await authenticateQaActor(QA_EMAILS.reception);
    barber = await authenticateQaActor(QA_EMAILS.barber);
  });
  afterAll(async () => { await sql?.end(); });

  it("M01/M02/M04: una sola lectura, total reconciliable con medios; importes string", async () => {
    const expected = await oracle(sql);
    const response = await commercial(owner, { from: FROM, to: TO });
    expect(response.money.state).toBe("SUCCESS");
    expect(response.money.data!.totalMinor).toBe(String(expected.m01.total));
    expect(response.money.data!.count).toBe(Number(expected.m02.count));
    expect(typeof response.money.data!.totalMinor).toBe("string");
    const byMethod = response.money.data!.byMethod;
    const sum = byMethod.reduce((acc, item) => acc + BigInt(item.amountMinor), 0n);
    expect(sum.toString()).toBe(String(expected.m01.total));
    for (const row of expected.m04) {
      const found = byMethod.find((item) => item.method === row.method);
      expect(found?.amountMinor).toBe(String(row.minor));
    }
    expect(response.money.data!.refundsMinor).toBeTypeOf("string");
    expect(response.money.interval!.from).toBe(new Date(`${FROM}T03:00:00.000Z`).toISOString());
    expect(response.money.interval!.to).toBe(new Date(`${TO}T03:00:00.000Z`).toISOString());
  });

  it("M11: vencimiento con due_date local y direcciones sin neteo", async () => {
    const expected = await oracle(sql);
    const response = await commercial(owner, { from: FROM, to: TO });
    const kinds = response.obligations.data!.byKind;
    for (const row of expected.m11) {
      const found = kinds.find((item) => item.kind === row.kind);
      expect(found?.overdueCount).toBe(Number(row.overdue));
    }
    expect(kinds.every((item) => typeof item.pendingCount === "number")).toBe(true);
  });

  it("M12/M16: contención de períodos; OPEN_ESTIMATE nunca es deuda", async () => {
    const contained = await commercial(owner, { from: "2026-11-01", to: "2026-12-02" });
    const notContained = await commercial(owner, { from: "2026-11-02", to: "2026-12-01" });
    expect(contained.settlements.data!.realDebt.length).toBeGreaterThanOrEqual(notContained.settlements.data!.realDebt.length);
    expect(notContained.settlements.data!.realDebt).toEqual([]);
    expect(contained.settlements.data!.estimateStates.every((state) => ["NOT_CONFIGURED", "OPEN_ESTIMATE"].includes(state))).toBe(true);
  });

  it("M13: listado filtrado sin responseBody", async () => {
    const response = await commercial(owner, { from: FROM, to: TO });
    expect(response.uncertain.state).toBe("UNKNOWN");
    for (const item of response.uncertain.data!.items) {
      expect(Object.keys(item).sort()).toEqual(["command", "createdAt", "operationId", "status"]);
      expect(["PREPARED", "UNKNOWN"]).toContain(item.status);
    }
  });

  it("M07/M08/M10/M14/M15: proyección operativa contra oráculos", async () => {
    const expected = await oracle(sql);
    const response = await operational(owner, { from: FROM, to: TO });
    const shifts = response.shifts.data!;
    expect(shifts.confirmed).toBe(Number(expected.m07.confirmed));
    expect(shifts.attended).toBe(Number(expected.m07.attended));
    expect(shifts.cancelled).toBe(Number(expected.m07.cancelled));
    expect(shifts.noShow).toBe(Number(expected.m07.noShow));
    expect(response.attendance.data!.count).toBe(Number(expected.m08.count));
    expect(response.orders.state).toBe("ZERO");
    expect(response.conflicts.state).toBe("ZERO");
    expect(response.courses.state).toBe("ZERO");
    expect(response.courseOccupancy.data!.nextCursor).toBeNull();
  });

  it("BARBER: self forzado, sin economía global ni pedidos/cursos; otro profesional 403", async () => {
    const response = await operational(barber, { from: FROM, to: TO });
    expect(response.orders.state).toBe("DENIED");
    expect(response.courses.state).toBe("DENIED");
    expect(response.economy.state).not.toBe("DENIED");
    await expect(operational(barber, { from: FROM, to: TO, staffMemberId: "bbbbbbb1-1111-4111-8111-111111111111" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("gate de rol: RECEPTIONIST sin agregados; BARBER denegado en comercial/intervenciones", async () => {
    const receptionResponse = await commercial(reception, { from: FROM, to: TO });
    expect(receptionResponse.money.state).toBe("DENIED");
    expect(receptionResponse.settlements.state).toBe("DENIED");
    await expect(commercial(barber, { from: FROM, to: TO })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ownerSummary(reception, { date: FROM })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(interventions(barber, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("resumen del Dueño: tres bloques, jornada local y destinos condicionados", async () => {
    const expected = await oracle(sql);
    const response = await ownerSummary(owner, { date: FROM });
    expect(response.businessTimezone).toBe("America/Argentina/Buenos_Aires");
    expect(response.localDate).toBe(FROM);
    expect(response.collectedToday.data!.totalMinor).toBe(String(expected.m01.total));
    expect(response.shiftsToday.data!.attended).toBe(Number(expected.m07.attended));
    expect(response.shiftsToday.data!.courseSessions).toBe(0);
    for (const item of response.requiresAttention.data!) {
      expect(item.id).toContain(B1);
      if (item.capabilityRequired && !owner.capabilities.has(item.capabilityRequired as never)) expect(item.destination).toBeNull();
    }
  });

  it("historial: cursor mixto null-safe, sin duplicados ni changes", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let previous: { occurredAt: string; objectId: string; sequence: number | null; eventId: string } | null = null;
    for (let page = 0; page < 8; page += 1) {
      const response = await history(owner, { from: FROM, to: TO, limit: 2, cursor });
      for (const item of response.items) {
        expect(item).not.toHaveProperty("changes");
        seen.push(item.eventId);
      }
      if (!response.items.length) break;
      const last = response.items.at(-1)!;
      if (previous) expect(last.occurredAt <= previous.occurredAt).toBe(true);
      if (cursor) expect(decodeHistoryCursor(cursor).eventId).toBeTruthy();
      previous = last;
      cursor = response.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("lecturas repetidas no escriben auditoría ni intentos", async () => {
    const before = (await sql`select count(*)::int n from system.audit_events where business_id=${B1}`)[0]!.n;
    const attempts = (await sql`select count(*)::int n from system.operation_attempts where business_id=${B1}`)[0]!.n;
    await commercial(owner, { from: FROM, to: TO });
    await operational(owner, { from: FROM, to: TO });
    await interventions(owner, {});
    await history(owner, { from: FROM, to: TO, limit: 5 });
    const after = (await sql`select count(*)::int n from system.audit_events where business_id=${B1}`)[0]!.n;
    const attemptsAfter = (await sql`select count(*)::int n from system.operation_attempts where business_id=${B1}`)[0]!.n;
    expect(after).toBe(before);
    expect(attemptsAfter).toBe(attempts);
  });
});
