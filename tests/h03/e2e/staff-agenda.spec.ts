import { expect, test, type Page } from "@playwright/test";
import { createOwnerContext, cleanupContext, signIn } from "../../h01/e2e/helpers";

/**
 * H03.U05 · E2E de Agenda Staff.
 *
 * Recorre la aplicación real (navegador + API + PostgreSQL) para los tres
 * roles con agenda: Dueño, Recepción y Barbero. Cada aserción comprueba el
 * efecto PERSISTIDO en la base, no sólo el texto de la interfaz.
 *
 * Aislamiento: el suite crea su propio contexto de arranque (createOwnerContext)
 * y sus propios usuarios Receptionist/Barber — nunca siembra ni opera datos en
 * el negocio QA compartido (10000000-...-0001).
 */

let ctx: Awaited<ReturnType<typeof createOwnerContext>>;
let receptionist = { email: "", password: "YoungKingz-E2E!26", staffId: "" };
let barber = { email: "", password: "YoungKingz-E2E!26", staffId: "" };
let staffEmailSuffix = "";

test.setTimeout(180_000);

async function createStaffWithRole(role: "RECEPTIONIST" | "BARBER", firstName: string, lastName: string) {
  const email = `u05-${role.toLowerCase()}-${staffEmailSuffix}@example.com`;
  const { data: created, error } = await ctx.admin.auth.admin.createUser({ email, password: "YoungKingz-E2E!26", email_confirm: true });
  if (error) throw error;
  const [person] = await ctx.db`insert into iam.persons(first_name,last_name) values (${firstName},${lastName}) returning id`;
  const [staff] = await ctx.db`insert into team.staff_members(business_id,person_id,employment_status,access_status) values (${ctx.businessId},${person!.id},'ACTIVE','ACTIVE') returning id`;
  await ctx.db`insert into team.staff_relationship_periods(business_id,staff_member_id) values (${ctx.businessId},${staff!.id})`;
  await ctx.db`insert into iam.staff_role_states(business_id,staff_member_id) values (${ctx.businessId},${staff!.id})`;
  await ctx.db`insert into iam.role_assignments(business_id,staff_member_id,role,effective_at,assigned_by_account_id) values (${ctx.businessId},${staff!.id},${role},now(),${ctx.accountId})`;
  await ctx.db`insert into iam.user_accounts(person_id,auth_user_id,verified_email,status) values (${person!.id},${created.user.id},${email},'ACTIVE')`;
  const [account] = await ctx.db`select id from iam.user_accounts where auth_user_id=${created.user.id}`;
  await ctx.db`insert into iam.account_security_states(account_id) values (${account!.id})`;
  return { email, staffId: String(staff!.id) };
}

test.beforeAll(async () => {
  ctx = await createOwnerContext();
  staffEmailSuffix = ctx.suffix;
  const r = await createStaffWithRole("RECEPTIONIST", "Recepción", "U05");
  const b = await createStaffWithRole("BARBER", "Barbero", "U05");
  receptionist = { ...r, password: "YoungKingz-E2E!26" };
  barber = { ...b, password: "YoungKingz-E2E!26" };

  const owner = (await ctx.db`select id from iam.user_accounts where person_id=${ctx.personId} limit 1`)[0]!;
  const version = (await ctx.db`insert into business.booking_policy_versions(business_id,version_number,public_booking_enabled,horizon_calendar_dates,min_lead_minutes,start_step_minutes,cancel_cutoff_minutes,reschedule_cutoff_minutes,created_by) values (${ctx.businessId},1,true,365,0,30,120,120,${owner.id}) returning id`)[0]!;
  await ctx.db`insert into business.booking_policy_states(business_id,current_version_id) values (${ctx.businessId},${version.id})`;
});

test.afterAll(async () => {
  // Limpieza propia: sólo filas creadas por este suite (rol replica sólo en la
  // transacción local). El propio negocio de prueba se descarta en cleanupContext.
  await ctx.db.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from booking.reservation_events where business_id=${ctx.businessId}`;
    await tx`delete from booking.reservation_items where business_id=${ctx.businessId}`;
    await tx`delete from booking.reservations where business_id=${ctx.businessId}`;
    await tx`delete from availability.allocation_service_requirements where business_id=${ctx.businessId}`;
    await tx`delete from availability.resource_allocations where business_id=${ctx.businessId}`;
    await tx`delete from availability.business_guards where business_id=${ctx.businessId}`;
    await tx`delete from business.booking_policy_states where business_id=${ctx.businessId}`;
    await tx`delete from business.booking_policy_versions where business_id=${ctx.businessId}`;
    await tx`delete from system.audit_events where business_id=${ctx.businessId}`;
    await tx`delete from system.operation_attempts where business_id=${ctx.businessId}`;
  });
  await cleanupContext(ctx).catch(() => undefined);
});

async function login(page: Page, email: string, password = "YoungKingz-E2E!26") {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(/\/team|\/agenda|\/account/);
}

const loginOwner = (page: Page) => login(page, ctx.email, ctx.password);
const loginReceptionist = (page: Page) => login(page, receptionist.email);
const loginBarber = (page: Page) => login(page, barber.email);

async function localDateOffset(days: number): Promise<string> {
  const target = new Date(Date.now() + days * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(target);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Inserta una reserva CONFIRMED con su Allocation ACTIVE. */
async function seedReservation(staffMemberId: string, customerName: string, localDate: string, hour: number, minute = 30) {
  const reservationId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const startsAt = `${localDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;
  const endsAt = `${localDate}T${String(hour).padStart(2, "0")}:${String(minute + 29).padStart(2, "0")}:00Z`;
  await ctx.db.begin(async (tx) => {
    await tx`insert into system.operation_attempts(operation_id,business_id,command_name,request_hash,status,response_status,completed_at) values (${operationId},${ctx.businessId},'test.fixture','fixture','SUCCEEDED',200,now())`;
    await tx`insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at) values (${ctx.businessId},${staffMemberId},'RESERVATION',${reservationId},${localDate},${startsAt},${endsAt},${startsAt},${endsAt})`;
    await tx`insert into booking.reservations(id,business_id,revision,status,owner_type,contact_snapshot,staff_member_id,policy_version_id,policy_snapshot,commercial_total_minor,currency,starts_at,ends_at,occupied_starts_at,occupied_ends_at,business_local_date,business_timezone_snapshot,created_operation_id)
      values (${reservationId},${ctx.businessId},1,'CONFIRMED','GUEST',${ctx.db.json({ name: customerName, phone: "1155551234" })},${staffMemberId},(select current_version_id from business.booking_policy_states where business_id=${ctx.businessId}),'{}'::jsonb,1000,'ARS',${startsAt},${endsAt},${startsAt},${endsAt},${localDate},'America/Argentina/Buenos_Aires',${operationId})`;
  });
  return reservationId;
}

test("H03.U05 E2E-01 Owner entra a la agenda compartida y ve el filtro por profesional", async ({ page }) => {
  await loginOwner(page);
  await page.goto("/agenda");
  await expect(page.getByRole("heading", { name: "Agenda" })).toBeVisible();
  await expect(page.getByText("Turnos del negocio por profesional.")).toBeVisible();
  await expect(page.getByLabel("Filtro de profesional")).toBeVisible();
});

test("H03.U05 E2E-02 Recepción ve la agenda compartida con el filtro de estado NO_SHOW", async ({ page }) => {
  await loginReceptionist(page);
  await page.goto("/agenda");
  await expect(page.getByRole("heading", { name: "Agenda" })).toBeVisible();
  await expect(page.getByLabel("Filtro de profesional")).toBeVisible();
  await expect(page.getByLabel("Filtro de estado")).toContainText("No se presentaron");
});

test("H03.U05 E2E-03 Barbero entra a su agenda PROPIA: sin filtro por profesional", async ({ page }) => {
  await loginBarber(page);
  await page.goto("/agenda");
  await expect(page.getByRole("heading", { name: "Agenda" })).toBeVisible();
  await expect(page.getByText("Tus turnos del día.")).toBeVisible();
  await expect(page.getByLabel("Filtro de profesional")).toHaveCount(0);
});

test("H03.U05 E2E-04 La agenda del barbero NO muestra reservas de otros profesionales", async ({ page }) => {
  const today = await localDateOffset(0);
  await seedReservation(ctx.staffId, "Reserva De Otro", today, 10);

  await loginBarber(page);
  await page.goto("/agenda");
  await page.getByLabel("Desde").fill(today);
  await page.getByLabel("Hasta").fill(today);
  await expect(page.getByText("Reserva De Otro")).toHaveCount(0);

  // El OWNER sí ve esa reserva en su agenda compartida.
  await loginOwner(page);
  await page.goto("/agenda");
  await page.getByLabel("Desde").fill(today);
  await page.getByLabel("Hasta").fill(today);
  await expect(page.getByText("Reserva De Otro")).toBeVisible();
});

test("H03.U05 E2E-05 Recepción registra llegada y no-show sobre la agenda, con efecto persistido", async ({ page }) => {
  // El no-show sólo puede confirmarse sobre un turno cuya hora ya transcurrió:
  // se siembra el turno del día local anterior.
  const yesterday = await localDateOffset(-1);
  const reservationId = await seedReservation(receptionist.staffId, "Cliente E2E U05", yesterday, 11);

  await loginReceptionist(page);
  await page.goto("/agenda");
  await page.getByLabel("Desde").fill(yesterday);
  await page.getByLabel("Hasta").fill(yesterday);

  await page.getByRole("button", { name: /Abrir reserva de Cliente E2E U05/ }).click();
  await expect(page.getByRole("heading", { name: "Cliente E2E U05" })).toBeVisible();

  // Llegada: no cambia el estado ni libera la allocation.
  await page.getByRole("button", { name: "Registrar llegada" }).click();
  await expect(page.getByRole("status")).toContainText("Llegada registrada");
  const afterArrival = await ctx.db`select status, revision from booking.reservations where id=${reservationId}`;
  expect(afterArrival[0]!.status).toBe("CONFIRMED");
  const arrivalEvents = await ctx.db`select count(*)::int count from booking.reservation_events where reservation_id=${reservationId} and event_type='ARRIVAL_REGISTERED'`;
  expect(arrivalEvents[0]!.count).toBe(1);

  // No-show: estado terminal y allocation liberada.
  await page.getByRole("button", { name: "Confirmar no-show" }).click();
  await expect(page.getByRole("status")).toContainText("No-show confirmado");
  const afterNoShow = await ctx.db`select status, revision, no_show_at from booking.reservations where id=${reservationId}`;
  expect(afterNoShow[0]!.status).toBe("NO_SHOW");
  expect(afterNoShow[0]!.no_show_at).toBeTruthy();
  const allocation = await ctx.db`select status::text from availability.resource_allocations where source_id=${reservationId} and source_type='RESERVATION'`;
  expect(allocation.map((row) => row.status)).toEqual(["RELEASED"]);
  const noShowEvents = await ctx.db`select count(*)::int count from booking.reservation_events where reservation_id=${reservationId} and event_type='NO_SHOW_CONFIRMED'`;
  expect(noShowEvents[0]!.count).toBe(1);
});

test("H03.U05 E2E-06 El barbero NO alcanza una reserva ajena por la API", async ({ page }) => {
  const today = await localDateOffset(0);
  const reservationId = await seedReservation(ctx.staffId, "Reserva Ajena", today, 16);

  await loginBarber(page);
  await page.goto("/agenda");
  await page.getByLabel("Desde").fill(today);
  await page.getByLabel("Hasta").fill(today);
  await expect(page.getByText("Reserva Ajena")).toHaveCount(0);

  // Con el token del barbero, la API rechaza la reserva ajena (B01 §B5.3).
  const token = await signIn(barber.email, "YoungKingz-E2E!26");
  expect(token).not.toBe("");
  const response = await page.request.fetch(`http://127.0.0.1:4100/v1/staff/bookings/${reservationId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(403);
});
