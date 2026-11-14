/**
 * H03.U06 · CAP-03-07 · Ausencias — dominio puro (sin I/O ni reloj implícito).
 *
 * Autoridad de la máquina de estados de la solicitud de ausencia:
 *
 *            solicitar
 *   (ninguno) ────────▶ PENDING
 *                         │
 *            aprobar ────┤   rechazar (desde PENDING/APPROVED)
 *                         ▼                   │
 *                      APPROVED ◀────────────┘
 *                         │
 *            aplicar (conflictos resueltos)
 *                         ▼
 *                      APPLIED   (terminal)
 *                         │
 *            retirar (desde PENDING/APPROVED)
 *                         ▼
 *                      WITHDRAWN (terminal)
 *
 * Invariantes (B01 §01):
 *  · INV-ABS-01 `PENDING` no bloquea disponibilidad.
 *  · INV-ABS-02 `APPROVED` no cancela reservas automáticamente.
 *  · INV-ABS-03 `APPLIED` sólo con los compromisos incompatibles resueltos.
 */
import { DomainError } from "@youngkingz/contracts";
import type { AbsenceStatus } from "@youngkingz/contracts";

export const absenceTerminalStatuses = ["APPLIED", "REJECTED", "WITHDRAWN"] as const;
export type AbsenceTerminalStatus = (typeof absenceTerminalStatuses)[number];

/** Transiciones válidas de la solicitud de ausencia. */
export const absenceTransitions: Readonly<Record<AbsenceStatus, readonly AbsenceStatus[]>> = {
  PENDING: ["APPROVED", "REJECTED", "WITHDRAWN"],
  APPROVED: ["APPLIED", "REJECTED", "WITHDRAWN"],
  APPLIED: [],
  REJECTED: [],
  WITHDRAWN: []
};

/** ¿La transición es válida según la máquina de estados congelada? */
export function isAbsenceTransitionAllowed(from: AbsenceStatus, to: AbsenceStatus): boolean {
  return absenceTransitions[from].includes(to);
}

/**
 * Valida la transición solicitada. Una transición inválida es un conflicto de
 * dominio (409 CONFLICT), no una validación de forma (400).
 */
export function assertAbsenceTransition(from: AbsenceStatus, to: AbsenceStatus): void {
  if (isAbsenceTransitionAllowed(from, to)) return;
  if (absenceTerminalStatuses.includes(from as AbsenceTerminalStatus)) {
    throw new DomainError("CONFLICT", `Absence is already ${from} (terminal state)`, 409, { from, to });
  }
  throw new DomainError("CONFLICT", `Invalid absence transition ${from} -> ${to}`, 409, { from, to });
}

/**
 * Valida el intervalo local `[startMinute, endMinute)` de la ausencia.
 * El intervalo es de minutos desde la medianoche del día local del Business.
 */
export function assertAbsenceInterval(startMinute: number, endMinute: number): void {
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) {
    throw new DomainError("VALIDATION_ERROR", "Absence interval must use whole minutes", 400);
  }
  if (startMinute < 0 || startMinute > 1439) {
    throw new DomainError("VALIDATION_ERROR", "startMinute must be between 0 and 1439", 400, { startMinute });
  }
  if (endMinute < 1 || endMinute > 1440) {
    throw new DomainError("VALIDATION_ERROR", "endMinute must be between 1 and 1440", 400, { endMinute });
  }
  if (startMinute >= endMinute) {
    throw new DomainError("VALIDATION_ERROR", "startMinute must be before endMinute", 400, { startMinute, endMinute });
  }
}

/**
 * ¿Se solapan dos intervalos locales `[aStart, aEnd)` y `[bStart, bEnd)`?
 * Dos intervalos que sólo se tocan en el borde NO se solapan.
 */
export function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Formatea un minuto local como `HH:mm` (para snapshots y respuestas). */
export function minuteToClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
