# 03 — RESERVATION DOMAIN (G03)

**Estado:** VERIFIED_PASS

Módulo puro `apps/api/src/modules/booking/domain/reservation.ts`: `computeReservationSnapshot` (D13, duración/buffers/precio, total exacto), `toPolicySnapshot`, `cutoffAllows` (inclusivo en segundos), `assertStatusTransition` (CONFIRMED→CANCELLED terminal), `assertExpectedRevision`, `nextEventSequence`, `sanitizedChanges`.

Pruebas: `tests/h03/unit/booking-reservation.spec.ts` — 10/10 PASS (valid, D13, precio negativo, moneda inválida, duración cero, selección vacía/>10, snapshot histórico, cutoff inclusivo, transición terminal, revisión stale, orden de eventos, cambios sanitizados).
