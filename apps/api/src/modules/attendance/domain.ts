/**
 * H03.U06 · CAP-03-08 · Prestación real (Attendance) — dominio puro.
 *
 * Attendance representa lo que OCURRIÓ en la barbería:
 *
 *   registrar (desde reserva o walk-in)
 *        │
 *        ▼
 *   IN_PROGRESS (opcional) ──► COMPLETED   (terminal)
 *                          ├─► PARTIAL    (terminal)
 *                          └─► INTERRUPTED(terminal)
 *
 * Invariantes (B01 §4.8):
 *  · INV-ATT-01 Attendance ≠ Reservation.
 *  · INV-ATT-02 La llegada (`arrival`) NO implica atención.
 *  · INV-ATT-03 El no-show NO genera atención.
 *  · INV-ATT-04 Un walk-in NO exige Reservation ficticia (`reservation_id` nullable).
 *  · INV-ATT-05 Un walk-in NO crea cuenta CLIENT.
 *  · INV-ATT-06 Un walk-in NO genera Sale, Payment ni movimientos de stock.
 *  · INV-ATT-07 `IN_PROGRESS` no es obligatorio: se puede registrar ya terminal.
 *  · INV-ATT-08 Las correcciones conservan trazabilidad (no se borra nada).
 */
import { DomainError } from "@youngkingz/contracts";
import type { AttendanceStatus, TerminalAttendanceStatus } from "@youngkingz/contracts";

export const attendanceTerminalStatuses = ["COMPLETED", "PARTIAL", "INTERRUPTED"] as const;

/** Estados terminales: una atención terminal no se reabre por registro, sólo por corrección. */
export function isTerminalAttendance(status: AttendanceStatus): boolean {
  return attendanceTerminalStatuses.includes(status as TerminalAttendanceStatus);
}

/**
 * Transición de estado de la atención.
 * Sólo se admite `IN_PROGRESS → terminal`. Un terminal no se reabre: la
 * Persistencia lo garantiza además con el índice único parcial
 * `attendances_one_terminal_per_reservation`.
 */
export function assertAttendanceTransition(from: AttendanceStatus, to: AttendanceStatus): void {
  if (!isTerminalAttendance(to)) {
    throw new DomainError("VALIDATION_ERROR", `Invalid attendance state ${to}`, 400, { to });
  }
  if (from !== "IN_PROGRESS") {
    throw new DomainError("CONFLICT", `Attendance is already ${from} (terminal state)`, 409, { from, to });
  }
}

/**
 * Coherencia entre la forma del registro y sus invariantes.
 * · Con reserva: `walk_in` es falso.
 * · Sin reserva (walk-in): `walk_in` es verdadero y hay contacto mínimo.
 */
export function assertAttendanceShape(input: {
  reservationId?: string | null;
  walkIn: boolean;
  hasContact: boolean;
  hasClientProfile: boolean;
}): void {
  const hasReservation = Boolean(input.reservationId);
  if (hasReservation && input.walkIn) {
    throw new DomainError("VALIDATION_ERROR", "A walk-in cannot reference a reservation", 400);
  }
  if (!hasReservation && !input.walkIn) {
    throw new DomainError("VALIDATION_ERROR", "An attendance requires a reservation or the walk-in flag", 400);
  }
  if (input.walkIn && !input.hasContact) {
    throw new DomainError("VALIDATION_ERROR", "A walk-in requires the contact name and phone", 400);
  }
  if (input.walkIn && input.hasClientProfile) {
    // No se vincula una ficha CRM desde un walk-in: eso exigiría acreditación.
    throw new DomainError("VALIDATION_ERROR", "A walk-in cannot be linked to a client profile", 400);
  }
}
