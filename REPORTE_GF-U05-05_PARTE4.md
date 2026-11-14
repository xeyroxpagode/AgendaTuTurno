# REPORTE GF-U05-05 — Parte 4: Gaps de persistencia, riesgos de integridad, confianza, limitaciones

## Gaps de persistencia para U05 "Agenda Staff"

**G1 — No existe tabla/vista de lectura denormalizada de agenda.** Todas las consultas día/semana/profesional requieren joins en tiempo real sobre `resource_allocations`, `reservations`, `reservation_items`, `staff_members`, `services`. Para alta concurrencia de lectura (agenda pública) esto puede ser costoso; no hay `agenda_read_model` ni vista materializada.
**G2 — `resource_allocations.source_id` no tiene FK declarada a `booking.reservations`.** Cuando `source_type='RESERVATION'`, el vínculo es lógico y solo se valida mediante el trigger diferible `assert_reservation_allocation_integrity`. No hay FK rígida, por lo que el integridad depende totalmente del trigger y de su correcto disparo en todas las rutas de escritura.
**G3 — `booking.reservations.current_allocation_id` es nullable y no se fuerza NOT NULL para CONFIRMED a nivel de columna.** El trigger impone que un CONFIRMED tenga exactamente 1 allocation ACTIVE, pero no garantiza que `current_allocation_id` apunte a esa allocation (solo comparó staff/interval/fecha, no el id). Podría haber inconsistencia entre `current_allocation_id` y la allocation ACTIVE real.
**G4 — Estados ausentes** (ver P11): no hay `PENDING`, `COMPLETED`, `NO_SHOW`, `RESCHEDULE_REQUESTED` en `reservations.status`, ni `check_in`/`check_out`. Una reprogramación es solo una nueva revisión/evento, no un estado de ciclo de vida explícito.
**G5 — No hay tabla que vincule `client_profiles` a sus reservas desde el lado CRM.** La navegación cliente→reservas requiere escanear `booking.reservations` por `client_profile_id` (hay índice `booking_reservations_owner` solo para `owner_account_id`, no para `client_profile_id`). Falta índice en `reservations(business_id, client_profile_id)`.
**G6 — U02 (identidad cliente) ausente como tabla mergeada en el esquema TypeScript.** `client-auth.ts` existe como archivo nuevo (`??`) pero la migración `202611030001_h03_u02_client_identity.sql` también está sin mergear (`??`). No está claro si `client_account_links.auth_method='pending-u02'` se resuelve en esta rama.
**G7 — `audit_events` no se popula automáticamente por cambios de allocation/ocupación.** Solo `operation_attempts` y `reservation_events` existen; no hay trigger que escriba en `audit_events` cuando se crea/libera un `resource_allocations` por motivo distinto a una reserva (ej. OPERATIONAL_BLOCK).
**G8 — No hay restricción de "un turno activo por cliente en solapamiento" a nivel de cliente.** La exclusión GiST es por profesional, no por cliente. Un mismo cliente podría tener dos reservas confirmadas en solapamiento con distintos profesionales (posiblemente de negocio, pero no restringido).

## Riesgos de integridad bajo concurrencia

**R1 — Race condition en doble reserva a pesar de GiST.** La exclusión GiST `no_overlapping_active_allocations` se evalúa en el momento de INSERT/UPDATE de la allocation. Si dos transacciones concurrentes crean allocations para el mismo profesional en rangos solapantes, PostgreSQL las serializa (una espera o falla con exclusion violation). Riesgo bajo si todas las escrituras pasan por `resource_allocations`, pero medio si alguna ruta escribe directamente en `reservations` sin crear allocation (el trigger diferido se ejecuta al commit, pudiendo permitir estados intermedios visibles si el nivel de aislamiento no es serializable).
**R2 — Triggers diferibles `initially deferred`.** Las restricciones Reservation↔Allocation se verifican al COMMIT, no por cada sentencia. Bajo concurrencia, dos transacciones pueden dejar temporalmente el estado inconsistente (ej. reserva CONFIRMED sin allocation) y solo fallar al hacer commit, aumentando la ventana de aborto y posibles retry storms en la aplicación.
**R3 — `current_allocation_id` no sincronizado con la allocation ACTIVE.** El trigger compara staff/interval/fecha pero no verifica que `reservations.current_allocation_id = allocation.id`. Una aplicación podría leer `current_allocation_id` y obtener una allocation distinta (o RELEASED) de la ACTIVE real, causando confusión en la agenda.
**R4 — Ausencia de estado `PENDING`/`BLOCKED` puede forzar usos indebidos de `CANCELLED`.** Si una reserva se "bloquea" temporalmente marcándola CANCELLED y luego restaurándola, se pierden los eventos intermedios y se rompe la semántica de cancelación (cancelled_at se manipula).
**R5 — `guest_credentials` única ACTIVE por reserva depende de índice parcial.** Si se crea una segunda credencial ACTIVE por la misma reserva en carrera, el índice parcial único la rechaza (bueno), pero la aplicación debe manejar el error de unicidad (23505) de forma explícita.
**R6 — `reservation_events` es append-only por trigger, pero `changes` es JSONB no tipado.** No hay esquema forzado para el contenido de `changes`; bajo concurrencia dos eventos podrían registrar revisiones no lineales si la aplicación no usa `sequence` correctamente. La unicidad `(business_id, reservation_id, sequence)` ayuda pero no impide gaps de secuencia.
**R7 — RLS habilitado en tablas booking/availability pero sin políticas visibles en las migraciones.** Las migraciones solo hacen `enable row level security` y `revoke all from anon/authenticated`, `grant all to service_role`. No se ven políticas `CREATE POLICY`; el acceso se asume 100% vía `service_role` (backend). Si alguna ruta expone tablas directamente a `authenticated`/`anon` sin RLS policies, las lecturas/escrituras fallarían o quedarían sin control.

## Nivel de confianza de cada hallazgo

| Hallazgo | Evidencia | Confianza |
|---|---|---|
| Estructura `booking.reservations`, `reservation_items`, `reservation_events` | booking.ts líneas 16-106 + SQL líneas 13-112 | ALTA |
| Exclusión GiST doble ocupación | availability.ts:87-91 + SQL:190-194 | ALTA |
| Trigger diferible Reserva↔Allocation | SQL:208-301 | ALTA |
| CHECK cancelada (cancelled_at) | booking.ts:49 + SQL:44-45 | ALTA |
| Historial append-only reservation_events | booking.ts:85-106 + SQL:91-122 | ALTA |
| Índices para consultas agenda | booking.ts:58-61 + availability.ts:75,91-93 | ALTA |
| current_allocation_id no verificado contra allocation.id | booking.ts:30 + trigger SQL:237-244 | MEDIA (inferencia) |
| Gaps de estados (PENDING, COMPLETED, etc.) | booking.ts:11-14 | ALTA |
| CRM↔Booking vinculado opcionalmente | booking.ts:22-24, 48 | ALTA |
| RLS sin políticas CREATE POLICY visibles | SQL:304-315 | ALTA |
| U02 ausente del workspace TypeScript | estado git ?? en client-auth.ts + migración | ALTA |

## Limitaciones
1. Auditoría estática sobre código y migraciones SQL; no se ejecutó SQL ni se inspeccionó la base de datos runtime.
2. No se revisó la capa de aplicación (apps/api) que orquesta transacciones; el comportamiento real bajo concurrencia depende de ella.
3. No se verificó si existen políticas RLS `CREATE POLICY` fuera de los archivos leídos (posiblemente en otra migración no listada).
4. No se confirmó qué migraciones están aplicadas a la base real vs. cuáles están pendientes (`??` en git status).
5. El nivel de aislamiento de transacciones usado por la aplicación no se inspeccionó; afecta la severidad de R1/R2.
6. No se revisaron tests de integración para validar el comportamiento runtime de los triggers.

---

Fin del reporte GF-U05-05. Revisión read-only completa. No se modificó ningún archivo.
