# 12 — CANCEL BOOKING (G12)

**Estado:** VERIFIED_PASS

`modules/booking/commands/cancel.ts` (`cancelBooking`): autorización por principal (STAFF/CLIENT/GUEST_RESERVATION), idempotencia, guard Business, lock Reservation, expectedRevision, estado, cutoff histórico inclusivo en segundos (policy snapshot), Release U03, CANCELLED, evento + auditoría, commit. Repetición idempotente. CANCELLED terminal en U04.

Verificado en E2E (`booking-confirm.spec.ts`): cancelación dentro de ventana libera la Allocation (status RELEASED). Tests de frontera de cutoff (13:59:59/14:00:00/14:00:01) cubiertos a nivel de dominio (`cutoffAllows`, unit).
