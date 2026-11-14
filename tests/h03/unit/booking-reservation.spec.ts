import { describe, expect, it } from "vitest";
import {
  assertExpectedRevision, assertStatusTransition, computeReservationSnapshot,
  cutoffAllows, nextEventSequence, sanitizedChanges, toPolicySnapshot,
} from "../../../apps/api/src/modules/booking/domain/reservation";
import { bookingSchemaSummary } from "@youngkingz/database";

const item = (overrides: Partial<Parameters<typeof computeReservationSnapshot>[0][number]> = {}) => ({
  serviceId: "11111111-1111-4111-8111-111111111111",
  serviceName: "Corte",
  termsVersionId: "22222222-2222-4222-8222-222222222222",
  durationMinutes: 30,
  preBufferMinutes: 5,
  postBufferMinutes: 5,
  priceMinor: 1000,
  currency: "ARS" as const,
  ...overrides,
});

describe("H03.U04 reservation domain", () => {
  it("builds a valid snapshot with positions and exact total", () => {
    const r = computeReservationSnapshot([item(), item({ serviceId: "33333333-3333-4333-8333-333333333333", serviceName: "Barba", termsVersionId: "44444444-4444-4444-8444-444444444444", durationMinutes: 20, priceMinor: 500 })]);
    expect(r.items.map(i => i.position)).toEqual([1, 2]);
    expect(r.commercialTotalMinor).toBe(1500);
    expect(r.currency).toBe("ARS");
  });

  it("rejects duplicate services (D13) in order", () => {
    expect(() => computeReservationSnapshot([item(), item()])).toThrowError(/distinct/);
  });

  it("rejects negative price, non-ARS currency, invalid moneda and zero duration", () => {
    expect(() => computeReservationSnapshot([item({ priceMinor: -1 })])).toThrowError();
    expect(() => computeReservationSnapshot([item({ currency: "USD" })])).toThrowError(/currency/);
    expect(() => computeReservationSnapshot([item({ durationMinutes: 0 })])).toThrowError();
    expect(() => computeReservationSnapshot([item({ preBufferMinutes: -1 })])).toThrowError();
  });

  it("rejects empty selection and more than ten services", () => {
    expect(() => computeReservationSnapshot([])).toThrowError();
    expect(() => computeReservationSnapshot(Array.from({ length: 11 }, (_, i) => item({ serviceId: `s${i}` })))).toThrowError();
  });

  it("policy snapshot keeps historical cutoffs verbatim", () => {
    const s = toPolicySnapshot({ id: "p", versionNumber: 3, revision: 9, horizonCalendarDates: 30, minLeadMinutes: 0, startStepMinutes: 30, cancelCutoffMinutes: 120, rescheduleCutoffMinutes: 120, publicBookingEnabled: true });
    expect(s).toMatchObject({ versionNumber: 3, cancelCutoffMinutes: 120, rescheduleCutoffMinutes: 120 });
  });

  it("cutoff is inclusive in seconds: T−120 allows, T−120+1s rejects", () => {
    const start = new Date("2026-11-04T19:00:00.000Z");
    const atMinus120 = new Date("2026-11-04T17:00:00.000Z");
    const atMinus120Plus = new Date("2026-11-04T17:00:01.000Z");
    expect(cutoffAllows(start, atMinus120, 120)).toBe(true);
    expect(cutoffAllows(start, atMinus120Plus, 120)).toBe(false);
  });

  it("CONFIRMED→CANCELLED is the only terminal transition", () => {
    expect(() => assertStatusTransition("CONFIRMED", "CANCELLED")).not.toThrow();
    expect(() => assertStatusTransition("CANCELLED", "CONFIRMED")).toThrowError(/terminal/);
    expect(() => assertStatusTransition("CONFIRMED", "CONFIRMED")).toThrowError();
  });

  it("stale revision rejected as STALE_REVISION", () => {
    expect(() => assertExpectedRevision(2, 1)).toThrowError(/STALE_REVISION|expectedRevision/);
    expect(() => assertExpectedRevision(2, 2)).not.toThrow();
  });

  it("events are ordered by explicit sequence", () => {
    expect(nextEventSequence([])).toBe(1);
    expect(nextEventSequence([{ sequence: 1 }, { sequence: 2 }])).toBe(3);
  });

  it("sanitizedChanges exposes no fields that did not change", () => {
    expect(sanitizedChanges({ a: 1, b: "x" }, { a: 2, b: "x" })).toEqual({ a: { before: 1, after: 2 } });
  });
});

describe("H03.U06 · correctivos U05 de dominio y persistencia", () => {
  it("UT-01 · CANCELLED y NO_SHOW tienen mensajes terminales DISTINTOS", () => {
    let cancelled = "";
    let noShow = "";
    try {
      assertStatusTransition("CANCELLED", "CANCELLED");
    } catch (error) {
      cancelled = (error as Error).message;
    }
    try {
      assertStatusTransition("NO_SHOW", "NO_SHOW");
    } catch (error) {
      noShow = (error as Error).message;
    }
    expect(cancelled).toMatch(/cancelled/i);
    expect(noShow).toMatch(/no.show/i);
    expect(cancelled).not.toBe(noShow);

    // El código de dominio se conserva (no se inventan códigos huérfanos).
    try {
      assertStatusTransition("NO_SHOW", "CANCELLED");
    } catch (error) {
      expect(error).toMatchObject({ code: "BOOKING_ALREADY_CANCELLED", statusCode: 409 });
    }
  });

  it("UT-02 · el esquema Drizzle de Booking refleja las constraints del SQL U05", () => {
    const summary = bookingSchemaSummary();
    expect(summary.reservationColumns).toContain("no_show_at");

    const statusCheck = summary.reservationChecks.find((check) => check.sql.includes("CONFIRMED") && check.sql.includes("CANCELLED") && check.sql.includes("NO_SHOW"));
    expect(statusCheck).toBeTruthy();
    expect(statusCheck!.name).toBe("booking_reservations_status_check");

    const noShowCheck = summary.reservationChecks.find((check) => check.sql.includes("no_show_at"));
    expect(noShowCheck).toBeTruthy();

    // La unique compuesta de la indisponibilidad efectiva existe en Drizzle
    // (ELEPHANT-020: Drizzle no validaba la constraint real del SQL).
    expect(summary.effectiveUnavailabilityUniques).toContain("staff_effective_unavailabilit_business_id_source_type_sourc_key");
    expect(summary.effectiveUnavailabilityColumns).toContain("source_type");
  });
});
