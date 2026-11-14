/**
 * H03.U05 · Integración de Agenda Staff contra PostgreSQL real.
 *
 * Cada caso ejecuta el comando/ruta REAL y verifica el estado PERSISTIDO en
 * PostgreSQL: no se comprueba sólo el código de respuesta ni la forma del
 * payload. Los casos negativos comprueban el aislamiento multi-Business y el
 * alcance propio del barbero.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { database } from "../../../apps/api/src/lib/runtime";
import { createStaffReservation } from "../../../apps/api/src/modules/booking/commands/staff-create";
import { registerStaffArrival } from "../../../apps/api/src/modules/booking/commands/arrival";
import { confirmStaffNoShow } from "../../../apps/api/src/modules/booking/commands/no_show";
import { reassignStaffReservation } from "../../../apps/api/src/modules/booking/commands/reassign";
import { listStaffAgenda, getStaffReservationDetail } from "../../../apps/api/src/modules/booking/queries";
import { roleCapabilities } from "@youngkingz/contracts";
import {
  destroyStaffAgendaBusiness, seedConfirmedReservation, seedStaffAgendaBusiness,
  STAFF_CREATE_DATE, type StaffAgendaSeed,
} from "./staff-agenda-fixtures";

let seed: StaffAgendaSeed;

beforeAll(async () => {
  seed = await seedStaffAgendaBusiness("U05 Agenda");
});

afterAll(async () => {
  await destroyStaffAgendaBusiness(seed);
});

async function reservationState(reservationId: string) {
  const [reservation] = await database.client`select id,status,revision,no_show_at "noShowAt",cancelled_at "cancelledAt",staff_member_id "staffMemberId",starts_at "startsAt" from booking.reservations where id=${reservationId}`;
  const allocations = await database.client`select id,status::text status,staff_member_id "staffMemberId" from availability.resource_allocations where source_id=${reservationId} and source_type='RESERVATION'`;
  const events = await database.client`select event_type "eventType",sequence from booking.reservation_events where reservation_id=${reservationId} order by sequence`;
  return { reservation, allocations, events };
}

describe("H03.U05 · comandos de Agenda Staff (PostgreSQL real)", () => {
  it("crea una reserva asistida con Reservation + Allocation + items + evento, atómicamente", async () => {
    const operationId = randomUUID();
    const result = await createStaffReservation({
      businessId: seed.business,
      actorAccountId: seed.receptionistAccount,
      serviceIds: [seed.serviceCut],
      localDate: STAFF_CREATE_DATE,
      visibleStart: "13:30",
      professionalPreference: { type: "SPECIFIC", staffMemberId: seed.barberStaff },
      contact: { name: "Cliente Asistido", phone: "1155550000" },
      reason: "Reserva tomada por recepción",
      operationId,
    });

    expect(result.status).toBe("CONFIRMED");
    expect(result.replayed).toBe(false);
    expect(result.staffMemberId).toBe(seed.barberStaff);
    expect(result.commercialTotalMinor).toBe(10000);

    const state = await reservationState(result.reservationId);
    expect(state.reservation!.status).toBe("CONFIRMED");
    expect(Number(state.reservation!.revision)).toBe(1);
    expect(state.reservation!.noShowAt).toBeNull();
    expect(state.allocations).toHaveLength(1);
    expect(state.allocations[0]!.status).toBe("ACTIVE");
    expect(state.allocations[0]!.staffMemberId).toBe(seed.barberStaff);
    expect(state.events.map((event) => event.eventType)).toEqual(["RESERVATION_CONFIRMED"]);

    const items = await database.client`select service_id "serviceId", price_minor "priceMinor" from booking.reservation_items where reservation_id=${result.reservationId}`;
    expect(items).toHaveLength(1);
    expect(Number(items[0]!.priceMinor)).toBe(10000);
  });

  it("es idempotente por operation_id: replay sin efectos duplicados", async () => {
    const operationId = randomUUID();
    const input = {
      businessId: seed.business,
      actorAccountId: seed.receptionistAccount,
      serviceIds: [seed.serviceCut],
      localDate: STAFF_CREATE_DATE,
      visibleStart: "15:30",
      professionalPreference: { type: "SPECIFIC" as const, staffMemberId: seed.barberStaff },
      contact: { name: "Cliente Idempotente", phone: "1155550001" },
      operationId,
    };
    const first = await createStaffReservation(input);
    const replay = await createStaffReservation(input);

    expect(replay.replayed).toBe(true);
    expect(replay.reservationId).toBe(first.reservationId);
    const count = Number((await database.client`select count(*) c from booking.reservations where business_id=${seed.business}`)[0]!.c);
    const allocations = Number((await database.client`select count(*) c from availability.resource_allocations where business_id=${seed.business} and source_type='RESERVATION'`)[0]!.c);
    expect(allocations).toBe(count);
  });

  it("rechaza el mismo operation_id con contenido distinto (IDEMPOTENCY_CONFLICT)", async () => {
    const operationId = randomUUID();
    const base = {
      businessId: seed.business,
      actorAccountId: seed.receptionistAccount,
      serviceIds: [seed.serviceCut],
      localDate: STAFF_CREATE_DATE,
      visibleStart: "17:30",
      professionalPreference: { type: "SPECIFIC" as const, staffMemberId: seed.barberStaff },
      contact: { name: "Cliente", phone: "1155550002" },
      operationId,
    };
    await createStaffReservation(base);
    await expect(createStaffReservation({ ...base, visibleStart: "19:30" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("registra la llegada sin cambiar el estado ni liberar la Allocation (no es Attendance)", async () => {
    const { reservationId } = await seedConfirmedReservation(seed, { staffMemberId: seed.barberStaff });
    const before = await reservationState(reservationId);

    const result = await registerStaffArrival({
      businessId: seed.business,
      actorAccountId: seed.receptionistAccount,
      actorStaffMemberId: seed.receptionistStaff,
      reservationId,
      expectedRevision: Number(before.reservation!.revision),
      arrivalMethod: "PRESENCIAL",
      selfScopeOnly: false,
      operationId: randomUUID(),
    });

    expect(result.status).toBe("CONFIRMED");
    expect(result.revision).toBe(2);

    const after = await reservationState(reservationId);
    expect(after.reservation!.status).toBe("CONFIRMED");
    expect(after.reservation!.noShowAt).toBeNull();
    expect(after.allocations[0]!.status).toBe("ACTIVE");
    expect(after.events.map((event) => event.eventType)).toEqual(["RESERVATION_CONFIRMED", "ARRIVAL_REGISTERED"]);
  });

  it("la llegada es idempotente: repetirla no duplica el evento", async () => {
    const { reservationId } = await seedConfirmedReservation(seed, { staffMemberId: seed.barberStaff });
    const first = await registerStaffArrival({
      businessId: seed.business, actorAccountId: seed.receptionistAccount, actorStaffMemberId: seed.receptionistStaff,
      reservationId, expectedRevision: 1, selfScopeOnly: false, operationId: randomUUID(),
    });
    const second = await registerStaffArrival({
      businessId: seed.business, actorAccountId: seed.receptionistAccount, actorStaffMemberId: seed.receptionistStaff,
      reservationId, expectedRevision: first.revision, selfScopeOnly: false, operationId: randomUUID(),
    });

    expect(second.arrivedAt).toBe(first.arrivedAt);
    const state = await reservationState(reservationId);
    expect(state.events.filter((event) => event.eventType === "ARRIVAL_REGISTERED")).toHaveLength(1);
    expect(Number(state.reservation!.revision)).toBe(2);
  });

  it("confirma el no-show: estado NO_SHOW, no_show_at, Allocation liberada y evento", async () => {
    const { reservationId } = await seedConfirmedReservation(seed, { staffMemberId: seed.barberStaff });
    const before = await reservationState(reservationId);

    const result = await confirmStaffNoShow({
      businessId: seed.business,
      actorAccountId: seed.receptionistAccount,
      actorStaffMemberId: seed.receptionistStaff,
      reservationId,
      expectedRevision: Number(before.reservation!.revision),
      reason: "El cliente no se presentó",
      selfScopeOnly: false,
      operationId: randomUUID(),
    });

    expect(result.status).toBe("NO_SHOW");
    expect(result.released).toBe(true);
    expect(result.revision).toBe(2);

    const after = await reservationState(reservationId);
    expect(after.reservation!.status).toBe("NO_SHOW");
    expect(after.reservation!.noShowAt).toBeTruthy();
    expect(after.reservation!.cancelledAt).toBeNull();
    expect(after.allocations[0]!.status).toBe("RELEASED");
    expect(after.events.map((event) => event.eventType)).toEqual(["RESERVATION_CONFIRMED", "NO_SHOW_CONFIRMED"]);
  });

  it("el no-show es terminal: repetirlo es error, no un replay silencioso", async () => {
    const { reservationId } = await seedConfirmedReservation(seed, { staffMemberId: seed.barberStaff });
    await confirmStaffNoShow({
      businessId: seed.business, actorAccountId: seed.receptionistAccount, actorStaffMemberId: seed.receptionistStaff,
      reservationId, expectedRevision: 1, selfScopeOnly: false, operationId: randomUUID(),
    });
    await expect(confirmStaffNoShow({
      businessId: seed.business, actorAccountId: seed.receptionistAccount, actorStaffMemberId: seed.receptionistStaff,
      reservationId, expectedRevision: 2, selfScopeOnly: false, operationId: randomUUID(),
    })).rejects.toMatchObject({ code: "BOOKING_ALREADY_CANCELLED" });

    const state = await reservationState(reservationId);
    expect(state.events.filter((event) => event.eventType === "NO_SHOW_CONFIRMED")).toHaveLength(1);
  });

  it("no permite confirmar no-show de un turno cuya hora todavía no transcurrió", async () => {
    const futureDate = "2026-12-20";
    const { reservationId } = await seedConfirmedReservation(seed, {
      staffMemberId: seed.barberStaff,
      localDate: futureDate,
      startsAt: `${futureDate}T13:30:00Z`,
      endsAt: `${futureDate}T14:20:00Z`,
      occupiedStartsAt: `${futureDate}T13:25:00Z`,
      occupiedEndsAt: `${futureDate}T14:25:00Z`,
    });
    await expect(confirmStaffNoShow({
      businessId: seed.business, actorAccountId: seed.receptionistAccount, actorStaffMemberId: seed.receptionistStaff,
      reservationId, expectedRevision: 1, selfScopeOnly: false, operationId: randomUUID(),
    })).rejects.toMatchObject({ code: "BOOKING_NO_SHOW_WINDOW_NOT_OPEN" });

    const state = await reservationState(reservationId);
    expect(state.reservation!.status).toBe("CONFIRMED");
    expect(state.allocations[0]!.status).toBe("ACTIVE");
  });

  it("rechaza el no-show con revisión obsoleta (STALE_REVISION)", async () => {
    const { reservationId } = await seedConfirmedReservation(seed, { staffMemberId: seed.barberStaff });
    await expect(confirmStaffNoShow({
      businessId: seed.business, actorAccountId: seed.receptionistAccount, actorStaffMemberId: seed.receptionistStaff,
      reservationId, expectedRevision: 7, selfScopeOnly: false, operationId: randomUUID(),
    })).rejects.toMatchObject({ code: "STALE_REVISION" });
  });

  it("reasigna a otro profesional elegible conservando reservation_id y el turno", async () => {
    const { reservationId } = await seedConfirmedReservation(seed, { staffMemberId: seed.barberStaff });
    const before = await reservationState(reservationId);

    const result = await reassignStaffReservation({
      businessId: seed.business,
      actorAccountId: seed.receptionistAccount,
      actorStaffMemberId: seed.receptionistStaff,
      reservationId,
      expectedRevision: 1,
      staffMemberId: seed.ownerStaff,
      reason: "Reasignación por indisponibilidad",
      selfScopeOnly: false,
      operationId: randomUUID(),
    });

    expect(result.reservationId).toBe(reservationId);
    expect(result.staffMemberId).toBe(seed.ownerStaff);
    expect(result.startsAt).toBe(new Date(before.reservation!.startsAt as string).toISOString());

    const after = await reservationState(reservationId);
    expect(after.reservation!.staffMemberId).toBe(seed.ownerStaff);
    expect(Number(after.reservation!.revision)).toBe(2);
    const active = after.allocations.filter((allocation) => allocation.status === "ACTIVE");
    expect(active).toHaveLength(1);
    expect(active[0]!.staffMemberId).toBe(seed.ownerStaff);
    // La allocation de origen queda RELEASED (no se duplica ocupación).
    expect(after.allocations.filter((allocation) => allocation.status === "RELEASED")).toHaveLength(1);
  });

  it("rechaza reasignar a un profesional de otro Business (FORBIDDEN)", async () => {
    const other = await seedStaffAgendaBusiness("U05 Agenda Otro");
    try {
      const { reservationId } = await seedConfirmedReservation(seed, { staffMemberId: seed.barberStaff });
      await expect(reassignStaffReservation({
        businessId: seed.business, actorAccountId: seed.receptionistAccount, actorStaffMemberId: seed.receptionistStaff,
        reservationId, expectedRevision: 1, staffMemberId: other.ownerStaff,
        reason: "Intento de fuga multi-Business", selfScopeOnly: false, operationId: randomUUID(),
      })).rejects.toMatchObject({ code: "FORBIDDEN" });

      const state = await reservationState(reservationId);
      expect(state.reservation!.staffMemberId).toBe(seed.barberStaff);
      expect(Number(state.reservation!.revision)).toBe(1);
    } finally {
      await destroyStaffAgendaBusiness(other);
    }
  });

  it("rechaza reasignar a un profesional no elegible para los servicios (PROFESSIONAL_NOT_ELIGIBLE)", async () => {
    const { reservationId } = await seedConfirmedReservation(seed, { staffMemberId: seed.barberStaff });
    // El barbero deja de ser elegible para el servicio de la reserva.
    await database.client`delete from team.staff_service_assignments where business_id=${seed.business} and service_id=${seed.serviceCut} and staff_service_set_id in (select id from team.staff_service_sets where business_id=${seed.business} and staff_member_id=${seed.ownerStaff})`;

    await expect(reassignStaffReservation({
      businessId: seed.business, actorAccountId: seed.receptionistAccount, actorStaffMemberId: seed.receptionistStaff,
      reservationId, expectedRevision: 1, staffMemberId: seed.ownerStaff,
      reason: "Profesional no elegible", selfScopeOnly: false, operationId: randomUUID(),
    })).rejects.toMatchObject({ code: "PROFESSIONAL_NOT_ELIGIBLE" });
  });
});

describe("H03.U05 · consultas de agenda y alcance por rol", () => {
  const actorFor = (role: "OWNER" | "RECEPTIONIST" | "BARBER") => ({
    accountId: role === "OWNER" ? seed.ownerAccount : role === "RECEPTIONIST" ? seed.receptionistAccount : seed.barberAccount,
    personId: "", businessId: seed.business,
    staffMemberId: role === "OWNER" ? seed.ownerStaff : role === "RECEPTIONIST" ? seed.receptionistStaff : seed.barberStaff,
    accessSessionId: "", roleAssignmentId: "", role,
    contextRevision: 1, capabilities: new Set(roleCapabilities[role]), email: "",
  });

  it("la agenda compartida lista las reservas del Business y filtra por profesional y estado", async () => {
    const own = await seedConfirmedReservation(seed, { staffMemberId: seed.barberStaff, customerName: "Cliente Agenda" });
    const other = await seedConfirmedReservation(seed, { staffMemberId: seed.ownerStaff, customerName: "Cliente Otro" });

    const all = await listStaffAgenda(actorFor("OWNER"), { status: "ALL", limit: 100 });
    const ids = all.items.map((item) => item.id);
    expect(ids).toContain(own.reservationId);
    expect(ids).toContain(other.reservationId);

    const byStaff = await listStaffAgenda(actorFor("OWNER"), { status: "ALL", staffMemberId: seed.barberStaff, limit: 100 });
    expect(byStaff.items.map((item) => item.id)).toContain(own.reservationId);
    expect(byStaff.items.map((item) => item.id)).not.toContain(other.reservationId);

    const confirmedOnly = await listStaffAgenda(actorFor("OWNER"), { status: "CONFIRMED", staffMemberId: seed.barberStaff, limit: 100 });
    expect(confirmedOnly.items.every((item) => item.status === "CONFIRMED")).toBe(true);
  });

  it("la agenda propia del barbero sólo muestra sus reservas", async () => {
    const own = await seedConfirmedReservation(seed, { staffMemberId: seed.barberStaff });
    const other = await seedConfirmedReservation(seed, { staffMemberId: seed.ownerStaff });

    const agenda = await listStaffAgenda(actorFor("BARBER"), { status: "ALL", limit: 100 });
    const ids = agenda.items.map((item) => item.id);
    expect(ids).toContain(own.reservationId);
    expect(ids).not.toContain(other.reservationId);
  });

  it("el barbero no puede consultar la agenda de otro profesional (FORBIDDEN)", async () => {
    await expect(listStaffAgenda(actorFor("BARBER"), { status: "ALL", staffMemberId: seed.ownerStaff, limit: 100 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("el detalle incluye items, eventos y el estado NO_SHOW con su marca temporal", async () => {
    const { reservationId } = await seedConfirmedReservation(seed, { staffMemberId: seed.barberStaff });
    await confirmStaffNoShow({
      businessId: seed.business, actorAccountId: seed.receptionistAccount, actorStaffMemberId: seed.receptionistStaff,
      reservationId, expectedRevision: 1, selfScopeOnly: false, operationId: randomUUID(),
    });

    const detail = await getStaffReservationDetail(actorFor("RECEPTIONIST"), reservationId);
    expect(detail.reservation.status).toBe("NO_SHOW");
    expect(detail.reservation.noShowAt).toBeTruthy();
    expect(detail.items).toHaveLength(1);
    expect(detail.events.map((event) => event.eventType)).toEqual(["RESERVATION_CONFIRMED", "NO_SHOW_CONFIRMED"]);
  });

  it("el barbero no puede abrir el detalle de una reserva ajena (FORBIDDEN)", async () => {
    const { reservationId } = await seedConfirmedReservation(seed, { staffMemberId: seed.ownerStaff });
    await expect(getStaffReservationDetail(actorFor("BARBER"), reservationId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("aisla por Business: no expone reservas de otro negocio", async () => {
    const other = await seedStaffAgendaBusiness("U05 Agenda Ajeno");
    try {
      const { reservationId } = await seedConfirmedReservation(other, { staffMemberId: other.barberStaff });
      await expect(getStaffReservationDetail(actorFor("OWNER"), reservationId)).rejects.toMatchObject({ code: "BOOKING_NOT_FOUND" });
      const agenda = await listStaffAgenda(actorFor("OWNER"), { status: "ALL", limit: 100 });
      expect(agenda.items.map((item) => item.id)).not.toContain(reservationId);
    } finally {
      await destroyStaffAgendaBusiness(other);
    }
  });
});
