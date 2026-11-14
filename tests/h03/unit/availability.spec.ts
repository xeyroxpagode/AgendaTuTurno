import { describe, expect, it } from "vitest";
import { availabilitySearchSchema, roleCapabilities } from "@youngkingz/contracts";
import {
  addLocalDays, assertWithinHorizon, compareRelativeLoad, composeServiceSequence,
  deterministicCandidateOrder, intersectIntervals, intervalContains,
  localDateTimeToInstant, normalizeIntervals, subtractIntervals, totalMinutes
} from "../../../apps/api/src/modules/availability/temporal";

describe("H03.U03 temporal interval engine", () => {
  it("normalizes, intersects and subtracts half-open intervals", () => {
    expect(normalizeIntervals([{ startMinute: 600, endMinute: 780 }, { startMinute: 780, endMinute: 1080 }])).toEqual([{ startMinute: 600, endMinute: 1080 }]);
    expect(intersectIntervals([{ startMinute: 600, endMinute: 1200 }], [{ startMinute: 540, endMinute: 1080 }])).toEqual([{ startMinute: 600, endMinute: 1080 }]);
    expect(subtractIntervals([{ startMinute: 600, endMinute: 1080 }], [{ startMinute: 780, endMinute: 840 }])).toEqual([{ startMinute: 600, endMinute: 780 }, { startMinute: 840, endMinute: 1080 }]);
    expect(intervalContains([{ startMinute: 600, endMinute: 630 }], 630, 660)).toBe(false);
    expect(intervalContains([{ startMinute: 600, endMinute: 660 }], 630, 660)).toBe(true);
    expect(totalMinutes([{ startMinute: 600, endMinute: 780 }, { startMinute: 840, endMinute: 1080 }])).toBe(420);
  });

  it("preserves every multiservice buffer exactly (SP-01/SP-02)", () => {
    const result = composeServiceSequence(16 * 60, [
      { id: "cut", preBufferMinutes: 5, durationMinutes: 30, postBufferMinutes: 5 },
      { id: "beard", preBufferMinutes: 5, durationMinutes: 20, postBufferMinutes: 5 }
    ]);
    expect(result).toMatchObject({ occupiedStartMinute: 15 * 60 + 55, visibleStartMinute: 16 * 60, visibleEndMinute: 17 * 60, occupiedEndMinute: 17 * 60 + 5, occupiedMinutes: 70, visibleMinutes: 60 });
    expect(result.steps[1]).toMatchObject({ preparationStartMinute: 16 * 60 + 35, serviceStartMinute: 16 * 60 + 40, serviceEndMinute: 17 * 60 });
  });

  it("keeps exact non-cadence duration without rounding", () => {
    const result = composeServiceSequence(600, [{ id: "35m", preBufferMinutes: 0, durationMinutes: 35, postBufferMinutes: 0 }]);
    expect(result.visibleEndMinute).toBe(635);
  });
});

describe("H03.U03 local dates and DST", () => {
  it("uses 30 local calendar dates including today", () => {
    expect(addLocalDays("2026-11-04", 29)).toBe("2026-12-03");
    expect(() => assertWithinHorizon("2026-12-03", "2026-11-04", 30)).not.toThrow();
    expect(() => assertWithinHorizon("2026-12-04", "2026-11-04", 30)).toThrowError(/outside/i);
  });

  it("resolves an unambiguous local instant", () => {
    expect(localDateTimeToInstant("2026-11-04", 10 * 60, "America/Argentina/Buenos_Aires").toISOString()).toBe("2026-11-04T13:00:00.000Z");
  });

  it("rejects nonexistent and ambiguous DST times", () => {
    expect(() => localDateTimeToInstant("2026-03-08", 2 * 60 + 30, "America/New_York")).toThrowError(/nonexistent or ambiguous/i);
    expect(() => localDateTimeToInstant("2026-11-01", 1 * 60 + 30, "America/New_York")).toThrowError(/nonexistent or ambiguous/i);
  });

  it("maps 24:00 to the next local midnight without an overnight placement", () => {
    expect(localDateTimeToInstant("2026-11-04", 1440, "America/Argentina/Buenos_Aires").toISOString()).toBe("2026-11-05T03:00:00.000Z");
  });
});

describe("H03.U03 ANY balancing", () => {
  it("compares exact proportional load with integer cross multiplication", () => {
    expect(compareRelativeLoad({ confirmedMinutes: 120, capacityMinutes: 240 }, { confirmedMinutes: 120, capacityMinutes: 480 })).toBeGreaterThan(0);
  });

  it("uses a stable seed-based tie break rather than SQL/UUID order", () => {
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
    expect(deterministicCandidateOrder("business:date:10:00:cut", ids)).toEqual(deterministicCandidateOrder("business:date:10:00:cut", [...ids].reverse()));
    expect(new Set([deterministicCandidateOrder("slot-a", ids)[0], deterministicCandidateOrder("slot-b", ids)[0], deterministicCandidateOrder("slot-c", ids)[0]]).size).toBeGreaterThan(1);
  });
});

describe("H03.U03 contracts and permissions", () => {
  it("rejects repeated service IDs per D13", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(() => availabilitySearchSchema.parse({ serviceIds: [id, id], fromDate: "2026-11-04", throughDate: "2026-11-04", professionalPreference: { type: "ANY" } })).toThrow(/Service IDs must be distinct/);
    expect(() => availabilitySearchSchema.parse({ serviceIds: [id], fromDate: "2026-02-30", throughDate: "2026-11-04", professionalPreference: { type: "ANY" } })).toThrow();
  });

  it("keeps commercial management Owner-only by default", () => {
    expect(roleCapabilities.OWNER).toContain("availability.manage");
    expect(roleCapabilities.RECEPTIONIST).toContain("availability.read");
    expect(roleCapabilities.RECEPTIONIST).not.toContain("availability.manage");
    expect(roleCapabilities.BARBER).toContain("availability.self.read");
  });
});
