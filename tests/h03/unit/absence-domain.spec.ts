/**
 * H03.U06 · Unitarios del dominio de Ausencias (CAP-03-07).
 *
 * Verifican la máquina de estados, la validación de intervalos y la
 * detección de solapamiento: son las reglas que gobiernan el flujo
 * `PENDING → APPROVED → APPLIED` / `PENDING → REJECTED | WITHDRAWN`.
 */
import { describe, expect, it } from "vitest";
import {
  assertAbsenceInterval, assertAbsenceTransition, absenceTerminalStatuses,
  absenceTransitions, intervalsOverlap, isAbsenceTransitionAllowed, minuteToClock
} from "../../../apps/api/src/modules/absence/domain";

describe("H03.U06 · dominio de ausencias", () => {
  it("UT-03 · un intervalo inválido produce VALIDATION_ERROR", () => {
    expect(() => assertAbsenceInterval(0, 60)).not.toThrow();
    expect(() => assertAbsenceInterval(0, 1440)).not.toThrow();
    expect(() => assertAbsenceInterval(1439, 1440)).not.toThrow();

    expect(() => assertAbsenceInterval(600, 600)).toThrowError(/before/);
    expect(() => assertAbsenceInterval(600, 500)).toThrowError(/before/);
    expect(() => assertAbsenceInterval(-1, 600)).toThrowError(/startMinute/);
    expect(() => assertAbsenceInterval(1440, 1500)).toThrowError(/startMinute/);
    expect(() => assertAbsenceInterval(0, 0)).toThrowError(/endMinute/);
    expect(() => assertAbsenceInterval(0, 1441)).toThrowError(/endMinute/);
    expect(() => assertAbsenceInterval(0.5, 60)).toThrowError(/whole minutes/);
  });

  it("la máquina de estados admite sólo las transiciones normativas", () => {
    expect(isAbsenceTransitionAllowed("PENDING", "APPROVED")).toBe(true);
    expect(isAbsenceTransitionAllowed("PENDING", "REJECTED")).toBe(true);
    expect(isAbsenceTransitionAllowed("PENDING", "WITHDRAWN")).toBe(true);
    expect(isAbsenceTransitionAllowed("APPROVED", "APPLIED")).toBe(true);
    expect(isAbsenceTransitionAllowed("APPROVED", "REJECTED")).toBe(true);
    expect(isAbsenceTransitionAllowed("APPROVED", "WITHDRAWN")).toBe(true);

    expect(isAbsenceTransitionAllowed("PENDING", "APPLIED")).toBe(false);
    expect(isAbsenceTransitionAllowed("PENDING", "PENDING")).toBe(false);
    expect(isAbsenceTransitionAllowed("APPROVED", "APPROVED")).toBe(false);
  });

  it("los estados terminales no admiten ninguna transición", () => {
    for (const terminal of absenceTerminalStatuses) {
      expect(absenceTransitions[terminal]).toHaveLength(0);
      for (const target of ["PENDING", "APPROVED", "APPLIED", "REJECTED", "WITHDRAWN"] as const) {
        expect(() => assertAbsenceTransition(terminal, target)).toThrowError(/terminal/);
      }
    }
  });

  it("una transición inválida desde un estado no terminal es CONFLICT", () => {
    try {
      assertAbsenceTransition("PENDING", "APPLIED");
      throw new Error("debería haber lanzado");
    } catch (error) {
      expect(error).toMatchObject({ code: "CONFLICT", statusCode: 409 });
    }
  });

  it("los intervalos que sólo se tocan NO se solapan", () => {
    expect(intervalsOverlap(480, 600, 600, 720)).toBe(false);
    expect(intervalsOverlap(600, 720, 480, 600)).toBe(false);
    expect(intervalsOverlap(480, 600, 540, 660)).toBe(true);
    expect(intervalsOverlap(480, 660, 540, 600)).toBe(true);
    expect(intervalsOverlap(480, 600, 480, 600)).toBe(true);
  });

  it("minuto local → HH:mm", () => {
    expect(minuteToClock(0)).toBe("00:00");
    expect(minuteToClock(540)).toBe("09:00");
    expect(minuteToClock(1440)).toBe("24:00");
  });
});
