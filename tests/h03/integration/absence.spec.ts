/**
 * H03.U06 · CAP-03-07 · Ausencias y conflictos — integración contra PostgreSQL real.
 *
 * Cada caso verifica el efecto PERSISTIDO, no sólo el código de respuesta:
 * estado de la solicitud, indisponibilidad efectiva, eventos del ledger y
 * conflictos registrados en `availability.commitment_conflicts`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { database } from "../../../apps/api/src/lib/runtime";
import { roleCapabilities } from "@youngkingz/contracts";
import { applyAbsence, approveAbsence, rejectAbsence, requestAbsence, syncAbsenceConflicts, withdrawAbsence } from "../../../apps/api/src/modules/absence/commands";
import { getAbsenceDetail, listAbsenceConflicts, listAbsences } from "../../../apps/api/src/modules/absence/queries";
import { resolveSlot } from "../../../apps/api/src/modules/availability/queries";
import { reassignStaffReservation } from "../../../apps/api/src/modules/booking/commands/reassign";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization";
import {
  ABSENCE_DATE, ABSENCE_DATE_2, absenceState, countEffectiveUnavailability,
  destroyStaffAgendaBusiness, seedLocalReservation, seedStaffAgendaBusiness, type StaffAgendaSeed
} from "./absence-fixtures";

let seed: StaffAgendaSeed;

beforeAll(async () => {
  seed = await seedStaffAgendaBusiness("U06 Ausencias");
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

describe("H03.U06 · ciclo de vida de la ausencia (PostgreSQL real)", () => {
  it("IT-ABS-01 · una ausencia PENDING no bloquea la disponibilidad", async () => {
    const created = await requestAbsence({
      actor: actorFor("BARBER"),
      staffMemberId: seed.barberStaff,
      localDate: ABSENCE_DATE_2,
      startMinute: 480,
      endMinute: 600,
      reason: "Ausencia de prueba",
      operationId: randomUUID()
    });

    expect(created.status).toBe("PENDING");
    expect(created.revision).toBe(1);
    expect(created.replayed).toBe(false);

    const state = await absenceState(created.absenceId);
    expect(state.absence!.status).toBe("PENDING");
    expect(state.events.map((event) => event.eventType)).toEqual(["ABSENCE_REQUESTED"]);

    // INV-ABS-01: no existe indisponibilidad efectiva.
    expect(await countEffectiveUnavailability(seed.business, seed.barberStaff, ABSENCE_DATE_2)).toBe(0);

    // La disponibilidad sigue ofreciendo el horario del profesional.
    const slot = await resolveSlot(database.client, {
      businessId: seed.business,
      serviceIds: [seed.serviceCut],
      localDate: ABSENCE_DATE_2,
      visibleStartMinute: 480,
      professionalPreference: { type: "SPECIFIC", staffMemberId: seed.barberStaff },
      requirePublic: false,
      now: new Date()
    });
    expect(slot.staffMemberId).toBe(seed.barberStaff);
  });

  it("IT-ABS-01b · la solicitud es idempotente por operation_id", async () => {
    const operationId = randomUUID();
    const input = {
      actor: actorFor("BARBER"), staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2,
      startMinute: 900, endMinute: 960, reason: "Idempotencia", operationId
    };
    const first = await requestAbsence(input);
    const replay = await requestAbsence(input);
    expect(replay.replayed).toBe(true);
    expect(replay.absenceId).toBe(first.absenceId);
    const count = Number((await database.client`select count(*)::int c from absence.absence_requests where business_id=${seed.business}`)[0]!.c);
    const events = Number((await database.client`select count(*)::int c from absence.absence_events where business_id=${seed.business}`)[0]!.c);
    expect(events).toBe(count);
  });

  it("IT-ABS-01c · un intervalo inválido se rechaza (VALIDATION_ERROR)", async () => {
    await expect(requestAbsence({
      actor: actorFor("BARBER"), staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2,
      startMinute: 600, endMinute: 600, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(requestAbsence({
      actor: actorFor("BARBER"), staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2,
      startMinute: 600, endMinute: 500, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("IT-ABS-01d · el BARBER no puede solicitar ausencia para otro profesional (CN-01)", async () => {
    await expect(requestAbsence({
      actor: actorFor("BARBER"), staffMemberId: seed.ownerStaff, localDate: ABSENCE_DATE_2,
      startMinute: 480, endMinute: 540, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("IT-ABS-02 · aprobar NO cancela las reservas del profesional (INV-ABS-02)", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE, startMinute: 540 });

    const created = await requestAbsence({
      actor: actorFor("BARBER"), staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE,
      startMinute: 480, endMinute: 660, reason: "Ausencia con reserva", operationId: randomUUID()
    });
    const approved = await approveAbsence({
      actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 1, operationId: randomUUID()
    });
    expect(approved.status).toBe("APPROVED");
    expect(approved.revision).toBe(2);

    const [reservationRow] = await database.client`select status::text status from booking.reservations where id=${reservation.reservationId}`;
    expect(reservationRow!.status).toBe("CONFIRMED");
    const allocations = await database.client`select status::text status from availability.resource_allocations where source_id=${reservation.reservationId}`;
    expect(allocations.every((allocation) => allocation.status === "ACTIVE")).toBe(true);

    // Aprobar no crea indisponibilidad efectiva (sólo `APPLIED` lo hace).
    expect(await countEffectiveUnavailability(seed.business, seed.barberStaff, ABSENCE_DATE)).toBe(0);
  });

  it("IT-ABS-03 · aplicar sin aprobar se rechaza (409 CONFLICT)", async () => {
    const created = await requestAbsence({
      actor: actorFor("BARBER"), staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2,
      startMinute: 1200, endMinute: 1260, reason: "Sin aprobar", operationId: randomUUID()
    });
    await expect(applyAbsence({
      actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 1, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await countEffectiveUnavailability(seed.business, seed.barberStaff, ABSENCE_DATE_2)).toBe(0);
  });

  it("IT-ABS-04 · aplicar con compromisos sin resolver se rechaza (AVAILABILITY_IMPACT_CONFLICT)", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.ownerStaff, localDate: ABSENCE_DATE, startMinute: 540, customerName: "Cliente Conflicto" });

    const created = await requestAbsence({
      actor: actorFor("OWNER"), staffMemberId: seed.ownerStaff, localDate: ABSENCE_DATE,
      startMinute: 480, endMinute: 660, reason: "Ausencia en conflicto", operationId: randomUUID()
    });
    await approveAbsence({ actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 1, operationId: randomUUID() });

    await expect(applyAbsence({
      actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 2, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "AVAILABILITY_IMPACT_CONFLICT" });

    // El conflicto queda registrado y la ausencia sigue sin aplicarse.
    const conflicts = await database.client`
      select c.status::text status, a.source_id "sourceId"
        from availability.commitment_conflicts c
        join availability.resource_allocations a on a.business_id=c.business_id and a.id=c.allocation_id
       where c.business_id=${seed.business} and c.reason_code='APPLIED_ABSENCE'`;
    expect(conflicts.some((conflict) => conflict.sourceId === reservation.reservationId && conflict.status === "OPEN")).toBe(true);

    const state = await absenceState(created.absenceId);
    expect(state.absence!.status).toBe("APPROVED");
    expect(await countEffectiveUnavailability(seed.business, seed.ownerStaff, ABSENCE_DATE)).toBe(0);
  });

  it("IT-ABS-05 · la consulta de conflictos lista las reservas afectadas", async () => {
    const created = await requestAbsence({
      actor: actorFor("OWNER"), staffMemberId: seed.ownerStaff, localDate: ABSENCE_DATE,
      startMinute: 480, endMinute: 660, reason: "Detección de conflictos", operationId: randomUUID()
    });
    await approveAbsence({ actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 1, operationId: randomUUID() });

    const conflicts = await listAbsenceConflicts(actorFor("OWNER"), created.absenceId);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some((conflict) => conflict.reservationId !== null)).toBe(true);
    expect(conflicts.every((conflict) => conflict.customerName !== undefined)).toBe(true);
  });

  it("IT-ABS-06 · resolver el compromiso con Booking y aplicar deja la ausencia efectiva", async () => {
    const reservation = await seedLocalReservation(seed, { staffMemberId: seed.ownerStaff, localDate: ABSENCE_DATE_2, startMinute: 600, customerName: "Cliente Reasignable" });

    const created = await requestAbsence({
      actor: actorFor("OWNER"), staffMemberId: seed.ownerStaff, localDate: ABSENCE_DATE_2,
      startMinute: 480, endMinute: 780, reason: "Resolución por reasignación", operationId: randomUUID()
    });
    await approveAbsence({ actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 1, operationId: randomUUID() });

    // Primero se detecta el conflicto...
    await expect(applyAbsence({
      actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 2, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "AVAILABILITY_IMPACT_CONFLICT" });

    // ...luego se resuelve con la operación autorizada de Booking (reasignar).
    await reassignStaffReservation({
      businessId: seed.business, actorAccountId: seed.ownerAccount, actorStaffMemberId: seed.ownerStaff,
      reservationId: reservation.reservationId, expectedRevision: 1, staffMemberId: seed.receptionistStaff,
      reason: "Reasignación por ausencia", selfScopeOnly: false, operationId: randomUUID()
    });

    // La reasignación conserva la reserva: no se borra (INV-ABS: resolver ≠ borrar).
    const [afterReassign] = await database.client`select status::text status, staff_member_id "staffMemberId" from booking.reservations where id=${reservation.reservationId}`;
    expect(afterReassign!.status).toBe("CONFIRMED");
    expect(afterReassign!.staffMemberId).toBe(seed.receptionistStaff);

    const synced = await syncAbsenceConflicts({ actor: actorFor("OWNER"), absenceId: created.absenceId, operationId: randomUUID() });
    expect(synced.conflicts.every((conflict) => conflict.status === "RESOLVED")).toBe(true);

    const applied = await applyAbsence({
      actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 2, operationId: randomUUID()
    });
    expect(applied.status).toBe("APPLIED");
    expect(applied.revision).toBe(3);

    const state = await absenceState(created.absenceId);
    expect(state.absence!.status).toBe("APPLIED");
    expect(state.absence!.appliedAt).toBeTruthy();
    expect(state.events.map((event) => event.eventType)).toContain("ABSENCE_APPLIED");

    // La indisponibilidad efectiva existe y Availability ya no ofrece el horario.
    expect(await countEffectiveUnavailability(seed.business, seed.ownerStaff, ABSENCE_DATE_2)).toBe(1);
    await expect(resolveSlot(database.client, {
      businessId: seed.business, serviceIds: [seed.serviceCut], localDate: ABSENCE_DATE_2,
      visibleStartMinute: 540, professionalPreference: { type: "SPECIFIC", staffMemberId: seed.ownerStaff },
      requirePublic: false, now: new Date()
    })).rejects.toMatchObject({ code: "SLOT_CONFLICT" });
  });

  it("IT-ABS-07 · rechazar y retirar son terminales", async () => {
    const rejected = await requestAbsence({
      actor: actorFor("BARBER"), staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2,
      startMinute: 60, endMinute: 120, reason: "Para rechazar", operationId: randomUUID()
    });
    const rejection = await rejectAbsence({
      actor: actorFor("OWNER"), absenceId: rejected.absenceId, expectedRevision: 1,
      reason: "Cobertura de personal", operationId: randomUUID()
    });
    expect(rejection.status).toBe("REJECTED");
    await expect(applyAbsence({
      actor: actorFor("OWNER"), absenceId: rejected.absenceId, expectedRevision: 2, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const withdrawn = await requestAbsence({
      actor: actorFor("BARBER"), staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2,
      startMinute: 180, endMinute: 240, reason: "Para retirar", operationId: randomUUID()
    });
    const withdrawal = await withdrawAbsence({
      actor: actorFor("BARBER"), absenceId: withdrawn.absenceId, expectedRevision: 1, operationId: randomUUID()
    });
    expect(withdrawal.status).toBe("WITHDRAWN");
    await expect(applyAbsence({
      actor: actorFor("OWNER"), absenceId: withdrawn.absenceId, expectedRevision: 2, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const state = await absenceState(withdrawn.absenceId);
    expect(state.events.map((event) => event.eventType)).toEqual(["ABSENCE_REQUESTED", "ABSENCE_WITHDRAWN"]);
  });

  it("IT-ABS-07b · una revisión obsoleta se rechaza (STALE_REVISION)", async () => {
    const created = await requestAbsence({
      actor: actorFor("BARBER"), staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2,
      startMinute: 300, endMinute: 360, reason: "Revisión obsoleta", operationId: randomUUID()
    });
    await expect(approveAbsence({
      actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 7, operationId: randomUUID()
    })).rejects.toMatchObject({ code: "STALE_REVISION" });
  });
});

describe("H03.U06 · alcance y aislamiento de ausencias", () => {
  it("el BARBER sólo ve sus propias ausencias", async () => {
    const own = await requestAbsence({
      actor: actorFor("BARBER"), staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2,
      startMinute: 420, endMinute: 480, reason: "Propia", operationId: randomUUID()
    });
    const others = await requestAbsence({
      actor: actorFor("OWNER"), staffMemberId: seed.ownerStaff, localDate: ABSENCE_DATE_2,
      startMinute: 420, endMinute: 480, reason: "Ajena", operationId: randomUUID()
    });

    const mine = await listAbsences(actorFor("BARBER"), { status: "ALL", limit: 100 });
    const ids = mine.map((item) => item.id);
    expect(ids).toContain(own.absenceId);
    expect(ids).not.toContain(others.absenceId);

    await expect(getAbsenceDetail(actorFor("BARBER"), others.absenceId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("aisla por Business: una ausencia de otro negocio no existe para este actor", async () => {
    const other = await seedStaffAgendaBusiness("U06 Ausencias Ajeno");
    try {
      const foreign = await requestAbsence({
        actor: actorFor("OWNER"), staffMemberId: seed.ownerStaff, localDate: ABSENCE_DATE,
        startMinute: 60, endMinute: 120, reason: "Ajena", operationId: randomUUID()
      });
      const foreignInOther = await requestAbsence({
        actor: { ...actorFor("OWNER"), businessId: other.business, accountId: other.ownerAccount, staffMemberId: other.ownerStaff },
        staffMemberId: other.ownerStaff, localDate: ABSENCE_DATE,
        startMinute: 60, endMinute: 120, reason: "Ajena", operationId: randomUUID()
      });
      expect(foreign.absenceId).not.toBe(foreignInOther.absenceId);

      await expect(getAbsenceDetail(actorFor("OWNER"), foreignInOther.absenceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await destroyStaffAgendaBusiness(other);
    }
  });

  it("el historial conserva la secuencia de eventos y sus revisiones", async () => {
    const created = await requestAbsence({
      actor: actorFor("BARBER"), staffMemberId: seed.barberStaff, localDate: ABSENCE_DATE_2,
      startMinute: 780, endMinute: 840, reason: "Historial", operationId: randomUUID()
    });
    await approveAbsence({ actor: actorFor("OWNER"), absenceId: created.absenceId, expectedRevision: 1, operationId: randomUUID() });

    const detail = await getAbsenceDetail(actorFor("OWNER"), created.absenceId);
    expect(detail.events.map((event) => event.eventType)).toEqual(["ABSENCE_REQUESTED", "ABSENCE_APPROVED"]);
    expect(detail.events[0]!.beforeRevision).toBeNull();
    expect(detail.events[0]!.afterRevision).toBe(1);
    expect(detail.events[1]!.beforeRevision).toBe(1);
    expect(detail.events[1]!.afterRevision).toBe(2);
    expect(detail.absence.revision).toBe(2);
    expect(detail.absence.status).toBe("APPROVED");
  });
});
