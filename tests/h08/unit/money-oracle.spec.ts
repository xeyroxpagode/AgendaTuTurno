import { describe, expect, it } from "vitest";
import { commissionMinor, parseMinor, minorToString, assertMinorRange } from "@youngkingz/contracts";

/** Oráculos DR-03 (idénticos a `DR03_ECONOMIC_CALCULATION_ORACLES.csv`). */
describe("H08 · oráculos monetarios BigInt", () => {
  it("OC-COMMISSION-REALIZED: 100000 @1000bps = 10000", () => {
    expect(minorToString(commissionMinor(parseMinor("100000"), 1000))).toBe("10000");
  });
  it("OC-COMMISSION-COLLECTED: (100000-10000) @1500bps = 13500", () => {
    expect(minorToString(commissionMinor(parseMinor("90000"), 1500))).toBe("13500");
  });
  it("OC-COMMISSION-PARTIAL: 60000 @1500bps = 9000", () => {
    expect(minorToString(commissionMinor(parseMinor("60000"), 1500))).toBe("9000");
  });
  it("OC-FIXED-PERIOD: 50000 una sola vez (sin Attendance ficticia)", () => {
    expect(minorToString(parseMinor("50000"))).toBe("50000");
  });
  it("OC-CHAIR-RENT: saldo derivado 50000-20000 = 30000", () => {
    expect(minorToString(parseMinor("50000") - parseMinor("20000"))).toBe("30000");
  });
  it("OC-ROUNDING: floor(33333*1000/10000) = 3333", () => {
    expect(minorToString(commissionMinor(parseMinor("33333"), 1000))).toBe("3333");
  });
  it("OC-LARGE-AMOUNT: 9e18 @100bps sin overflow (9e16)", () => {
    expect(minorToString(commissionMinor(parseMinor("9000000000000000000"), 100))).toBe("90000000000000000");
  });
  it("rechaza importes fuera de rango y bps inválidos", () => {
    expect(() => assertMinorRange(parseMinor("-1"))).toThrow(RangeError);
    expect(() => commissionMinor(parseMinor("100"), 10001)).toThrow(RangeError);
  });
});
