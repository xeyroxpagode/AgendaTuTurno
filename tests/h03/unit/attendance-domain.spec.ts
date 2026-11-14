/**
 * H03.U06 · Unitarios del dominio de Prestación real (CAP-03-08).
 *
 * Verifican la máquina de estados de la atención y la coherencia entre la
 * forma del registro y sus invariantes (walk-in legítimo, sin reserva
 * ficticia, sin ficha CRM automática).
 */
import { describe, expect, it } from "vitest";
import {
  assertAttendanceShape, assertAttendanceTransition, attendanceTerminalStatuses, isTerminalAttendance
} from "../../../apps/api/src/modules/attendance/domain";

describe("H03.U06 · dominio de atenciones", () => {
  it("UT-04 · sólo los estados terminales son válidos como destino", () => {
    for (const terminal of attendanceTerminalStatuses) {
      expect(isTerminalAttendance(terminal)).toBe(true);
      expect(() => assertAttendanceTransition("IN_PROGRESS", terminal)).not.toThrow();
    }
    expect(isTerminalAttendance("IN_PROGRESS")).toBe(false);
    expect(() => assertAttendanceTransition("IN_PROGRESS", "IN_PROGRESS")).toThrowError(/Invalid attendance state/);
  });

  it("una atención terminal no se reabre por registro", () => {
    for (const terminal of attendanceTerminalStatuses) {
      try {
        assertAttendanceTransition(terminal, "COMPLETED");
        throw new Error("debería haber lanzado");
      } catch (error) {
        expect(error).toMatchObject({ code: "CONFLICT", statusCode: 409 });
      }
    }
  });

  it("la combinación legítima de walk-in es reservation_id NULL + walk_in true", () => {
    expect(() => assertAttendanceShape({ reservationId: null, walkIn: true, hasContact: true, hasClientProfile: false })).not.toThrow();
  });

  it("un walk-in exige contacto y NO admite ficha CRM", () => {
    expect(() => assertAttendanceShape({ reservationId: null, walkIn: true, hasContact: false, hasClientProfile: false }))
      .toThrowError(/contact/);
    expect(() => assertAttendanceShape({ reservationId: null, walkIn: true, hasContact: true, hasClientProfile: true }))
      .toThrowError(/client profile/);
  });

  it("una atención con reserva no puede ser walk-in, y una sin reserva debe ser walk-in", () => {
    expect(() => assertAttendanceShape({ reservationId: "11111111-1111-4111-8111-111111111111", walkIn: true, hasContact: true, hasClientProfile: false }))
      .toThrowError(/cannot reference a reservation/);
    expect(() => assertAttendanceShape({ reservationId: null, walkIn: false, hasContact: true, hasClientProfile: false }))
      .toThrowError(/reservation or the walk-in flag/);
    expect(() => assertAttendanceShape({ reservationId: "11111111-1111-4111-8111-111111111111", walkIn: false, hasContact: false, hasClientProfile: false }))
      .not.toThrow();
  });
});
