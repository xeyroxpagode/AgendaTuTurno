/**
 * F2/F3 · Defecto de concurrencia real: GETs paralelos de Reporting con
 * GoTrue real. Antes del correctivo, `revalidateAuthority` dentro de una Tx
 * REPEATABLE READ devuelve 500/40001 cuando otra petición actualiza
 * `iam.access_sessions.last_seen_at` durante la autenticación.
 */
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../apps/api/src/app.js";
import { runtime } from "../../../apps/api/src/lib/runtime.js";

const QA_EMAIL = "owner-qa@youngkingz.local";
const QA_PASSWORD = "QaTestPass2026!x";
const B1 = "11111111-1111-4111-8111-111111111111";
const URLS = [
  "/v1/reporting/owner-summary",
  "/v1/reporting/commercial?from=2026-11-01&to=2026-12-01",
  "/v1/reporting/operational?from=2026-11-01&to=2026-12-01",
  "/v1/reporting/interventions",
  "/v1/reporting/history?from=2026-11-01&to=2026-12-01&limit=2"
];

describe("H09 · concurrencia real de lecturas Reporting", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let token: string;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!);
    const [{ current_database: name }] = await sql`select current_database()` as unknown as Array<{ current_database: string }>;
    if (!String(name).startsWith("youngkingz_h08_qa_h09rec_20261125")) throw new Error(`BLOQUEADO: base ${name}`);
    const supabase = createClient(runtime.supabaseUrl, process.env.SUPABASE_ANON_KEY!);
    const { data, error } = await supabase.auth.signInWithPassword({ email: QA_EMAIL, password: QA_PASSWORD });
    if (error || !data.session?.access_token) throw new Error(`GoTrue real falló: ${error?.message ?? "sin token"}`);
    token = data.session.access_token;
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => { await app?.close(); await sql?.end(); });

  it("cinco GETs concurrentes responden 200 con estados canónicos y sin escrituras de Reporting", async () => {
    const beforeAudit = (await sql`select count(*)::int n from system.audit_events where business_id=${B1}`)[0]!.n;
    const beforeAttempts = (await sql`select count(*)::int n from system.operation_attempts where business_id=${B1}`)[0]!.n;
    const responses = await Promise.all(URLS.map((url) => app.inject({
      method: "GET", url, headers: { authorization: `Bearer ${token}` }
    })));
    for (const [index, response] of responses.entries()) {
      expect(response.statusCode, `${URLS[index]} → ${response.statusCode} ${response.body.slice(0, 160)}`).toBe(200);
      const body = response.json();
      expect(body).toBeTypeOf("object");
      if (index === 0) expect(body.collectedToday.state).toMatch(/SUCCESS|ZERO/);
      if (index === 1) expect(body.money.state).toMatch(/SUCCESS|ZERO/);
      if (index === 4) expect(Array.isArray(body.items)).toBe(true);
    }
    const afterAudit = (await sql`select count(*)::int n from system.audit_events where business_id=${B1}`)[0]!.n;
    const afterAttempts = (await sql`select count(*)::int n from system.operation_attempts where business_id=${B1}`)[0]!.n;
    expect(afterAudit).toBe(beforeAudit);
    expect(afterAttempts).toBe(beforeAttempts);
  });

  it("el reintento no debilita la revocación: rol revocado sigue dando 403", async () => {
    const assignment = await sql<{ id: string }[]>`
      select id from iam.role_assignments where business_id=${B1} and role='OWNER' and revoked_at is null limit 1`;
    const roleAssignmentId = assignment[0]!.id;
    await sql`update iam.role_assignments set revoked_at=now() where id=${roleAssignmentId}`;
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const supabase = createClient(runtime.supabaseUrl, process.env.SUPABASE_ANON_KEY!);
      const login = await supabase.auth.signInWithPassword({ email: QA_EMAIL, password: QA_PASSWORD });
      const revokedToken = login.data.session?.access_token;
      if (!revokedToken) throw new Error("GoTrue real no devolvió token tras la revocación");
      const response = await app.inject({
        method: "GET", url: "/v1/reporting/operational?from=2026-11-01&to=2026-12-01",
        headers: { authorization: `Bearer ${revokedToken}` }
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await sql`update iam.role_assignments set revoked_at=null where id=${roleAssignmentId}`;
    }
  });
});
