# 02 — DATABASE AND INTEGRITY (G02)

**Estado:** VERIFIED_PASS

Migración aditiva `supabase/migrations/202611050002_h03_u04_booking.sql` aplicada (reset local verificado con `assert-local-supabase.ps1`).

Esquema `booking`: `reservations`, `reservation_items`, `reservation_events` (append-only, trigger 55000), `guest_credentials` (digest, unique ACTIVE por reserva), `guest_delivery_envelopes` (bytea, key_version, TTL), `guest_recovery_cases`.

Extensiones aditivas a `system.operation_attempts`: `principal_kind` (STAFF/CLIENT/GUEST_INTENT/GUEST_RESERVATION) + `principal_ref`, índice. `catalog.service_terms_versions` ganó `unique (business_id, id)` para FK tenant-safe.

Integridad bidireccional Reservation↔Allocation: triggers diferibles `reservations_allocation_integrity` y `allocations_reservation_integrity` (G08). RLS + grants mínimos (service_role all; anon/authenticated revoke). Sin escritura directa anon/authenticated.

Pruebas: `tests/h03/integration/booking-integrity.spec.ts` — 17/17 PASS contra PostgreSQL real (creación válida, CONFIRMED sin Allocation, Allocation huérfana, doble ACTIVE, Staff/intervalo cruzado, CANCELLED con ACTIVE, cross-tenant FK, D13 duplicado, posición duplicada, estados inválidos, RLS anon/authenticated, append-only events, borrado prohibido).

Correctivo: fecha fija `2026-11-05` en U03 availability spec estaba en el pasado; cambiada a `2099-11-05`. Suites h03: 44/44 → 64/64 tras integrar U04.
