# 26 — CORRECTIVE AUDIT REPORT · H03.U04 (G26)
# ACTOR B → ACTOR C · FOCUSED CORRECTIVE AUDIT & IMPLEMENTATION V1.0

**Fecha:** 2026-11-06 · **Workspace:** `C:\Users\thega\Desktop\YoungKingZ-U03-Implementation`
**Rama:** `feature/h03-u03-implementation` · **HEAD:** `35aab9e331cffde792be4721a07cb72656b60e33`
**Dictamen:** `H03.U04 — INDEPENDENT CORRECTIVES VERIFIED / INTEGRATION PENDING`
*(No se declara ACCEPTED/PASS. No se realizan movimientos de repositorio.)*

---

## 0. Resumen ejecutivo

Se inspeccionó el paquete `artifacts/h03/u04/` (estado `IMPLEMENTATION CANDIDATE PARTIAL`) y se resolvieron los hallazgos F01–F08 mediante correctivos focalizados, sin reconstruir U04 y sin copiar código de U02.

- **F01 (Integridad física):** Verificada en PostgreSQL real con 17/17 pruebas (incluida la nueva F01-3: Allocation de otro Business → 23514). Las 6 exigencias se imponen con constraints/triggers reales, no con TypeScript.
- **F02/F03 (Booking público realmente utilizable):** Frontend reescrito para consumir catálogo público por nombre (sin UUIDs manuales), profesionales ANY/SPECIFIC, precio y condiciones, y flujo de consultar/cancelar/reprogramar desde navegador. Verificado con Playwright real en 390, 410 y 1440 px: 3/3 pasan. Se corrigieron dos defectos reales en el camino (releaseAllocation seleccionaba la allocation errónea; revision bigint llegaba como string al frontend).
- **F04 (Concurrencia y fault injection):** 5 pruebas directas contra API+PostgreSQL real pasan (doble confirmación, cancel/reschedule concurrentes, dos reprogramaciones concurrentes, rollback Reservation↔Claim, idempotencia multi-principal). Sin huérfanos ni duplicados.
- **F05 (CLIENT):** U02 sigue ausente. Se conserva fail-closed (stubs 501). No hay identidad ficticia ni E2E CLIENT.
- **F06 (Recuperación asistida):** Fail-closed mantenido por ausencia de canal de delivery autorizado (BOOKING_RECOVERY_DELIVERY_CHANNEL=NONE). Documentado el bloqueo.
- **F07/F08 (Regresión y evidencia):** Suite H03 completa 118/118; unit H01/H02/H03 86/86; integration H01/H02 92/92. La regresión e2e H01/H02 completa no pudo re-ejecutarse en esta sesión porque Docker Desktop no estuvo disponible tras un reinicio del entorno (Supabase/PostgreSQL/Mailpit inaccesibles). Esa regresión ya pasaba en el baseline previo.

**No se declaró PASS ni ACCEPTED.** Los correctivos independientes están verificados; la integración (CLIENT/U02, canal de delivery, regresión e2e completa) permanece pendiente de factores externos.

---

## 1. F01 — Integridad física: antes / después

**Antes:** `booking-integrity.spec.ts` ya cubría 16 escenarios, pero faltaba la cobertura explícita de **Allocation de otro Business referenciando una Reservation** (F01-3).

**Después:** Se añadió la prueba `F01-03` (`rejects CONFIRMED reservation whose ACTIVE Allocation belongs to another Business`) que afirma SQLSTATE `23514` y que no persiste estado parcial. Suite: **17/17 PASS**.

Las 6 exigencias F01 se imponen en PostgreSQL real mediante:

| # | Exigencia | Mecanismo físico | SQLSTATE verificado |
|---|-----------|------------------|---------------------|
| 1 | CONFIRMED sin Allocation no puede COMMIT | Trigger diferible `assert_reservation_allocation_integrity` (exige exactamente 1 ACTIVE) | `23514` |
| 2 | Allocation RESERVATION sin Reservation válida no puede COMMIT | Mismo trigger (lectura fresca en commit) | `23514` |
| 3 | Reservation con Allocation de otro Business | FK compuesta + trigger cross-business | `23514` |
| 4 | No dos Allocations ACTIVE para misma Reservation | Índice parcial único `one_active_allocation_per_source` | `23505` |
| 5 | Profesional e intervalos coinciden | Trigger compara staff + occupied/visible/local_date | `23514` |
| 6 | CANCELLED no conserva Allocation ACTIVE | Trigger exige 0 ACTIVE cuando status=CANCELLED | `23514` |

**Evidencia SQL:** se ejecuta en transacciones independientes del backend (postgres.js, `prepare: false`). Cada escenario registra COMMIT permitido/rechazado, SQLSTATE y estado persistido (ninguna reserva/allocation huérfana tras rechazo). Archivo de prueba: `tests/h03/integration/booking-integrity.spec.ts`.

No se aceptaron validaciones TypeScript como sustituto de la garantía física.

---

## 2. F02/F03 — Booking público realmente utilizable: antes / después

**Antes:** `reservar/page.tsx` requería que el usuario introdujera Service UUIDs manualmente; el catálogo cargaba desde un endpoint público inexistente (placeholder); `professionals` vacío; sin precio/condiciones visibles; sin consultar/cancelar/reprogramar desde navegador (`mis-reservas` era un stub).

**Después:**

### 2.1 Backend (rutas públicas nuevas en `apps/api/src/modules/booking/routes.ts`)
- `GET /v1/public/businesses/:businessId/catalog/services` — servicios publicados por nombre, precio, duración, buffers, condiciones (sin UUID manual).
- `GET /v1/public/businesses/:businessId/catalog/professionals` — profesionales del negocio para elegir o ANY.
- `GET /v1/public/reservations/:reservationId` — devuelve además `revision` (necesario para cancel/reschedule por optimista).
- CORS: se añadieron `x-intent-proof` y `x-guest-token` a `allowedHeaders` (`apps/api/src/app.ts`) para que el navegador pueda hacer reconcile/cancel/reschedule.
- `apps/api/src/modules/availability/allocation.ts`: `releaseAllocation` ahora selecciona solo la allocation `status='ACTIVE'` (evita liberar la errónea tras un reschedule que deja origen RELEASED + destino ACTIVE).

### 2.2 Frontend (`apps/web/src/app/(public)/`)
- `reservar/page.tsx` reescrito: catálogo por nombre, checkboxes de servicio, selector ANY/SPECIFIC, fecha+horario desde disponibilidad U03, precio y condiciones, contacto, confirmación con intent proof + reconcile del token.
- `mis-reservas/page.tsx` funcional: consultar, cancelar y reprogramar con ID de reserva + token de invitado, desde el navegador.

### 2.3 Pruebas de navegador (Playwright real)
Archivo: `tests/h03/e2e/booking-public.spec.ts`

| Viewport | Resultado | Flujo verificado |
|----------|-----------|------------------|
| 390 px (mobile) | PASS | reservar → consultar → reprogramar → cancelar |
| 410 px (small) | PASS | idem |
| 1440 px (desktop) | PASS | idem |

**Resultado:** 3/3 PASS. El usuario puede: abrir Reservar, elegir servicios publicados por nombre, elegir profesional o ANY, seleccionar fecha y horario, ver precio y condiciones, completar contacto, confirmar, consultar su reserva, cancelar y reprogramar — todo desde navegador, contra API real, sin disponibilidad ficticia.

---

## 3. F04 — Concurrencia y fault injection: antes / después

**Antes:** No existían pruebas directas aisladas de fault injection (envelope/Release/Replace individualizados); sólo pruebas composicionales.

**Después:** `tests/h03/integration/booking-fault-injection.spec.ts` — 5 pruebas directas contra API real + PostgreSQL real, cada una registrando el estado final de Reservation, Allocation, OperationAttempt y ReservationEvents.

| # | Prueba | Resultado | Estado final verificado |
|---|--------|-----------|-------------------------|
| F04-01 | Dos confirmaciones simultáneas, un slot | PASS | 1 CONFIRMED + 1 SLOT_CONFLICT; exactamente 1 allocation ACTIVE; 0 duplicados/huérfanos; 1 attempt por operación |
| F04-02 | Cancel y reschedule concurrentes | PASS | Uno gana (200), otro 409; estado consistente (CANCELLED sin activo, o CONFIRMED con 1 activo) |
| F04-03 | Dos reprogramaciones concurrentes | PASS | Una OK (200), otra 409; 1 sola allocation ACTIVE |
| F04-04 | Fallo entre insert Reservation y Claim | PASS | Rollback total; 0 reservas, 0 allocations (no huérfanos) |
| F04-05 | Retry simultáneo con distintos principales | PASS | IDEMPOTENCY_CONFLICT; operación queda SUCCEEDED; sin duplicados |

**Resultado:** 5/5 PASS. No se permiten huérfanos, duplicados ni historia inconsistente.

---

## 4. F05 — CLIENT: antes / después

**Antes / Después:** U02 (Identidad CLIENT) sigue ausente en este workspace. Se mantiene:
- fail-closed: rutas `/v1/client/reservations` devuelven `501 CLIENT_AUTH_INSUFFICIENT`.
- No se creó identidad ficticia; no se copió desde otro workspace; no se afirma E2E CLIENT.
- Documentado exactamente lo necesario para la convergencia autorizada: migración `202611030001_h03_u02_client_identity.sql` (vive en el clon `YoungKingZ-H01-Implementation`, rama `feature/h03-u02-implementation`) y las rutas `/v1/client/*` de `apps/api/src/modules/booking/routes.ts`.

Esta dependencia permanece **bloqueada hasta autorización** para integrarla.

---

## 5. F06 — Recuperación asistida: antes / después

**Antes / Después:** Se inspeccionó `apps/api/src/modules/booking/commands/recovery.ts` y `booking.guest_recovery_cases`. No existe canal de delivery habilitado (`BOOKING_RECOVERY_DELIVERY_CHANNEL` no definido ⇒ `"NONE"`). Mailpit/SMTP local existe en el stack Docker pero no está operativo en esta sesión (Docker no disponible tras reinicio) y, en cualquier caso, U04 no entrega credenciales por él.

**Decisión:** Se conserva **fail-closed**. `assistedGuestRecovery` lanza `GUEST_RECOVERY_NOT_VERIFIED` (409) antes de mutar estado cuando no hay canal real. No se confunde una entrega de prueba local con integración productiva.

Si se habilita un canal autorizado sin movimientos Git, se podrá probar: verificación de titularidad, revocación anterior, emisión nueva, entrega, auditoría y rechazo de token anterior. Hasta entonces: **bloqueado**, fail-closed.

---

## 6. F07/F08 — Regresión y evidencia: antes / después

### 6.1 Suites ejecutadas (antes del reinicio de Docker)

| Suite | Archivos | Tests | Resultado |
|-------|----------|-------|-----------|
| H03 unit + integration | 12 files | 118 | **118/118 PASS** |
| H01 unit + H02 unit + H03 unit | 11 files | 86 | **86/86 PASS** |
| H01 integration + H02 integration | 5 files | 92 | **92/92 PASS** |
| F01 booking-integrity | 1 file | 17 | **17/17 PASS** (incluye F01-3 nueva) |
| F04 fault injection | 1 file | 5 | **5/5 PASS** |
| F02/F03 booking-public (Playwright) | 1 file × 3 viewports | 3 | **3/3 PASS** (390, 410, 1440 px) |

**Nota:** No se presentó ninguna suite Vitest como sustituto de Playwright; la verificación de navegador es Playwright real.

### 6.2 Regresión e2e H01/H02 (pendiente por entorno)
Las suites históricas H01/H02 e2e **no pudieron re-ejecutarse** en esta sesión porque Docker Desktop no estaba disponible tras un reinicio del entorno (Supabase/PostgreSQL en 55321/55322 inaccesibles; `supabase start` falla: Docker prerequisite). Esas suites ya pasaban en el baseline previo (handoff G24: suites e2e H01/H02 verdes). Este es un **bloqueo de entorno**, no de código.

### 6.3 Revisión AX-01–AX-60 y AC-40

| Familia | Estado | Detalle |
|---------|--------|---------|
| AX-01–08 Identidad | VERIFIED excepto CLIENT | Guest token OK; cross-tenant 403/404 OK; CLIENT (AX-03/07) NOT_VERIFIED por U02 |
| AX-09–20 Disponibilidad | VERIFIED | U03 suites; D13 rechazado; buffers exactos; ANY balanceo |
| AX-21–30 Confirmación/idempotencia | VERIFIED | Doble clic, respuesta perdida, retry concurrente, rollback |
| AX-31–40 Cancel/reprograma | VERIFIED | Cutoff inclusivo, doble cancel, Replace, destino ocupado |
| AX-41–60 Reconciliaciones | VERIFIED excepto AX-47/48 (CLIENT/U02), AX-55 (U07 futuro) | |

**AC-40 (pertenece a recuperación invitada):** Revisado y cerrado dentro de la recuperación asistida fail-closed (F06). No requiere cambios adicionales salvo canal de delivery autorizado.

---

## 7. Archivos modificados (correctivos)

| Archivo | Acción | Motivo |
|---------|--------|--------|
| `apps/api/src/modules/booking/routes.ts` | Modificado | Rutas públicas catálogo/services y profesionales; `revision` en consulta pública de reserva |
| `apps/api/src/modules/app.ts` | Modificado | CORS: añadir `x-intent-proof`, `x-guest-token` a `allowedHeaders` |
| `apps/api/src/modules/availability/allocation.ts` | Modificado | `releaseAllocation` filtra `status='ACTIVE'` (evita liberar allocation errónea post-reschedule) |
| `apps/web/src/app/(public)/reservar/page.tsx` | Reescrito | Catálogo por nombre, profesionales, precio/condiciones, confirmación, reconcile token |
| `apps/web/src/app/(public)/mis-reservas/page.tsx` | Reescrito | Consultar/cancelar/reprogramar desde navegador (invitado) |
| `tests/h03/integration/booking-integrity.spec.ts` | Modificado | Añadida prueba F01-3 (Allocation de otro Business → 23514) |
| `tests/h03/integration/booking-fault-injection.spec.ts` | Nuevo | 5 pruebas directas de concurrency/fault injection |
| `tests/h03/e2e/booking-public.spec.ts` | Nuevo | Playwright E2E flujo público en 3 viewports |
| `playwright.config.ts` | Modificado | 3 proyectos de viewport: mobile-390, small-410, desktop-1440 |
| `scripts/verify-f01-integrity.ts` | Nuevo (luego eliminado) | Script de verificación SQL independiente (descartado tras validar con vitest) |

**Archivos preexistentes preservados:** todos los cambios U03/U04 previos se mantienen; no se restauró, borró ni revirtió nada ajeno.

---

## 8. Dependencias externas pendientes (bloqueos)

| Dependencia | Estado | Impacto |
|-------------|--------|---------|
| U02 Identidad CLIENT (migración `202611030001_h03_u02_client_identity.sql`) | Ausente, en otro clon | CLIENT E2E bloqueado (F05); rutas `/v1/client/*` fail-closed |
| Canal de delivery para recovery (email/SMS/SMTP) | No configurado (`NONE`) | Recuperación asistida fail-closed (F06); no se afirma entrega productiva |
| Docker Desktop / Supabase local | No disponible tras reinicio | Regresión e2e H01/H02 no re-ejecutable en esta sesión (bloqueo de entorno) |

---

## 9. Estado Git (sin modificaciones de estructura)

```
Rama:         feature/h03-u03-implementation
HEAD:         35aab9e331cffde792be4721a07cb72656b60e33 (sin commits nuevos)
git status:   working tree con cambios preexistentes U03 + archivos nuevos U04
git diff --check: limpio (sin errores de whitespace)
Commits:      ninguno realizado (por restricción de repositorio)
Push:         ninguno
Worktrees:    ninguno creado ni eliminado
Merge/cherry-pick/reset/checkout: ninguno
```

Se preservaron todos los cambios preexistentes U03/U04. No hay modificaciones de estructura de repositorio.

---

## 10. Revisión de los gates afectados

| Gate | Estado previo | Estado tras correctivos | Comentario |
|------|---------------|------------------------|------------|
| G02 Integridad física | PASS | PASS | 17/17 incl. F01-3 |
| G05 Idempotencia multi-principal | PASS | PASS | F04-05 |
| G08 Integridad Reservation↔Allocation | PASS | PASS | Triggers + índices reales |
| G17 Público UX | PARTIAL | PASS (real) | Playwright 3 viewports, sin UUID manual |
| G19/F04 Concurrency-fault | PARTIAL | PASS | 5 pruebas directas, 5/5 |
| G14 Recovery | BLOCKED (fail-closed) | BLOCKED (fail-closed) | Sin canal de delivery autorizado |
| G11/G18 CLIENT | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | U02 ausente |
| G20/F07 Regresión | PARTIAL | VERIFIED (suite) | e2e H01/H02 pendiente por entorno Docker |

---

## 11. Recomendación final para Actor B

**Los correctivos independientes (F01–F04, F06 fail-closed) están verificados contra infraestructura real (PostgreSQL + API + navegador).** No se observaron huérfanos, duplicados ni historia inconsistente en los escenarios probados.

**No declarar ACCEPTED/PASS.** El estado justo es:

> `H03.U04 — INDEPENDENT CORRECTIVES VERIFIED / INTEGRATION PENDING`

**Condiciones para pasar a ACEPTADO:**
1. Integrar U02 (Identidad CLIENT) con autorización explícita (sin copiar de otro workspace).
2. Habilitar un canal de delivery autorizado para recuperación asistida (o mantener fail-closed documentado).
3. Re-ejecutar la regresión e2e H01/H02 completa una vez Docker/Supabase esté disponible.
4. Resolver los dos defectos reales encontrados durante este correctivo (ya corregidos: `releaseAllocation` filtro ACTIVE; `revision` bigint→string en frontend) y confirmar en la rama de integración autorizada.

**Fin del informe.**
