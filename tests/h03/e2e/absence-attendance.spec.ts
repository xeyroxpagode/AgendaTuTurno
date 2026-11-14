import { expect, test, type Page } from "@playwright/test";
import { createOwnerContext, cleanupContext } from "../../h01/e2e/helpers";

let ctx: Awaited<ReturnType<typeof createOwnerContext>>;
let receptionist = { email: "", password: "YoungKingz-E2E!26", staffId: "" };
let barber = { email: "", password: "YoungKingz-E2E!26", staffId: "" };
let staffEmailSuffix = "";

test.setTimeout(120_000);

async function createStaffWithRole(role: "RECEPTIONIST" | "BARBER", firstName: string, lastName: string) {
  const email = `u06-${role.toLowerCase()}-${staffEmailSuffix}@example.com`;
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
  const r = await createStaffWithRole("RECEPTIONIST", "Recepcion", "U06");
  const b = await createStaffWithRole("BARBER", "Barbero", "U06");
  receptionist = { ...r, password: "YoungKingz-E2E!26" };
  barber = { ...b, password: "YoungKingz-E2E!26" };

  const owner = (await ctx.db`select id from iam.user_accounts where person_id=${ctx.personId} limit 1`)[0]!;
  const version = (await ctx.db`insert into business.booking_policy_versions(business_id,version_number,public_booking_enabled,horizon_calendar_dates,min_lead_minutes,start_step_minutes,cancel_cutoff_minutes,reschedule_cutoff_minutes,created_by) values (${ctx.businessId},1,true,365,0,30,120,120,${owner.id}) returning id`)[0]!;
  await ctx.db`insert into business.booking_policy_states(business_id,current_version_id) values (${ctx.businessId},${version.id})`;
});

test.afterAll(async () => {
  await ctx.db.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from absence.absence_events where business_id=${ctx.businessId}`;
    await tx`delete from absence.absence_requests where business_id=${ctx.businessId}`;
    await tx`delete from attendance.attendance_events where business_id=${ctx.businessId}`;
    await tx`delete from attendance.attendance_corrections where business_id=${ctx.businessId}`;
    await tx`delete from attendance.attendances where business_id=${ctx.businessId}`;
    await tx`delete from team.staff_effective_unavailability where business_id=${ctx.businessId}`;
    await tx`delete from availability.commitment_conflicts where business_id=${ctx.businessId}`;
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

async function seedReservation(staffMemberId: string, customerName: string, localDate: string, hour: number, minute = 0) {
  const reservationId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const at = (h: number, m: number) => `${localDate}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
  const startsAt = at(hour, minute);
  const endsAt = at(hour, minute + 50);
  await ctx.db.begin(async (tx) => {
    await tx`insert into system.operation_attempts(operation_id,business_id,command_name,request_hash,status,response_status,completed_at) values (${operationId},${ctx.businessId},'test.fixture','fixture','SUCCEEDED',200,now())`;
    await tx`insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at) values (${ctx.businessId},${staffMemberId},'RESERVATION',${reservationId},${localDate},${startsAt},${endsAt},${startsAt},${endsAt})`;
    await tx`insert into booking.reservations(id,business_id,revision,status,owner_type,contact_snapshot,staff_member_id,policy_version_id,policy_snapshot,commercial_total_minor,currency,starts_at,ends_at,occupied_starts_at,occupied_ends_at,business_local_date,business_timezone_snapshot,created_operation_id)
      values (${reservationId},${ctx.businessId},1,'CONFIRMED','GUEST',${ctx.db.json({ name: customerName, phone: "1155551234" })},${staffMemberId},(select current_version_id from business.booking_policy_states where business_id=${ctx.businessId}),'{}'::jsonb,1000,'ARS',${startsAt},${endsAt},${startsAt},${endsAt},${localDate},'America/Argentina/Buenos_Aires',${operationId})`;
  });
  return reservationId;
}

test("H03.U06 E2E-01 El Dueño recorre el ciclo completo de una ausencia", async ({ page }) => {
  const day = await localDateOffset(3);
  await loginOwner(page);
  await page.goto("/absences");
  await expect(page.getByRole("heading", { name: "Ausencias" })).toBeVisible();

  await page.getByRole("button", { name: "Solicitar ausencia" }).first().click();
  await page.getByLabel("Profesional de la ausencia").selectOption({ index: 1 });
  await page.getByLabel("Fecha").fill(day);
  await page.getByLabel("Desde").fill("09:00");
  await page.getByLabel("Hasta").fill("13:00");
  await page.getByLabel("Motivo").fill("Ausencia E2E");
  await page.getByRole("button", { name: "Enviar solicitud" }).click();
  await expect(page.getByRole("status")).toContainText("Solicitud registrada");

  const requested = await ctx.db`select id, status::text status from absence.absence_requests where business_id=${ctx.businessId} order by created_at desc limit 1`;
  expect(requested[0]!.status).toBe("PENDING");

  const unavailability = await ctx.db`select count(*)::int count from team.staff_effective_unavailability where business_id=${ctx.businessId}`;
  expect(unavailability[0]!.count).toBe(0);

  await page.getByRole("button", { name: /Abrir ausencia de/ }).first().click();
  await page.getByRole("button", { name: "Aprobar" }).click();
  await expect(page.getByRole("status")).toContainText("Ausencia aprobada");
  await page.getByRole("button", { name: "Aplicar ausencia" }).click();
  await expect(page.getByRole("status")).toContainText("Ausencia aplicada");

  const applied = await ctx.db`select status::text status, applied_at from absence.absence_requests where id=${requested[0]!.id}`;
  expect(applied[0]!.status).toBe("APPLIED");
  expect(applied[0]!.applied_at).toBeTruthy();

  const events = await ctx.db`select event_type::text from absence.absence_events where absence_request_id=${requested[0]!.id} order by sequence`;
  expect(events.map((row: { event_type: string }) => row.event_type)).toEqual(["ABSENCE_REQUESTED", "ABSENCE_APPROVED", "ABSENCE_APPLIED"]);
});

test("H03.U06 E2E-02 El Barbero solicita una ausencia propia y no puede aprobarla", async ({ page }) => {
  const day = await localDateOffset(4);
  await loginBarber(page);
  await page.goto("/absences");
  await expect(page.getByRole("heading", { name: "Ausencias" })).toBeVisible();

  await page.getByRole("button", { name: "Solicitar ausencia" }).first().click();
  await page.getByLabel("Fecha").fill(day);
  await page.getByLabel("Desde").fill("09:00");
  await page.getByLabel("Hasta").fill("12:00");
  await page.getByLabel("Motivo").fill("Ausencia propia E2E");
  await page.getByRole("button", { name: "Enviar solicitud" }).click();
  await expect(page.getByRole("status")).toContainText("Solicitud registrada");

  await page.getByRole("button", { name: /Abrir ausencia de/ }).first().click();
  await expect(page.getByRole("button", { name: "Aprobar" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Aplicar ausencia" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retirar" })).toBeVisible();
});

test("H03.U06 E2E-03 Se registra una atención real desde una reserva", async ({ page }) => {
  const day = await localDateOffset(5);
  const reservationId = await seedReservation(ctx.staffId, "Cliente Atencion E2E", day, 10);

  await loginOwner(page);
  await page.goto("/attendance");
  await expect(page.getByRole("heading", { name: "Atención real" })).toBeVisible();

  await page.getByRole("button", { name: "Registrar atención" }).first().click();
  await page.getByLabel("Reserva (opcional)").fill(reservationId);
  await page.getByLabel("Profesional responsable").selectOption({ index: 1 });
  await page.getByLabel("Servicio realizado").fill("Corte E2E");
  await page.getByLabel("Duración total (min)").fill("30");
  await page.getByRole("button", { name: "Guardar atención" }).click();
  await expect(page.getByRole("status")).toContainText("Atención registrada");

  const attendances = await ctx.db`
    select reservation_id, status::text status, walk_in, client_profile_id
      from attendance.attendances where business_id=${ctx.businessId}`;
  expect(attendances).toHaveLength(1);
  expect(attendances[0]!.reservation_id).toBe(reservationId);
  expect(attendances[0]!.status).toBe("COMPLETED");
  expect(attendances[0]!.walk_in).toBe(false);

  const reservations = await ctx.db`select status::text status from booking.reservations where id=${reservationId}`;
  expect(reservations[0]!.status).toBe("CONFIRMED");
});

test("H03.U06 E2E-04 Se registra un walk-in SIN reserva y SIN cuenta de cliente", async ({ page }) => {
  const before = await ctx.db`select count(*)::int count from clients.client_profiles`;
  const accountsBefore = await ctx.db`select count(*)::int count from iam.user_accounts`;

  await loginReceptionist(page);
  await page.goto("/attendance");
  await page.getByRole("button", { name: "Registrar atención" }).first().click();
  await page.getByLabel("Reserva (opcional)").fill("");
  await page.getByLabel("Profesional responsable").selectOption({ index: 1 });
  await page.getByLabel("Nombre del cliente").fill("Walk-in E2E");
  await page.getByLabel("Teléfono").fill("1170001234");
  await page.getByLabel("Servicio realizado").fill("Corte E2E");
  await page.getByRole("button", { name: "Guardar atención" }).click();
  await expect(page.getByRole("status")).toContainText("Atención registrada");

  const walkIns = await ctx.db`
    select reservation_id, walk_in, client_profile_id, status::text status
      from attendance.attendances where business_id=${ctx.businessId} and walk_in = true`;
  expect(walkIns).toHaveLength(1);
  expect(walkIns[0]!.reservation_id).toBeNull();
  expect(walkIns[0]!.client_profile_id).toBeNull();
  expect(walkIns[0]!.status).toBe("COMPLETED");

  const after = await ctx.db`select count(*)::int count from clients.client_profiles`;
  const accountsAfter = await ctx.db`select count(*)::int count from iam.user_accounts`;
  expect(after[0]!.count).toBe(before[0]!.count);
  expect(accountsAfter[0]!.count).toBe(accountsBefore[0]!.count);
});

test("H03.U06 E2E-05 El caso negativo: walk-in sin contacto no se puede registrar", async ({ page }) => {
  await loginReceptionist(page);
  await page.goto("/attendance");
  await page.getByRole("button", { name: "Registrar atención" }).first().click();
  await page.getByLabel("Profesional responsable").selectOption({ index: 1 });
  await page.getByLabel("Nombre del cliente").fill("");
  await page.getByLabel("Teléfono").fill("");
  await expect(page.getByRole("button", { name: "Guardar atención" })).toBeDisabled();

  const invalid = await ctx.db`select count(*)::int count from attendance.attendances where business_id=${ctx.businessId} and contact_snapshot->>'name' = ''`;
  expect(invalid[0]!.count).toBe(0);
});
