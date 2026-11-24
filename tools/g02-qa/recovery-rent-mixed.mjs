import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

process.loadEnvFile(".env");
const out = process.env.G02_OUT;
const web = new URL(process.env.E2E_WEB_BASE);
const api = new URL(process.env.E2E_API_BASE);
const db = new URL(process.env.G02_QA_DATABASE_URL);
for (const service of [web, api, db]) assert.match(service.hostname, /^(127\.0\.0\.1|localhost)$/);
assert.match(db.pathname, /^\/youngkingz_h08_qa_journey_/);
const sql = postgres(db.href, { max: 1 });
const browser = await chromium.launch();
const owner = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "es-AR" });
const staff = "bbbbbbb3-3333-4333-8333-333333333333";
const email = "owner-qa@youngkingz.local";
const steps = [];
let phase = "Login de Owner";
const notice = (message) => expect(owner.getByRole("status").filter({ hasText: message })).toBeVisible({ timeout: 15000 });
const act = (name) => owner.getByRole("button", { name, exact: true });

try {
  await owner.goto(new URL("/login", web).href);
  await owner.getByLabel("Correo").pressSequentially(email);
  await owner.getByLabel("Contraseña").pressSequentially(process.env.G02_QA_PASSWORD);
  await act("Ingresar").click();
  await owner.waitForURL(/\/team|\/account/);
  await owner.getByRole("link", { name: "Economía del personal", exact: true }).click();
  await owner.locator("li.record-row").filter({ hasText: "Barbero QA" }).getByRole("link", { name: "Ver economía" }).click();
  await expect(owner.getByRole("heading", { name: /Economía.*Barbero QA/ })).toBeVisible();
  const economy = owner.url();
  const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await auth.auth.signInWithPassword({ email, password: process.env.G02_QA_PASSWORD });
  assert.ok(data.session, error?.message);
  const recordConfirmedTransfer = async (amountMinor) => {
    const operationId = randomUUID();
    const res = await fetch(new URL("/v1/money/operations", api), {
      method: "POST",
      headers: { authorization: "Bearer " + data.session.access_token, "content-type": "application/json", "x-operation-id": operationId },
      body: JSON.stringify({ components: [{ method: "TRANSFER", amountMinor, accredited: true, reference: operationId, evidenceReference: "Transferencia sintética QA G02-R" }] })
    });
    assert.ok(res.ok, "Transferencia fixture HTTP " + res.status);
    return (await res.json()).data.id;
  };
  const settle = async (modality, fixed, rent) => {
    phase = "Configurar, estimar y cerrar " + modality;
    const [period] = await sql`
      select to_char(candidate,'YYYY-MM') as "month", to_char(candidate,'YYYY-MM-DD') as "first",
             to_char(candidate+interval '1 month'-interval '1 day','YYYY-MM-DD') as "last"
      from generate_series('2085-01-01'::date,'2099-01-01'::date,interval '1 month') candidate
      where not exists (
        select 1 from econ.agreement_versions v join econ.agreements a on a.business_id=v.business_id and a.id=v.agreement_id
        where a.staff_member_id=${staff} and v.valid_from<candidate+interval '1 month' and v.valid_to>candidate
      ) order by candidate limit 1`;
    assert.ok(period);
    await owner.getByLabel("Modalidad").selectOption(modality);
    if (fixed) await owner.getByLabel("Importe fijo por período ($)").fill(String(fixed));
    await owner.getByLabel("Alquiler de silla por período ($)").fill(String(rent));
    await owner.getByLabel("Unidad del período").selectOption("MONTHS");
    await owner.getByLabel("Cantidad por período").fill("1");
    await owner.getByLabel("Fecha de inicio del ciclo").fill(period.first);
    await owner.getByLabel("Vigente desde").fill(period.first);
    await owner.getByLabel("Vigente hasta").fill(period.last);
    await act("Guardar versión").click();
    await notice("Versión del acuerdo guardada");
    await owner.getByLabel("Período", { exact: true }).fill(period.month);
    await act("Calcular estimación").click();
    await notice("Estimación actualizada");
    await expect(owner.getByText("Estimación abierta")).toBeVisible();
    await owner.getByLabel("Confirmación para cerrar").pressSequentially("CLOSE_SETTLEMENT");
    await act("Cerrar período").click();
    await notice("Período cerrado");
    const [row] = await sql`
      select id,snapshot,payable_obligation_id,receivable_obligation_id,total_payable_minor::text payable,total_receivable_minor::text receivable
      from econ.settlements where staff_member_id=${staff} and period_start=${period.first}`;
    assert.equal(row?.payable, String(fixed * 100));
    assert.equal(row?.receivable, String(rent * 100));
    assert.ok(row.receivable_obligation_id);
    if (fixed) assert.ok(row.payable_obligation_id && row.payable_obligation_id !== row.receivable_obligation_id);
    else assert.equal(row.payable_obligation_id, null);
    const obligations = await sql`select kind,amount_minor::text amount from obligations.expense_obligations where settlement_id=${row.id} order by kind`;
    assert.deepEqual([...obligations], fixed
      ? [{ kind: "PAYABLE", amount: row.payable }, { kind: "RECEIVABLE", amount: row.receivable }]
      : [{ kind: "RECEIVABLE", amount: row.receivable }]);
    steps.push({ phase, period, settlementId: row.id, obligations: [...obligations] });
    return { row, period };
  };

  const rent = await settle("CHAIR_RENT", 0, 100);
  phase = "Cobranza parcial y total por Finanzas";
  const parts = await Promise.all([recordConfirmedTransfer(3700), recordConfirmedTransfer(6300)]);
  await owner.goto(new URL("/finanzas", web).href);
  await expect(owner.getByTestId("finance-role")).toHaveText("OWNER");
  const tab = owner.getByRole("navigation", { name: "Secciones financieras" }).getByRole("button", { name: "Obligaciones" });
  if (await tab.getAttribute("aria-current") !== "page") await tab.click();
  const card = owner.getByTestId("obligation-card").filter({ hasText: "Alquiler de silla " + rent.period.first });
  await expect(card).toContainText("Por cobrar");
  for (const [index, sourceId] of parts.entries()) {
    const state = index === 0 ? "PARTIAL" : "SETTLED";
    await card.getByLabel("Dinero confirmado").selectOption(sourceId);
    await card.getByRole("button", { name: "Aplicar cobro" }).click();
    await notice("Cobro aplicado sobre dinero ya confirmado");
    await expect(card).toContainText(state);
    const [balance] = await sql`
      select o.amount_minor::text amount, sum(p.amount_minor)::text collected, (o.amount_minor-sum(p.amount_minor))::text balance, o.status
      from obligations.expense_obligations o join obligations.obligation_payments p on o.id=p.obligation_id
      where o.id=${rent.row.receivable_obligation_id} group by o.id`;
    assert.deepEqual(balance, index === 0
      ? { amount: "10000", collected: "3700", balance: "6300", status: state }
      : { amount: "10000", collected: "10000", balance: "0", status: state });
    steps.push({ phase, balance });
  }
  await owner.reload();
  if (await tab.getAttribute("aria-current") !== "page") await tab.click();
  await expect(card).toContainText("SETTLED");
  await owner.screenshot({ path: path.join(out, "08_SCREENSHOTS", "rent-collected.png") });

  await owner.goto(economy);
  const mixed = await settle("MIXED", 200, 75);
  phase = "Ajustes mixtos sobre ambos lados sin neteo";
  for (const [kind, amount] of [["PAYABLE", "10"], ["RECEIVABLE", "-5"]]) {
    await owner.getByLabel("Liquidación").selectOption(mixed.row.id);
    await owner.getByLabel("Lado").selectOption(kind);
    await owner.getByLabel("Importe ($; negativo para reducir)").fill(amount);
    await owner.getByLabel("Motivo").fill("Ajuste QA G02-R " + kind);
    await act("Registrar ajuste").click();
    await notice("Ajuste registrado");
  }
  const [history] = await sql`select status,snapshot from econ.settlements where id=${mixed.row.id}`;
  assert.deepEqual(history.snapshot, mixed.row.snapshot);
  assert.equal(history.status, "ADJUSTED");
  const adjusted = await sql`select kind,amount_minor::text amount from obligations.expense_obligations where settlement_id=${mixed.row.id} order by kind`;
  assert.deepEqual([...adjusted], [{ kind: "PAYABLE", amount: "21000" }, { kind: "RECEIVABLE", amount: "7000" }]);
  await owner.reload();
  await expect(owner.getByText("Ajuste QA G02-R RECEIVABLE", { exact: false }).first()).toBeVisible();
  await owner.screenshot({ path: path.join(out, "08_SCREENSHOTS", "mixed-separate-adjustments.png") });
  steps.push({ phase, obligations: [...adjusted], originalSnapshotUnchanged: true, persisted: true });
} catch (error) {
  steps.push({ phase, error: error.message });
  await owner.screenshot({ path: path.join(out, "08_SCREENSHOTS", "rent-mixed-failure.png") });
  process.exitCode = 1;
} finally {
  await writeFile(path.join(out, "04_EXPLORATORY", "rent-mixed-journey.json"), JSON.stringify(steps, null, 2));
  await sql.end();
  await browser.close();
}
