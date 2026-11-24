import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

process.loadEnvFile(".env");
const base = process.env.E2E_WEB_BASE;
const api = process.env.E2E_API_BASE;
const out = process.env.G02_OUT;
const target = new URL(process.env.G02_QA_DATABASE_URL);
assert.match(target.hostname, /^(localhost|127\.0\.0\.1)$/);
assert.match(target.pathname, /^\/youngkingz_h08_qa_journey_/);
const sql = postgres(target.href, { max: 1 });
const book = "11111111-1111-4111-8111-111111111111";
const barberId = "bbbbbbb3-3333-4333-8333-333333333333";
const ownerId = "33333333-3333-4333-8333-333333333333";
const receptionId = "bbbbbbb2-2222-4222-8222-222222222222";
const serviceName = "Corte real G02-R";
const guestName = "Cliente Economía " + Date.now().toString(36);
const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short" }).format(new Date());
const month = date.slice(0, 7);
const first = month + "-01";
const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
const resultFile = path.join(out, "04_EXPLORATORY", "attendance-economy-journey.json");
const resume = process.env.G02_RESUME_AFTER_CLOSE === "1";
const steps = resume ? JSON.parse(fs.readFileSync(resultFile, "utf8")).filter((step) => !step.error) : [];
let economyPage;
let settlement;
let expected;
let phase = "catalog, hours and booking policy fixture";
const browser = await chromium.launch();
const context = () => browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "es-AR" });
const [visitor, owner, reception, barber] = await Promise.all([context(), context(), context(), context()]);
let active = owner;
const exact = (page, name) => page.getByRole("button", { name, exact: true });
const notice = (page, text) => expect(page.getByRole("status").filter({ hasText: text })).toBeVisible({ timeout: 15000 });
const screen = (page, name) => page.screenshot({ path: path.join(out, "08_SCREENSHOTS", "economy-" + name + ".png"), fullPage: false });
const login = async (page, type) => {
  await page.goto(base + "/login");
  await page.getByLabel("Correo").pressSequentially(type + "-qa@youngkingz.local");
  await page.getByLabel("Contraseña").pressSequentially(process.env.G02_QA_PASSWORD);
  await exact(page, "Ingresar").click();
  await page.waitForURL(/\/team|\/account/);
  await page.getByRole("link", { name: "Agenda", exact: true }).waitFor({ timeout: 15000 });
};
try {
  if (!resume) {
  await sql.begin(async (tx) => {
    if ((await tx`select id from catalog.services where business_id=${book} and name=${serviceName}`).length) return;
    const [category] = await tx`insert into catalog.service_categories(business_id,name) values (${book},'Servicios G02-R') returning id`;
    const [service] = await tx`insert into catalog.services(business_id,name,category_id,publication,lifecycle) values (${book},${serviceName},${category.id},'PUBLISHED','ACTIVE') returning id`;
    const [terms] = await tx`insert into catalog.service_terms_versions(business_id,service_id,version_number,price_minor,currency,duration_minutes,pre_buffer_minutes,post_buffer_minutes,effective_from)
      values (${book},${service.id},1,10000,'ARS',30,0,0,now()) returning id`;
    await tx`update catalog.services set current_terms_version_id=${terms.id} where id=${service.id}`;
    const [set] = await tx`insert into team.staff_service_sets(business_id,staff_member_id) values (${book},${barberId}) returning id`;
    await tx`insert into team.staff_service_assignments(business_id,staff_service_set_id,service_id) values (${book},${set.id},${service.id})`;
    const [schedule] = await tx`insert into team.staff_weekly_schedules(business_id,staff_member_id) values (${book},${barberId}) returning id`;
    await tx`insert into team.staff_schedule_intervals(business_id,weekly_schedule_id,weekday,start_minute,end_minute)
      select ${book},${schedule.id},day,540,1440 from generate_series(1,7) day`;
    const [hours] = await tx`insert into business.business_hours_configs(business_id) values (${book}) returning id`;
    await tx`insert into business.business_hours_intervals(business_id,config_id,weekday,start_minute,end_minute)
      select ${book},${hours.id},day,540,1440 from generate_series(1,7) day`;
    const [policy] = await tx`insert into business.booking_policy_versions(business_id,version_number,public_booking_enabled,horizon_calendar_dates,min_lead_minutes,start_step_minutes,cancel_cutoff_minutes,reschedule_cutoff_minutes,created_by)
      values (${book},1,true,30,0,30,120,120,${ownerId}) returning id`;
    await tx`insert into business.booking_policy_states(business_id,current_version_id) values (${book},${policy.id})`;
  });
  phase = "Owner creates explicit commission from UI";
  await login(owner, "owner");
  await owner.getByRole("link", { name: "Economía del personal", exact: true }).click();
  await owner.locator("li.record-row").filter({ hasText: "Barbero QA" }).getByRole("link", { name: "Ver economía" }).click();
  await owner.waitForURL(/\/team\/[^/]+\/economia$/);
  economyPage = owner.url();
  const [existing] = await sql`select v.id from econ.agreements a join econ.agreement_versions v on v.agreement_id=a.id
    where a.business_id=${book} and a.staff_member_id=${barberId} and v.valid_from=${first}`;
  if (!existing) {
    await owner.getByLabel("Modalidad").selectOption("COMMISSION");
    await owner.getByLabel("Base de cálculo").selectOption("REALIZED");
    await owner.getByLabel("Comisión (%)").fill("10");
    await owner.getByLabel("Vigente desde").fill(first);
    await owner.getByLabel("Vigente hasta").fill(monthEnd);
    await exact(owner, "Guardar versión").click();
    await notice(owner, "Versión del acuerdo guardada");
  }
  const [terms] = await sql`select v.id,v.commission_base,v.bps,v.created_by_account_id from econ.agreements a join econ.agreement_versions v on v.agreement_id=a.id
    where a.business_id=${book} and a.staff_member_id=${barberId} and v.valid_from=${first}`;
  assert.equal(terms.commission_base, "REALIZED");
  assert.equal(Number(terms.bps), 1000);
  assert.equal(terms.created_by_account_id, ownerId);
  steps.push({ phase, terms });

  phase = "Visitor books guest appointment from public navigation";
  active = visitor;
  await visitor.goto(base);
  await visitor.getByRole("link", { name: /Reservar un turno/ }).click();
  await visitor.getByLabel("Barbería").selectOption({ label: "Young KingZ QA B1" });
  await visitor.getByRole("checkbox", { name: new RegExp(serviceName) }).check();
  await visitor.locator('input[type="date"]').fill(date);
  const slots = visitor.getByRole("button", { name: /Horario/ });
  await slots.first().click();
  await visitor.getByPlaceholder("Nombre").pressSequentially(guestName);
  await visitor.getByPlaceholder("Teléfono").pressSequentially("1155550190");
  await exact(visitor, "Cotizar turno").click();
  const confirmed = visitor.waitForResponse((r) => r.url().endsWith("/reservations") && r.request().method() === "POST");
  await exact(visitor, "Confirmar reserva").click();
  const reservationResponse = await confirmed;
  assert.ok(reservationResponse.ok(), "Booking HTTP " + reservationResponse.status());
  const { reservationId } = await reservationResponse.json();
  await expect(visitor.getByText("Reserva confirmada")).toBeVisible();
  steps.push({ phase, reservationId });

  phase = "Reception registers arrival and terminal attendance for Barber";
  active = reception;
  await login(reception, "reception");
  await reception.getByRole("link", { name: "Agenda", exact: true }).click();
  await reception.getByRole("button", { name: new RegExp("Abrir reserva de " + guestName) }).click();
  await exact(reception, "Registrar llegada").click();
  await reception.getByRole("link", { name: "Registrar atención de este turno" }).click();
  await expect(reception.getByRole("checkbox", { name: serviceName })).toBeChecked();
  await expect(reception.getByLabel("Profesional responsable")).toHaveValue(barberId);
  await exact(reception, "Guardar atención").click();
  await notice(reception, "Atención registrada.");
  const [attendance] = await sql`select id,status,staff_member_id,attended_by_staff_member_id,services_performed_snapshot
    from attendance.attendances where reservation_id=${reservationId}`;
  assert.equal(attendance.status, "COMPLETED");
  assert.equal(attendance.staff_member_id, receptionId);
  assert.equal(attendance.attended_by_staff_member_id, barberId);
  assert.equal(attendance.services_performed_snapshot[0].priceMinor, 10000);
  steps.push({ phase, attendance });
  await screen(reception, "attendance");

  phase = "Reception creates and confirms sale from attendance";
  await exact(reception, "Crear venta de la atención").click();
  await reception.waitForURL(/\/ventas\?sale=/);
  const saleId = new URL(reception.url()).searchParams.get("sale");
  const sale = reception.getByTestId("sale-card").filter({ hasText: serviceName }).first();
  await sale.getByRole("button", { name: "Confirmar", exact: true }).click();
  await notice(reception, "Venta confirmada.");
  const [sold] = await sql`select status,total_minor::text,attendance_id,source from sales.sales where id=${saleId}`;
  assert.deepEqual(sold, { status: "CONFIRMED", total_minor: "10000", attendance_id: attendance.id, source: "ATTENDANCE" });
  steps.push({ phase, saleId, sold });

  phase = "Reception opens cash and takes payment from the sale";
  await reception.getByRole("link", { name: "Caja", exact: true }).click();
  if (!(await sql`select id from cash.cash_sessions where business_id=${book} and status='OPEN'`).length) {
    await exact(reception, "Abrir caja").click();
    await notice(reception, "Caja abierta y confirmada.");
  }
  await reception.getByRole("link", { name: "Ventas", exact: true }).click();
  await sale.getByRole("link", { name: "Cobrar venta" }).click();
  await expect(reception.getByTestId("checkout-panel").getByRole("combobox").first()).toHaveValue(saleId);
  await reception.getByLabel("Efectivo", { exact: true }).fill("10000");
  await reception.getByRole("checkbox", { name: "Entregar stock ahora" }).uncheck();
  await exact(reception, "Ejecutar checkout").click();
  await notice(reception, /Checkout.+verificado/);
  const [collected] = await sql`select m.id,m.confirmed_minor::text,m.status from money.money_operations m where m.business_id=${book} and m.sale_id=${saleId}`;
  assert.equal(collected.status, "SUCCEEDED");
  assert.equal(collected.confirmed_minor, "10000");
  steps.push({ phase, collected });
  await screen(reception, "checkout");

  phase = "Owner previews, verifies attribution and closes";
  active = owner;
  await owner.goto(economyPage);
  await owner.getByLabel("Período", { exact: true }).fill(month);
  await exact(owner, "Calcular estimación").click();
  await notice(owner, "Estimación actualizada");
  await expect(owner.getByText("Estimación abierta")).toBeVisible();
  const [preview] = await sql`select total_payable_minor::text,lines from econ.estimates where business_id=${book}
    and staff_member_id=${barberId} and period_start=${first}`;
  expected = BigInt(preview.total_payable_minor);
  assert.ok(expected >= 1000n);
  assert.ok(preview.lines.some((line) => line.sourceId === saleId && line.amountMinor === "1000"));
  const [agendaBefore] = await sql`select to_jsonb(r) reservation,to_jsonb(a) allocation from booking.reservations r join availability.resource_allocations a on a.id=r.current_allocation_id where r.id=${reservationId}`;
  await owner.getByLabel("Confirmación para cerrar").pressSequentially("CLOSE_SETTLEMENT");
  await exact(owner, "Cerrar período").click();
  await notice(owner, "Período cerrado");
  [settlement] = await sql`select id,payable_obligation_id,total_payable_minor::text,snapshot from econ.settlements where business_id=${book}
    and staff_member_id=${barberId} and period_start=${first}`;
  assert.equal(settlement.total_payable_minor, expected.toString());
  assert.ok(settlement.snapshot.sources.some((line) => line.sourceId === saleId && line.amountMinor === "1000"));
  const [agendaAfter] = await sql`select to_jsonb(r) reservation,to_jsonb(a) allocation from booking.reservations r join availability.resource_allocations a on a.id=r.current_allocation_id where r.id=${reservationId}`;
  assert.deepEqual(agendaAfter, agendaBefore);
  steps.push({ phase, settlementId: settlement.id, obligationId: settlement.payable_obligation_id, expected: expected.toString(), unchangedAgenda: true });

  } else {
    phase = "resume from previously verified settlement";
    const recorded = steps.find((step) => step.settlementId && step.unchangedAgenda);
    assert.ok(recorded);
    [settlement] = await sql`select id,payable_obligation_id,total_payable_minor::text,snapshot from econ.settlements where id=${recorded.settlementId}`;
    assert.equal(settlement.payable_obligation_id, recorded.obligationId);
    expected = BigInt(recorded.expected);
    assert.equal(settlement.total_payable_minor, expected.toString());
    await login(owner, "owner");
    await owner.getByRole("link", { name: "Economía del personal", exact: true }).click();
    await owner.locator("li.record-row").filter({ hasText: "Barbero QA" }).getByRole("link", { name: "Ver economía" }).click();
    await owner.waitForURL(/\/team\/[^/]+\/economia$/);
    economyPage = owner.url();
  }

  const settled = async () => (await sql`select status,amount_minor::text,
    (select sum(amount_minor)::text from obligations.obligation_payments where obligation_id=o.id) paid
    from obligations.expense_obligations o where id=${settlement.payable_obligation_id}`)[0];
  phase = "owner settles obligation partially then fully; Barber sees own payment";
  if (!steps.some((step) => step.phase === phase && step.settled?.status === "SETTLED")) {
  const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await auth.auth.signInWithPassword({ email: "owner-qa@youngkingz.local", password: process.env.G02_QA_PASSWORD });
  assert.ok(signed.data.session);
  const funding = async (amountMinor) => {
    const ref = crypto.randomUUID();
    const r = await fetch(api + "/v1/money/operations", { method: "POST",
      headers: { authorization: "Bearer " + signed.data.session.access_token, "content-type": "application/json", "x-operation-id": ref },
      body: JSON.stringify({ components: [{ method: "TRANSFER", amountMinor, accredited: true, reference: ref, evidenceReference: "Fondos sintéticos QA" }] })
    });
    assert.ok(r.ok, "Funding fixture HTTP " + r.status);
    return (await r.json()).data.id;
  };
  const partialAmount = Number(expected / 3n);
  const sources = [await funding(partialAmount), await funding(Number(expected) - partialAmount)];
  await owner.getByRole("link", { name: "Obligaciones", exact: true }).click();
  const obligation = owner.getByTestId("obligation-card").filter({ hasText: "Liquidación " + first });
  const pay = async (id, status) => {
    await obligation.getByLabel("Dinero confirmado").selectOption(id);
    await obligation.getByRole("button", { name: "Aplicar pago" }).click();
    await notice(owner, "Pago aplicado sobre dinero ya confirmado.");
    await expect(obligation).toContainText(status);
  };
  await pay(sources[0], "PARTIAL");
  await login(barber, "barber");
  await barber.getByRole("link", { name: "Mi economía", exact: true }).click();
  await expect(barber.getByRole("heading", { name: "Mi economía" })).toBeVisible();
  await expect(barber.getByText(/pagado/).first()).toBeVisible();
  await screen(barber, "barber-partial");
  await pay(sources[1], "SETTLED");
  assert.deepEqual(await settled(), { status: "SETTLED", amount_minor: expected.toString(), paid: expected.toString() });
  steps.push({ phase, partialAmount, settled: await settled() });
  }

  phase = "Owner posts positive and negative adjustments and reloads";
  await owner.goto(economyPage);
  const adjust = async (amount, reason) => {
    await owner.getByLabel("Liquidación").selectOption(settlement.id);
    await owner.getByLabel("Importe ($; negativo para reducir)", { exact: true }).fill(String(amount));
    await owner.getByLabel("Motivo", { exact: true }).pressSequentially(reason);
    await exact(owner, "Registrar ajuste").click();
    await notice(owner, "Ajuste registrado");
  };
  await adjust(4, "Reconocimiento adicional QA");
  await adjust(-2, "Revisión de diferencia QA");
  await owner.reload();
  await expect(owner.getByText(/Revisión de diferencia QA/)).toBeVisible();
  const [post] = await sql`select status,snapshot from econ.settlements where id=${settlement.id}`;
  assert.equal(post.status, "ADJUSTED");
  assert.deepEqual(post.snapshot, settlement.snapshot);
  assert.deepEqual(await settled(), { status: "PARTIAL", amount_minor: (expected + 200n).toString(), paid: expected.toString() });
  steps.push({ phase, snapshotUnchanged: true, obligation: await settled() });
  await screen(owner, "adjustments");
} catch (error) {
  steps.push({ phase, error: error.message });
  await screen(active, "journey-failure");
  process.exitCode = 1;
} finally {
  fs.writeFileSync(resultFile, JSON.stringify(steps, null, 2));
  await sql.end();
  await browser.close();
}
