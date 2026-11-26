import { describe, expect, it } from "vitest";
import {
  blockCompletions, indicatorDefinitions, indicatorIds, readStates,
  reportingHistoryQuerySchema, reportingIntervalQuerySchema, type Capability
} from "@youngkingz/contracts";
import { assertCapability, decodeHistoryCursor, decodeOccupancyCursor, encodeHistoryCursor, encodeOccupancyCursor, requireRole, resolveInterval } from "../../../apps/api/src/modules/reporting/dto.js";
import { reportingCriticality } from "../../../apps/api/src/modules/reporting/queries.js";

describe("H09 · contrato de estados y DTO", () => {
  it("ReadState y completeness son exactamente los del contrato (sin variantes de dominio)", () => {
    expect([...readStates]).toEqual([
      "LOADING", "SUCCESS", "ZERO", "EMPTY", "NOT_APPLICABLE",
      "NOT_CONFIGURED", "UNKNOWN", "ERROR_RECOVERABLE", "DENIED"
    ]);
    expect([...blockCompletions]).toEqual(["COMPLETE", "PARTIAL", "INCOMPLETE", "UNKNOWN", "NOT_CONFIGURED"]);
  });

  it("catálogo reconciliado: 17 indicadores únicos M01..M17", () => {
    expect(indicatorIds).toHaveLength(17);
    expect(Object.keys(indicatorDefinitions).sort()).toEqual([...indicatorIds].sort());
    expect(indicatorDefinitions.M17.formula).toContain("sin audit_events.changes");
  });

  it("intervalo semiabierto: to debe ser posterior a from y fecha local válida", () => {
    expect(() => reportingIntervalQuerySchema.parse({ from: "2026-11-26", to: "2026-11-25" })).toThrow();
    expect(() => reportingIntervalQuerySchema.parse({ from: "2026-11-25", to: "2026-11-26" })).not.toThrow();
    expect(() => reportingHistoryQuerySchema.parse({ from: "26/11/2026" })).toThrow();
  });

  it("jornada local: medianoche Argentina 24h; DST real 23h/25h sin sumar día ni restar ms", () => {
    const argentina = resolveInterval({ timezone: "America/Argentina/Buenos_Aires", today: "2026-11-25", asOf: "2026-11-25T12:00:00.000Z" }, "2026-11-25", "2026-11-26");
    expect((argentina.toInstant.getTime() - argentina.fromInstant.getTime()) / 3_600_000).toBe(24);
    const spring = resolveInterval({ timezone: "America/New_York", today: "2026-03-08", asOf: "2026-03-08T12:00:00.000Z" }, "2026-03-08", "2026-03-09");
    expect((spring.toInstant.getTime() - spring.fromInstant.getTime()) / 3_600_000).toBe(23);
    const fall = resolveInterval({ timezone: "America/New_York", today: "2026-11-01", asOf: "2026-11-01T12:00:00.000Z" }, "2026-11-01", "2026-11-02");
    expect((fall.toInstant.getTime() - fall.fromInstant.getTime()) / 3_600_000).toBe(25);
    expect(argentina.interval.from).toBe(argentina.fromInstant.toISOString());
    expect(argentina.interval.to).toBe(argentina.toInstant.toISOString());
  });

  it("cursores mal formados se rechazan con 400 antes de castear en SQL", () => {
    expect(() => decodeHistoryCursor(Buffer.from(JSON.stringify({ occurredAt: "no-date", objectId: "x", sequence: null, eventId: "e" })).toString("base64url"))).toThrow(/Invalid history cursor/);
    expect(() => decodeHistoryCursor(Buffer.from(JSON.stringify({ occurredAt: "2026-11-25T00:00:00Z", objectId: "not-uuid", sequence: 1, eventId: "e" })).toString("base64url"))).toThrow(/Invalid history cursor/);
    expect(() => decodeHistoryCursor(Buffer.from(JSON.stringify({ occurredAt: "2026-11-25T00:00:00Z", objectId: "11111111-1111-4111-8111-111111111111", sequence: 1.5, eventId: "e" })).toString("base64url"))).toThrow(/Invalid history cursor/);
    expect(() => decodeOccupancyCursor(Buffer.from("no-date|not-uuid").toString("base64url"))).toThrow(/Invalid course occupancy cursor/);
  });

  it("__CONFLICT__ se niega aunque la capability esté presente", () => {
    const actor = {
      role: "OWNER", capabilities: new Set<Capability>(["money.create"]),
      grantScopes: new Map([[ "money.create" as Capability, { staffMemberId: "__CONFLICT__" } ]])
    } as never;
    expect(() => assertCapability(actor, "money.create")).toThrow(/conflicting grants/);
    expect(() => requireRole(actor, ["BARBER"])).toThrow(/Insufficient role/);
  });
});

describe("H09 · M09 criticidad", () => {
  it("prioridad NEGATIVE → NO_POSITION → ZERO → UNCONFIGURED → LOW/OK; minimum NULL ≠ 0", () => {
    expect(reportingCriticality(-1, 5, true)).toBe("NEGATIVE");
    expect(reportingCriticality(-1, null, true)).toBe("NEGATIVE");
    expect(reportingCriticality(0, 10, false)).toBe("NO_POSITION");
    expect(reportingCriticality(0, 10, true)).toBe("ZERO");
    expect(reportingCriticality(4, null, true)).toBe("UNCONFIGURED");
    expect(reportingCriticality(4, 0, true)).toBe("OK");
    expect(reportingCriticality(4, 5, true)).toBe("LOW");
    expect(reportingCriticality(5, 5, true)).toBe("OK");
  });
});

describe("H09 · cursor mixto null-safe (Q09-38) y cursor separado (Q09-38b)", () => {
  type Row = { occurredAt: string; objectId: string; sequence: number | null; eventId: string };

  const compare = (a: Row, b: Row): number => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt > b.occurredAt ? -1 : 1;
    if (a.objectId !== b.objectId) return a.objectId < b.objectId ? -1 : 1;
    if (a.sequence === null && b.sequence === null) return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    if (a.sequence === null) return 1;
    if (b.sequence === null) return -1;
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  };

  const after = (row: Row, cursor: Row): boolean => {
    if (row.occurredAt < cursor.occurredAt) return true;
    if (row.occurredAt > cursor.occurredAt) return false;
    if (row.objectId > cursor.objectId) return true;
    if (row.objectId < cursor.objectId) return false;
    if (cursor.sequence !== null) {
      if (row.sequence !== null && row.sequence > cursor.sequence) return true;
      if (row.sequence === null) return true;
    }
    if (row.sequence === cursor.sequence) return row.eventId > cursor.eventId;
    return false;
  };

  const fixture: Row[] = [
    { occurredAt: "2026-11-25T12:00:00.000Z", objectId: "b", sequence: null, eventId: "sales:2" },
    { occurredAt: "2026-11-25T12:00:00.000Z", objectId: "a", sequence: 2, eventId: "booking:2" },
    { occurredAt: "2026-11-25T12:00:00.000Z", objectId: "a", sequence: 1, eventId: "booking:1" },
    { occurredAt: "2026-11-25T12:00:00.000Z", objectId: "a", sequence: null, eventId: "money:1" },
    { occurredAt: "2026-11-25T12:00:00.000Z", objectId: "a", sequence: null, eventId: "money:2" },
    { occurredAt: "2026-11-25T11:00:00.000Z", objectId: "z", sequence: 1, eventId: "attendance:1" }
  ].sort(compare);

  it("paginación sin pérdidas ni duplicados con sequence NULL y empates", () => {
    const collected: string[] = [];
    let cursor: Row | null = null;
    for (let page = 0; page < 10; page += 1) {
      const rows = fixture.filter((row) => cursor === null || after(row, cursor)).slice(0, 2);
      if (!rows.length) break;
      collected.push(...rows.map((row) => row.eventId));
      cursor = rows.at(-1)!;
    }
    expect(collected).toEqual(fixture.map((row) => row.eventId));
    expect(new Set(collected).size).toBe(fixture.length);
  });

  it("cursor opaco conserva sequence NULL y no se mezcla con el de courseOccupancy", () => {
    const original: Row = { occurredAt: "2026-11-25T12:00:00.000Z", objectId: "11111111-1111-4111-8111-111111111111", sequence: null, eventId: "money.money_operations:11111111-1111-4111-8111-111111111111" };
    expect(decodeHistoryCursor(encodeHistoryCursor(original))).toEqual(original);
    const occupancy = encodeOccupancyCursor("2026-11-25T09:00:00.000Z", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(decodeOccupancyCursor(occupancy)).toEqual({ startsAt: "2026-11-25T09:00:00.000Z", allocationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(() => decodeHistoryCursor(occupancy)).toThrow();
  });
});
