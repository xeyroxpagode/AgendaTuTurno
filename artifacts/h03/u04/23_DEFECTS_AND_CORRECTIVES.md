# 23 — DEFECTS AND CORRECTIVES (G23)

1. **availability.spec.ts — fecha fija en el pasado (U03, preexistente).** Test "protects H02 schedule…" usaba `2026-11-05` ya pasado vs `now()` SQL. Correctivo: cambiar a `2099-11-05`. Suite 44/44 → 64/64.
2. **operation_attempts principal_kind.** Migración aditiva con `add column if not exists` + `drop/add constraint if exists` para idempotencia de re-runs. NOTICE esperado en reset.
3. **catalog.service_terms_versions** carecía de `unique (business_id, id)`; se añadió de forma aditiva para FK compuestas tenant-safe.
4. **Deferrable trigger timing** para `current_allocation_id`: el check por reserva en INSERT veía null; se movió la validación de `current_allocation_id` al lado de la Allocation (lectura fresca en commit) y la verificación de enlace se garantiza en la aplicación (confirm/cancel/reschedule).
5. **postgres.js timestamps** llegan como strings (prepare:false): cancel/reschedule convierten con `new Date(...)` antes de `.toISOString()`.
6. **SQL templating**: interpolaciones dentro de literales SQL (`'${x}'`) generan parámetros inválidos; corregido usando parámetros directos o `interval '1 hour' * n`.
7. **U03 tests** adaptados a la nueva invariante Reservation↔Allocation mediante fixtures (`reservation-fixtures.ts`) que crean la reserva CONFIRMED vinculada; sin debilitar aserciones.
8. **Recovery asistida** queda fail-closed por ausencia de canal real (documentado, no fingido).
9. **CLIENT** bloqueado por ausencia de U02 (no se fabricó identidad).
No hay defectos HIGH/CRITICAL abiertos en U04 salvo los bloqueos externos declarados.
