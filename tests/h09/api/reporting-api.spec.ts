import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../apps/api/src/app.js";
import { runtime } from "../../../apps/api/src/lib/runtime.js";

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

const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const FROM = "2026-11-24";
const TO = "2026-11-25";

async function tokenFor(email: string): Promise<string> {
  const supabase = createClient(runtime.supabaseUrl, process.env.SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: QA_PASSWORD });
  if (error || !data.session?.access_token) throw new Error(`No se pudo autenticar ${email}: ${error?.message ?? "sin token"}`);
  return data.session.access_token;
}

describe("H09 · API HTTP real (6 GET)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let ownerToken: string;
  let receptionToken: string;
  let barberToken: string;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!);
    await assertQaDatabase(sql);
    ownerToken = await tokenFor(QA_EMAILS.owner);
    receptionToken = await tokenFor(QA_EMAILS.reception);
    barberToken = await tokenFor(QA_EMAILS.barber);
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await sql?.end(); });

  it("OWNER: seis endpoints 200 con cache no-store y estados canónicos", async () => {
    const paths = [
      "/v1/reporting/owner-summary?date=2026-11-24",
      `/v1/reporting/commercial?from=${FROM}&to=${TO}`,
      `/v1/reporting/operational?from=${FROM}&to=${TO}`,
      "/v1/reporting/interventions",
      `/v1/reporting/history?from=${FROM}&to=${TO}&limit=2`,
      "/v1/reporting/indicators/M17"
    ];
    for (const url of paths) {
      const response = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${ownerToken}` } });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["cache-control"]).toContain("no-store");
      const body = response.json();
      expect(body).toBeTypeOf("object");
      expect(JSON.stringify(body)).not.toMatch(/responseBody|"changes"|service_role/);
    }
  });

  it("RECEPTIONIST: sin agregados financieros ni resumen; BARBER: denegado en comercial", async () => {
    const reception = await app.inject({ method: "GET", url: `/v1/reporting/commercial?from=${FROM}&to=${TO}`, headers: { authorization: `Bearer ${receptionToken}` } });
    expect(reception.statusCode).toBe(200);
    expect(reception.json().money.state).toBe("DENIED");
    expect(reception.json().settlements.state).toBe("DENIED");
    const summary = await app.inject({ method: "GET", url: "/v1/reporting/owner-summary", headers: { authorization: `Bearer ${receptionToken}` } });
    expect(summary.statusCode).toBe(403);
    const barber = await app.inject({ method: "GET", url: `/v1/reporting/commercial?from=${FROM}&to=${TO}`, headers: { authorization: `Bearer ${barberToken}` } });
    expect(barber.statusCode).toBe(403);
    const barberOp = await app.inject({ method: "GET", url: `/v1/reporting/operational?from=${FROM}&to=${TO}`, headers: { authorization: `Bearer ${barberToken}` } });
    expect(barberOp.statusCode).toBe(200);
    expect(barberOp.json().orders.state).toBe("DENIED");
  });

  it("M17 por fuente: BARBER no ve dinero/ventas/obligaciones; RECEPTIONIST no ve obligaciones/economía", async () => {
    const url = "/v1/reporting/history?from=2000-01-01&to=2035-01-01&limit=100";
    const owner = (await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${ownerToken}` } })).json();
    expect(owner.items.map((item: { type: string }) => item.type)).toEqual(expect.arrayContaining(["SALE_CONFIRMED", "MONEY_CONFIRMED", "OBLIGATION_CHANGE"]));
    const barber = (await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${barberToken}` } })).json();
    const barberTypes = new Set<string>(barber.items.map((item: { type: string }) => item.type));
    for (const type of ["SALE_CONFIRMED", "MONEY_CONFIRMED", "CASH_MOVEMENT", "OBLIGATION_CHANGE", "ORDER_TRANSITION", "STOCK_MOVEMENT", "ECONOMY_EVENT"]) {
      expect(barberTypes.has(type), `BARBER no debe ver ${type}`).toBe(false);
    }
    const reception = (await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${receptionToken}` } })).json();
    const receptionTypes = new Set<string>(reception.items.map((item: { type: string }) => item.type));
    for (const type of ["OBLIGATION_CHANGE", "ECONOMY_EVENT"]) {
      expect(receptionTypes.has(type), `RECEPTIONIST no debe ver ${type}`).toBe(false);
    }
  });

  it("negativas: sin token 401, cross-business 403, intervalo inválido 400", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/reporting/interventions" })).statusCode).toBe(401);
    const cross = await app.inject({ method: "GET", url: `/v1/reporting/commercial?from=${FROM}&to=${TO}`,
      headers: { authorization: `Bearer ${ownerToken}`, "x-business-id": B2 } });
    expect(cross.statusCode).toBe(403);
    const invalid = await app.inject({ method: "GET", url: `/v1/reporting/commercial?from=${TO}&to=${FROM}`,
      headers: { authorization: `Bearer ${ownerToken}` } });
    expect(invalid.statusCode).toBe(400);
    const badIndicator = await app.inject({ method: "GET", url: "/v1/reporting/indicators/M99", headers: { authorization: `Bearer ${ownerToken}` } });
    expect(badIndicator.statusCode).toBe(400);
  });

  it("indicadores: definición sin datos de negocio", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/reporting/indicators/M17", headers: { authorization: `Bearer ${ownerToken}` } });
    const body = response.json();
    expect(body.id).toBe("M17");
    expect(Object.keys(body).sort()).toEqual(["domain", "formula", "grain", "id", "interval", "name", "qualityStates", "scopes", "source", "timestampSemantic"].sort());
    expect(JSON.stringify(body)).not.toContain(B1);
  });

  it("lecturas HTTP no escriben audit_events de Reporting", async () => {
    const before = (await sql`select count(*)::int n from system.audit_events where business_id=${B1}`)[0]!.n;
    for (const url of ["/v1/reporting/owner-summary", `/v1/reporting/commercial?from=${FROM}&to=${TO}`,
      `/v1/reporting/operational?from=${FROM}&to=${TO}`, "/v1/reporting/interventions",
      `/v1/reporting/history?from=${FROM}&to=${TO}&limit=2`]) {
      await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${ownerToken}` } });
    }
    const after = (await sql`select count(*)::int n from system.audit_events where business_id=${B1}`)[0]!.n;
    expect(after).toBe(before);
  });
});
