/**
 * H03.U06 · Concurrencia e idempotencia — integración contra PostgreSQL real.
 *
 * Estas pruebas ejecutan operaciones REALES simultáneas sobre la misma base y
 * comprueban el invariante que las hace seguras: nunca hay doble ocupación y
 * nunca quedan estados incompatibles.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { database } from "../../../apps/api/src/lib/runtime";
import { roleCapabilities } from "@youngkingz/contracts";
import { approveAbsence, applyAbsence, requestAbsence } from "../../../apps/api/src/modules/absence/commands";
import { registerAttendance } from "../../../apps/api/src/modules/attendance/commands";
import { registerStaffArrival } from "../../../apps/api/src/modules/booking/commands/arrival";
import { createStaffReservation } from "../../../apps/api/src/modules/booking/commands/staff-create";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization";
import {
  ABSENCE_DATE_2, destroyStaffAgendaBusiness, seedLocalReservation,
  seedStaffAgendaBusiness, type StaffAgendaSeed
} from "./absence-fixtures";

let seed: StaffAgendaSeed;

beforeAll(async () => {
  seed = await seedStaffAgendaBusiness("U06 Concurrencia");
});

afterAll(async () => {
  await destroyStaffAgendaBusiness(seed);
});

const actorFor = (role: "OWNER" | "RECEPTIONIST" | "BARBER"): Actor => ({
  accountId: role === "OWNER" ? seed.ownerAccount : role === "RECEPTIONIST" ? seed.receptionistAccount : seed.barberAccount,
  personId: "", businessId: seed.business,
  staffMemberId: role === "OWNER" ? seed.ownerStaff : role === "RECEPTIONIST" ? seed.receptionistStaff : seed.barberStaff,
  accessSessionId: "", roleAssignmentId: "", role,
  contextRevision: 1, capabilities: new Set(roleCapabilities[role]), email: ""
});

describe("H03.U06 · concurrencia", () => {
  it("IT-CON-01 · dos llegadas simultáneas producen un solo evento y la misma marca", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2, startMinute: 60 });

    const [first, second] = await Promise.allSettled([
      registerStaffArrival({
        businessId: seed.business, actorAccountId: seed.barberAccount, actorStaffMemberId: seed.barberStaff,
        reservationId: reservation.reservationId, expectedRevision: 1, selfScopeOnly: true, operationId: randomUUID()
      }),
      registerStaffArrival({
        businessId: seed.business, actorAccountId: seed.barberAccount, actorStaffMemberId: seed.barberStaff,
        reservationId: reservation.reservationId, expectedRevision: 1, selfScopeOnly: true, operationId: randomUUID()
      })
    ]);

    const fulfilled = [first, second].filter((item) => item.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const events = await database.client`
      select count(*)::int c from booking.reservation_events where reservation_id=${reservation.reservationId} and event_type='ARRIVAL_REGISTERED'`;
    expect(Number(events[0]!.c)).toBe(1);

    const [row] = await database.client`select revision::int revision from booking.reservations where id=${reservation.reservationId}`;
    expect(Number(row!.revision)).toBe(2);
  });

  it("IT-CON-02 · dos atenciones simultáneas para la misma reserva: sólo una gana", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2, startMinute: 120 });

    const results = await Promise.allSettled([
      registerAttendance({
        actor: actorFor("BARBER"), reservationId: reservation.reservationId,
        servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 30 }], status: "COMPLETED",
        operationId: randomUUID()
      }),
      registerAttendance({
        actor: actorFor("BARBER"), reservationId: reservation.reservationId,
        servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 30 }], status: "COMPLETED",
        operationId: randomUUID()
      })
    ]);

    const fulfilled = results.filter((item) => item.status === "fulfilled");
    expect(fulfilled.length).toBe(1);
    const rejected = results.filter((item) => item.status === "rejected");
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });

    const rows = await database.client`select count(*)::int c from attendance.attendances where reservation_id=${reservation.reservationId}`;
    expect(Number(rows[0]!.c)).toBe(1);
  });

  it("IT-CON-03 · aplicar una ausencia y crear una reserva simultáneas no producen doble ocupación", async () => {
    const date = "2026-12-23";
    const created = await requestAbsence({
      actor: actorFor("OWNER"), staffMemberId: seed.barberStaff, localDate: date,
      startMinute: 480, endMinute: 720, reason: "Ausencia concurrente", operationId: randomUUID()
    });
    await approveAbsence({ actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 1, operationId: randomUUID() });

    const [applied, booked] = await Promise.allSettled([
      applyAbsence({ actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 2, operationId: randomUUID() }),
      createStaffReservation({
        businessId: seed.business, actorAccountId: seed.receptionistAccount,
        serviceIds: [seed.serviceCut], localDate: date, visibleStart: "09:00",
        professionalPreference: { type: "SPECIFIC", staffMemberId: seed.barberStaff },
        contact: { name: "Cliente Concurrente", phone: "1177770001" },
        reason: "Reserva concurrente", operationId: randomUUID()
      })
    ]);

    const appliedOk = applied.status === "fulfilled";
    const bookedOk = booked.status === "fulfilled";
    // Exactamente una de las dos operaciones puede prosperar: ambas compiten
    // por el mismo `lockAvailabilityGuard`.
    expect([appliedOk, bookedOk].filter(Boolean)).toHaveLength(1);

    const [absenceRow] = await database.client`select status::text status from absence.absence_requests where id=${created.absenceId}`;
    const allocations = await database.client`
      select count(*)::int c from availability.resource_allocations
       where business_id=${seed.business} and staff_member_id=${seed.barberStaff} and local_date=${date} and status='ACTIVE'`;

    if (appliedOk) {
      expect(absenceRow!.status).toBe("APPLIED");
      // La ausencia aplicada no deja ninguna ocupación activa en su intervalo.
      expect(Number(allocations[0]!.c)).toBe(0);
      const unavailability = await database.client`
        select count(*)::int c from team.staff_effective_unavailability
         where business_id=${seed.business} and staff_member_id=${seed.barberStaff} and local_date=${date} and released_at is null`;
      expect(Number(unavailability[0]!.c)).toBe(1);
    } else {
      expect(absenceRow!.status).toBe("APPROVED");
      expect(Number(allocations[0]!.c)).toBe(1);
      const unavailability = await database.client`
        select count(*)::int c from team.staff_effective_unavailability
         where business_id=${seed.business} and staff_member_id=${seed.barberStaff} and local_date=${date} and released_at is null`;
      expect(Number(unavailability[0]!.c)).toBe(0);
    }
  });

  it("dos aplicaciones simultáneas de la misma ausencia: sólo una gana", async () => {
    const date = "2026-12-30";
    const created = await requestAbsence({
      actor: actorFor("OWNER"), staffMemberId: seed.ownerStaff, localDate: date,
      startMinute: 480, endMinute: 600, reason: "Doble aplicación", operationId: randomUUID()
    });
    await approveAbsence({ actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 1, operationId: randomUUID() });

    const results = await Promise.allSettled([
      applyAbsence({ actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 2, operationId: randomUUID() }),
      applyAbsence({ actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 2, operationId: randomUUID() })
    ]);
    const fulfilled = results.filter((item) => item.status === "fulfilled");
    expect(fulfilled.length).toBe(1);

    const [row] = await database.client`select status::text status, revision::int revision from absence.absence_requests where id=${created.absenceId}`;
    expect(row!.status).toBe("APPLIED");
    expect(Number(row!.revision)).toBe(3);

    const unavailability = await database.client`
      select count(*)::int c from team.staff_effective_unavailability
       where business_id=${seed.business} and staff_member_id=${seed.ownerStaff} and local_date=${date} and released_at is null`;
    expect(Number(unavailability[0]!.c)).toBe(1);
  });
});
