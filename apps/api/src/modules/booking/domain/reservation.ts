/**
 * H03.U04 · Reservation domain — puro, sin I/O ni fechas implícitas.
 *
 * Autoridad comercial de Reservation: identidad permanente, snapshots históricos,
 * servicios distintos y ordenados, transición CONFIRMED→CANCELLED terminal,
 * revisión monótona y totales exactos. No reimplementa disponibilidad (U03).
 */
import { DomainError } from "@youngkingz/contracts";
import type { PolicySnapshot } from "@youngkingz/contracts";

export const RESERVATION_MAX_ITEMS = 10;
export const SUPPORTED_CURRENCY = "ARS" as const;

export type ReservationItemInput = {
  serviceId: string;
  serviceName: string;
  termsVersionId: string;
  durationMinutes: number;
  preBufferMinutes: number;
  postBufferMinutes: number;
  priceMinor: number;
  currency: string;
  conditions?: string | null;
};

export type ComputedReservationItem = ReservationItemInput & {
  position: number;
  currency: typeof SUPPORTED_CURRENCY;
};

export type ComputedReservationSnapshot = {
  items: ComputedReservationItem[];
  commercialTotalMinor: number;
  currency: typeof SUPPORTED_CURRENCY;
};

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new DomainError("VALIDATION_ERROR", `${field} must not be empty`, 400);
}

/**
 * Valida servicios distintos y ordenados (D13), duraciones exactas y precios.
 * Devuelve ítems con posición 1..n y total exacto en minor units.
 */
export function computeReservationSnapshot(items: ReadonlyArray<ReservationItemInput>): ComputedReservationSnapshot {
  if (items.length < 1) throw new DomainError("VALIDATION_ERROR", "At least one Service is required", 400);
  if (items.length > RESERVATION_MAX_ITEMS) throw new DomainError("VALIDATION_ERROR", `At most ${RESERVATION_MAX_ITEMS} Services per reservation`, 400);

  const seen = new Set<string>();
  let total = 0;
  const computed = items.map((item, index): ComputedReservationItem => {
    assertNonEmpty(item.serviceId, "serviceId");
    assertNonEmpty(item.serviceName, "serviceName");
    assertNonEmpty(item.termsVersionId, "termsVersionId");
    if (seen.has(item.serviceId)) throw new DomainError("VALIDATION_ERROR", "Service IDs must be distinct", 400, { serviceId: item.serviceId });
    seen.add(item.serviceId);
    if (!Number.isInteger(item.durationMinutes) || item.durationMinutes <= 0) throw new DomainError("VALIDATION_ERROR", "durationMinutes must be a positive integer", 400);
    if (!Number.isInteger(item.preBufferMinutes) || item.preBufferMinutes < 0) throw new DomainError("VALIDATION_ERROR", "preBufferMinutes must be >= 0", 400);
    if (!Number.isInteger(item.postBufferMinutes) || item.postBufferMinutes < 0) throw new DomainError("VALIDATION_ERROR", "postBufferMinutes must be >= 0", 400);
    if (!Number.isSafeInteger(item.priceMinor) || item.priceMinor < 0) throw new DomainError("VALIDATION_ERROR", "priceMinor must be a non-negative safe integer", 400);
    if (item.currency !== SUPPORTED_CURRENCY) throw new DomainError("VALIDATION_ERROR", `currency '${item.currency}' is not supported`, 400, { currency: item.currency });
    total += item.priceMinor;
    return { ...item, currency: SUPPORTED_CURRENCY, position: index + 1 };
  });
  if (!Number.isSafeInteger(total)) throw new DomainError("VALIDATION_ERROR", "commercial total exceeds safe integer range", 400);
  return { items: computed, commercialTotalMinor: total, currency: SUPPORTED_CURRENCY };
}

/** Política histórica activa en el momento de confirmar, congelada en la Reservation. */
export function toPolicySnapshot(policy: { id: string; versionNumber: number; revision: number; horizonCalendarDates: number; minLeadMinutes: number; startStepMinutes: number; cancelCutoffMinutes: number; rescheduleCutoffMinutes: number; publicBookingEnabled: boolean }): PolicySnapshot {
  return {
    id: policy.id,
    versionNumber: policy.versionNumber,
    revision: policy.revision,
    horizonCalendarDates: policy.horizonCalendarDates,
    minLeadMinutes: policy.minLeadMinutes,
    startStepMinutes: policy.startStepMinutes,
    cancelCutoffMinutes: policy.cancelCutoffMinutes,
    rescheduleCutoffMinutes: policy.rescheduleCutoffMinutes,
    publicBookingEnabled: policy.publicBookingEnabled,
  };
}

/**
 * Corte inclusivo en segundos de servidor (CR-09): permitido cuando
 * now <= start - cutoff, p. ej. T−120 exacto permite; T−120+1s rechaza.
 */
export function cutoffAllows(scheduledStart: Date, now: Date, cutoffMinutes: number): boolean {
  const cutoffMs = cutoffMinutes * 60_000;
  return scheduledStart.getTime() - now.getTime() >= cutoffMs;
}

/**
 * Transición de estado. Sólo se admiten las transiciones terminalmente
 * significativas; el resto de cambios (reprogramación, reasignación, llegada)
 * conservan `CONFIRMED` y no pasan por esta función.
 *
 * H03.U05: `CONFIRMED → NO_SHOW` es válida (no-show explícito, terminal).
 * `CANCELLED` y `NO_SHOW` son terminales: no admiten ninguna transición.
 *
 * H03.U06 · WP-11 · U05-CORR-06: los estados terminales tienen MENSAJE
 * DISTINTO. `NO_SHOW` no es una cancelación: el mensaje y el detalle deben
 * distinguirlo para que el error no sea engañoso en la interfaz.
 */
export function assertStatusTransition(from: "CONFIRMED" | "CANCELLED" | "NO_SHOW", to: "CANCELLED" | "NO_SHOW"): void {
  if (from === "CANCELLED") throw new DomainError("BOOKING_ALREADY_CANCELLED", "Reservation is already cancelled (terminal state)", 409, { status: from });
  if (from === "NO_SHOW") throw new DomainError("BOOKING_ALREADY_CANCELLED", "Reservation is already a NO_SHOW (terminal state)", 409, { status: from });
  if (from !== "CONFIRMED") throw new DomainError("VALIDATION_ERROR", `Invalid status transition ${from} → ${to}`, 400);
  if (to !== "CANCELLED" && to !== "NO_SHOW") throw new DomainError("VALIDATION_ERROR", `Invalid status transition ${from} → ${to}`, 400);
}

export function assertExpectedRevision(current: number, expected: number): void {
  if (!Number.isInteger(expected) || expected !== current) {
    throw new DomainError("STALE_REVISION", "expectedRevision does not match the current revision", 409, { currentRevision: current });
  }
}

/** Orden explícito para reservation_events: secuencia monótona por reserva. */
export function nextEventSequence(existing: ReadonlyArray<{ sequence: number }>): number {
  return existing.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
}

/** Cambios sanitizados para el historial: nunca secretos ni contactos completos. */
export function sanitizedChanges(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { before: unknown; after: unknown }> {
  const result: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) result[key] = { before: before[key] ?? null, after: after[key] ?? null };
  }
  return result;
}
