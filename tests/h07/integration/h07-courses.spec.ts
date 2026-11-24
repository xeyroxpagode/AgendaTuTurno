import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "@youngkingz/contracts";
import { assertQaDatabase } from "../../support/h07-h08-seed";
import { authenticateQaActor, QA_EMAILS } from "../../support/h07-h08-auth";
import { createCourse, publishCourse, scheduleSession } from "../../../apps/api/src/modules/courses/commands";
import { confirmSession, cancelSession } from "../../../apps/api/src/modules/courses/session-commands";
import { getSession, publicCourses, getCourse } from "../../../apps/api/src/modules/courses/repository";
import { localDateTimeToInstant } from "../../../apps/api/src/modules/availability/temporal.js";
import { applyAbsence, approveAbsence, requestAbsence } from "../../../apps/api/src/modules/absence/commands.js";
import { listAbsenceConflicts } from "../../../apps/api/src/modules/absence/queries.js";

const B1 = "11111111-1111-4111-8111-111111111111";
const B2_STAFF = "bbbbbbb4-4444-4444-8444-444444444444";
const futureDate = () => new Date(Date.now() + (10 + Math.floor(Math.random() * 365)) * 86400000).toISOString().slice(0, 10);

describe("H07 · Courses sobre PostgreSQL QA real", () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!);
    await assertQaDatabase(sql);
  });
  afterAll(async () => { await sql?.end(); });

  it("ciclo completo: borrador -> publicar -> sesión -> confirmar -> cancelar, con identidad estable", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const barber = await authenticateQaActor(QA_EMAILS.barber);
    const created = await createCourse(owner, { title: `Curso QA ${randomUUID().slice(0, 8)}`, summary: "Resumen", contactChannel: "EMAIL", contactValue: "curso@qa.local" }, randomUUID());
    const courseId = created.data.id;
    expect(created.data.status).toBe("DRAFT");

    await publishCourse(owner, courseId, randomUUID());
    const scheduled = await scheduleSession(owner, { courseId, instructorStaffMemberId: barber.staffMemberId, localDate: futureDate(), localStart: "10:00", durationMinutes: 60 }, randomUUID());
    const sessionId = scheduled.data.id;
    expect(scheduled.data.status).toBe("SCHEDULED");

    const confirmed = await confirmSession(owner, { sessionId }, randomUUID());
    expect(confirmed.data.status).toBe("CONFIRMED");
    const [allocation] = await sql`select source_type "sourceType" from availability.resource_allocations where source_id=${sessionId}`;
    expect(allocation?.sourceType).toBe("COURSE_SESSION");

    const cancelled = await cancelSession(owner, { sessionId }, randomUUID());
    expect(cancelled.data.status).toBe("CANCELLED");
    const current = await getSession(B1, sessionId);
    expect(String(current?.id)).toBe(sessionId);
    const [active] = await sql`select id from availability.resource_allocations where source_id=${sessionId} and status='ACTIVE'`;
    expect(active).toBeUndefined();
  });

  it("publicación oculta borradores", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const draft = await createCourse(owner, { title: `Borrador QA ${randomUUID().slice(0, 8)}` }, randomUUID());
    const published = await createCourse(owner, { title: `Publicado QA ${randomUUID().slice(0, 8)}` }, randomUUID());
    await publishCourse(owner, published.data.id, randomUUID());
    const publicData = await publicCourses(B1);
    expect(publicData.courses.some((course) => course.id === draft.data.id)).toBe(false);
    expect(publicData.courses.some((course) => course.id === published.data.id)).toBe(true);
  });

  it("rechaza instructor de otro Business", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const created = await createCourse(owner, { title: `Curso cross QA ${randomUUID().slice(0, 8)}` }, randomUUID());
    await expect(scheduleSession(owner, {
      courseId: created.data.id, instructorStaffMemberId: B2_STAFF,
      localDate: futureDate(), localStart: "11:00", durationMinutes: 60
    }, randomUUID())).rejects.toMatchObject({ code: "INSTRUCTOR_NOT_ELIGIBLE" });
  });

  it("Q07-07: an unknown instructor cannot create a session", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const { data: course } = await createCourse(owner, { title: `Curso instructor QA ${randomUUID()}` }, randomUUID());
    await expect(scheduleSession(owner, {
      courseId: course.id, instructorStaffMemberId: randomUUID(),
      localDate: futureDate(), localStart: "11:00", durationMinutes: 60
    }, randomUUID())).rejects.toMatchObject({ code: "INSTRUCTOR_NOT_ELIGIBLE" });
    expect(await sql`select id from courses.course_sessions where course_id=${course.id}`).toHaveLength(0);
  });

  it("actor de otro Business NO ve cursos de B1", async () => {
    const actorB2 = await authenticateQaActor(QA_EMAILS.ownerB2);
    expect(actorB2.businessId).toBe("22222222-2222-4222-8222-222222222222");
    expect(await getCourse(actorB2.businessId, "00000000-0000-4000-8000-000000000001")).toBeUndefined();
  });

  it("DST: hora inexistente/ambigua se rechaza en zona que sí usa DST", () => {
    expect(() => localDateTimeToInstant("2026-03-08", 150, "America/New_York")).toThrow(DomainError);
    expect(() => localDateTimeToInstant("2026-11-01", 90, "America/New_York")).toThrow(DomainError);
  });

  it("Q07-09: exact midnight ends the operational day without inventing a local instant", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const barber = await authenticateQaActor(QA_EMAILS.barber);
    const localDate = futureDate();
    const course = await createCourse(owner, { title: `Límite de fecha QA ${randomUUID()}` }, randomUUID());
    const input = { courseId: course.data.id, instructorStaffMemberId: barber.staffMemberId, localDate, localStart: "23:30" };
    const ended = await scheduleSession(owner, { ...input, durationMinutes: 30 }, randomUUID());
    const [row] = await sql`select timezone,local_date::text,
      to_char(occupied_start_at at time zone timezone,'HH24:MI') local_start,
      to_char(occupied_end_at at time zone timezone,'HH24:MI') local_end,
      (occupied_end_at at time zone timezone)::date=local_date+1 day_advanced,
      extract(epoch from occupied_end_at-occupied_start_at)::int seconds
      from courses.course_sessions where id=${ended.data.id}`;
    expect(row).toMatchObject({ timezone: "America/Argentina/Buenos_Aires", local_date: localDate,
      local_start: "23:30", local_end: "00:00", day_advanced: true, seconds: 1800 });
    await expect(scheduleSession(owner, { ...input, durationMinutes: 45 }, randomUUID()))
      .rejects.toMatchObject({ code: "INVALID_INTERVAL" });
    expect(await sql`select id from courses.course_sessions where course_id=${course.data.id}`).toHaveLength(1);
  });

  it("NEW-04: real DST gap and fold are rejected by the scheduling command", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.ownerB2);
    const previous = await sql`select timezone from business.businesses where id=${owner.businessId}`;
    await sql`update business.businesses set timezone='America/New_York' where id=${owner.businessId}`;
    await sql`insert into team.professional_profiles(business_id,staff_member_id,professional_display_name,status)
      values (${owner.businessId},${owner.staffMemberId},'Instructor DST QA','ACTIVE') on conflict do nothing`;
    try {
      const course = await createCourse(owner, { title: `Curso DST QA ${randomUUID()}` }, randomUUID());
      for (const [localDate, localStart] of [["2027-03-14", "02:30"], ["2027-11-07", "01:30"]]) {
        await expect(scheduleSession(owner, { courseId: course.data.id, instructorStaffMemberId: owner.staffMemberId,
          localDate, localStart, durationMinutes: 45 }, randomUUID())).rejects.toMatchObject({ code: "TIMEZONE_AMBIGUOUS", statusCode: 409 });
      }
      expect(await sql`select id from courses.course_sessions where course_id=${course.data.id}`).toHaveLength(0);
      expect(await sql`select id from availability.resource_allocations where business_id=${owner.businessId}
        and source_type='COURSE_SESSION' and local_date in ('2027-03-14','2027-11-07')`).toHaveLength(0);
    } finally {
      await sql`update business.businesses set timezone=${previous[0]!.timezone} where id=${owner.businessId}`;
    }
  });

  it("NEW-02: an approved absence preserves an existing course and reports the conflict", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const barber = await authenticateQaActor(QA_EMAILS.barber);
    const [free] = await sql`select to_char(day,'YYYY-MM-DD') date from generate_series(current_date+2,current_date+28,interval '1 day') day
      where not exists (select 1 from availability.resource_allocations a where a.staff_member_id=${barber.staffMemberId}
        and a.local_date=day::date and a.status='ACTIVE')
      and not exists (select 1 from team.staff_effective_unavailability e where e.staff_member_id=${barber.staffMemberId}
        and e.local_date=day::date and e.released_at is null) order by day desc limit 1`;
    const course = await createCourse(owner, { title: `Curso ausencia existente QA ${randomUUID()}` }, randomUUID());
    const session = await scheduleSession(owner, { courseId: course.data.id, instructorStaffMemberId: barber.staffMemberId,
      localDate: free!.date, localStart: "16:00", durationMinutes: 60 }, randomUUID());
    await confirmSession(owner, { sessionId: session.data.id }, randomUUID());
    const requested = await requestAbsence({ actor: owner, staffMemberId: barber.staffMemberId, localDate: free!.date,
      startMinute: 960, endMinute: 1020, reason: "Prueba QA de conflicto", operationId: randomUUID() });
    const approved = await approveAbsence({ actor: owner, absenceId: requested.absenceId, expectedRevision: requested.revision, operationId: randomUUID() });
    await expect(applyAbsence({ actor: owner, absenceId: approved.absenceId, expectedRevision: approved.revision, operationId: randomUUID() }))
      .rejects.toMatchObject({ code: "AVAILABILITY_IMPACT_CONFLICT", details: { conflictingCourseSessions: [session.data.id] } });
    expect(await listAbsenceConflicts(owner, approved.absenceId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ courseId: course.data.id, status: "CONFIRMED", conflictStatus: "OPEN" })
    ]));
    expect(await sql`select id from availability.resource_allocations where source_id=${session.data.id} and status='ACTIVE'`).toHaveLength(1);
    await cancelSession(owner, { sessionId: session.data.id }, randomUUID());
    expect((await applyAbsence({ actor: owner, absenceId: approved.absenceId,
      expectedRevision: approved.revision, operationId: randomUUID() })).status).toBe("APPLIED");
  });

  it("ausencia efectiva solapada bloquea la confirmación (matriz única)", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const barber = await authenticateQaActor(QA_EMAILS.barber);
    const created = await createCourse(owner, { title: `Curso ausencia QA ${randomUUID().slice(0, 8)}` }, randomUUID());
    const date = futureDate();
    const scheduled = await scheduleSession(owner, { courseId: created.data.id, instructorStaffMemberId: barber.staffMemberId, localDate: date, localStart: "15:00", durationMinutes: 60 }, randomUUID());
    await sql`insert into team.staff_effective_unavailability(business_id,staff_member_id,source_type,source_id,local_date,start_minute,end_minute)
      values (${B1},${barber.staffMemberId},'OPERATIONAL_BLOCK',${randomUUID()},${date},900,1000)`;
    try {
      await expect(confirmSession(owner, { sessionId: scheduled.data.id }, randomUUID())).rejects.toMatchObject({ code: "AVAILABILITY_IMPACT_CONFLICT" });
    } finally {
      await sql`delete from team.staff_effective_unavailability where business_id=${B1} and staff_member_id=${barber.staffMemberId} and local_date=${date} and start_minute=900`;
    }
  });

  it("Q07-14: dos cursos confirman el mismo horario, un ganador y un SLOT_CONFLICT", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const barber = await authenticateQaActor(QA_EMAILS.barber);
    const created = await createCourse(owner, { title: `Curso concurrencia QA ${randomUUID().slice(0, 8)}` }, randomUUID());
    const competing = await createCourse(owner, { title: `Curso concurrencia QA ${randomUUID().slice(0, 8)}` }, randomUUID());
    const date = futureDate();
    const first = await scheduleSession(owner, { courseId: created.data.id, instructorStaffMemberId: barber.staffMemberId, localDate: date, localStart: "17:00", durationMinutes: 60 }, randomUUID());
    const second = await scheduleSession(owner, { courseId: competing.data.id, instructorStaffMemberId: barber.staffMemberId, localDate: date, localStart: "17:00", durationMinutes: 60 }, randomUUID());
    const results = await Promise.allSettled([
      confirmSession(owner, { sessionId: first.data.id }, randomUUID()),
      confirmSession(owner, { sessionId: second.data.id }, randomUUID())
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.some((result) => result.status === "rejected" && (result.reason as DomainError).code === "SLOT_CONFLICT")).toBe(true);
    const allocations = await sql`select id from availability.resource_allocations where source_id in (${first.data.id},${second.data.id}) and status='ACTIVE'`;
    expect(allocations).toHaveLength(1);
  });

  it("Q07-15: replay concurrente de una confirmación crea una sola ocupación", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const barber = await authenticateQaActor(QA_EMAILS.barber);
    const { data: course } = await createCourse(owner, { title: `Confirmación QA ${randomUUID()}` }, randomUUID());
    const date = futureDate();
    const { data: session } = await scheduleSession(owner, {
      courseId: course.id, instructorStaffMemberId: barber.staffMemberId,
      localDate: date, localStart: "16:00", durationMinutes: 15
    }, randomUUID());
    const operationId = randomUUID();
    const results = await Promise.all([
      confirmSession(owner, { sessionId: session.id }, operationId),
      confirmSession(owner, { sessionId: session.id }, operationId)
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]?.data).toEqual(results[1]?.data);
    expect(await sql`select id from availability.resource_allocations where source_id=${session.id} and status='ACTIVE'`).toHaveLength(1);
    expect(await sql`select id from courses.course_session_events where session_id=${session.id} and event_type='CONFIRMED'`).toHaveLength(1);
  });
});
