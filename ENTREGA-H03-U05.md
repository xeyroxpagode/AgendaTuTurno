# ENTREGA H03.U05 — Operación de Agenda Staff

**Repositorio:** `C:\Users\thega\Desktop\YoungKingz-U03-Implementation`
**Rama/HEAD:** `feature/h03-u03-implementation`, `35aab9e`
**Fecha:** 12 nov 2026
**Entregado a:** Actor B (candidato a aceptación — **no auto-aceptado**)

---

## 1. Veredicto

> **H03.U05 — D01 PARTIAL / CORRECTIVES REQUIRED**

La implementación está completa y toda la ejecución de pruebas es verde (vitest 303/303; E2E U05 18/18 en 3 viewports; integración Postgres real 18/18; booking-public 3/3 viewports). Sin embargo, las dos revisiones EGM (IAM + persistencia) retornan **R1_REQUIRED**: hay correctives requeridos (no bloqueantes en ejecución) antes de "todo verde". Este documento es el candidato a aceptación; **Actor B debe ACEPTAR explícitamente. No hay auto-aceptación.**

---

## 2. Estado por Work Package (WP-01 → WP-08)

| WP | Contenido | Estado |
|----|-----------|--------|
| WP-01 | Contratos, esquema Drizzle, migración SQL NO_SHOW; aplicada primero en DB aislada `ykz_u05_migration_test`, luego dev DB; 296 reservas intactas; registrada en `supabase_migrations.schema_migrations` | ✅ HECHO |
| WP-02 | Capabilities `bookings.{create,arrival,no_show,self.read,self.arrival,self.no_show}`, `roleCapabilities` por rol, error `BOOKING_NO_SHOW_WINDOW_NOT_OPEN` | ✅ HECHO |
| WP-03 | `booking/queries.ts`: list + detail + history, `business_id` isolation, cursor paginación | ✅ HECHO |
| WP-04 | Comandos `staff-create.ts`, `arrival.ts` (idempotente, timestamp), `no_show.ts`, `reassign.ts` (atómicos, revisión +1) | ✅ HECHO |
| WP-05 | Frontend: workspace agenda, ruta `/agenda`, enlace nav, protección `/agenda` en proxy, estilos | ✅ HECHO |
| WP-06 | vitest 303/303 PASS; E2E U05 18/18 PASS (3 viewports); `booking-public` arreglado y pasa | ✅ HECHO |
| WP-07/WP-08 | Correctives: cursor, arrival idempotente timestamp, `allowPastSlot` en reasignación, casts bigint non-null-safe | ✅ HECHO |
| EGM IAM | Revisión read-only | ⚠️ R1_REQUIRED (4 hallazgos) |
| EGM Persistencia | Revisión read-only | ⚠️ R1_REQUIRED (6 hallazgos) |

---

## 3. Matriz de capacidades (B01 / C01)

| Capability | OWNER | RECEPTIONIST | BARBER | CLIENT | GUEST |
|---|---|---|---|---|---|
| `bookings.create` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `bookings.read` (agenda compartida negocio) | ✅ | ✅ | ❌ | ❌ | ❌ |
| `bookings.self.read` (agenda propia) | ✅ | ✅ | ✅ | ❌ | ❌ |
| `bookings.arrival` / `bookings.self.arrival` | ✅ | ✅ | ✅ (solo propio) | ❌ | ❌ |
| `bookings.no_show` / `bookings.self.no_show` | ✅ | ✅ | ✅ (solo propio) | ❌ | ❌ |
| `bookings.override.*` | ✅ | ✅ (solo rol con override) | ❌ | ❌ | ❌ |

- `NO_SHOW` es estado de reserva consistente en contratos + Drizzle + SQL. `NO_SHOW_CONFIRMED` / `ARRIVAL_REGISTERED` son solo nombres de evento.
- BARBER usa `*.self.*` (agenda propia); sin `bookings.read` (no acceso a otros profesionales).
- Alcance en consultas: `bookings.read` = agenda compartida del negocio; `bookings.self.read` = agenda propia únicamente.
- `allowPastSlot` en `resolveSlot`/`claimAllocation` para reasignar sin corte de horizonte.

---

## 4. Endpoints API (U05)

| Método | Ruta | Acción |
|---|---|---|
| GET | `/v1/staff/bookings` | `listStaffAgenda` — agenda filtrada por `business_id`, paginación cursor |
| GET | `/v1/staff/bookings/:id` | `getStaffReservationDetail` |
| POST | `/v1/staff/bookings` | `staff-create` |
| POST | `/v1/staff/bookings/:id/arrival` | `arrival` (idempotente, no libera allocation) |
| POST | `/v1/staff/bookings/:id/no-show` | `no_show` (estado terminal `NO_SHOW`, libera allocation) |
| POST | `/v1/staff/bookings/:id/reassign` | `reassign` (revisión +1, mismo negocio, conserva turno) |

---

## 5. Superficies de frontend

- Ruta staff: `apps/web/src/app/(staff)/agenda/page.tsx` → `/agenda`
- Componente: `apps/web/src/features/agenda/AgendaWorkspace.tsx` + `api.ts`
- Nav: `apps/web/src/components/AppShell.tsx` (enlace Agenda + `aria-label` en cada enlace; fix de accesibilidad móvil)
- Protección: `apps/web/src/proxy.ts` (`/agenda` solo roles con autoridad staff)

---

## 6. Resultados de pruebas

| Suite | Resultado | Detalle |
|---|---|---|
| vitest (unit) | ✅ 27 archivos, 303/303 PASS | Incluye `availability-api.spec.ts` (fecha determinista dentro del horizonte) |
| Integración Postgres real | ✅ `staff-agenda.spec.ts` 18/18 | Aislamiento por rol, multi-business, transiciones, idempotencia |
| E2E U05 `staff-agenda.spec.ts` | ✅ 18/18 × 3 viewports (mobile-390, small-410, desktop-1440) | Owner/Recepción/Barbero; efectos verificados en BD |
| E2E `booking-public.spec.ts` | ✅ 3/3 viewports | Flujo reservar → consultar → reprogramar → cancelar |
| E2E suite completa | ⚠️ 13 fallos | **Todos** H02 `schedules`/`professionals` en mobile-390 / small-410; desktop-1440 pasa |

**Nota sobre los 12 fallos H02 móviles:** preexistentes y fuera de alcance H03.U05. En HEAD solo existía el proyecto `chromium`; los proyectos `mobile-390` / `small-410` se añadieron en el trabajo sin commitear y nunca se ejecutaron. Fallan por overflow/intercepción del editor de horario semanal de H02 en móvil. No son regresiones de U05 ni atribuibles a esta entrega; se documentan y no se tocan (no ampliar alcance).

---

## 7. Estado de Git y cambios de esta sesión

- **Sin commits, sin push, sin reset/clean/merge/rebase** (orden de operación respetada).
- Árbol sucio preexistente (≈80 archivos antes de esta sesión); cambios preexistentes de H01/H02 preservados, no tocados (`schedules/`, `staff-services/`, `system/operations.ts`, `team/service.ts`, `app.ts`, `runtime.ts`, `layout.tsx`, `page.tsx`, `proxy.ts`, `contracts/index.ts`, `database/index.ts/schema.ts`, `playwright.config.ts`, `supabase/config.toml`, `vitest.config.ts`, evidencias `docs/h01/...`).
- `git diff --check`: solo aviso CRLF preexistente en `packages/contracts/package.json`; sin errores.

**Cambios de esta sesión (H03.U05):**
- Modificados: `apps/web/src/components/AppShell.tsx` (aria-labels nav), `apps/web/src/app/globals.css` (regla nav móvil accesible)
- Reescritos/nuevos (untracked): `tests/h03/e2e/staff-agenda.spec.ts` (aislado, contexto propio, roles propios), `tests/h03/e2e/booking-public.spec.ts` (fecha dinámica + selector `aria-label` real del slot), `tests/h03/integration/availability-api.spec.ts` (fecha dentro del horizonte)
- Los archivos base de U05 (contratos, Drizzle, migración, routes, queries, comandos, AgendaWorkspace, fixtures, etc.) ya estaban en el árbol desde WP-01…WP-06.

**Estado BD compartida QA Dev (`10000000-0000-4000-8000-000000000001`):** limpiada al finalizar — 0 reservas, 0 allocations, 0 eventos, 0 operation attempts de test. Migración validada primero en DB aislada `ykz_u05_migration_test` antes de aplicarse a dev.

---

## 8. Riesgos y hallazgos EGM (R1_REQUIRED — correctives requeridos)

### EGM — Persistencia (6 hallazgos)

| Severidad | Ubicación | Hallazgo |
|---|---|---|
| P1 | `supabase/migrations/...booking_staff.sql:60-62` vs `packages/database/src/booking.ts:16,44-59` | La migración aplica CHECK `status in ('CONFIRMED','CANCELLED','NO_SHOW')`, pero el esquema Drizzle no restringe `status` a esos valores (divergencia ORM↔DB). |
| P1 | `apps/api/src/modules/booking/commands/no_show.ts:88-89` | `confirmStaffNoShow` devuelve `noShowAt` con el reloj del llamante (`now` de input), mientras la fila persiste `now()` del servidor; con sesgo de reloj o `now` pasado, el payload no coincide con lo persistido. |
| P2 | `apps/api/src/modules/booking/commands/arrival.ts:62-70` | Replay idempotente de llegada (evento `ARRIVAL_REGISTERED` ya existente) retorna sin `assertExpectedRevision`; un `expectedRevision` obsoleto no es rechazado (`STALE_REVISION`) en el camino idempotente. |
| P2 | `apps/api/src/modules/booking/domain/reservation.ts:102-103` | `assertStatusTransition` usa el mismo código/mensaje (`BOOKING_ALREADY_CANCELLED`, "already cancelled") para `CANCELLED` y para `NO_SHOW` terminal; mensaje inapropiado para no-show. |
| P3 | `apps/api/src/modules/booking/commands/reassign.ts:143` | El evento append-only se nombra `RESERVATION_RESCHEDULED` aunque la operación es reasignación de profesional (inconsistencia con `booking.reservation.reassigned`). |

**Comprobado como correcto (no defectos):** no_show no infiere por tiempo transcurrido (solo acción explícita); llegada no cambia estado distinto de `CONFIRMED`; todas las operaciones staff filtran por `business_id`; `reassign` valida destino mismo negocio; trigger de consistencia cubre `NO_SHOW` con 0 allocations ACTIVE; `releaseAllocation` libera en misma transacción sin doble ocupación.

### EGM — IAM (4 hallazgos)

| Severidad | Ubicación | Hallazgo |
|---|---|---|
| P1 | `packages/contracts/src/index.ts:59` + `authorization.ts:74` | `bookings.read` figura en `delegableCapabilities` y los grants se combinan con `roleCapabilities` sin validar compatibilidad de rol; un BARBER con grant `bookings.read` leería la agenda compartida (reservas de otros profesionales) — elevación sobre su ámbito propio. |
| P2 | `packages/contracts/src/index.ts:51-60` | `bookings.self.*`, `bookings.create`, `bookings.arrival`, `bookings.no_show` no figuran en `delegableCapabilities`; el alcance propio U05 no es otorgable/revocable vía `iam.capability_grants` (depende de asignación estática de rol). |
| P3 | `apps/api/src/modules/booking/routes.ts:270-280` | `listStaffAgenda` y `getStaffReservationDetail` no invocan `requireCapability` en `preHandler`; la autorización descansa solo en `resolveAgendaScope` de `queries.ts` (sin defensa en profundidad en ruta). |
| P3 | `tests/h03/integration/staff-agenda.spec.ts:286-292` | `actorFor` construye el Actor desde `roleCapabilities[role]` sin grants de BD; no ejercita el camino de grants ni aísla contra un BARBER sobredotado con `bookings.read`. |

---

## 9. Criterios de aceptación pendientes (decisión de Actor B)

La entrega cumple la ejecución de pruebas en su totalidad para H03.U05, pero las revisiones EGM exigen correctives (P1/P2/P3 listados arriba). Antes de dar por cerrada la tarea, Actor B debe:

1. Revisar y aceptar (o rechazar) el veredicto `H03.U05 — D01 PARTIAL / CORRECTIVES REQUIRED`.
2. Decidir si se aplican los correctives EGM (persistencia + IAM) en un lote posterior, o si se aceptan como deuda conocida con plan de corrección.
3. Confirmar que los 12 fallos H02 móviles se gestionan fuera del alcance H03.U05.

**Esta entrega no se auto-acepta.** Queda a la espera de la aceptación explícita de Actor B.
