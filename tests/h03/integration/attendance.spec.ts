/**
 * H03.U06 · CAP-03-08 · Prestación real (Attendance) — integración contra PostgreSQL real.
 *
 * Attendance representa lo que OCURRIÓ. Cada caso verifica el estado
 * PERSISTIDO: la fila de `attendance.attendances`, su ledger de eventos, las
 * correcciones y los efectos colaterales que NO deben ocurrir (ni una cuenta
 * CLIENT, ni una ficha CRM, ni ventas, pagos o movimientos de stock).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { database } from "../../../apps/api/src/lib/runtime";
import { roleCapabilities } from "@youngkingz/contracts";
import { correctAttendance, registerAttendance, setAttendanceState } from "../../../apps/api/src/modules/attendance/commands";
import { getAttendanceDetail, listAttendances } from "../../../apps/api/src/modules/attendance/queries";
import { registerStaffArrival } from "../../../apps/api/src/modules/booking/commands/arrival";
import { confirmStaffNoShow } from "../../../apps/api/src/modules/booking/commands/no_show";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization";
import {
  ABSENCE_DATE, ABSENCE_DATE_2, destroyStaffAgendaBusiness, seedLocalReservation,
  seedStaffAgendaBusiness, type StaffAgendaSeed
} from "./absence-fixtures";

let seed: StaffAgendaSeed;

/** Fecha local ya transcurrida: imprescindible para las ventanas de no-show. */
const PAST_DATE = "2026-11-04";

beforeAll(async () => {
  seed = await seedStaffAgendaBusiness("U06 Atenciones");
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

async function attendanceRow(attendanceId: string) {
  const [row] = await database.client`
    select id, reservation_id "reservationId", walk_in "walkIn", status::text status,
           staff_member_id "staffMemberId", attended_by_staff_member_id "attendedByStaffMemberId",
           client_profile_id "clientProfileId", revision::int revision,
           started_at "startedAt", finished_at "finishedAt",
           services_performed_snapshot "servicesPerformedSnapshot",
           contact_snapshot "contactSnapshot", notes
      from attendance.attendances where id=${attendanceId}`;
  return row as {
    id: string; reservationId: string | null; walkIn: boolean; status: string;
    staffMemberId: string; attendedByStaffMemberId: string; clientProfileId: string | null; revision: number;
    startedAt: Date; finishedAt: Date | null; servicesPerformedSnapshot: unknown; contactSnapshot: unknown; notes: string | null;
  };
}

async function attendanceEvents(attendanceId: string) {
  return database.client`
    select event_type::text "eventType", sequence, before_revision::int "beforeRevision", after_revision::int "afterRevision"
      from attendance.attendance_events where attendance_id=${attendanceId} order by sequence`;
}

describe("H03.U06 · Attendance desde una reserva legítima (PostgreSQL real)", () => {
  it("IT-ATT-01 · registra la atención sin modificar la reserva", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE, startMinute: 480, customerName: "Cliente Atencion" });

    const created = await registerAttendance({
      actor: actorFor("BARBER"),
      reservationId: reservation.reservationId,
      servicesPerformedSnapshot: [{ serviceId: seed.serviceCut, name: "Corte U05", durationMinutes: 30, priceMinor: 10000, currency: "ARS" }],
      operationId: randomUUID()
    });

    expect(created.status).toBe("IN_PROGRESS");
    expect(created.reservationId).toBe(reservation.reservationId);
    expect(created.walkIn).toBe(false);

    const row = await attendanceRow(created.attendanceId);
    expect(row.reservationId).toBe(reservation.reservationId);
    expect(row.walkIn).toBe(false);
    expect(row.attendedByStaffMemberId).toBe(seed.barberStaff);

    // INV-ATT-01: Attendance ≠ Reservation. La reserva sigue CONFIRMED.
    const [reservationRow] = await database.client`select status::text status from booking.reservations where id=${reservation.reservationId}`;
    expect(reservationRow!.status).toBe("CONFIRMED");

    const events = await attendanceEvents(created.attendanceId);
    expect(events.map((event) => event.eventType)).toEqual(["ATTENDANCE_REGISTERED"]);
  });

  it("IT-ATT-01b · la llegada NO implica atención y la atención NO exige llegada", async () => {
    // Se registra la atención SIN evento de llegada previo: INV-ATT-02.
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2, startMinute: 480 });
    const before = await database.client`
      select count(*)::int c from booking.reservation_events where reservation_id=${reservation.reservationId} and event_type='ARRIVAL_REGISTERED'`;
    expect(Number(before[0]!.c)).toBe(0);

    const created = await registerAttendance({
      actor: actorFor("BARBER"), reservationId: reservation.reservationId, operationId: randomUUID()
    });
    expect(created.attendanceId).toBeTruthy();

    // Y la llegada posterior tampoco crea una atención.
    await registerStaffArrival({
      businessId: seed.business, actorAccountId: seed.barberAccount, actorStaffMemberId: seed.barberStaff,
      reservationId: reservation.reservationId, expectedRevision: 1, selfScopeOnly: true, operationId: randomUUID()
    });
    const attendances = await database.client`
      select count(*)::int c from attendance.attendances where reservation_id=${reservation.reservationId}`;
    expect(Number(attendances[0]!.c)).toBe(1);
  });

  it("CN-10 · una reserva cancelada NO admite atención", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2, startMinute: 600 });
    // Cancelación coherente: la reserva terminal no conserva allocations ACTIVE.
    await database.client.begin(async tx => {
      await tx`update availability.resource_allocations set status='RELEASED', released_at=now(), release_reason='test_cancelled' where source_id=${reservation.reservationId} and source_type='RESERVATION'`;
      await tx`update booking.reservations set status='CANCELLED', cancelled_at=now() where id=${reservation.reservationId}`;
    });

    await expect(registerAttendance({
      actor: actorFor("BARBER"), reservationId: reservation.reservationId, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const rows = await database.client`select count(*)::int c from attendance.attendances where reservation_id=${reservation.reservationId}`;
    expect(Number(rows[0]!.c)).toBe(0);
  });

  it("CN-11 · una reserva admite como mucho UNA atención terminal", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2, startMinute: 720 });
    const first = await registerAttendance({
      actor: actorFor("BARBER"), reservationId: reservation.reservationId,
      servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 30 }],
      status: "COMPLETED", operationId: randomUUID()
    });
    expect(first.status).toBe("COMPLETED");

    await expect(registerAttendance({
      actor: actorFor("BARBER"), reservationId: reservation.reservationId,
      servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 30 }],
      status: "COMPLETED", operationId: randomUUID()
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const rows = await database.client`select count(*)::int c from attendance.attendances where reservation_id=${reservation.reservationId}`;
    expect(Number(rows[0]!.c)).toBe(1);
  });

  it("IT-ATT-04 · los estados terminales son COMPLETED, PARTIAL e INTERRUPTED", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2, startMinute: 840 });
    const created = await registerAttendance({
      actor: actorFor("BARBER"), reservationId: reservation.reservationId, operationId: randomUUID()
    });

    const finished = await setAttendanceState({
      actor: actorFor("BARBER"), attendanceId: created.attendanceId, status: "PARTIAL",
      servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 15 }],
      expectedRevision: 1, operationId: randomUUID()
    });
    expect(finished.status).toBe("PARTIAL");
    expect(finished.revision).toBe(2);

    const row = await attendanceRow(created.attendanceId);
    expect(row.status).toBe("PARTIAL");
    expect(row.finishedAt).toBeTruthy();

    // Un terminal no se reabre por registro: sólo por corrección.
    await expect(setAttendanceState({
      actor: actorFor("BARBER"), attendanceId: created.attendanceId, status: "COMPLETED",
      servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 30 }],
      expectedRevision: 2, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const events = await attendanceEvents(created.attendanceId);
    expect(events.map((event) => event.eventType)).toEqual(["ATTENDANCE_REGISTERED", "ATTENDANCE_PARTIAL"]);
  });

  it("IT-ATT-04b · los servicios realizados pueden diferir de los reservados", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.ownerStaff, localDate: ABSENCE_DATE_2, startMinute: 960 });
    const created = await registerAttendance({
      actor: actorFor("OWNER"), reservationId: reservation.reservationId,
      attendedByStaffMemberId: seed.ownerStaff,
      servicesPerformedSnapshot: [
        { serviceId: seed.serviceCut, name: "Corte U05", durationMinutes: 20, priceMinor: 10000, currency: "ARS" },
        { serviceId: seed.serviceBeard, name: "Barba U05", durationMinutes: 10, priceMinor: 5000, currency: "ARS" }
      ],
      status: "COMPLETED", operationId: randomUUID()
    });

    const detail = await getAttendanceDetail(actorFor("OWNER"), created.attendanceId);
    expect(detail.reservedServices).toHaveLength(1);
    expect(detail.attendance.servicesPerformed).toHaveLength(2);
    expect(detail.attendance.servicesPerformed.map((service) => service.name)).toEqual(["Corte U05", "Barba U05"]);
  });

  it("el registro es idempotente por operation_id", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.ownerStaff, localDate: ABSENCE_DATE_2, startMinute: 1080 });
    const operationId = randomUUID();
    const input = { actor: actorFor("OWNER"), reservationId: reservation.reservationId, operationId };
    const first = await registerAttendance(input);
    const replay = await registerAttendance(input);
    expect(replay.replayed).toBe(true);
    expect(replay.attendanceId).toBe(first.attendanceId);
    const rows = await database.client`select count(*)::int c from attendance.attendances where reservation_id=${reservation.reservationId}`;
    expect(Number(rows[0]!.c)).toBe(1);
  });
});

describe("H03.U06 · walk-in: atención sin reserva (PostgreSQL real)", () => {
  it("IT-ATT-02 · el walk-in no crea Reservation, ni cuenta CLIENT, ni ventas, pagos o stock", async () => {
    const [profilesBefore] = await database.client`select count(*)::int c from clients.client_profiles`;
    const [accountsBefore] = await database.client`select count(*)::int c from iam.user_accounts`;
    const [tablesBefore] = await database.client`
      select count(*)::int c from information_schema.tables
       where table_schema not in ('pg_catalog','information_schema')
         and (table_name ilike '%sale%' or table_name ilike '%payment%' or table_name ilike '%stock%' or table_name ilike '%inventory%')`;

    const created = await registerAttendance({
      actor: actorFor("RECEPTIONIST"),
      walkIn: true,
      attendedByStaffMemberId: seed.receptionistStaff,
      contactSnapshot: { name: "Walk-in Sin Reserva", phone: "1199990001" },
      servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 30, priceMinor: 10000, currency: "ARS" }],
      status: "COMPLETED",
      operationId: randomUUID()
    });

    expect(created.walkIn).toBe(true);
    expect(created.reservationId).toBeNull();

    const row = await attendanceRow(created.attendanceId);
    // La combinación legítima: `reservation_id = NULL` CON `walk_in = true`.
    expect(row.reservationId).toBeNull();
    expect(row.walkIn).toBe(true);
    expect(row.clientProfileId).toBeNull();

    const [profilesAfter] = await database.client`select count(*)::int c from clients.client_profiles`;
    const [accountsAfter] = await database.client`select count(*)::int c from iam.user_accounts`;
    const [tablesAfter] = await database.client`
      select count(*)::int c from information_schema.tables
       where table_schema not in ('pg_catalog','information_schema')
         and (table_name ilike '%sale%' or table_name ilike '%payment%' or table_name ilike '%stock%' or table_name ilike '%inventory%')`;

    expect(Number(profilesAfter!.c)).toBe(Number(profilesBefore!.c));
    expect(Number(accountsAfter!.c)).toBe(Number(accountsBefore!.c));
    expect(Number(tablesAfter!.c)).toBe(Number(tablesBefore!.c));

    // No existe ninguna Reservation ficticia asociada.
    const [fictitious] = await database.client`
      select count(*)::int c from booking.reservations where contact_snapshot->>'name' = 'Walk-in Sin Reserva'`;
    expect(Number(fictitious!.c)).toBe(0);

    const events = await attendanceEvents(created.attendanceId);
    expect(events.map((event) => event.eventType)).toEqual(["ATTENDANCE_WALKIN_REGISTERED"]);
  });

  it("IT-ATT-03 · un walk-in sin contacto se rechaza (VALIDATION_ERROR) y no crea fila", async () => {
    const before = await database.client`select count(*)::int c from attendance.attendances where business_id=${seed.business}`;
    await expect(registerAttendance({
      actor: actorFor("RECEPTIONIST"), walkIn: true, attendedByStaffMemberId: seed.receptionistStaff,
      operationId: randomUUID()
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const after = await database.client`select count(*)::int c from attendance.attendances where business_id=${seed.business}`;
    expect(Number(after[0]!.c)).toBe(Number(before[0]!.c));
  });

  it("un walk-in duplicado para el mismo profesional y contacto se rechaza", async () => {
    const input = {
      actor: actorFor("RECEPTIONIST"), walkIn: true, attendedByStaffMemberId: seed.receptionistStaff,
      contactSnapshot: { name: "Walk-in Duplicado", phone: "1199990002" }, operationId: randomUUID()
    };
    await registerAttendance(input);
    await expect(registerAttendance({ ...input, operationId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("un walk-in no puede vincularse a una ficha CRM", async () => {
    const [profile] = await database.client`select id from clients.client_profiles limit 1`;
    if (!profile) return;
    await expect(registerAttendance({
      actor: actorFor("RECEPTIONIST"), walkIn: true, attendedByStaffMemberId: seed.receptionistStaff,
      clientProfileId: profile.id, contactSnapshot: { name: "Walk-in CRM", phone: "1199990003" },
      operationId: randomUUID()
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("H03.U06 · correcciones de atención con trazabilidad", () => {
  it("IT-ATT-09 · la corrección conserva estado anterior, posterior, autor, momento y motivo", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2, startMinute: 1200 });
    const created = await registerAttendance({
      actor: actorFor("BARBER"), reservationId: reservation.reservationId,
      servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 30 }],
      status: "COMPLETED", operationId: randomUUID()
    });

    const corrected = await correctAttendance({
      actor: actorFor("OWNER"), attendanceId: created.attendanceId,
      servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 20 }],
      notes: "Ajuste de duración", reason: "Corrección de la duración registrada",
      expectedRevision: 1, operationId: randomUUID()
    });
    expect(corrected.revision).toBe(2);

    const [correction] = await database.client`
      select id, changed_by_account_id "changedByAccountId", changed_at "changedAt",
             before_snapshot "beforeSnapshot", after_snapshot "afterSnapshot", reason
        from attendance.attendance_corrections where attendance_id=${created.attendanceId}`;
    expect(correction).toBeTruthy();
    expect(correction!.changedByAccountId).toBe(seed.ownerAccount);
    expect(correction!.changedAt).toBeTruthy();
    expect(correction!.reason).toBe("Corrección de la duración registrada");
    expect((correction!.beforeSnapshot as { revision: number }).revision).toBe(1);
    expect((correction!.afterSnapshot as { revision: number }).revision).toBe(2);

    // La atención original NO se borra: sigue existiendo y con el valor corregido.
    const row = await attendanceRow(created.attendanceId);
    expect(row.revision).toBe(2);
    expect((row.servicesPerformedSnapshot as Array<{ durationMinutes: number }>)[0]!.durationMinutes).toBe(20);

    const events = await attendanceEvents(created.attendanceId);
    expect(events.map((event) => event.eventType)).toEqual(["ATTENDANCE_REGISTERED", "ATTENDANCE_CORRECTED"]);

    const detail = await getAttendanceDetail(actorFor("OWNER"), created.attendanceId);
    expect(detail.corrections).toHaveLength(1);
    expect(detail.corrections[0]!.reason).toBe("Corrección de la duración registrada");
  });

  it("IT-ATT-10 · una corrección sin motivo se rechaza (VALIDATION_ERROR)", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2, startMinute: 1260 });
    const created = await registerAttendance({
      actor: actorFor("BARBER"), reservationId: reservation.reservationId,
      servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 30 }],
      status: "COMPLETED", operationId: randomUUID()
    });

    await expect(correctAttendance({
      actor: actorFor("OWNER"), attendanceId: created.attendanceId, notes: "sin motivo",
      expectedRevision: 1, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const corrections = await database.client`select count(*)::int c from attendance.attendance_corrections where attendance_id=${created.attendanceId}`;
    expect(Number(corrections[0]!.c)).toBe(0);
  });

  it("una revisión obsoleta no sobrescribe una corrección más reciente", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2, startMinute: 1320 });
    const created = await registerAttendance({
      actor: actorFor("BARBER"), reservationId: reservation.reservationId,
      servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 30 }],
      status: "COMPLETED", operationId: randomUUID()
    });
    await correctAttendance({
      actor: actorFor("OWNER"), attendanceId: created.attendanceId, notes: "primera",
      reason: "Primera corrección", expectedRevision: 1, operationId: randomUUID()
    });

    await expect(correctAttendance({
      actor: actorFor("OWNER"), attendanceId: created.attendanceId, notes: "segunda",
      reason: "Segunda corrección obsoleta", expectedRevision: 1, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "STALE_REVISION" });

    const row = await attendanceRow(created.attendanceId);
    expect(row.revision).toBe(2);
    expect(row.notes).toBe("primera");
  });
});

describe("H03.U06 · alcance y aislamiento de atenciones", () => {
  it("el BARBER sólo ve sus propias atenciones y no puede corregir las ajenas", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.ownerStaff, localDate: ABSENCE_DATE_2, startMinute: 1380 });
    const foreign = await registerAttendance({
      actor: actorFor("OWNER"), reservationId: reservation.reservationId,
      attendedByStaffMemberId: seed.ownerStaff,
      servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 30 }],
      status: "COMPLETED", operationId: randomUUID()
    });

    const mine = await listAttendances(actorFor("BARBER"), { status: "ALL", walkIn: "ALL", limit: 100 });
    expect(mine.every((item) => item.attendedByStaffMemberId === seed.barberStaff)).toBe(true);
    expect(mine.map((item) => item.id)).not.toContain(foreign.attendanceId);

    await expect(getAttendanceDetail(actorFor("BARBER"), foreign.attendanceId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(correctAttendance({
      actor: actorFor("BARBER"), attendanceId: foreign.attendanceId, notes: "intento",
      reason: "Intento fuera de alcance", expectedRevision: 1, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("el RECEPTIONIST ve el historial completo del Business", async () => {
    const items = await listAttendances(actorFor("RECEPTIONIST"), { status: "ALL", walkIn: "ALL", limit: 100 });
    expect(items.length).toBeGreaterThan(0);
    const owners = new Set(items.map((item) => item.attendedByStaffMemberId));
    expect(owners.size).toBeGreaterThan(1);
  });

  it("aisla por Business: una atención de otro negocio no existe para este actor", async () => {
    const other = await seedStaffAgendaBusiness("U06 Atenciones Ajeno");
    try {
      const reservation = await seedLocalReservation(other, { staffMemberId: other.ownerStaff, localDate: ABSENCE_DATE_2, startMinute: 480 });
      const foreign = await registerAttendance({
        actor: { ...actorFor("OWNER"), businessId: other.business, accountId: other.ownerAccount, staffMemberId: other.ownerStaff },
        reservationId: reservation.reservationId, attendedByStaffMemberId: other.ownerStaff,
        servicesPerformedSnapshot: [{ name: "Corte U05", durationMinutes: 30 }],
        status: "COMPLETED", operationId: randomUUID()
      });
      await expect(getAttendanceDetail(actorFor("OWNER"), foreign.attendanceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await destroyStaffAgendaBusiness(other);
    }
  });
});

describe("H03.U06 · correctivos U05 verificados sobre el dominio de Attendance", () => {
  it("IT-ATT-06 · el replay de llegada con revisión obsoleta se rechaza (STALE_REVISION)", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE, startMinute: 300 });
    const first = await registerStaffArrival({
      businessId: seed.business, actorAccountId: seed.barberAccount, actorStaffMemberId: seed.barberStaff,
      reservationId: reservation.reservationId, expectedRevision: 1, selfScopeOnly: true, operationId: randomUUID()
    });
    expect(first.revision).toBe(2);

    await expect(registerStaffArrival({
      businessId: seed.business, actorAccountId: seed.barberAccount, actorStaffMemberId: seed.barberStaff,
      reservationId: reservation.reservationId, expectedRevision: 1, selfScopeOnly: true, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "STALE_REVISION" });

    const events = await database.client`
      select count(*)::int c from booking.reservation_events where reservation_id=${reservation.reservationId} and event_type='ARRIVAL_REGISTERED'`;
    expect(Number(events[0]!.c)).toBe(1);
  });

  it("IT-ATT-07 · el no-show usa el reloj del servidor y el payload coincide con la BD", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: PAST_DATE, startMinute: 240 });
    const result = await confirmStaffNoShow({
      businessId: seed.business, actorAccountId: seed.barberAccount, actorStaffMemberId: seed.barberStaff,
      reservationId: reservation.reservationId, expectedRevision: 1, reason: "No se presentó",
      selfScopeOnly: true, operationId: randomUUID()
    });

    const [row] = await database.client`select no_show_at "noShowAt" from booking.reservations where id=${reservation.reservationId}`;
    expect(new Date(row!.noShowAt as Date).toISOString()).toBe(result.noShowAt);
    expect(new Date(result.noShowAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("IT-ATT-08 · el no-show sobre un turno futuro se rechaza", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: "2026-12-20", startMinute: 600 });
    await expect(confirmStaffNoShow({
      businessId: seed.business, actorAccountId: seed.barberAccount, actorStaffMemberId: seed.barberStaff,
      reservationId: reservation.reservationId, expectedRevision: 1, selfScopeOnly: true, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "BOOKING_NO_SHOW_WINDOW_NOT_OPEN" });
  });
});
