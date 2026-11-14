# REPORTE GF-U05-05 — Parte 2: Respuestas a preguntas obligatorias (1-6)

## A01-G06 — Pregunta 1: Fuente autoritativa de turnos
**Respuesta:** La fuente autoritativa de un turno (reserva) es `booking.reservations`, cuya fila representa el turno con `starts_at`/`ends_at` (slot visible al cliente) y `occupied_starts_at`/`occupied_ends_at` (bloque real ocupado en la agenda del profesional). El estado del turno vive en `reservations.status` (`CONFIRMED` / `CANCELLED`), y la ocupación física del recurso se refleja en `availability.resource_allocations` vinculada vía `reservations.current_allocation_id`.
**Archivo:línea:** `packages/database/src/booking.ts:16-56`; `supabase/migrations/202611050002_h03_u04_booking.sql:13-57`

## A01-G06 — Pregunta 2: Dónde se registra la ocupación real
**Respuesta:** La ocupación real del profesional se registra en `availability.resource_allocations` (campos `occupied_start_at`/`occupied_end_at` y `occupied_range` de tipo `tstzrange`), con `status='ACTIVE'` y `source_type='RESERVATION'` apuntando a la reserva. La integridad bidireccional Reserva↔Asignación se impone mediante triggers diferibles `assert_reservation_allocation_integrity` (un `CONFIRMED` requiere exactamente 1 allocation ACTIVE coincidente; un `CANCELLED` no debe tener allocations ACTIVE).
**Archivo:línea:** `packages/database/src/availability.ts:82-93`; `supabase/migrations/202611050001_h03_u03_availability.sql:165-202`; `supabase/migrations/202611050002_h03_u04_booking.sql:208-301`

## A01-G06 — Pregunta 3: Cómo se distingue una reserva cancelada
**Respuesta:** Se distingue por el CHECK `status_cancelled_consistency`: `(status = 'CONFIRMED' and cancelled_at is null) or (status = 'CANCELLED' and cancelled_at is not null)`. Una reserva cancelada tiene `status='CANCEL'` y `cancelled_at` poblado; una confirmada tiene `status='CONFIRMED'` y `cancelled_at IS NULL`. Además, el trigger impone que una reserva `CANCELLED` no retenga `resource_allocations` ACTIVE.
**Archivo:línea:** `packages/database/src/booking.ts:49`; `supabase/migrations/202611050002_h03_u04_booking.sql:44-45, 246-256`

## A01-G06 — Pregunta 4: Cómo se conserva el historial de reprogramaciones
**Respuesta:** Mediante la tabla append-only `booking.reservation_events` con `sequence` (monotónico por reserva), `before_revision`/`after_revision`, `changes` (JSONB del diff), `event_type`, `reason_code`, `audit_reference`, `occurred_at`, y vínculo a `operation_attempts`. Las reprogramaciones quedan como eventos con el cambio de `starts_at`/`ends_at`/`occupied_*` entre revisiones. Hay un trigger `reservation_events_immutable` que rechaza cualquier UPDATE/DELETE (errcode 55000), haciendo el historial inmutable. Cada reserva lleva `revision` (bigint, >=1) que se incrementa con cada modificación.
**Archivo:línea:** `packages/database/src/booking.ts:16-20, 85-106`; `supabase/migrations/202611050002_h03_u04_booking.sql:91-122`

## A01-G06 — Pregunta 5: Qué tablas requiere consultar la Agenda (U05)
**Respuesta:** Para renderizar una agenda día/semana/profesional la Agenda debe consultar:
1. `availability.resource_allocations` — ocupación real del profesional (occupied_range, status ACTIVE).
2. `booking.reservations` — turnos confirmados y cancelados (starts_at/ends_at, status, staff_member_id, business_local_date).
3. `booking.reservation_items` — servicios asignados a cada turno (duración, buffers, precio).
4. `team.staff_members` — catálogo de profesionales del negocio.
5. `catalog.services` / `catalog.service_terms_versions` — nombre y precio del servicio (snapshot ya está en reservation_items, pero el catálogo da nombre vigente).
6. `availability.commitment_conflicts` — conflictos abiertos que afectan disponibilidad (opcional, para mostrar alertas).
7. `team.staff_effective_unavailability` — ausencias/bloqueos operativos del profesional (opcional, para bloquear franjas).
8. `business.business_hours_configs` / `business_hours_intervals` / `business_date_exceptions` — horario de negocio y excepciones (para validar franjas disponibles).
**Archivo:línea:** `packages/database/src/availability.ts:70-81, 82-104`; `packages/database/src/booking.ts:16-83`; `packages/database/src/schedules.ts:14-42`; `packages/database/src/catalog.ts:7-53`

## A01-G06 — Pregunta 6: ¿Puede obtener info sin duplicar persistencia?
**Respuesta:** Sí, parcialmente. `booking.reservation_items` ya snapshotpea `service_name_snapshot`, `duration_minutes`, `pre/post_buffer_minutes`, `price_minor` y `conditions_snapshot`, por lo que la Agenda puede obtener el detalle del servicio sin unir `catalog.services` en tiempo de lectura (evita depender de versión vigente del catálogo). El nombre legible del profesional y del negocio requiere unir `team.staff_members` → `iam.persons` y `business.businesses`. No hay tabla de lectura denormalizada (no existe `agenda_read_model` ni vista materializada); toda la info se obtiene por joins sobre las tablas fuente sin duplicar persistencia adicional.
**Archivo:línea:** `packages/database/src/booking.ts:58-83`; `packages/database/src/catalog.ts:18-34`

---

## (Parte 2 de 4 — se continúa en Parte 3 con preguntas 7-12)
