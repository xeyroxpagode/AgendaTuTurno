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

  it("actor de otro Business NO ve cursos de B1", async () => {
    const actorB2 = await authenticateQaActor(QA_EMAILS.ownerB2);
    expect(actorB2.businessId).toBe("22222222-2222-4222-8222-222222222222");
    expect(await getCourse(actorB2.businessId, "00000000-0000-4000-8000-000000000001")).toBeUndefined();
  });

  it("DST: hora inexistente/ambigua se rechaza en zona que sí usa DST", () => {
    expect(() => localDateTimeToInstant("2026-03-08", 150, "America/New_York")).toThrow(DomainError);
    expect(() => localDateTimeToInstant("2026-11-01", 90, "America/New_York")).toThrow(DomainError);
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

  it("dos confirmaciones concurrentes con solape total: un ganador y un SLOT_CONFLICT", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const barber = await authenticateQaActor(QA_EMAILS.barber);
    const created = await createCourse(owner, { title: `Curso concurrencia QA ${randomUUID().slice(0, 8)}` }, randomUUID());
    const date = futureDate();
    const first = await scheduleSession(owner, { courseId: created.data.id, instructorStaffMemberId: barber.staffMemberId, localDate: date, localStart: "08:00", durationMinutes: 60 }, randomUUID());
    const second = await scheduleSession(owner, { courseId: created.data.id, instructorStaffMemberId: barber.staffMemberId, localDate: date, localStart: "08:00", durationMinutes: 60 }, randomUUID());
    const results = await Promise.allSettled([
      confirmSession(owner, { sessionId: first.data.id }, randomUUID()),
      confirmSession(owner, { sessionId: second.data.id }, randomUUID())
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.some((result) => result.status === "rejected" && (result.reason as DomainError).code === "SLOT_CONFLICT")).toBe(true);
  });
});
