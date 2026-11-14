# 15 — STAFF EXCEPTIONS (G15)

**Estado:** VERIFIED_PASS

`modules/booking/commands/staff-exceptions.ts`: `staffExceptionCancel`/`staffExceptionReschedule` requieren capability `bookings.override.cancel`/`bookings.override.reschedule`, motivo ≥3 chars, bypass de cutoff público, validación U03 (guard + GiST), auditoría. Sin Agenda Staff completa (U05 fuera de alcance).
Rutas: `POST /v1/staff/bookings/:id/override-cancel`, `.../override-reschedule`.
