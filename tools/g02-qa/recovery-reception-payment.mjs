import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

process.loadEnvFile(".env");
const out = process.env.G02_OUT;
const base = process.env.E2E_WEB_BASE ?? "http://localhost:3101";
const api = process.env.E2E_API_BASE ?? "http://127.0.0.1:4100";
const db = new URL(process.env.G02_QA_DATABASE_URL);
assert.match(db.hostname, /^(127\.0\.0\.1|localhost)$/);
assert.match(db.pathname, /^\/youngkingz_h07_qa_/);
const sql = postgres(db.href, { max: 1 });
const browser = await chromium.launch();
const owner = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "es-AR" });
const reception = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "es-AR" });
const steps = [];
owner.on("dialog", async (dialog) => { if (dialog.message().includes("Revocar el permiso para registrar pagos")) await dialog.accept(); else await dialog.dismiss(); });
let stage = "login";
const login = async (page, username) => {
  await page.goto(base + "/login");
  await page.getByLabel("Correo").pressSequentially(username + "-qa@youngkingz.local");
  await page.getByLabel("Contraseña").pressSequentially(process.env.G02_QA_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL(/\/team|\/account/);
  await page.getByRole("link", { name: "Agenda", exact: true }).waitFor({ timeout: 15000 });
};
const status = (page, text) => expect(page.getByRole("status").filter({ hasText: text })).toBeVisible({ timeout: 15000 });
let toggle;
try {
  await Promise.all([login(owner, "owner"), login(reception, "reception")]);
  stage = "owner configures agreement closes period";
  await owner.getByRole("link", { name: "Economía del personal", exact: true }).click();
  await owner.locator("li.record-row").filter({ hasText: "Barbero QA" }).getByRole("link", { name: "Ver economía" }).click();
  await expect(owner.getByRole("heading", { name: /Economía.*Barbero QA/ })).toBeVisible();
  const candidates = await sql`
    select to_char(candidate, 'YYYY-MM') as "month", to_char(candidate, 'YYYY-MM-DD') as "first",
           to_char(candidate+interval '1 month'-interval '1 day', 'YYYY-MM-DD') as "last"
      from generate_series('2070-01-01'::date,'2080-01-01'::date,interval '1 month') candidate
     where not exists (select 1 from econ.agreement_versions v join econ.agreements a on a.business_id=v.business_id and a.id=v.agreement_id
        where a.staff_member_id='bbbbbbb3-3333-4333-8333-333333333333' and v.valid_from<candidate+interval '1 month' and v.valid_to>candidate)
     order by candidate limit 1`;
  assert.equal(candidates.length, 1);
  const { month, first, last } = candidates[0];
  await owner.getByLabel("Modalidad").selectOption("FIXED");
  await owner.getByLabel("Importe fijo por período ($)").fill("100");
  await owner.getByLabel("Unidad del período").selectOption("MONTHS");
  await owner.getByLabel("Cantidad por período").fill("1");
  await owner.getByLabel("Fecha de inicio del ciclo").fill(first);
  await owner.getByLabel("Vigente desde").fill(first);
  await owner.getByLabel("Vigente hasta").fill(last);
  await owner.getByRole("button", { name: "Guardar versión" }).click();
  await status(owner, "Versión del acuerdo guardada");
  await owner.getByLabel("Período", { exact: true }).fill(month);
  await owner.getByRole("button", { name: "Calcular estimación" }).click();
  await status(owner, "Estimación actualizada");
  await expect(owner.getByText("Estimación abierta")).toBeVisible();
  await owner.getByLabel("Confirmación para cerrar").pressSequentially("CLOSE_SETTLEMENT");
  await owner.getByRole("button", { name: "Cerrar período" }).click();
  await status(owner, "Período cerrado");
  const [settlement] = await sql`select id,payable_obligation_id,total_payable_minor::text from econ.settlements where staff_member_id='bbbbbbb3-3333-4333-8333-333333333333' and period_start=${first}`;
  assert.equal(settlement?.total_payable_minor, "10000");
  steps.push({ actor: "Owner", stage, settlement, month });
  await owner.screenshot({ path: path.join(out, "08_SCREENSHOTS", "owner-fixed-settlement.png"), fullPage: false });

  stage = "prepare confirmed funding fixture";
  const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await auth.auth.signInWithPassword({ email: "owner-qa@youngkingz.local", password: process.env.G02_QA_PASSWORD });
  assert.ok(data.session, error?.message);
  const funding = async (amountMinor) => {
    const ref = crypto.randomUUID();
    const response = await fetch(api + "/v1/money/operations", {
      method: "POST",
      headers: { authorization: "Bearer " + data.session.access_token, "content-type": "application/json", "x-operation-id": ref },
      body: JSON.stringify({ components: [{ method: "TRANSFER", amountMinor, accredited: true, reference: ref, evidenceReference: "Acreditación QA G02-R" }] })
    });
    assert.ok(response.ok, "Funding fixture HTTP " + response.status);
    return (await response.json()).data.id;
  };
  const partial = await funding(3700);
  const remainder = await funding(6300);

  stage = "verify starting grant state";
  await owner.getByRole("link", { name: "Equipo", exact: true }).click();
  await owner.getByRole("button").filter({ hasText: "Recepción QA" }).first().click();
  toggle = owner.getByRole("checkbox", { name: "Registrar pagos de liquidaciones" });
  await expect(toggle).toBeEnabled();
  if (await toggle.isChecked()) { await toggle.click(); await expect(toggle).not.toBeChecked(); }
  stage = "reception lacks grant";
  await reception.goto(base + "/finanzas");
  await expect(reception.getByTestId("finance-role")).toHaveText("RECEPTIONIST");
  await expect(reception.getByRole("button", { name: "Aplicar pago" })).toHaveCount(0);
  steps.push({ actor: "Reception", stage, buttonAvailable: false });

  stage = "owner issues grant from team toggle";
  await toggle.click();
  await status(owner, "Permiso para registrar pagos de liquidaciones concedido");
  const [grant] = await sql`select id from iam.capability_grants where staff_member_id='bbbbbbb2-2222-4222-8222-222222222222' and capability='obligations.pay' and revoked_at is null`;
  assert.ok(grant?.id);
  steps.push({ actor: "Owner", stage, grantId: grant.id });
  stage = "Reception pays in Finance";
  await reception.reload();
  const card = reception.getByTestId("obligation-card").filter({ hasText: "Liquidación " + first });
  await expect(card).toBeVisible({ timeout: 15000 });
  const fundingField = card.getByLabel("Dinero confirmado");
  await fundingField.selectOption(partial);
  await card.getByRole("button", { name: "Aplicar pago" }).click();
  await status(reception, "Pago aplicado sobre dinero ya confirmado");
  await expect(card).toContainText("PARTIAL");
  const [balance] = await sql`select o.amount_minor::text amount, sum(p.amount_minor)::text paid, o.status from obligations.expense_obligations o join obligations.obligation_payments p on o.id=p.obligation_id where o.id=${settlement.payable_obligation_id} group by o.id`;
  assert.deepEqual(balance, { amount: "10000", paid: "3700", status: "PARTIAL" });
  await reception.reload();
  await expect(card).toContainText("PARTIAL");
  await reception.screenshot({ path: path.join(out, "08_SCREENSHOTS", "reception-payment-persisted.png"), fullPage: false });
  steps.push({ actor: "Reception", stage, balance, persisted: true });

  stage = "revoked grant rejects next action";
  await fundingField.selectOption(remainder);
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  const [revoked] = await sql`select revoked_at is not null revoked from iam.capability_grants where id=${grant.id}`;
  assert.ok(revoked?.revoked);
  const denied = reception.waitForResponse((response) => response.url().endsWith("/pay") && response.request().method() === "POST");
  await card.getByRole("button", { name: "Aplicar pago" }).click();
  assert.equal((await denied).status(), 403);
  await status(reception, "FORBIDDEN");
  await reception.reload();
  await expect(reception.getByTestId("finance-role")).toHaveText("RECEPTIONIST");
  await expect(reception.getByRole("button", { name: "Aplicar pago" })).toHaveCount(0);
  steps.push({ actor: "Reception", stage, response: 403, buttonAvailableAfterReload: false });
} catch (error) {
  steps.push({ stage, error: error.message });
  await owner.screenshot({ path: path.join(out, "08_SCREENSHOTS", "reception-owner-failure.png"), fullPage: false });
  await reception.screenshot({ path: path.join(out, "08_SCREENSHOTS", "reception-failure.png"), fullPage: false });
  process.exitCode = 1;
} finally {
  if (toggle && await toggle.isVisible() && await toggle.isChecked()) {
    await toggle.click().catch(() => undefined);
    await expect(toggle).not.toBeChecked().catch(() => undefined);
  }
  fs.writeFileSync(path.join(out, "04_EXPLORATORY", "reception-grant-payment.json"), JSON.stringify(steps, null, 2));
  await sql.end();
  await browser.close();
}
