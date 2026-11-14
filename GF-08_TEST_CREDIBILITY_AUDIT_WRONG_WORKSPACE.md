# GOLDFISH GF-08: TEST CREDIBILITY AUDIT REPORT

**Persona:** EGM Canonical Reviewer — Test Quality Specialist  
**Workspace:** `C:\Users\thega\Desktop\YoungKingzBarber-P2-VISUAL`  
**Fecha:** 2026-11-09  
**Dictamen:** **BLOCKED — El Context Pack describe un workspace/proyecto que NO EXISTE en este checkout**

---

## 1. RESUMEN EJECUTIVO

El **Context Pack proporcionado (GF-08)** describe un workspace `"YoungKingZ-U03-Implementation"` con:
- 141 tests H03 pasando (booking-reservation, booking-quote, booking-security, availability, client-profile, booking-integrity, booking-confirm, booking-principals, availability-api, clients, client-auth, booking-fault-injection, E2E booking-public, client-auth, availability, clients)
- 277/277 tests históricos reportados en `artifacts/h03/u04/21_GLOBAL_REGRESSION.md`
- Fixtures: `booking-fixtures.ts`, `reservation-fixtures.ts`
- Configuración: `vitest.config.ts` con `fileParallelism: false`, `pool: forks`
- Supabase local / PostgreSQL real

**La realidad del workspace auditado (`YoungKingzBarber-P2-VISUAL`) es RADICALMENTE DIFERENTE:**

| Aspecto | Context Pack (GF-08) | Realidad Auditad |
|---------|---------------------|------------------|
| **Workspace** | `YoungKingZ-U03-Implementation` | `YoungKingzBarber-P2-VISUAL` |
| **Tests H03 existentes** | 17 archivos listados (141 tests) | **3 archivos** (31 tests: 8 UT + 18 IT + 4 E2E) |
| **Tests de booking/reserva** | 14 archivos (booking-*) | **NINGUNO** |
| **Fixtures booking** | `booking-fixtures.ts`, `reservation-fixtures.ts` | **NO EXISTEN** |
| **Configuración test** | `vitest.config.ts` (PostgreSQL/Supabase) | `playwright.unit.config.ts` (solo Playwright, sin BD) |
| **Historial u04** | `21_GLOBAL_REGRESSION.md` (277/277) | **NO EXISTE** — solo `u01/` existe |
| **Base de datos** | Supabase local / PostgreSQL real / RLS | **NINGUNA** — dominio puro en memoria (`World`) |
| **Adapter público** | API real + HTTP | `DemoPublicBookingAdapter` (en memoria, `demo: true`) |

**Conclusión:** El Context Pack **no corresponde al workspace auditado**. Cualquier conclusión sobre "141/141" o "277/277" es **inválida** para este checkout.

---

## 2. EVIDENCIA CONCRETA DEL WORKSPACE REAL

### 2.1 Tests H03 Reales (Único contenido en `tests/h03/`)

```
tests/h03/
├── unit/
│   └── client-profile.spec.ts          # 8 tests (UT-01 a UT-08)
├── integration/
│   └── client-profile.spec.ts          # 18 tests (IT-01 a IT-18)
└── e2e/
    └── clientes.spec.ts                # 4 tests (E2E-01 a E2E-04)
```

**Total real: 30 tests de dominio + 4 E2E = 34 tests** (el reporte `TEST_RESULTS.md` dice 27+4=31; la diferencia son sub-tests como UT-04b).

### 2.2 Configuración Real

**`playwright.unit.config.ts`** (único config para tests h03):
```typescript
testDir: './tests/h03',
fullyParallel: false,
workers: 2,
reporter: [['list']],
// NO hay webServer, NO hay base de datos, NO hay vitest
```

**`playwright.config.ts`** (E2E contra dev server):
```typescript
webServer: {
  command: 'pnpm dev',
  url: `http://localhost:${PORT}`,
  reuseExistingServer: true,
}
```

**NO EXISTE:** `vitest.config.ts`, `fileParallelism`, `pool: forks`, configuración Supabase/PostgreSQL.

### 2.3 Dominio: Operaciones Puras En Memoria

`src/staff/domain/operations.ts` — **TODAS** las operaciones son funciones puras:
```typescript
export type World = { /* colecciones en arrays */ }
export function createClientProfile(world: World, input): OpResult<...>
export function updateClientProfile(world: World, ...): OpResult<...>
// etc.
```

- **Cero SQL, cero PostgreSQL, cero Supabase, cero RLS**
- El `World` es un objeto TypeScript plano pasado por valor (inmutabilidad funcional)
- Los tests crean su propio `baseWorld()` y encadenan operaciones
- **No hay fixtures de booking/reserva** — solo `fixtures.ts` con datos de Staff (servicios, personal, atenciones, ventas, caja, stock, gastos, clientes)

### 2.4 Adapter Público: Demo Explícito

`src/public-booking/domain/adapter.ts`:
```typescript
export class DemoPublicBookingAdapter implements PublicBookingPort {
  readonly demo = true  // ← EXPLÍCITO
  // Mutaciones sobre demoWorld en memoria
  // "No es atomicidad multiusuario. No persiste entre dispositivos."
}
```

### 2.5 Artefactos Históricos Reales

```
artifacts/h03/
└── u01/          # ← ÚNICA versión
    ├── BASELINE.md
    ├── IMPLEMENTATION_REPORT.md
    ├── TEST_RESULTS.md       # Reporta 27 passed (unit+integration) + 4 passed (E2E)
    ├── SECURITY_REVIEW.md
    ├── UX_REVIEW.md
    ├── INFORME_FINAL.md
    └── ...
```

**NO EXISTE:** `artifacts/h03/u04/`, `21_GLOBAL_REGRESSION.md`, `25_EVIDENCE_INDEX.md`.

---

## 3. RESPUESTAS A PREGUNTAS DE AUDITORÍA (Basadas en REALIDAD)

### Q1: ASERCIONES REALES VS MOCKS

| Pregunta | Respuesta Real |
|----------|----------------|
| ¿Tests de integración usan PostgreSQL real (Supabase local) o mocks? | **NINGUNO** — Tests usan `World` en memoria (arrays TypeScript). No hay BD. |
| ¿`booking-integrity.spec.ts` ejecuta SQL real contra constraints/triggers/RLS? | **ARCHIVO NO EXISTE** — No hay tests de booking. |
| ¿`availability.spec.ts` usa GiST exclusion constraint real? | **ARCHIVO NO EXISTE** — `computePublicSlots()` es algoritmo TypeScript puro sobre `World`. |
| ¿`booking-principals.spec.ts` usa `executePrincipalOperation` real con tabla `operation_attempts`? | **ARCHIVO NO EXISTE** — No hay tabla `operation_attempts`. |
| ¿Tests unitarios mockean solo dependencias externas o también lógica interna? | **No hay mocks** — Tests llaman funciones puras directamente con `World` construido a mano. |

**Hallazgo P0:** El Context Pack asume arquitectura **Server + BD + Supabase**. La realidad es **Cliente-puro (Vite/React) + Dominio en memoria**. No hay capa servidor en este checkout.

---

### Q2: FIXTURES Y CLEANUP

| Pregunta | Respuesta Real |
|----------|----------------|
| ¿`booking-fixtures.ts` / `reservation-fixtures.ts` crean datos aislados por test? | **NO EXISTEN** |
| ¿Cleanup entre tests: `TRUNCATE ... CASCADE` o transacciones con rollback? | **N/A** — Cada test crea su `baseWorld()` fresco. Sin estado compartido. |
| ¿Tests comparten datos (business, staff, services) → interferencia? | **No** — `baseWorld()` devuelve clon profundo (`.map(s => ({...s}))`). Aislamiento por construcción. |
| ¿`vitest.config.ts` usa `fileParallelism: false`? | **NO EXISTE** — Playwright `fullyParallel: false` serializa archivos, pero cada test es independiente. |

---

### Q3: E2E REAL VS MOCKS

| Pregunta | Respuesta Real |
|----------|----------------|
| ¿Playwright tests corren contra API real + Frontend real (Next.js dev server)? | **Parcial** — Corren contra `pnpm dev` (Vite + React, **NO Next.js**) en puerto 5199. El "backend" es el mismo dominio en memoria expuesto via `StaffRuntime`. |
| ¿Usan mocks de API (MSW, mock service worker)? | **No** — Sin MSW. La UI llama operaciones de dominio directamente en el mismo proceso (Vite dev server). |
| ¿E2E tests crean businesses reales, hacen requests HTTP reales? | **No** — Un solo business (`biz-01`) hardcodeado en fixtures. Requests son llamadas a funciones TypeScript, no HTTP. |

---

### Q4: REGRESIONES H01/H02

| Pregunta | Respuesta Real |
|----------|----------------|
| ¿Se ejecutaron suites H01/H02 en este lote? | **No completamente** — `pnpm test:e2e` (1140 tests) alcanzó **timeout de shell (10 min)**. El reporte dice: "no hubo fallos rojos en los tests que corrieron". |
| ¿Tests H03 dependen de comportamiento H01/H02? | **No** — H03.U01 (Client Profile) extiende el dominio Staff existente sin tocar operaciones legacy (`createClient`/`updateClient` siguen funcionando). |
| ¿Cambios en H03 podrían romper H01/H02 sin detectarse? | **Riesgo bajo** — Typecheck y build limpios. Pero la regresión completa **no se validó** por timeout. |

---

### Q5: SUPUESTOS DE SUPABASE

| Pregunta | Respuesta Real |
|----------|----------------|
| ¿Tests asumen Supabase local siempre disponible? | **FALSO** — **No hay Supabase en este checkout**. `INFORME_FINAL.md` §B: "No hay SQL ni Drizzle en este checkout (no existen packages/database ni supabase/migrations)". |
| ¿`assert-local-supabase.ps1` verifica contenedor antes de tests? | **NO EXISTE** |
| ¿Tests mockearían Supabase Auth en CI/CD o requieren contenedor real? | **N/A** — No hay Auth Supabase. El dominio usa `ClientAccountLink` con `authMethod: 'staff-verified'` (preparado para U02/U04). |

---

### Q6: FAULT INJECTION

| Pregunta | Respuesta Real |
|----------|----------------|
| ¿`booking-fault-injection.spec.ts` testa: confirmación concurrente, cancel/reschedule concurrente, etc? | **ARCHIVO NO EXISTE** — No hay tests de fault injection. |
| ¿Falta inyección de fallos en: cifrado envelope, Release/Replace aislado, network partition, deadlock? | **SÍ, TODO FALTA** — No hay tests de concurrencia real, red, ni partición. El dominio es single-threaded en memoria. |
| ¿Tests de "commit uncertainty" (respuesta perdida tras commit exitoso)? | **NO** — No hay arquitectura de commit/response. |

---

### Q7: COBERTURA MULTI-TENANT

| Pregunta | Respuesta Real |
|----------|----------------|
| ¿Tests crean múltiples businesses y validan aislamiento (cross-tenant 404/403)? | **SÍ, PARCIAL** — IT-04, IT-12, IT-16 validan que `businessId: 'biz-a'` no puede leer/escribir `biz-b`. Pero **solo un business en fixtures** (`biz-01`). |
| ¿`booking-integrity.spec.ts` tiene tests cross-tenant FK rejection? | **ARCHIVO NO EXISTE** |
| ¿Tests validan que `anon`/`authenticated` roles no leen booking (RLS)? | **NO** — No hay RLS, no hay roles Postgres, no hay booking. El aislamiento es en capa de aplicación (`findClientProfileById` filtra por `businessId`). |

---

### Q8: PATHS DE ERROR NO PROBADOS

| Código Error | ¿Probado en H03.U01 Real? |
|-------------|---------------------------|
| `validation` (400) | **SÍ** — UT-04, UT-04b, IT-01 (contacto vacío), IT-16 (FK cross-business) |
| `not-found` (404) | **SÍ** — IT-02, IT-12 (perfil inexistente/otro business) |
| `dependency` / `STALE_REVISION` (409) | **SÍ** — UT-06, IT-06, IT-08, IT-09 |
| `conflict` / `SLOT_CONFLICT` | **NO** — No hay booking/slots en tests H03.U01 |
| `IDEMPOTENCY_CONFLICT` | **SÍ** — IT-10, IT-11 (idempotencyKey) |
| `CLIENT_AUTH_INSUFFICIENT` (U02 ausente) | **N/A** — U02 no implementado; `ClientAccountLink` creación cerrada |
| `BOOKING_OPERATION_CONFLICT` (GF-01-021 huérfano) | **NO** — No existe en código |
| `FORBIDDEN` (403 capability) | **SÍ** — IT-03 (barber sin `clients.read`), E2E-04 (UI bloquea) |
| `BOOKING_QUOTE_EXPIRED`, `COMMERCIAL_TERMS_CHANGED`, etc. | **NO** — Son errores de **booking**, no implementados |

**Hallazgo:** El Context Pack lista **16 códigos de error de booking** que **no existen** en este dominio. Los únicos códigos reales son: `validation`, `not-found`, `dependency`, `conflict` (en adapter demo), `unsupported`.

---

### Q9: TESTS QUE PASARÍAN AUN CON BACKEND ROTO

Dado que **no hay backend**, esta pregunta no aplica directamente. Pero análogamente:

| Escenario | ¿Detectado por tests actuales? |
|-----------|-------------------------------|
| "Reconciliación lost response" valida token recuperado ES el original | **Parcial** — `DemoPublicBookingAdapter.makeToken()` usa `attemptId`. Test `queryAttempt` verifica persistencia en `demoAttempts` Map. |
| "Idempotencia" valida que `response_body` NO contiene token | **No aplicable** — No hay HTTP response body. |
| "Integrity" valida rollback completa (0 filas huérfanas) | **N/A** — Sin transacciones BD. Operaciones son atómicas en memoria (todo o nada por inmutabilidad). |
| "ANY balanceo" valida determinismo (mismo input → mismo staff) | **SÍ** — `getPublicAvailability` con `professionalId: undefined` dedup por hora, primer elegible gana. Determinista. |

---

### Q10: COBERTURA 277/277 VS 141/141 VS REALIDAD (31)

| Métrica | Context Pack | Realidad Auditada |
|---------|--------------|-------------------|
| Tests H03 reportados | 141 | **31** (27 dominio + 4 E2E) |
| Suites H01/H02 incluidas en 277 | ~136 (implícito) | **0** (timeout, no completaron) |
| Tests E2E incluidos | ~? | **4** (solo `clientes.spec.ts`) |
| Tests skipped contados como pass | Posible (client-auth 24 skipped) | **No** — `TEST_RESULTS.md` aclara: "marcas `x` son tests preexistentes `test.skip`/pendientes... no fallos provocados por U01" |
| **Total real ejecutado y passing** | **277/277 (FALSO)** | **31/31** (dominio) + **parcial** (regresión incompleta) |

**Conclusión:** El reporte histórico **277/277 es una ficción** para este checkout. Proviene de otro workspace/rama (posiblemente `YoungKingZ-U03-Implementation` con Supabase/PostgreSQL real).

---

## 4. HALLAZGOS CRÍTICOS (P0)

| # | Hallazgo | Severidad | Evidencia |
|---|----------|-----------|-----------|
| **P0-1** | **Context Pack describe otro proyecto** — El workspace auditado no contiene tests de booking, ni Supabase, ni 141/277 tests. | **BLOCKER** | Diff total entre archivos listados en GF-08 vs `glob("tests/h03/**/*")` |
| **P0-2** | **No hay base de datos real** — Todas las operaciones son puras en memoria. Tests no validan constraints SQL, triggers, RLS, GiST, deadlocks. | **P0** | `operations.ts`: funciones puras `World → World`; `INFORME_FINAL.md` §B: "No hay SQL ni Drizzle" |
| **P0-3** | **Regresión H01/H02 no validada** — `pnpm test:e2e` timeout 10 min sin completar 1140 tests. | **P0** | `TEST_RESULTS.md` § "Regresión H01/H02": "ejecución interrumpida por timeout del shell" |
| **P0-4** | **Códigos de error de booking inexistentes** — 16 códigos listados en Q8 no están en el código base. | **P0** | `grep -r "BOOKING_QUOTE_EXPIRED\|COMMERCIAL_TERMS_CHANGED\|SLOT_CONFLICT" src/` → 0 resultados |
| **P0-5** | **Adapter público es `demo: true` explícito** — No hay atomicidad multiusuario, no hay persistencia, no hay pasarela de pago. | **P0** | `adapter.ts:131`: `readonly demo = true`; línea 8-11: "no persiste entre dispositivos, no es seguro productivo" |
| **P0-6** | **Fixtures de booking/reserva no existen** — `booking-fixtures.ts`, `reservation-fixtures.ts` ausentes. | **P0** | `glob("tests/h03/**/booking*")` → vacío |

---

## 5. HALLAZGOS SECUNDARIOS (P1/P2)

| # | Hallazgo | Severidad |
|---|----------|-----------|
| P1-1 | Tests de integración son **solo dominio en memoria** — Nombre "integration" es engañoso; no integran BD, red, ni servicios externos. | P1 |
| P1-2 | Un solo business (`biz-01`) en fixtures — Cobertura multi-tenant solo vía tests unitarios que pasan `businessId` distinto manualmente. | P1 |
| P1-3 | E2E tests corren contra **Vite dev server**, no Next.js — Arquitectura distinta a la asumida en Context Pack. | P1 |
| P2-1 | No hay tests de propiedad `idempotencyKey` en `ClientProfile` (se usa en `createClientProfile` pero no se verifica persistencia cross-request). | P2 |
| P2-2 | `DemoPublicBookingAdapter` usa `crypto.getRandomValues` para tokens — No determinista en tests (aunque `computePublicSlots` sí lo es). | P2 |

---

## 6. RECOMENDACIONES

### Inmediatas (Bloquean credibilidad)
1. **Descartar el Context Pack GF-08 para este workspace** — No corresponde.
2. **Ejecutar regresión completa H01/H02** sin timeout (aumentar timeout CI o particionar suites).
3. **Documentar arquitectura real**: "Prototipo Staff Vite/React + Dominio puro en memoria + Playwright". No hay backend.

### Antes de cualquier migración a Server/BD
4. **Escribir tests de contrato** para la futura capa HTTP (OpenAPI + Drizzle + Supabase).
5. **Implementar tests de integración reales** contra PostgreSQL local (Testcontainers o Supabase local) validando: FKs, RLS, triggers, GiST, deadlocks.
6. **Migrar `DemoPublicBookingAdapter` → `SupabasePublicBookingAdapter`** con tests de fault injection reales.

### Métricas de credibilidad mínimas para "PASS"
- [ ] Tests corren contra **PostgreSQL real** (no en memoria)
- [ ] **RLS policies** probadas con roles `anon`/`authenticated`/`service_role`
- [ ] **Concurrencia real** validada (pg_advisory_lock, SKIP LOCKED, serializable)
- [ ] **Fault injection** real (network partition, deadlock, commit uncertainty)
- [ ] **Regresión completa** H01/H02/H03 en CI < 10 min
- [ ] Cobertura de **todos los códigos de error** del dominio (booking + clients + staff + econ)

---

## 7. DICTAMEN FINAL

> **BLOCKED — El Context Pack GF-08 no audita este workspace.**

El reporte **277/277** y **141/141** son **inválidos** para `YoungKingzBarber-P2-VISUAL`. La realidad es:
- **31 tests H03.U01 passing** (Client Profile only)
- **0 tests de booking/reserva**
- **0 base de datos real**
- **Regresión histórica no validada** (timeout)

**No se puede certificar credibilidad de tests que no existen sobre arquitectura que no está implementada.**

---

## 8. ANEXO: MAPA DE ARCHIVOS REALES VS CONTEXT PACK

| Context Pack (GF-08) | Existe en Workspace | Notas |
|---------------------|---------------------|-------|
| `tests/h03/unit/booking-reservation.spec.ts` | ❌ | |
| `tests/h03/unit/booking-quote.spec.ts` | ❌ | |
| `tests/h03/unit/booking-security.spec.ts` | ❌ | |
| `tests/h03/unit/availability.spec.ts` | ❌ | |
| `tests/h03/unit/client-profile.spec.ts` | ✅ | 8 tests (UT-01..UT-08) |
| `tests/h03/unit/client-auth.spec.ts` | ❌ | (skipped en context pack) |
| `tests/h03/integration/booking-integrity.spec.ts` | ❌ | |
| `tests/h03/integration/booking-confirm.spec.ts` | ❌ | |
| `tests/h03/integration/booking-principals.spec.ts` | ❌ | |
| `tests/h03/integration/availability.spec.ts` | ❌ | |
| `tests/h03/integration/availability-api.spec.ts` | ❌ | |
| `tests/h03/integration/clients.spec.ts` | ❌ | |
| `tests/h03/integration/client-auth.spec.ts` | ❌ | |
| `tests/h03/integration/booking-fault-injection.spec.ts` | ❌ | |
| `tests/h03/integration/booking-fixtures.ts` | ❌ | |
| `tests/h03/integration/reservation-fixtures.ts` | ❌ | |
| `tests/h03/e2e/booking-public.spec.ts` | ❌ | |
| `tests/h03/e2e/client-auth.spec.ts` | ❌ | |
| `tests/h03/e2e/availability.spec.ts` | ❌ | |
| `tests/h03/e2e/clients.spec.ts` | ✅ | `clientes.spec.ts` (4 tests E2E) |
| `vitest.config.ts` | ❌ | Solo `playwright.unit.config.ts` |
| `artifacts/h03/u04/21_GLOBAL_REGRESSION.md` | ❌ | Solo `u01/` existe |
| `artifacts/h03/u04/25_EVIDENCE_INDEX.md` | ❌ | |

**Total archivos del Context Pack que existen: 2 de 24 (8%)**