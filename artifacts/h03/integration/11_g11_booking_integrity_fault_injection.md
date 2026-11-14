# 11 — G11 Integridad Booking + fault injection

- `booking-integrity.spec.ts`: 17/17 PASS (incluye F01-3 cross-business allocation → SQLSTATE 23514).
- `booking-fault-injection.spec.ts`: 5/5 PASS (doble confirmación, cancel/reschedule concurrentes, dos reprogramaciones concurrentes, rollback Reservation↔Claim, idempotencia multi-principal).
- `booking-principals.spec.ts` y `booking-confirm.spec.ts` PASS.
- Estado final PostgreSQL verificado: sin huérfanos ni duplicados.
- Veredicto: G11 PASS.