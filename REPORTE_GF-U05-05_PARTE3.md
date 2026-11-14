# REPORTE GF-U05-05 — Parte 3: Respuestas a preguntas obligatorias (7-12)

## A01-G06 — Pregunta 7: Consultas eficientes para agendas día/semana/profesional
**Respuesta:** Las consultas eficientes se resuelven por índices compuestos tenant-safe:
- Por profesional + fecha: `resource_allocations(business_id, staff_member_id, localDate, status)` + `reservations(business_id, staff_member_id, business_local_date)`. Filtro `status='ACTIVE'` y rango `occupied_range && [inicio, fin)` para solapamiento de día/semana.
- Por negocio + fecha + estado: `reservations(business_id, status, starts_at)` para listar turnos confirmados/cancelados de un día.
- Por operación: `reservations(business_id, created_operation_id)` y `reservation_events(business_id, operation_id)` para trazabilidad.
- Reserva por allocation: `resource_allocations(business_id, source_type, source_id)` (unique parcial `one_active_allocation_per_source`).
No hay vista materializada ni tabla de lectura denormalizada; las consultas son joins en tiempo real sobre los índices indicados.
**Archivo:línea:** `packages/database/src/availability.ts:91-92, 176-202`; `packages/database/src/booking.ts:50-61`; `supabase/migrations/202611050001_h03_u03_availability.sql:191-202`; `supabase/migrations/202611050002_h03_u04_booking.sql:58-61`

## A01-G06 — Pregunta 8: Índices que respaldan esas consultas
**Respuesta:**
- `booking_reservations_business_status` (business_id, status, starts_at) — listado día por estado.
- `booking_reservations_staff_date` (business_id, staff_member_id, business_local_date) — agenda profesional por día.
- `booking_reservations_operation` (business_id, created_operation_id) — trazabilidad operación→reserva.
- `booking_reservation_items_reservation` (business_id, reservation_id) — ítems de turno.
- `booking_reservation_events_reservation` (business_id, reservation_id, sequence) — historial ordenado.
- `booking_reservation_events_operation` (business_id, operation_id) — eventos por operación.
- `resource_allocations_staff_date` (business_id, staff_member_id, localDate, status) — ocupación profesional.
- `one_active_allocation_per_source` (business_id, source_type, source_id) WHERE status='ACTIVE' — unicidad allocation activa por reserva.
- `resource_allocations_source` (business_id, source_type, source_id).
- Exclusión GiST `no_overlapping_active_allocations` (business_id, staff_member_id, occupied_range &&) WHERE status='ACTIVE' — evita solapamiento.
- `staff_effective_unavailability_lookup` (business_id, staff_member_id, localDate) WHERE released_at IS NULL — ausencias vigentes.
- `commitment_conflicts_open` (business_id, status, detected_at desc) — conflictos abiertos.
**Archivo:línea:** `packages/database/src/availability.ts:75, 91-93`; `packages/database/src/booking.ts:50-61`; `supabase/migrations/202611050001_h03_u03_availability.sql:190-202, 141-143`; `supabase/migrations/202611050002_h03_u04_booking.sql:58-61, 144-146, 165, 192`

## A01-G06 — Pregunta 9: Restricciones que impiden doble ocupación
**Respuesta:**
1. Exclusión GiST `no_overlapping_active_allocations` sobre `resource_allocations` (business_id =, staff_member_id =, occupied_range &&) WHERE status='ACTIVE' — impide que dos allocations ACTIVE del mismo profesional se solapen en el mismo rango ocupado. Requiere extensión `btree_gist` y `tstzrange`.
2. Índice parcial único `one_active_allocation_per_source` (business_id, source_type, source_id) WHERE status='ACTIVE' — una sola allocation ACTIVE por reserva (fuente).
3. CHECKs en `resource_allocations`: `occupied_start_at < occupied_end_at`, `occupied_start_at <= visible_start_at`, `visible_end_at <= occupied_end_at`, `(status='ACTIVE' and released_at is null) or (status='RELEASED' and released_at is not null)`.
4. Trigger diferible `assert_reservation_allocation_integrity`: un `CONFIRMED` requiere exactamente 1 allocation ACTIVE coincidente en staff/interval/fecha; un `CANCELLED` no debe tener allocations ACTIVE.
5. CHECKs en `reservations`: `ends_at > starts_at`, `occupied_starts_at <= starts_at`, `ends_at <= occupied_ends_at`, `occupied_starts_at < occupied_ends_at`.
**Archivo:línea:** `packages/database/src/availability.ts:87-88, 91`; `supabase/migrations/202611050001_h03_u03_availability.sql:1-2, 176-198`; `supabase/migrations/202611050002_h03_u04_booking.sql:208-301, 196-198`

## A01-G06 — Pregunta 10: Eventos de auditoría existentes
**Respuesta:**
- `system.audit_events` (business_id, actor_account_id, operation_id, action, capability, scope, resource_type, resource_id, outcome, changes, occurredAt) — registro genérico de operaciones autorizadas.
- `system.operation_attempts` (operation_id PK, business_id, actor_account_id, commandName, requestHash, status, responseStatus, errorCode, createdAt, completedAt, principal_kind, principal_ref) — idempotencia e intentos de operación; `booking.reservation_events.operation_id` y `guest_delivery_envelopes.operation_id` referencian esta tabla.
- `booking.reservation_events` — historial append-only por reserva (revisión, before/after, changes, reason_code, audit_reference); trigger `reservation_events_immutable` impide UPDATE/DELETE.
- `booking.guest_recovery_cases.audit_reference` — referencia de auditoría para casos de recuperación.
- `clients.client_account_links.audit_reference` — referencia de auditoría para vinculación de cuentas cliente.
No hay una tabla dedicada de "audit_log" de cambios de agenda aparte de `reservation_events` + `audit_events`; los cambios de ocupación (allocation) no generan fila en `audit_events` automáticamente salvo que la capa de aplicación lo haga.
**Archivo:línea:** `packages/database/src/schema.ts:26-27`; `packages/database/src/booking.ts:85-106`; `supabase/migrations/202611050002_h03_u04_booking.sql:91-122, 195-205`

## A01-G06 — Pregunta 11: Estados no representados
**Respuesta:**
- `reservations.status` solo modela `CONFIRMED` y `CANCELLED`. Faltan estados intermedios: `PENDING` (pendiente de pago/confirmación), `RESCHEDULE_REQUESTED` (reprogramación solicitada), `COMPLETED` (servicio realizado), `NO_SHOW` (cliente no se presentó), `BLOCKED_BY_STAFF`. Una reprogramación se modela como nueva revisión/evento sobre la misma reserva, no como estado propio.
- `allocation_status` solo `ACTIVE`/`RELEASED`. Falta `PENDING` (allocation creada pero no confirmada) y `EXPIRED` (allocation vencida sin confirmar).
- `commitment_conflicts.status` solo `OPEN`/`RESOLVED`. Falta `IGNORED`/`FALSE_POSITIVE`.
- `guest_credentials.status` solo `ACTIVE`/`REVOKED`. Falta `EXPIRED` (por `expiresAt` pasada sin revocar explícitamente).
- No hay representación explícita de "turno en curso/check-in" ni "turno finalizado" en `reservations`.
**Archivo:línea:** `packages/database/src/booking.ts:11-14`; `packages/database/src/availability.ts:13-16, 87`; `supabase/migrations/202611050001_h03_u03_availability.sql:4-7`; `supabase/migrations/202611050002_h03_u04_booking.sql:17-18, 131-132`

## A01-G06 — Pregunta 12: Info de CRM vs Booking
**Respuesta:** El CRM (U01/U02) vive en `clients.*` (`client_profiles`, `client_contacts`, `client_notes`, `client_account_links`) e `iam.*` (`persons`, `user_accounts`, `client_identity_states`, `client_access_sessions`). El booking referencia al cliente de forma opcional y desacoplada:
- `reservations.client_profile_id` → `clients.client_profiles(business_id, id)` (opcional, nullable; existe para dueños tipo CLIENT).
- `reservations.owner_account_id` → `iam.user_accounts(id)` (solo cuando ownerType='CLIENT'; NULL para GUEST).
- `reservations.contact_snapshot` (JSONB) — snapshot de contacto del momento de la reserva, para no depender del CRM en tiempo de lectura.
- No hay FK obligatoria de reserva a cliente: una reserva de invitado (GUEST) no tiene `client_profile_id` ni `owner_account_id`.
- El CRM no sabe de reservas; no hay columna/tabla que vincule `client_profiles` a `reservations` desde el lado cliente (la navegación es reserva→cliente, no cliente→reservas sin escanear `reservations`).
- `client_account_links.auth_method` incluye `'pending-u02'`, indicando que U02 (identidad cliente) aún no está完全mente integrada; este archivo está marcado como "ausente en workspace" aunque la migración SQL existe como `??` (nueva, no mergeada a HEAD).
**Archivo:línea:** `packages/database/src/booking.ts:16-30, 48`; `packages/database/src/clients.ts:39-137`; `packages/database/src/schema.ts:20-22`; `supabase/migrations/202611030001_h03_u02_client_identity.sql:1-148`

---

## (Parte 3 de 4 — se continúa en Parte 4: Gaps, riesgos, confianza, limitaciones)
