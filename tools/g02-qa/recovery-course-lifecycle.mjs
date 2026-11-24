import assert from "node:assert/strict";
import { createHmac, randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "es-AR" });
const visitor = await browser.newPage();
const steps = [];
const evidence = (ids, observed) => steps.push({ ids, status: "PASS", observed });
const file = path.join(out, "04_EXPLORATORY", "course-lifecycle.json");
const button = (name, scope = page) => scope.getByRole("button", { name, exact: true });
const notice = (message) => expect(page.getByRole("status").filter({ hasText: message })).toBeVisible({ timeout: 15000 });
const courseRow = (title) => page.locator("li.record-row").filter({ hasText: title });
const sessionRow = (slot) => page.locator("li.record-row").filter({ hasText: slot + " ·" });
let phase = "login";
try {
  await page.goto(base + "/login");
  await page.getByLabel("Correo").pressSequentially("owner-qa@youngkingz.local");
  await page.getByLabel("Contraseña").pressSequentially(process.env.G02_QA_PASSWORD);
  await button("Ingresar").click();
  await page.waitForURL(/\/team|\/account/);
  await page.getByRole("link", { name: "Agenda", exact: true }).waitFor({ timeout: 15000 });
  await page.goto(base + "/cursos");
  await page.getByRole("link", { name: "Agenda", exact: true }).waitFor({ timeout: 15000 });
  phase = "Q07-01";
  const title = "QA Ciclo " + Date.now().toString(36);
  await page.getByLabel("Título del curso").pressSequentially(title);
  await page.getByLabel("Medio de contacto").selectOption("PHONE");
  const phone = "+54 11 5555-0142";
  await page.getByLabel("Dato de contacto público").pressSequentially(phone);
  const courseCreation = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/v1/courses"));
  await button("Guardar borrador").click();
  const createdResponse = await courseCreation;
  if (!createdResponse.ok()) throw new Error("Crear curso HTTP " + createdResponse.status() + ": " + (await createdResponse.json()).error?.code);
  await notice("Borrador creado");
  const [course] = await sql`select id,business_id,revision,status,created_by_account_id from courses.courses where title=${title}`;
  assert.equal(course?.status, "DRAFT");
  const published = async () => {
    const response = await visitor.request.get(api + "/v1/public/businesses/" + course.business_id + "/courses");
    assert.ok(response.ok());
    return (await response.json()).data;
  };
  assert.ok(!(await published()).courses.some((item) => item.id === course.id));
  evidence([phase], { id: course.id, status: course.status, publicMatches: 0 });
  phase = "Q07-04";
  await button("Editar", courseRow(title)).click();
  const edited = title + " editado";
  await page.getByLabel("Título del curso").press("End");
  await page.getByLabel("Título del curso").pressSequentially(" editado");
  // Detect contact loss but continue so the remaining independent lifecycle checks run.
  const contactInput = page.getByLabel("Dato de contacto público");
  const contactLoaded = await contactInput.count() === 1 && await contactInput.inputValue() === phone;
  if (!contactLoaded) {
    steps.push({ ids: [], status: "FAIL", observed: "La edición no repuso el contacto existente", defect: "REC-D01" });
    await page.getByLabel("Medio de contacto").selectOption("PHONE");
    await contactInput.fill(phone);
  }
  await button("Guardar cambios").click();
  await notice("Oferta actualizada");
  const changed = await sql`select id,revision,contact_value from courses.courses where title in (${title},${edited})`;
  assert.equal(changed.length, 1);
  assert.equal(changed[0].id, course.id);
  assert.equal(changed[0].revision, course.revision + 1);
  assert.equal(changed[0].contact_value, phone);
  evidence([phase], changed[0]);
  phase = "Q07-02/Q07-05";
  await button("Publicar", courseRow(edited)).click();
  await notice("Curso publicado");
  const list = await published();
  const publicOffers = list.courses.filter((item) => item.id === course.id);
  assert.equal(publicOffers.length, 1);
  assert.equal(publicOffers[0].contactValue, phone);
  assert.equal(list.sessions.filter((item) => item.courseId === course.id).length, 0);
  const [publication] = await sql`select c.status,e.actor_account_id from courses.courses c join courses.course_events e on e.course_id=c.id where c.id=${course.id} and e.event_type='PUBLISHED'`;
  assert.equal(publication.status, "PUBLISHED");
  assert.equal(publication.actor_account_id, course.created_by_account_id);
  evidence(["Q07-02", "Q07-05"], { ...publication, publicOffers: 1, publicSessions: 0 });

  phase = "Q07-06/Q07-08/Q07-10";
  await courseRow(edited).getByRole("link", { name: "Sesiones" }).click();
  await expect(page.getByRole("heading", { name: "Sesiones del curso" })).toBeVisible();
  const instructor = page.getByLabel("Instructor");
  await expect(instructor).toBeEnabled({ timeout: 15000 });
  const instructorId = await instructor.locator("option").first().getAttribute("value");
  await instructor.selectOption(instructorId);
  const slots = await sql`
    select to_char(day,'YYYY-MM-DD') d from generate_series(current_date+2, current_date+32, interval '1 day') day
    where not exists (select 1 from availability.resource_allocations a
      where a.business_id=${course.business_id} and a.staff_member_id=${instructorId} and a.released_at is null
      and a.local_date=day::date)
    order by day limit 3`;
  assert.equal(slots.length, 3);
  const [origin, occupied, target] = slots.map(({ d }) => d);
  const schedule = async (date) => {
    await page.getByLabel("Fecha local").fill(date);
    await page.getByLabel("Hora local").fill("10:00");
    await button("Programar sesión").click();
    await notice("Sesión programada");
    const [session] = await sql`
      select id, status, timezone, local_date::text, occupied_start_at, occupied_end_at, instructor_staff_member_id, business_id
      from courses.course_sessions where course_id=${course.id} and local_date=${date} and status='SCHEDULED' order by created_at desc limit 1`;
    assert.equal(session.status, "SCHEDULED");
    assert.equal(session.instructor_staff_member_id, instructorId);
    assert.equal(session.business_id, course.business_id);
    assert.equal(session.occupied_end_at - session.occupied_start_at, 60 * 60 * 1000);
    return session;
  };
  const first = await schedule(origin);
  const second = await schedule(occupied);
  assert.notEqual(first.id, second.id);
  evidence(["Q07-06", "Q07-08"], { sessions: [first, second], selectedInstructor: instructorId });

  phase = "Q07-10/Q07-11";
  const allocations = (id) => sql`select id,source_id,staff_member_id,local_date::text,released_at from availability.resource_allocations where business_id=${course.business_id} and source_type='COURSE_SESSION' and source_id=${id} order by created_at,id`;
  await button("Confirmar", sessionRow(occupied)).click();
  await notice("Sesión confirmada");
  const [stillScheduled] = await sql`select status from courses.course_sessions where id=${first.id}`;
  assert.equal(stillScheduled.status, "SCHEDULED");
  await button("Confirmar", sessionRow(origin)).click();
  await notice("Sesión confirmada");
  const [initial] = await allocations(first.id);
  const [other] = await allocations(second.id);
  assert.equal(initial.local_date, origin);
  assert.equal(initial.released_at, null);
  assert.equal(other.local_date, occupied);
  assert.equal(other.released_at, null);
  evidence(["Q07-10", "Q07-11"], { initial, other, firstStatusWhenSecondConfirmed: stillScheduled.status });

  const reschedule = async (from, to) => {
    await button("Reprogramar", sessionRow(from)).click();
    await sessionRow(from).getByLabel("Nueva fecha local").fill(to);
    const response = page.waitForResponse((r) => r.url().endsWith("/reschedule") && r.request().method() === "POST");
    await button("Guardar nueva fecha", sessionRow(from)).click();
    return response;
  };
  phase = "Q07-18";
  assert.equal((await reschedule(origin, target)).status(), 200);
  await notice("Sesión reprogramada");
  const beforeConflict = await allocations(first.id);
  assert.equal(beforeConflict.length, 2);
  assert.ok(beforeConflict.find((a) => a.id === initial.id).released_at);
  assert.equal(beforeConflict.find((a) => !a.released_at).local_date, target);
  const [move] = await sql`select event_type,changes from courses.course_session_events where session_id=${first.id} and event_type='RESCHEDULED'`;
  assert.ok(move);
  evidence([phase], { sessionId: first.id, move, allocations: beforeConflict });
  phase = "Q07-19";
  const conflict = await reschedule(target, occupied);
  assert.equal(conflict.status(), 409);
  const conflictBody = await conflict.json();
  assert.match(JSON.stringify(conflictBody), /SLOT_CONFLICT/);
  assert.deepEqual(await allocations(first.id), beforeConflict);
  assert.deepEqual([...await allocations(second.id)], [other]);
  evidence([phase], { conflict: conflictBody, preservedAllocations: [beforeConflict, other] });
  await page.screenshot({ path: path.join(out, "08_SCREENSHOTS", "course-conflict.png"), fullPage: true });
  await button("Cancelar", sessionRow(target)).last().click();

  phase = "Q07-20";
  await button("Cancelar", sessionRow(target)).click();
  await notice("Sesión cancelada");
  const released = await allocations(first.id);
  assert.ok(released.every((allocation) => allocation.released_at));
  assert.deepEqual([...await allocations(second.id)], [other]);
  const events = await sql`select event_type,actor_account_id from courses.course_session_events where session_id=${first.id} order by created_at`;
  assert.deepEqual(events.map((event) => event.event_type), ["SCHEDULED", "CONFIRMED", "RESCHEDULED", "CANCELLED"]);
  evidence([phase], { released, retained: other, events });
  phase = "REC-D02";
  const history = page.locator(".audit-list");
  if (!(await history.getByText(/RESCHEDULED/).first().isVisible())) {
    steps.push({ ids: [], status: "FAIL", observed: "Historial por curso omitió el evento RESCHEDULED pese a existir en PostgreSQL", defect: phase });
  }
  await page.screenshot({ path: path.join(out, "08_SCREENSHOTS", "course-history.png"), fullPage: true });

  phase = "Q07-24";
  await visitor.goto(base);
  await visitor.getByRole("link", { name: /Ver cursos/ }).click();
  const publicBusiness = (await published()).business;
  await visitor.getByRole("link", { name: publicBusiness.name, exact: true }).click();
  await expect(visitor.getByRole("heading", { name: "Cursos · " + publicBusiness.name })).toBeVisible();
  const publicRow = visitor.locator("article").filter({ hasText: edited });
  await expect(publicRow).toContainText(phone);
  await expect(publicRow.getByRole("link", { name: phone })).toHaveAttribute("href", "tel:+541155550142");
  evidence(["Q07-29"], { renderedContact: phone, action: "tel:+541155550142" });
  const publicSessions = (await published()).sessions.filter((session) => session.courseId === course.id);
  assert.deepEqual(publicSessions.map((session) => session.id), [second.id]);
  await expect(publicRow.locator("li")).toHaveCount(1);
  await expect(publicRow.locator("li")).toContainText(publicSessions[0].instructorName);
  const [privateOffer] = await sql`select title from courses.courses where business_id=${course.business_id} and status='DRAFT' order by created_at desc limit 1`;
  assert.ok(privateOffer);
  await expect(visitor.locator("article").filter({ hasText: privateOffer.title })).toHaveCount(0);
  const publicDate = new Date(publicSessions[0].start).toLocaleString("es-AR", { timeZone: second.timezone, dateStyle: "long", timeStyle: "short" });
  await expect(publicRow.locator("li")).toContainText(publicDate);
  await expect(publicRow.getByRole("button", { name: /inscrib|matricul|pagar/i })).toHaveCount(0);
  await expect(publicRow.getByRole("link", { name: /inscrib|matricul|pagar/i })).toHaveCount(0);
  const [hidden] = await sql`select id,title from courses.courses where business_id=${course.business_id} and status='DRAFT' order by created_at desc limit 1`;
  const noPublicDetail = await visitor.request.get(api + "/v1/public/businesses/" + course.business_id + "/courses/" + hidden.id);
  assert.equal(noPublicDetail.status(), 404);
  assert.ok(!(await noPublicDetail.text()).includes(hidden.title));
  evidence(["Q07-27"], { directDetail: 404, publicListContainsDraft: false });
  await visitor.screenshot({ path: path.join(out, "08_SCREENSHOTS", "public-course-discovery.png"), fullPage: true });

  phase = "guest-booking";
  // Reuse the H03 booking fixture layout. Only catalog and availability configuration are seeded.
  const serviceName = "Corte QA G02-R";
  await sql.begin(async (tx) => {
    const [configured] = await tx`select id from catalog.services where business_id=${course.business_id} and name=${serviceName}`;
    if (configured) return;
    const [category] = await tx`insert into catalog.service_categories(business_id,name) values (${course.business_id},'Reservas G02-R') returning id`;
    const [service] = await tx`insert into catalog.services(business_id,name,category_id,publication,lifecycle) values (${course.business_id},${serviceName},${category.id},'PUBLISHED','ACTIVE') returning id`;
    const [terms] = await tx`insert into catalog.service_terms_versions(business_id,service_id,version_number,price_minor,currency,duration_minutes,pre_buffer_minutes,post_buffer_minutes,conditions,effective_from)
      values (${course.business_id},${service.id},1,10000,'ARS',30,0,0,'Condiciones de reserva QA',now()) returning id`;
    await tx`update catalog.services set current_terms_version_id=${terms.id} where id=${service.id}`;
    let [set] = await tx`select id from team.staff_service_sets where business_id=${course.business_id} and staff_member_id=${instructorId}`;
    if (!set) [set] = await tx`insert into team.staff_service_sets(business_id,staff_member_id) values (${course.business_id},${instructorId}) returning id`;
    await tx`insert into team.staff_service_assignments(business_id,staff_service_set_id,service_id) values (${course.business_id},${set.id},${service.id})`;
    let [schedule] = await tx`select id from team.staff_weekly_schedules where business_id=${course.business_id} and staff_member_id=${instructorId}`;
    if (!schedule) [schedule] = await tx`insert into team.staff_weekly_schedules(business_id,staff_member_id) values (${course.business_id},${instructorId}) returning id`;
    await tx`insert into team.staff_schedule_intervals(business_id,weekly_schedule_id,weekday,start_minute,end_minute)
      select ${course.business_id},${schedule.id},day,540,1080 from generate_series(1,7) day
      where not exists (select 1 from team.staff_schedule_intervals i where i.weekly_schedule_id=${schedule.id} and i.weekday=day)`;
    const [hours] = await tx`insert into business.business_hours_configs(business_id) values (${course.business_id}) returning id`;
    await tx`insert into business.business_hours_intervals(business_id,config_id,weekday,start_minute,end_minute)
      select ${course.business_id},${hours.id},day,540,1080 from generate_series(1,7) day`;
    const [policy] = await tx`insert into business.booking_policy_versions(business_id,version_number,public_booking_enabled,horizon_calendar_dates,min_lead_minutes,start_step_minutes,cancel_cutoff_minutes,reschedule_cutoff_minutes,created_by)
      values (${course.business_id},1,true,30,0,30,120,120,${course.created_by_account_id}) returning id`;
    await tx`insert into business.booking_policy_states(business_id,current_version_id) values (${course.business_id},${policy.id})`;
  });
  await visitor.reload();
  await visitor.getByRole("link", { name: "Reservar un turno en esta barbería" }).click();
  await expect(visitor.getByRole("heading", { name: "Reservar turno" })).toBeVisible();
  assert.equal(new URL(visitor.url()).searchParams.get("businessId"), course.business_id);
  await expect(visitor.getByText("Negocio (UUID)", { exact: true })).toHaveCount(0);
  evidence(["Q07-24"], { businessName: publicBusiness.name, publicSession: publicSessions[0], publicContact: phone, bookingLinkPreservesBusiness: true });
  await visitor.getByRole("checkbox", { name: new RegExp(serviceName) }).check();
  await visitor.locator("select").selectOption(instructorId);
  await visitor.locator('input[type="date"]').fill(occupied);
  const slotButton = (at) => visitor.getByRole("button", { name: "Horario " + at + " del " + occupied, exact: true });
  await expect(slotButton("11:30")).toBeVisible({ timeout: 15000 });
  await expect(slotButton("10:00")).toHaveCount(0);
  await expect(slotButton("10:30")).toHaveCount(0);
  const [bookableService] = await sql`select id from catalog.services where business_id=${course.business_id} and name=${serviceName}`;
  const occupiedQuote = await visitor.request.post(api + "/v1/public/businesses/" + course.business_id + "/booking-quotes", {
    data: { serviceIds: [bookableService.id], professionalPreference: { type: "SPECIFIC", staffMemberId: instructorId },
      localDate: occupied, visibleStart: "10:00" }
  });
  assert.equal(occupiedQuote.status(), 409);
  assert.match(JSON.stringify(await occupiedQuote.json()), /SLOT_CONFLICT|NO_AVAILABILITY/);
  evidence(["Q07-13"], { date: occupied, missingInUI: ["10:00", "10:30"], directQuoteResponse: 409 });
  await visitor.screenshot({ path: path.join(out, "08_SCREENSHOTS", "booking-course-conflict.png"), fullPage: true });
  await slotButton("11:30").click();
  const guestName = title + " invitado";
  await visitor.getByPlaceholder("Nombre").pressSequentially(guestName);
  await visitor.getByPlaceholder("Teléfono").pressSequentially("1155550142");
  await visitor.getByRole("button", { name: "Cotizar turno" }).click();
  const confirmed = visitor.waitForResponse((response) => response.url().endsWith("/reservations") && response.request().method() === "POST");
  await visitor.getByRole("button", { name: "Confirmar reserva" }).click();
  const confirmation = await confirmed;
  if (!confirmation.ok()) throw new Error("Reserva invitada HTTP " + confirmation.status() + ": " + (await confirmation.json()).error?.code);
  const { reservationId } = await confirmation.json();
  await expect(visitor.getByText(/Reserva confirmada/)).toBeVisible();
  const [booked] = await sql`select owner_type,status,staff_member_id,business_local_date::text from booking.reservations where id=${reservationId}`;
  assert.equal(booked.owner_type, "GUEST");
  assert.equal(booked.status, "CONFIRMED");
  assert.equal(booked.staff_member_id, instructorId);
  assert.equal(booked.business_local_date, occupied);
  await visitor.screenshot({ path: path.join(out, "08_SCREENSHOTS", "booking-confirmed-guest.png"), fullPage: true });
  phase = "Q07-12";
  const fetchReservation = () => sql`select r.status,r.revision,r.current_allocation_id,a.status::text allocation
    from booking.reservations r join availability.resource_allocations a on a.id=r.current_allocation_id where r.id=${reservationId}`;
  const [reservationBefore] = await fetchReservation();
  await page.getByLabel("Fecha local").fill(occupied);
  await page.getByLabel("Hora local").fill("11:30");
  await button("Programar sesión").click();
  await notice("Sesión programada");
  const cell = page.locator("li.record-row").filter({ hasText: occupied + " · 11:30" });
  const refused = page.waitForResponse((r) => r.url().endsWith("/confirm") && r.request().method() === "POST");
  await button("Confirmar", cell).click();
  const rejected = await refused;
  assert.equal(rejected.status(), 409);
  assert.match(JSON.stringify(await rejected.json()), /SLOT_CONFLICT/);
  const [reservationAfter] = await fetchReservation();
  assert.deepEqual(reservationAfter, reservationBefore);
  await button("Cancelar", cell).click();
  await notice("Sesión cancelada");
  evidence([phase], { reservationId, reservationPreserved: reservationAfter, courseConflict: 409 });
  phase = "reception-agenda";
  const reception = await browser.newPage({ locale: "es-AR", viewport: { width: 1440, height: 900 } });
  await reception.goto(base + "/login");
  await reception.getByLabel("Correo").pressSequentially("reception-qa@youngkingz.local");
  await reception.getByLabel("Contraseña").pressSequentially(process.env.G02_QA_PASSWORD);
  await reception.getByRole("button", { name: "Ingresar" }).click();
  await reception.waitForURL(/\/team|\/account/);
  await reception.getByRole("link", { name: "Agenda", exact: true }).click();
  await reception.getByText("Filtros de la agenda", { exact: true }).waitFor({ state: "hidden" });
  await reception.getByLabel("Hasta", { exact: true }).fill(occupied);
  await reception.getByLabel("Desde", { exact: true }).fill(occupied);
  await expect(reception.getByRole("region", { name: "Ocupación por cursos" }).getByText(edited)).toBeVisible();
  await reception.getByRole("button", { name: new RegExp("Abrir reserva de " + guestName) }).click();
  await expect(reception.getByRole("region", { name: "Detalle de la reserva" })).toBeVisible();
  await expect(reception.getByRole("button", { name: "Registrar llegada" })).toBeEnabled();
  await reception.screenshot({ path: path.join(out, "08_SCREENSHOTS", "reception-agenda-course.png"), fullPage: false });
  steps.push({ ids: [], status: "PASS", observed: { journey: "Reception Agenda shows the course, reservation and allowed arrival action", reservationId, courseDate: occupied } });
  phase = "guest-booking";
  await visitor.getByRole("button", { name: "Mostrar" }).click();
  const tokenSpan = visitor.locator("text=Token privado").locator("xpath=following::span[1]");
  await expect(tokenSpan).not.toHaveText(/^•+$/, { timeout: 10000 });
  const guestToken = (await tokenSpan.innerText()).trim();
  assert.ok(guestToken.length > 0, "UI no expuso el token de invitado tras Mostrar");
  const consultStatuses = [];
  visitor.on("response", (response) => {
    if (/\/v1\/public\/reservations\/[0-9a-f-]+$/.test(response.url())) consultStatuses.push(response.status());
  });
  await visitor.getByRole("link", { name: /Mis reservas/ }).click();
  await visitor.getByLabel("ID de la reserva").pressSequentially(reservationId, { delay: 2 });
  await visitor.getByLabel("Token de invitado").pressSequentially(guestToken, { delay: 2 });
  await expect(visitor.getByLabel("ID de la reserva")).toHaveValue(reservationId);
  await expect(visitor.getByLabel("Token de invitado")).toHaveValue(guestToken);
  await visitor.getByRole("button", { name: "Consultar reserva" }).click();
  try {
    await expect(visitor.getByRole("heading", { name: "Reserva " + reservationId })).toBeVisible({ timeout: 8000 });
  } catch (error) {
    const alertText = await visitor.locator('[role="alert"]').allInnerTexts();
    throw new Error(`${error.message} | consultStatuses=${JSON.stringify(consultStatuses)} tokenLength=${guestToken.length} tokenPrefix=${guestToken.slice(0, 4)} alerts=${JSON.stringify(alertText)}`);
  }
  await expect(visitor.getByText(/Estado:.*CONFIRMED/)).toBeVisible();
  steps.push({ ids: [], status: "PASS", observed: { journey: "Guest SPECIFIC", reservationId, booked, excluded: ["10:00", "10:30"], bookedTime: "11:30", consulted: true, tokenLength: guestToken.length, consultStatuses } });

  assert.equal((await reschedule(occupied, origin)).status(), 200);
  await notice("Sesión reprogramada");
  const availability = await browser.newPage();
  await availability.goto(base + "/reservar?businessId=" + course.business_id);
  await availability.getByRole("checkbox", { name: new RegExp(serviceName) }).check();
  await availability.locator("select").selectOption(instructorId);
  await availability.locator('input[type="date"]').fill(occupied);
  await expect(availability.getByRole("button", { name: "Horario 10:00 del " + occupied })).toBeVisible();
  await availability.close();
  await visitor.locator('input[type="date"]').fill(occupied);
  await visitor.locator('input[type="time"]').fill("10:00");
  await visitor.getByRole("button", { name: "Reprogramar" }).click();
  await expect(visitor.getByText("Reserva reprogramada.")).toBeVisible();
  await visitor.getByRole("button", { name: /Cancelar reserva/ }).click();
  await expect(visitor.getByText(/Estado:.*CANCELLED/)).toBeVisible();
  const [cancelledBooking] = await sql`select status, revision from booking.reservations where id=${reservationId}`;
  assert.equal(cancelledBooking.status, "CANCELLED");
  assert.ok(Number(cancelledBooking.revision) >= 3);
  steps.push({ ids: [], status: "PASS", observed: { journey: "Guest SPECIFIC", reservationId, courseMove: { from: occupied, to: origin }, reopened: "10:00", rescheduled: true, cancelledBooking } });

  phase = "authenticated-client-ANY";
  const serviceClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const clientFixture = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const phoneClient = "+54911" + randomInt(10000000, 99999999);
  const passwordClient = "QA-Cliente-" + crypto.randomUUID() + "!";
  const emailClient = crypto.randomUUID() + "@example.test";
  const created = await serviceClient.auth.admin.createUser({ phone: phoneClient, password: passwordClient, phone_confirm: true, email: emailClient, email_confirm: true });
  assert.ok(created.data.user, created.error?.message);
  await sql`insert into auth.users(id,email,phone) values (${created.data.user.id},${emailClient},${phoneClient}) on conflict (id) do nothing`;
  const signed = await clientFixture.auth.signInWithPassword({ phone: phoneClient, password: passwordClient });
  assert.ok(signed.data.session, signed.error?.message);
  const clientAuth = async (route, body) => {
    const { data } = await clientFixture.auth.getSession();
    const result = await fetch(api + "/v1/client-auth/" + route, {
      method: "POST", headers: { authorization: "Bearer " + data.session.access_token, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!result.ok) throw new Error("Client fixture " + route + " HTTP " + result.status);
    return result.json();
  };
  const clientIdentity = await clientAuth("bootstrap", { firstName: "Cliente", lastName: "QA G02" });
  const factor = await clientFixture.auth.mfa.enroll({ factorType: "totp", friendlyName: "Autenticador QA" });
  assert.ok(factor.data, factor.error?.message);
  const totp = () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const bits = [...factor.data.totp.secret.replace(/=+$/g, "").toUpperCase()].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
    const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const digest = createHmac("sha1", key).update(counter).digest();
    const offset = digest.at(-1) & 15;
    return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
  };
  const challenge = await clientFixture.auth.mfa.challenge({ factorId: factor.data.id });
  assert.ok(challenge.data, challenge.error?.message);
  const verified = await clientFixture.auth.mfa.verify({ factorId: factor.data.id, challengeId: challenge.data.id, code: totp() });
  assert.ok(verified.data, verified.error?.message);
  const batch = await clientAuth("recovery-codes/issue", { expectedRevision: clientIdentity.revision });
  await clientAuth("recovery-codes/ack", { batchVersion: batch.batchVersion, expectedRevision: batch.revision });

  const account = await browser.newPage({ locale: "es-AR", viewport: { width: 390, height: 844 } });
  await account.goto(base + "/cliente/ingresar");
  await account.getByLabel("Teléfono").fill(phoneClient);
  await account.getByLabel("Contraseña").pressSequentially(passwordClient);
  await account.getByRole("button", { name: "Ingresar" }).click();
  await account.waitForURL(/\/cliente\/seguridad\/verificar/);
  await account.getByLabel("Código de 6 dígitos").pressSequentially(totp());
  await account.getByRole("button", { name: "Verificar", exact: true }).click();
  await account.waitForURL(/\/cliente\/mis-cosas/);
  await account.goto(base + "/cursos/publicos");
  await account.getByRole("link", { name: publicBusiness.name, exact: true }).click();
  await account.getByRole("link", { name: "Reservar un turno en esta barbería" }).click();
  await expect(account.getByText(/datos verificados de tu cuenta/)).toBeVisible();
  await account.getByRole("checkbox", { name: new RegExp(serviceName) }).check();
  await expect(account.locator("select")).toHaveValue("ANY");
  await account.locator('input[type="date"]').fill(origin);
  await expect(account.getByRole("button", { name: "Horario 10:00 del " + origin, exact: true })).toHaveCount(0);
  await account.getByRole("button", { name: "Horario 12:30 del " + origin, exact: true }).click();
  await account.getByRole("button", { name: "Cotizar turno" }).click();
  const clientConfirm = account.waitForResponse((r) => r.url().endsWith("/v1/client/reservations") && r.request().method() === "POST");
  await account.getByRole("button", { name: "Confirmar reserva" }).click();
  const clientResponse = await clientConfirm;
  assert.ok(clientResponse.ok(), "Client reservation HTTP " + clientResponse.status());
  const clientBooking = await clientResponse.json();
  assert.equal(clientBooking.guestCredentialIssued, false);
  await expect(account.getByText("Reserva confirmada")).toBeVisible();
  await account.getByRole("link", { name: "Mis cosas" }).click();
  await account.getByRole("link", { name: "Mis reservas" }).click();
  const own = account.locator(".reservation-card").filter({ hasText: publicBusiness.name });
  await expect(own).toContainText("CONFIRMED");
  await account.screenshot({ path: path.join(out, "08_SCREENSHOTS", "client-account-reservation.png"), fullPage: false });
  await own.getByRole("button", { name: "Reprogramar" }).click();
  const rescheduleSlots = own.getByRole("group", { name: "Horarios disponibles" }).getByRole("button");
  await expect(rescheduleSlots.first()).toBeVisible({ timeout: 15000 });
  const chosenSlot = (await rescheduleSlots.first().innerText()).trim();
  await rescheduleSlots.first().click();
  await own.getByRole("button", { name: "Confirmar reprogramación" }).click();
  await expect(own).toContainText(chosenSlot);
  account.once("dialog", (dialog) => dialog.accept());
  await own.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(own).toContainText("CANCELLED");
  const [accountBooking] = await sql`select owner_type,owner_account_id,status,revision from booking.reservations where id=${clientBooking.reservationId}`;
  assert.equal(accountBooking.owner_type, "CLIENT");
  assert.equal(accountBooking.owner_account_id, clientIdentity.accountId);
  assert.equal(accountBooking.status, "CANCELLED");
  assert.ok(Number(accountBooking.revision) >= 3);
  steps.push({ ids: [], status: "PASS", observed: { journey: "Authenticated customer ANY", reservationId: clientBooking.reservationId, accountBooking, mfa: "real TOTP", guestCredentialIssued: false } });
  await account.close();

  phase = "Q07-22/Q07-23";
  const pastSlots = await sql`
    select to_char(day,'YYYY-MM-DD') d from generate_series(current_date-32, current_date-2, interval '1 day') day
    where not exists (select 1 from availability.resource_allocations a
      where a.business_id=${course.business_id} and a.staff_member_id=${instructorId} and a.released_at is null and a.local_date=day::date)
    order by day desc limit 2`;
  const [pastDate, unattendedDate] = pastSlots.map(({ d }) => d);
  const past = await schedule(pastDate);
  const unattended = await schedule(unattendedDate);
  for (const day of [pastDate, unattendedDate]) {
    await button("Confirmar", sessionRow(day)).click();
    await notice("Sesión confirmada");
  }
  const financialCounts = async () => {
    const [counts] = await sql`
      select (select count(*) from money.money_operations where business_id=${course.business_id}) money,
             (select count(*) from sales.sales where business_id=${course.business_id}) sales,
             (select count(*) from obligations.expense_obligations where business_id=${course.business_id}) obligations,
             (select count(*) from econ.settlements where business_id=${course.business_id}) settlements`;
    return counts;
  };
  const beforeCompletion = await financialCounts();
  await button("Registrar realización", sessionRow(pastDate)).click();
  await notice("Sesión registrada como realizada");
  await page.reload();
  await expect(sessionRow(pastDate)).toContainText("Realizada");
  await expect(sessionRow(unattendedDate)).toContainText("Confirmada");
  const [completedRow] = await sql`select status,completed_at,completed_by_account_id,occupied_end_at from courses.course_sessions where id=${past.id}`;
  const [unattendedRow] = await sql`select status,completed_at,occupied_end_at from courses.course_sessions where id=${unattended.id}`;
  assert.equal(completedRow.status, "COMPLETED");
  assert.ok(completedRow.completed_at > completedRow.occupied_end_at);
  assert.equal(completedRow.completed_by_account_id, course.created_by_account_id);
  assert.equal(unattendedRow.status, "CONFIRMED");
  assert.equal(unattendedRow.completed_at, null);
  assert.ok(unattendedRow.occupied_end_at.getTime() < Date.now());
  assert.deepEqual(await financialCounts(), beforeCompletion);
  evidence(["Q07-22", "QX-05"], { completedRow, unchangedFinancialCounts: beforeCompletion });
  evidence(["Q07-23"], unattendedRow);

  phase = "Q07-30";
  await expect(page.locator(".audit-list")).toContainText("COMPLETED");
  const eventsForCourse = await sql`select event_type from courses.course_events where course_id=${course.id}`;
  assert.ok(eventsForCourse.some((event) => event.event_type === "UPDATED"));
  evidence([phase], { courseEditsRecorded: true, sessionEventsShown: true, completedSession: past.id });
  const another = await schedule(target);
  await button("Confirmar", sessionRow(target).filter({ has: button("Confirmar") })).click();
  await notice("Sesión confirmada");
  phase = "Q07-03";
  await page.getByRole("link", { name: /Volver a Cursos/ }).click();
  await button("Despublicar", courseRow(edited)).click();
  await notice("Curso despublicado");
  assert.ok(!(await published()).courses.some((item) => item.id === course.id));
  const courseHistory = await sql`select event_type from courses.course_events where course_id=${course.id} order by created_at`;
  assert.deepEqual(courseHistory.map((event) => event.event_type), ["CREATED", "UPDATED", "PUBLISHED", "UNPUBLISHED"]);
  evidence([phase], { id: course.id, courseHistory, publicMatches: 0 });

  phase = "Q07-21";
  await button("Cancelar", courseRow(edited)).click();
  await notice("Curso cancelado");
  const [cancelled] = await sql`select c.status,s.status session_status,s.revision from courses.courses c join courses.course_sessions s on s.course_id=c.id where c.id=${course.id} and s.id=${second.id}`;
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.session_status, "CANCELLED");
  assert.ok(cancelled.revision > 1);
  assert.ok((await allocations(second.id)).every((allocation) => allocation.released_at));
  const [secondCancelled] = await sql`select status from courses.course_sessions where id=${another.id}`;
  assert.equal(secondCancelled.status, "CANCELLED");
  const releasedTwo = [...await allocations(second.id), ...await allocations(another.id)];
  assert.ok(releasedTwo.every((allocation) => allocation.released_at));
  evidence([phase], { ...cancelled, secondFutureSession: another.id, allocations: releasedTwo });
} catch (error) {
  steps.push({ ids: phase.startsWith("Q07-") ? phase.split("/") : [], status: "FAIL", observed: error.message });
  await page.screenshot({ path: path.join(out, "08_SCREENSHOTS", "course-lifecycle-failure.png"), fullPage: true });
} finally {
  fs.writeFileSync(file, JSON.stringify({ executedAt: new Date().toISOString(), steps }, null, 2));
  await sql.end();
  await browser.close();
}
if (steps.some(({ status }) => status === "FAIL")) process.exitCode = 1;
