import { expect, test } from "@playwright/test";
import { createOwnerContext, cleanupContext } from "../../h01/e2e/helpers";
import postgres from "postgres";

test.setTimeout(120_000);

let ctx: Awaited<ReturnType<typeof createOwnerContext>>;
let db: ReturnType<typeof postgres>;

/**
 * Fecha futura dentro del horizonte: el miércoles próximo según la zona del
 * Business (weekday = 3). La fecha fija anterior (2026-11-11) quedó en el
 * pasado con el paso del tiempo y hacía fallar el flujo públicamente.
 */
const BOOKING_DATE = nextWednesday(new Date());
const _VISIBLE_START = "13:30";

function nextWednesday(from: Date): string {
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const weekday = date.getUTCDay();
  const daysAhead = weekday <= 3 ? 3 - weekday : 10 - weekday;
  const next = new Date(date.getTime() + (daysAhead === 0 ? 7 : daysAhead) * 86_400_000);
  return next.toISOString().slice(0, 10);
}

async function seedPublicBusiness(businessId: string, staffId: string, accountId: string) {
  const category = (await db`insert into catalog.service_categories(id,business_id,name) values (${crypto.randomUUID()},${businessId},'Servicios E2E') returning id`)[0]!.id;
  const service = (await db`insert into catalog.services(id,business_id,name,category_id,publication,lifecycle) values (${crypto.randomUUID()},${businessId},'Corte E2E',${category},'PUBLISHED','ACTIVE') returning id`)[0]!.id;
  const terms = (await db`insert into catalog.service_terms_versions(id,business_id,service_id,version_number,price_minor,currency,duration_minutes,pre_buffer_minutes,post_buffer_minutes,conditions,effective_from) values (${crypto.randomUUID()},${businessId},${service},1,10000,'ARS',30,5,5,'Sin reembolso tras confirmar',now()) returning id`)[0]!.id;
  await db`update catalog.services set current_terms_version_id=${terms} where id=${service}`;
  const setId = (await db`insert into team.staff_service_sets(business_id,staff_member_id) values (${businessId},${staffId}) returning id`)[0]!.id;
  await db`insert into team.staff_service_assignments(business_id,staff_service_set_id,service_id) values (${businessId},${setId},${service})`;
  const sched = (await db`insert into team.staff_weekly_schedules(business_id,staff_member_id) values (${businessId},${staffId}) returning id`)[0]!.id;
  await db`insert into team.staff_schedule_intervals(business_id,weekly_schedule_id,weekday,start_minute,end_minute) values (${businessId},${sched},3,540,1080)`;
  const hours = (await db`insert into business.business_hours_configs(business_id) values (${businessId}) returning id`)[0]!.id;
  await db`insert into business.business_hours_intervals(business_id,config_id,weekday,start_minute,end_minute) values (${businessId},${hours},3,600,1200)`;
  const version = (await db`insert into business.booking_policy_versions(business_id,version_number,public_booking_enabled,horizon_calendar_dates,min_lead_minutes,start_step_minutes,cancel_cutoff_minutes,reschedule_cutoff_minutes,created_by) values (${businessId},1,true,30,0,30,120,120,${accountId}) returning id`)[0]!.id;
  await db`insert into business.booking_policy_states(business_id,current_version_id) values (${businessId},${version})`;
  return { serviceId: service, serviceName: "Corte E2E" };
}

function _uuidRegex(): RegExp {
  return /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/;
}

test.describe("H03.U04 F02/F03 — Booking público utilizable (sin UUIDs manuales)", () => {
  test.beforeAll(async () => {
    ctx = await createOwnerContext();
    db = postgres(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres", { prepare: false });
    await seedPublicBusiness(ctx.businessId, ctx.staffId, ctx.accountId);
  });

  test.afterAll(async () => {
    await db.end();
    await cleanupContext(ctx).catch(() => undefined);
  });

  test("flujo completo: reservar, consultar, reprogramar y cancelar desde el navegador", async ({ page }) => {
    await page.goto(`/reservar?businessId=${ctx.businessId}`);

    // 1. Abrir Reservar — servicios publicados cargados por nombre (no UUID manual).
    await expect(page.getByRole("heading", { name: "Reservar turno" })).toBeVisible();
    await expect(page.getByText(/Corte E2E/)).toBeVisible({ timeout: 10_000 });

    // 2. Elegir servicio por nombre (checkbox asociado al texto del servicio).
    await page.getByRole("checkbox", { name: /Corte E2E/ }).first().check();

    // 3. Elegir profesional ANY (por defecto).
    await expect(page.locator("select")).toHaveValue("ANY");

    // 4. Seleccionar fecha y horario.
    await page.locator('input[type="date"]').first().fill(BOOKING_DATE);
    // El botón de slot expone aria-label "Horario 13:30 del YYYY-MM-DD":
    // el nombre accesible, no el texto visible, es lo que matchea.
    const slotButton = page.getByRole("button", { name: /Horario 13:30/ }).first();
    await expect(slotButton).toBeVisible({ timeout: 10_000 });
    await slotButton.click();

    // 5. Ver precio y condiciones.
    await expect(page.getByText(/Subtotal estimado: 100 ARS/)).toBeVisible();
    await expect(page.getByText(/Sin reembolso tras confirmar/)).toBeVisible();

    // 6. Completar contacto.
    await page.getByPlaceholder("Nombre").fill("Invitado E2E");
    await page.getByPlaceholder("Teléfono").fill("1155551234");
    await page.getByPlaceholder("Email (opcional)").fill("e2e@test.local");

    // 7. Confirmar.
    await page.getByRole("button", { name: "Cotizar turno" }).click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Confirmar reserva" }).click();
    await expect(page.getByText(/Reserva confirmada/)).toBeVisible({ timeout: 15_000 });

    const reservationId = await page.locator("text=ID:").evaluate((el) => (el.textContent ?? "").match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/)?.[0] ?? "");
    expect(reservationId).toBeTruthy();
    // El token se enmascara por defecto; hay que pulsar "Mostrar" para revelarlo.
    await page.getByRole("button", { name: "Mostrar" }).click();
    const guestToken = await page.locator("text=Token privado").locator("xpath=following::span[1]").innerText();
    expect(guestToken).toMatch(/[A-Za-z0-9_-]{20,}/);

    // 8. Consultar su reserva (Mis reservas).
    await page.getByRole("link", { name: /Mis reservas/ }).click();
    await expect(page.getByRole("heading", { name: "Mis reservas" })).toBeVisible();
    await page.getByLabel("ID de la reserva").fill(reservationId);
    await page.getByLabel("Token de invitado").fill(guestToken);
    await page.getByRole("button", { name: "Consultar reserva" }).click();
    await expect(page.getByText(reservationId).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("CONFIRMED")).toBeVisible({ timeout: 10_000 });

    // 9. Reprogramar desde el navegador (misma reserva, nueva fecha/hora — miércoles con disponibilidad).
    await page.locator('input[type="date"]').last().fill("2026-11-18");
    await page.locator('input[type="time"]').fill("15:00");
    await page.getByRole("button", { name: "Reprogramar" }).click();
    await expect(page.getByText("Reserva reprogramada.").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("CONFIRMED")).toBeVisible();

    // 10. Cancelar desde el navegador.
    await page.getByRole("button", { name: /Cancelar reserva/ }).click();
    await expect(page.getByText("Reserva cancelada.").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("CANCELLED")).toBeVisible();
  });
});
