import { createHash } from "node:crypto";
import { DomainError, type ServiceRequirement } from "@youngkingz/contracts";
import type { CanonicalInterval } from "../schedules/domain.js";

export type OperationalSequence = {
  visibleStartMinute: number;
  visibleEndMinute: number;
  occupiedStartMinute: number;
  occupiedEndMinute: number;
  visibleMinutes: number;
  occupiedMinutes: number;
  steps: Array<{ serviceId: string; preparationStartMinute: number; serviceStartMinute: number; serviceEndMinute: number; occupiedEndMinute: number }>;
};

export function normalizeIntervals(input: ReadonlyArray<CanonicalInterval>): CanonicalInterval[] {
  const ordered = input.map(item => ({ ...item })).sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
  const result: CanonicalInterval[] = [];
  for (const item of ordered) {
    if (item.startMinute >= item.endMinute) throw new DomainError("VALIDATION_ERROR", "Interval must be non-empty", 400);
    const last = result.at(-1);
    if (!last || item.startMinute > last.endMinute) result.push(item);
    else last.endMinute = Math.max(last.endMinute, item.endMinute);
  }
  return result;
}

export function intersectIntervals(left: ReadonlyArray<CanonicalInterval>, right: ReadonlyArray<CanonicalInterval>): CanonicalInterval[] {
  const a = normalizeIntervals(left); const b = normalizeIntervals(right); const result: CanonicalInterval[] = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    const startMinute = Math.max(a[i]!.startMinute, b[j]!.startMinute);
    const endMinute = Math.min(a[i]!.endMinute, b[j]!.endMinute);
    if (startMinute < endMinute) result.push({ startMinute, endMinute });
    if (a[i]!.endMinute <= b[j]!.endMinute) i++; else j++;
  }
  return result;
}

export function subtractIntervals(base: ReadonlyArray<CanonicalInterval>, blocked: ReadonlyArray<CanonicalInterval>): CanonicalInterval[] {
  let result = normalizeIntervals(base);
  for (const cut of normalizeIntervals(blocked)) {
    result = result.flatMap(interval => {
      if (cut.endMinute <= interval.startMinute || cut.startMinute >= interval.endMinute) return [interval];
      const pieces: CanonicalInterval[] = [];
      if (cut.startMinute > interval.startMinute) pieces.push({ startMinute: interval.startMinute, endMinute: cut.startMinute });
      if (cut.endMinute < interval.endMinute) pieces.push({ startMinute: cut.endMinute, endMinute: interval.endMinute });
      return pieces;
    });
  }
  return result;
}

export function intervalContains(intervals: ReadonlyArray<CanonicalInterval>, startMinute: number, endMinute: number): boolean {
  return startMinute < endMinute && intervals.some(interval => interval.startMinute <= startMinute && endMinute <= interval.endMinute);
}

export function totalMinutes(intervals: ReadonlyArray<CanonicalInterval>): number {
  return normalizeIntervals(intervals).reduce((sum, interval) => sum + interval.endMinute - interval.startMinute, 0);
}

export function composeServiceSequence(visibleStartMinute: number, services: ReadonlyArray<ServiceRequirement>): OperationalSequence {
  if (!services.length) throw new DomainError("VALIDATION_ERROR", "At least one Service is required", 400);
  let cursor = visibleStartMinute;
  const occupiedStartMinute = visibleStartMinute - services[0]!.preBufferMinutes;
  const steps: OperationalSequence["steps"] = [];
  let visibleEndMinute = visibleStartMinute;
  services.forEach((service, index) => {
    if (index > 0) cursor += service.preBufferMinutes;
    const serviceStartMinute = cursor;
    cursor += service.durationMinutes;
    const serviceEndMinute = cursor;
    visibleEndMinute = serviceEndMinute;
    cursor += service.postBufferMinutes;
    steps.push({
      serviceId: service.id,
      preparationStartMinute: index === 0 ? occupiedStartMinute : serviceStartMinute - service.preBufferMinutes,
      serviceStartMinute, serviceEndMinute, occupiedEndMinute: cursor
    });
  });
  return {
    visibleStartMinute, visibleEndMinute, occupiedStartMinute, occupiedEndMinute: cursor,
    visibleMinutes: visibleEndMinute - visibleStartMinute,
    occupiedMinutes: cursor - occupiedStartMinute,
    steps
  };
}

export function addLocalDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function partsAt(instant: Date, timezone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(instant);
  } catch {
    throw new DomainError("BOOKING_POLICY_INVALID", "Business timezone is invalid", 409, { timezone });
  }
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}

function offsetAt(instant: Date, timezone: string): number {
  const p = partsAt(instant, timezone);
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime()) / 60000;
}

export function businessLocalDate(now: Date, timezone: string): string {
  const p = partsAt(now, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * Minuto del día en la zona horaria del Business para un instante dado.
 * Permite reconstruir el `visibleStartMinute` local de una reserva persistida
 * sin depender del reloj del servidor ni del desfase UTC.
 */
export function businessLocalMinuteOfDay(instant: Date, timezone: string): number {
  const p = partsAt(instant, timezone);
  return p.hour * 60 + p.minute;
}

export function localDateTimeToInstant(localDate: string, minuteOfDay: number, timezone: string): Date {
  const adjustedDate = minuteOfDay === 1440 ? addLocalDays(localDate, 1) : localDate;
  const adjustedMinute = minuteOfDay === 1440 ? 0 : minuteOfDay;
  const [year, month, day] = adjustedDate.split("-").map(Number);
  const hour = Math.floor(adjustedMinute / 60); const minute = adjustedMinute % 60;
  const naive = Date.UTC(year!, month! - 1, day!, hour, minute, 0);
  const offsets = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 6) offsets.add(offsetAt(new Date(naive + delta * 3_600_000), timezone));
  const candidates = [...offsets].map(offset => new Date(naive - offset * 60_000)).filter(candidate => {
    const p = partsAt(candidate, timezone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute && p.second === 0;
  });
  const unique = [...new Map(candidates.map(candidate => [candidate.getTime(), candidate])).values()];
  if (unique.length !== 1) throw new DomainError("TIMEZONE_AMBIGUOUS", "Local time is nonexistent or ambiguous in the Business timezone", 409, { localDate, minuteOfDay, timezone, matches: unique.length });
  return unique[0]!;
}

export function assertWithinHorizon(requestedDate: string, today: string, horizonCalendarDates: number): void {
  const last = addLocalDays(today, horizonCalendarDates - 1);
  if (requestedDate < today || requestedDate > last) throw new DomainError("OUTSIDE_BOOKING_HORIZON", "Date is outside the booking horizon", 400, { firstDate: today, lastDate: last });
}

export function compareRelativeLoad(a: { confirmedMinutes: number; capacityMinutes: number }, b: { confirmedMinutes: number; capacityMinutes: number }): number {
  if (a.capacityMinutes <= 0 || b.capacityMinutes <= 0) throw new DomainError("VALIDATION_ERROR", "Capacity must be positive", 400);
  return a.confirmedMinutes * b.capacityMinutes - b.confirmedMinutes * a.capacityMinutes;
}

export function deterministicCandidateOrder(seed: string, candidateIds: readonly string[]): string[] {
  return [...candidateIds].sort((a, b) => {
    const ha = createHash("sha256").update(`${seed}:${a}`).digest("hex");
    const hb = createHash("sha256").update(`${seed}:${b}`).digest("hex");
    return ha.localeCompare(hb) || a.localeCompare(b);
  });
}

export function formatMinute(minute: number): string {
  if (minute === 1440) return "24:00";
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function parseClock(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new DomainError("VALIDATION_ERROR", "Time must be HH:mm", 400);
  return Number(match[1]) * 60 + Number(match[2]);
}
