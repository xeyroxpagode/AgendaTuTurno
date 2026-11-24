import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "@youngkingz/contracts";
import { assertQaDatabase } from "../../support/h07-h08-seed";
import { authenticateQaActor, QA_EMAILS } from "../../support/h07-h08-auth";
import { createCourse, scheduleSession } from "../../../apps/api/src/modules/courses/commands.js";
import { cancelSession, confirmSession, rescheduleSession } from "../../../apps/api/src/modules/courses/session-commands.js";
import { assertInstructorEligible, eligibleInstructors } from "../../../apps/api/src/modules/courses/domain.js";
import { claimCourseSession } from "../../../apps/api/src/modules/courses/claim.js";
import { translateAllocationError } from "../../../apps/api/src/modules/availability/allocation.js";
import { getSession } from "../../../apps/api/src/modules/courses/repository.js";

const B1 = "11111111-1111-4111-8111-111111111111";
const futureDate = () => new Date(Date.now() + (10 + Math.floor(Math.random() * 300)) * 86400000).toISOString().slice(0, 10);

describe("H07 — regresiones de revisión independiente y oráculos NEW", () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!);
    await assertQaDatabase(sql);
  });
  afterAll(async () => { await sql?.end(); });

  it("P1 revisión: el selector expone exactamente los instructores que el backend acepta", async () => {
    const instructor = await authenticateQaActor(QA_EMAILS.barber);
    const staffId = instructor.staffMemberId;
    const listed = await eligibleInstructors(B1);
    expect(listed.some((item) => item.staffMemberId === staffId)).toBe(true);
    await sql.begin(async (tx) => {
      for (const item of listed) await expect(assertInstructorEligible(tx as never, B1, item.staffMemberId)).resolves.toBeUndefined();
    });
    await expect(assertInstructorEligible(sql as never, B1, randomUUID())).rejects.toMatchObject({ code: "INSTRUCTOR_NOT_ELIGIBLE" });

    // El caso que fallaba: BARBER con rol pero SIN perfil profesional. El
    // backend lo acepta; el antiguo selector (/v1/professionals) lo ocultaba.
    await sql`delete from team.professional_profiles where business_id=${B1} and staff_member_id=${staffId}`;
    try {
      expect((await eligibleInstructors(B1)).some((item) => item.staffMemberId === staffId)).toBe(true);
      await expect(assertInstructorEligible(sql as never, B1, staffId)).resolves.toBeUndefined();
    } finally {
      await sql`insert into team.professional_profiles(business_id,staff_member_id,professional_display_name,status)
        values (${B1},${staffId},'Barbero QA','ACTIVE') on conflict do nothing`;
    }

    // Y el inverso: access_status SUSPENDED debe desaparecer del selector y ser rechazado.
    await sql`update team.staff_members set access_status='SUSPENDED' where business_id=${B1} and id=${staffId}`;
    try {
      expect((await eligibleInstructors(B1)).some((item) => item.staffMemberId === staffId)).toBe(false);
      await expect(assertInstructorEligible(sql as never, B1, staffId)).rejects.toMatchObject({ code: "INSTRUCTOR_NOT_ELIGIBLE" });
    } finally {
      await sql`update team.staff_members set access_status='ACTIVE' where business_id=${B1} and id=${staffId}`;
    }
  });

  it("NEW-09: duración inválida y SQL 22000/23514 se traducen a INVALID_INTERVAL", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const barber = await authenticateQaActor(QA_EMAILS.barber);
    const { data: course } = await createCourse(owner, { title: `Duración inválida QA ${randomUUID()}` }, randomUUID());
    const base = { courseId: course.id, instructorStaffMemberId: barber.staffMemberId, localDate: futureDate() };
    for (const durationMinutes of [0, -1, 1441]) {
      await expect(scheduleSession(owner, { ...base, localStart: "10:00", durationMinutes }, randomUUID()))
        .rejects.toThrow();
    }
    expect(await sql`select id from courses.course_sessions where course_id=${course.id}`).toEqual([]);
    for (const code of ["22000", "23514"]) {
      expect(() => translateAllocationError({ code })).toThrow(DomainError);
      try { translateAllocationError({ code }); } catch (error) {
        expect((error as DomainError).code).toBe("INVALID_INTERVAL");
      }
    }
  });

  it("NEW-11: una sesión CONFIRMED sin allocation activa es rechazada por trigger", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const barber = await authenticateQaActor(QA_EMAILS.barber);
    const { data: course } = await createCourse(owner, { title: `Integridad QA ${randomUUID()}` }, randomUUID());
    const { data: session } = await scheduleSession(owner, {
      courseId: course.id, instructorStaffMemberId: barber.staffMemberId,
      localDate: futureDate(), localStart: "18:00", durationMinutes: 60
    }, randomUUID());
    await expect(sql.begin(async (tx) => {
      await tx`update courses.course_sessions set status='CONFIRMED' where id=${session.id}`;
    })).rejects.toMatchObject({ code: "23514" });
    const [row] = await sql`select status from courses.course_sessions where id=${session.id}`;
    expect(row.status).toBe("SCHEDULED");
  });

  it("NEW-12/P2: claimCourseSession no crea requirements de reserva", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const barber = await authenticateQaActor(QA_EMAILS.barber);
    const { data: course } = await createCourse(owner, { title: `Claim propio QA ${randomUUID()}` }, randomUUID());
    const date = futureDate();
    const { data: session } = await scheduleSession(owner, {
      courseId: course.id, instructorStaffMemberId: barber.staffMemberId,
      localDate: date, localStart: "16:00", durationMinutes: 60
    }, randomUUID());
    const claimed = await sql.begin(async (tx) => {
      const result = await claimCourseSession(tx as never, owner, {
        businessId: B1, sessionId: session.id, instructorStaffMemberId: barber.staffMemberId,
        localDate: date, startMinute: 16 * 60, durationMinutes: 60
      });
      // La integridad Sesión↔Allocation es DIFERIDA: el estado CONFIRMED se
      // escribe en la misma transacción, como hace confirmSession.
      await tx`update courses.course_sessions set status='CONFIRMED' where id=${session.id}`;
      return result;
    });
    const requirements = await sql`
      select ar.id from availability.allocation_service_requirements ar
      where ar.business_id=${B1} and ar.allocation_id=${claimed.allocationId}`;
    expect(requirements).toEqual([]);
  });

  it("P2 revisión: replay de reschedule devuelve el estado actual, no el cacheado", async () => {
    const owner = await authenticateQaActor(QA_EMAILS.owner);
    const barber = await authenticateQaActor(QA_EMAILS.barber);
    const { data: course } = await createCourse(owner, { title: `Replay QA ${randomUUID()}` }, randomUUID());
    const date = futureDate();
    const { data: session } = await scheduleSession(owner, {
      courseId: course.id, instructorStaffMemberId: barber.staffMemberId,
      localDate: date, localStart: "15:00", durationMinutes: 60
    }, randomUUID());
    await confirmSession(owner, { sessionId: session.id }, randomUUID());
    const current = await getSession(B1, session.id);
    const input = { sessionId: session.id, localDate: date, localStart: "16:00", durationMinutes: 60, revision: Number(current.revision) };
    const operationId = randomUUID();
    const first = await rescheduleSession(owner, input, operationId);
    // Mutación posterior con distinta autoría: el replay NO debe devolver el
    // estado cacheado RESCHEDULED, sino el estado real CANCELLED.
    await cancelSession(owner, { sessionId: session.id }, randomUUID());
    const replay = await rescheduleSession(owner, input, operationId);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe("CANCELLED");
    expect(replay.status).toBe(replay.currentStatus);
    expect(replay.revision).toBe(replay.currentRevision);
  });
});
