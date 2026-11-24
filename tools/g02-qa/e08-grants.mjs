/**
 * E-08 — Grant financiero legítimo para Reception (IAM real, sin bypass).
 * Oráculo: API real + BD QA aislada. Evidencia sin secretos.
 */
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import fs from "node:fs";
process.loadEnvFile?.(".env");
const OUT = "C:/Users/thega/Desktop/YKZ-H07-H08-FINAL-CLOSURE/02_CORRECTIVES/e08_results.json";
const sql = postgres("postgresql://postgres:postgres@127.0.0.1:56022/youngkingz_h07_qa_20261124", { max: 1 });
const tokenFor = async (email) => {
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data, error } = await s.auth.signInWithPassword({ email, password: "QaTestPass2026!x" });
  if (error) throw new Error(error.message);
  return data.session.access_token;
};
const call = async (token, method, path, body) => {
  const r = await fetch(`http://127.0.0.1:4100${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), "x-operation-id": crypto.randomUUID(), ...(body ? {} : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
};
const result = { startedAt: new Date().toISOString(), steps: [] };
const RECEPTION_STAFF = "bbbbbbb2-2222-4222-8222-222222222222";
const SETTLEMENT_ID = "e3446b09-8a3f-4b77-8989-728393239973";
const MONEY_OP_ID = "edae3da5-70b4-4a90-9162-ae4679ee1e3f";
const PAY_BODY = { settlementId: SETTLEMENT_ID, moneyOperationId: MONEY_OP_ID, amountMinor: 1000, kind: "PAYABLE" };
try {
  const owner = await tokenFor("owner-qa@youngkingz.local");
  const reception = await tokenFor("reception-qa@youngkingz.local");
  const roles = await call(owner, "GET", `/v1/staff/${RECEPTION_STAFF}/roles`);
  const assignment = Array.isArray(roles.body) ? roles.body.find((r) => r.role === "RECEPTIONIST") : null;
  result.steps.push({ step: "owner_reads_reception_roles", status: roles.status, roleAssignmentId: assignment?.id ?? null });

  const deniedBefore = await call(reception, "POST", "/v1/economy/settlements/payment", PAY_BODY);
  result.steps.push({ step: "reception_without_grant", status: deniedBefore.status, code: deniedBefore.body?.error?.code ?? deniedBefore.body?.code ?? null });

  const issued = await call(owner, "POST", `/v1/staff/${RECEPTION_STAFF}/grants`, { roleAssignmentId: assignment?.id, capability: "obligations.pay" });
  result.steps.push({ step: "owner_issues_obligations.pay", status: issued.status, body: issued.body });
  const grantId = issued.body?.id ?? issued.body?.data?.id ?? null;
  const grantsDb = await sql`select id,capability,scope,revoked_at from iam.capability_grants where business_id='11111111-1111-4111-8111-111111111111' and capability='obligations.pay'`;
  result.steps.push({ step: "db_grant_state", rows: grantsDb });

  const allowed = await call(reception, "POST", "/v1/economy/settlements/payment", PAY_BODY);
  result.steps.push({ step: "reception_with_grant", status: allowed.status, body: allowed.body });

  if (grantId) {
    const revoked = await call(owner, "POST", `/v1/grants/${grantId}/revoke`);
    result.steps.push({ step: "owner_revokes_grant", status: revoked.status, body: revoked.body });
  }
  const deniedAfter = await call(reception, "POST", "/v1/economy/settlements/payment", PAY_BODY);
  result.steps.push({ step: "reception_after_revocation", status: deniedAfter.status, code: deniedAfter.body?.error?.code ?? deniedAfter.body?.code ?? null });
} catch (e) {
  result.fatal = e.message;
} finally {
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
  await sql.end();
  console.log(JSON.stringify(result, null, 2));
}
