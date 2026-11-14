# 08 — RESERVATION/ALLOCATION INTEGRITY (G08)

**Estado:** VERIFIED_PASS

Triggers diferibles `reservations_allocation_integrity` y `allocations_reservation_integrity` + `reservations_no_delete`/`allocations_no_delete` (55000). La DB rechaza: CONFIRMED sin Allocation, Allocation RESERVATION huérfana, doble ACTIVE por fuente, Staff/intervalo/local_date cruzados, CANCELLED con ACTIVE, cross-tenant FK, D13 duplicado, posición duplicada, anon/authenticated direct read (42501), mutación/borrado de eventos (55000). Ver `booking-integrity.spec.ts` (17/17 PASS, PostgreSQL real).
