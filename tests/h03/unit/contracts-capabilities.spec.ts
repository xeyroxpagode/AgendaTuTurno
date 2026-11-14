/**
 * H03.U06 · Unitarios de contratos (capacabilities y matriz de autoridad).
 *
 * Verifican la matriz normativa B01 §5 y la compatibilidad rol <-> capability
 * que impide que un grant amplíe la autoridad de un rol fuera de su alcance.
 */
import { describe, expect, it } from "vitest";
import {
  capabilities, capabilitySchema, delegableCapabilities, grantableCapabilitiesByRole,
  isGrantCompatibleWithRole, roleCapabilities, roles, type Capability
} from "@youngkingz/contracts";

describe("H03.U06 · capabilities de Ausencias y Prestación real", () => {
  it("UT-05 · las capabilities nuevas existen y son válidas", () => {
    const expected: Capability[] = [
      "absence.request", "absence.read", "absence.approve", "absence.reject", "absence.withdraw", "absence.apply",
      "attendance.register", "attendance.read", "attendance.read.all", "attendance.correct"
    ];
    for (const capability of expected) {
      expect(capabilities).toContain(capability);
      expect(capabilitySchema.safeParse(capability).success).toBe(true);
    }
  });

  it("el OWNER tiene la autoridad global dentro de su Business", () => {
    for (const capability of capabilities) {
      if (capability === "iam.security.recover") continue;
      expect(roleCapabilities.OWNER).toContain(capability);
    }
    expect(roleCapabilities.OWNER).not.toContain("iam.security.recover");
  });

  it("el RECEPTIONIST opera ausencias y atenciones del Business, sin identidad de seguridad", () => {
    expect(roleCapabilities.RECEPTIONIST).toEqual(expect.arrayContaining([
      "absence.request", "absence.read", "absence.approve", "absence.reject", "absence.withdraw", "absence.apply",
      "attendance.register", "attendance.read", "attendance.read.all", "attendance.correct",
      "bookings.read", "bookings.create", "bookings.arrival", "bookings.no_show"
    ]));
    expect(roleCapabilities.RECEPTIONIST).not.toContain("iam.security.recover");
    expect(roleCapabilities.RECEPTIONIST).not.toContain("iam.grants.issue");
  });

  it("el BARBER sólo tiene alcance propio y NO aprueba ni aplica ausencias", () => {
    expect(roleCapabilities.BARBER).toEqual(expect.arrayContaining([
      "bookings.self.read", "bookings.self.arrival", "bookings.self.no_show",
      "absence.request", "absence.read", "absence.withdraw",
      "attendance.register", "attendance.read", "attendance.correct"
    ]));
    // Separación de funciones: quien solicita no se auto-aprueba.
    expect(roleCapabilities.BARBER).not.toContain("absence.approve");
    expect(roleCapabilities.BARBER).not.toContain("absence.reject");
    expect(roleCapabilities.BARBER).not.toContain("absence.apply");
    expect(roleCapabilities.BARBER).not.toContain("attendance.read.all");
    // El BARBER nunca tiene la agenda compartida.
    expect(roleCapabilities.BARBER).not.toContain("bookings.read");
    expect(roleCapabilities.BARBER).not.toContain("bookings.create");
    expect(roleCapabilities.BARBER).not.toContain("bookings.override.cancel");
    expect(roleCapabilities.BARBER).not.toContain("bookings.override.reschedule");
  });

  it("las capabilities nuevas NO son delegables por grant (deny-by-default)", () => {
    for (const capability of capabilities.filter((item) => item.startsWith("absence.") || item.startsWith("attendance."))) {
      expect(delegableCapabilities).not.toContain(capability);
    }
  });

  it("un grant sólo es compatible con el rol si la capability pertenece a su alcance", () => {
    // Un BARBER con un grant `bookings.read` NO es compatible (CN-06).
    expect(isGrantCompatibleWithRole("BARBER", "bookings.read")).toBe(false);
    expect(isGrantCompatibleWithRole("BARBER", "bookings.override.cancel")).toBe(false);
    expect(isGrantCompatibleWithRole("BARBER", "absence.apply")).toBe(false);
    // La propia capacidad del rol es compatible (el grant es un no-op inocuo).
    expect(isGrantCompatibleWithRole("BARBER", "bookings.self.read")).toBe(true);
    expect(isGrantCompatibleWithRole("BARBER", "attendance.register")).toBe(true);
    // El RECEPTIONIST conserva la superficie delegable congelada en H01.
    expect(isGrantCompatibleWithRole("RECEPTIONIST", "availability.manage")).toBe(true);
    expect(isGrantCompatibleWithRole("RECEPTIONIST", "iam.staff.create")).toBe(true);
    // `iam.security.recover` es exclusiva del proceso de recuperación: no es
    // compatible con ningún rol operativo.
    expect(isGrantCompatibleWithRole("RECEPTIONIST", "iam.security.recover")).toBe(false);
    expect(isGrantCompatibleWithRole("OWNER", "iam.security.recover")).toBe(false);
  });

  it("el BARBER no tiene ninguna capability adicional delegable", () => {
    expect(grantableCapabilitiesByRole.BARBER).toHaveLength(0);
  });

  it("cada rol tiene un conjunto base no vacío y coherente con la matriz", () => {
    for (const role of roles) {
      expect(roleCapabilities[role].length).toBeGreaterThan(0);
      for (const capability of roleCapabilities[role]) {
        expect(capabilities).toContain(capability);
      }
    }
  });
});
