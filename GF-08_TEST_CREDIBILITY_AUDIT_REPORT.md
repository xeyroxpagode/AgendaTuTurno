# GF-08 TEST CREDIBILITY AUDIT REPORT

**Workspace:** `C:\Users\thega\Desktop\YoungKingZ-U03-Implementation`
**Test Run:** `pnpm exec vitest run tests/h03` — **141/141 PASS (verified)**
**Historical Reference:** `artifacts/h03/u04/21_GLOBAL_REGRESSION.md` — 112/112 h03; `artifacts/h03/u04/25_EVIDENCE_INDEX.md` — 112 tests desglosados
**Persona:** EGM Canonical Reviewer — Test Quality Specialist
**Fecha:** 2026-11-09

---

## RESUMEN EJECUTIVO

| Métrica | Valor | Verificación |
|---------|-------|--------------|
| Tests h03 ejecutados | 141 | ✅ Confirmado en runtime |
| Tests h03 histórico (G21) | 112 | ✅ 21_GLOBAL_REGRESSION.md |
| Tests h03 histórico (G25) | 112 | ✅ 25_EVIDENCE_INDEX.md |
| Tests h01/h02/e2e en lote G21 | **No ejecutados** | ⚠️ Explícito en reporte |
| Total histórico "277" | **Inflado** | ❌ Incluye suites no ejecutadas + skipped |

**Conclusión principal:** El resultado **141/141 PASS es creíble** para h03 unit + integration. Los tests **E2E (Playwright) no se ejecutaron** en el comando vitest (están en `tests/h03/e2e/` y `playwright.config.ts` los filtra con `testMatch: "**/e2e/**/*.spec.ts"`). El reporte histórico de "277" parece inflado por conteo de tests skipped (client-auth.spec.ts) + h01/h02 no corridos en este lote.

---

## Q1: ASERCIONES REALES VS MOCKS

### Hallazgo: **Tests de integración usan PostgreSQL REAL (Supabase local) — no mocks**

**Evidencia concreta:**

1. **booking-integrity.spec.ts** (líneas 13-15, 82-92, 133-153):
   - `beforeAll` → `seedBookingBusiness("U04 Integrity")` ejecuta **SQL real** contra `database.client` (PostgreSQL local puerto 55322)
   - Tests adversariales: `database.client.begin(async tx => { ... })` con `expect(...).rejects.toMatchObject({ code: "23514" })` — códigos de error **PostgreSQL nativos** (check constraint violation, FK violation, unique violation)
   - Constraint GiST real probada: línea 60 "PostgreSQL physically rejects overlapping ACTIVE rows and allows touching ranges" → espera código `23P01` (exclusion constraint violation)

2. **booking-fault-injection.spec.ts** (líneas 31-36, 38-71):
   - `beforeAll` → `buildApp()` (Fastify real) + `seedBookingBusiness`
   - Tests usan `app.inject()` → **HTTP real** contra API Fastify en proceso
   - `finalState()` consulta tablas reales: `booking.reservations`, `availability.resource_allocations`, `booking.reservation_events`, `system.operation_attempts`

3. **availability.spec.ts** (integración, líneas 18-37):
   - `beforeAll` inserta negocio, staff, catálogo, policy en **transacción real**
   - Tests llaman `searchAvailability()`, `quoteAllocation()`, `claimAllocationOperation()`, `resolveSlot()` — **código de producción real** contra BD real

4. **booking-principals.spec.ts** (líneas 13-14, 21-32):
   - Usa `executePrincipalOperation` real con tabla `system.operation_attempts` real
   - Verifica `count(*) from system.operation_attempts where operation_id=...`

5. **booking-confirm.spec.ts** (líneas 15-18, 22-92):
   - `buildApp()` + `app.inject()` para flujo completo quote → confirm → read → reconcile → cancel
   - Verifica estado final en BD: `availability.resource_allocations` status = `RELEASED`

### Tests Unitarios: **Puro dominio + contratos — sin BD**

- `availability.spec.ts` (unit): Solo funciones puras (`normalizeIntervals`, `composeServiceSequence`, `deterministicCandidateOrder`) + esquemas Zod
- `booking-reservation.spec.ts`, `booking-quote.spec.ts`, `booking-security.spec.ts`: Lógica de dominio puro, validación HMAC, TTL
- `client-auth.spec.ts` (unit): Solo contratos Zod + concordancia Drizzle (schema introspection)
- `client-profile.spec.ts`: Domain logic puro

**Conclusión Q1:** ✅ **Integración = PostgreSQL real + API real**. ✅ **Unitario = Dominio puro + contratos**. No hay mocks de BD en integración. No hay mocks de lógica interna en unitarios.

---

## Q2: FIXTURES Y CLEANUP

### Hallazgo: **Fixtures crean businesses únicos por test file; Cleanup = Transacciones con rollback + afterAll manual**

**Evidencia:**

1. **booking-fixtures.ts** `seedBookingBusiness(label)` (líneas 27-66):
   - Genera **UUIDs únicos** para todo: `business`, `person`, `account`, `staffA`, `staffB`, `category`, `serviceCut`, `serviceBeard`, `termsCut`, `termsBeard`
   - `provisioning_key` incluye label + business UUID → **aislado por invocación**
   - Cada `beforeAll` en test files llama `seedBookingBusiness` con label distinto ("U04 Integrity", "F04 Fault", "U04 Principals", "U04 E2E")

2. **reservation-fixtures.ts** `seedConfirmedReservationWithAllocation`:
   - Usa `database.client.begin(async tx => { ... })` → **transacción con rollback automático en error**
   - Tests de integridad (booking-integrity.spec.ts) usan `database.client.begin` para cada caso adversarial → **rollback automático en reject**

3. **vitest.config.ts** (líneas 5-9):
   ```ts
   fileParallelism: false,
   sequence: { concurrent: false }
   ```
   - Archivos de test **serializados** (no paralelismo entre archivos)
   - Dentro de archivo: tests corren en serie por defecto de vitest

4. **clients.spec.ts** (integración, líneas 77-103):
   - `afterAll` manual: `DELETE` en orden topológico inverso (client_account_links → client_profiles → staff_members → persons → businesses)
   - `purgeTestUsers()` limpia Supabase Auth users creados durante tests

5. **booking-confirm.spec.ts** y **booking-fault-injection.spec.ts**:
   - `afterAll` → `app.close()` (cierra Fastify)
   - No limpian BD explícitamente → **dependen de businesses únicos + transacciones rollback**

### Riesgo identificado: **Interferencia potencial entre test files**

- `booking-integrity.spec.ts` línea 134: `const other = await seedBookingBusiness("U04 Integrity Other");` crea **segundo business** dentro del mismo archivo
- `booking-principals.spec.ts` línea 48: `const other = await seedBookingBusiness("U04 Principals Other");`
- `availability.spec.ts` (integración) crea **un business global** en `beforeAll` (líneas 14-37) y todos los tests lo comparten
- `clients.spec.ts` crea **businessA y businessB** globales

**Mitigación actual:** `fileParallelism: false` + UUIDs únicos por business evitan colisiones de PK. Pero **datos compartidos dentro de archivo** (availability.spec.ts, clients.spec.ts) pueden causar interferencia si tests no limpian su estado.

**Conclusión Q2:** ⚠️ **Aislamiento por business (UUID único) funciona entre archivos**. ⚠️ **Dentro de archivo: tests comparten business + staff + servicios** (availability.spec.ts, clients.spec.ts). Cleanup = rollback transaccional en tests adversariales + afterAll manual en algunos. **No hay TRUNCATE CASCADE global entre tests**.

---

## Q3: E2E REAL VS MOCKS

### Hallazgo: **Playwright E2E tests corren contra API REAL + Frontend REAL (Next.js dev server) — NO mocks**

**Evidencia — playwright.config.ts (líneas 1-34):**
```ts
webServer: [
  { command: "pnpm dev:api", port: apiPort, reuseExistingServer: true },      // API real (Fastify)
  { command: `pnpm --filter @youngkingz/web exec next dev -p ${webPort}`,      // Frontend real (Next.js)
    port: webPort, reuseExistingServer: true },
]
```
- `baseURL: http://localhost:${webPort}` → **Frontend real**
- Tests en `tests/h03/e2e/booking-public.spec.ts` (líneas 35-38):
  ```ts
  test.beforeAll(async () => {
    ctx = await createOwnerContext();  // Crea owner real via Supabase Auth
    db = postgres(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres");
    await seedPublicBusiness(ctx.businessId, ctx.staffId, ctx.accountId);  // SQL real en BD real
  });
  ```
- Test "flujo completo" (líneas 46-105): `page.goto(/reservar?businessId=...)`, clicks reales, form fills, espera toasts, extrae `reservationId` y `guestToken` del DOM

**No hay MSW, no hay mock service worker, no hay API mocks.**

**Conclusión Q3:** ✅ **E2E = HTTP real contra API real + Frontend real + BD real**. Credibilidad máxima para flujos usuario.

---

## Q4: REGRESIONES H01/H02

### Hallazgo: **Suites H01/H02 NO se ejecutaron en lote G21 — riesgo de regresión no detectada**

**Evidencia — 21_GLOBAL_REGRESSION.md (línea 11):**
> "No se ejecutaron suites h01/h02/e2e en este lote (alcance U04); no se alteraron."

**Tests H01 existentes:**
- `tests/h01/unit/contracts.spec.ts` (1 test file)
- `tests/h01/integration/h01-matrix.spec.ts` (1 test file)
- `tests/h01/e2e/` (helpers compartidos)

**Tests H02 existentes:**
- Unit: `contracts.spec.ts`, `domain.spec.ts`, `professionals.spec.ts`, `schedules.spec.ts`, `staff-services.spec.ts`
- Integration: `catalog.spec.ts`, `professionals.spec.ts`, `schedules.spec.ts`, `staff-services.spec.ts`
- E2E: `catalog.spec.ts`, `professionals.spec.ts`, `schedules.spec.ts`, `staff-services.spec.ts`

**Dependencias H03 → H01/H02:**
- H03 usa `iam.persons`, `iam.user_accounts`, `team.staff_members`, `catalog.services`, `team.staff_weekly_schedules`, `business.business_hours_configs`, `business.booking_policy_versions` — **tablas creadas por H01/H02**
- `availability.spec.ts` (integración) llama `replaceWeeklySchedule`, `replaceStaffServices`, `lifecycle` (H02 commands)
- `clients.spec.ts` crea `staff_role_states`, `role_assignments` (H02 IAM)

**Riesgo:** Cambios en H03 (ej. nuevo constraint en `resource_allocations`) podrían romper H02 schedule eligibility sin detectarse. Cambios en H02 (ej. `staff_role_states` schema) romperían `clients.spec.ts`.

**Conclusión Q4:** ❌ **Regresiones H01/H02 NO cubiertas en este lote**. Ejecutar `pnpm exec vitest run tests/h01 tests/h02` es necesario para validación completa.

---

## Q5: SUPUESTOS DE SUPABASE

### Hallazgo: **Tests asumen Supabase local running (puerto 55322) — verificado por script previo**

**Evidencia:**

1. **scripts/assert-local-supabase.ps1** (líneas 1-16):
   - Verifica `supabase/config.toml` tiene `project_id = "youngkingz-h01"` y `port = 55322`
   - TCP connect a `127.0.0.1:55322` → falla si contenedor no está arriba

2. **apps/api/src/lib/runtime.ts** (líneas 24-30):
   ```ts
   databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
   supabaseUrl: process.env.SUPABASE_URL ?? "http://127.0.0.1:55321",
   serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
   ```
   - Defaults apuntan a **Supabase local stack** (PostgreSQL 55322, Kong 55321)

3. **clients.spec.ts** (líneas 8-11, 63-65):
   - Requiere `SUPABASE_SERVICE_ROLE_KEY` → **falla si no hay Supabase real**
   - Usa `admin.auth.admin.createUser/deleteUser` → **Supabase Auth real**

**CI/CD Implication:** En CI/CD **requiere contenedor Supabase local running** (no mocks). No hay estrategia de mock para Auth en tests de integración.

**Conclusión Q5:** ⚠️ **Hard dependency en Supabase local**. ✅ Script de verificación existe. ❌ No hay fallback/mock para CI sin contenedor.

---

## Q6: FAULT INJECTION

### Hallazgo: **5 tests de fault injection cubren casos críticos — FALTAN vectores importantes**

**Cobertura actual (booking-fault-injection.spec.ts):**

| Test | Escenario | Código |
|------|-----------|--------|
| F04-01 | Doble confirmación concurrente mismo slot | `SLOT_CONFLICT` |
| F04-02 | Cancel + Reschedule concurrentes | `STALE_REVISION` / `CUTOFF` / `SLOT_CONFLICT` |
| F04-03 | Dos reschedules concurrentes | `SLOT_CONFLICT` |
| F04-04 | Rollback Reservation→Claim (falla infraestructura) | Transacción rollback |
| F04-05 | Idempotencia conflict (diferente principal, mismo operation_id) | `IDEMPOTENCY_CONFLICT` |

**VECTORES FALTANTES (críticos):**

| Vector faltante | Por qué importa | Test sugerido |
|-----------------|-----------------|---------------|
| **Cifrado envelope (guest_delivery_envelopes)** | Falla encriptación/desencriptación → token perdido | Inyectar fallo en `envelope.encrypt()` / `decrypt()` |
| **Release/Replace aislado** | `releaseAllocation` + `update reservation` en tx separadas | Test que falle entre release y reservation update |
| **Network partition / timeout** | Cliente no recibe respuesta tras commit exitoso | Simular `app.inject` timeout tras confirm |
| **Deadlock PostgreSQL** | Dos tx en orden inverso de locks | `Promise.all([txA.then(txB), txB.then(txA)])` |
| **Commit uncertainty (lost response)** | **CRÍTICO**: Respuesta perdida tras commit → reconciliation debe devolver **mismo** token | Verificar que `reconcile` devuelve `guestToken` **idéntico** al original (no uno nuevo) |
| **Idempotency response_body** | `operation_attempts.response_body` NO debe contener token | Verificar `response_body` sanitizado |

**Evidencia de gap en F04-04:** Test simula fallo **antes del Claim** (línea 168), pero no testa fallo **después del Claim pero antes del response**.

**Conclusión Q6:** ⚠️ **Cobertura parcial**. Faltan: commit uncertainty (token recovery identity), envelope crypto faults, network partition, deadlock, release/replace atomicidad parcial.

---

## Q7: COBERTURA MULTI-TENANT

### Hallazgo: **Tests crean múltiples businesses y validan aislamiento — COBERTURA BUENA**

**Evidencia:**

1. **booking-integrity.spec.ts**:
   - Líneas 133-138: Cross-business FK rejection (composite FK) → `23503`
   - Líneas 140-153: Cross-business Allocation vs Reservation → `23514` + verifica **0 filas huérfanas** post-rollback
   - Líneas 155-164: ReservationItem cross-business → `23503`

2. **booking-principals.spec.ts**:
   - Líneas 43-52: Reuse operation_id desde otro business → `IDEMPOTENCY_CONFLICT`
   - Líneas 29-35 (clients.spec.ts): Cross-business client detail → `404` (no revela existencia)

3. **clients.spec.ts**:
   - Líneas 122-128: Cross-business client detail → `404`
   - Líneas 329-337: Cross-business idempotency conflict → `IDEMPOTENCY_CONFLICT`

4. **booking-integrity.spec.ts** (líneas 214-225):
   - RLS denial para `anon` y `authenticated` roles en **6 tablas booking**:
     `reservations`, `reservation_items`, `reservation_events`, `guest_credentials`, `guest_delivery_envelopes`, `guest_recovery_cases`
   - Espera código `42501` (insufficient privilege)

**Gap:** No test explícito de `anon`/`authenticated` intentando **leer** booking tables via API (solo SQL directo). Pero RLS en SQL cubre el contrato.

**Conclusión Q7:** ✅ **Multi-tenant aislamiento probado**: FK cross-biz, RLS, idempotency cross-biz, 404 no-leak.

---

## Q8: PATHS DE ERROR NO PROBADOS

### Hallazgo: **Muchos DomainError codes cubiertos — FALTAN códigos huérfanos y validaciones límite**

**Codes PROBADOS (extraídos de tests):**

| Código | Test coverage |
|--------|---------------|
| `SLOT_CONFLICT` | booking-integrity (F01-3), fault-injection (F04-01/02/03), availability (GiST) |
| `IDEMPOTENCY_CONFLICT` | booking-principals (4 tests), fault-injection (F04-05), clients (4 tests) |
| `STALE_REVISION` | clients (stale revision), fault-injection (F04-02) |
| `BOOKING_POLICY_MISSING` | availability (policy absent) |
| `VALIDATION_ERROR` / `NO_AVAILABILITY` | availability (duplicate service, cadence) |
| `AVAILABILITY_IMPACT_CONFLICT` | availability (schedule/services/lifecycle impact) |
| `CONFLICT` (duplicate contact) | clients (duplicate phone) |
| `403` (RBAC) | clients (barber no read/create), booking-confirm (third party) |
| `404` (cross-biz no-leak) | booking-integrity, clients |
| `23514` (check constraints) | booking-integrity (10+ casos) |
| `23505` (unique violations) | booking-integrity (duplicate allocation, items) |
| `23503` (FK violations) | booking-integrity (cross-biz FK) |
| `23P01` (exclusion constraint) | availability (GiST overlap) |
| `55000` (trigger delete prevention) | booking-integrity (reservation_events, reservations) |
| `42501` (RLS) | booking-integrity, availability |

**Codes NO PROBADOS / HUÉRFANOS:**

| Código | Estado | Riesgo |
|--------|--------|--------|
| `CLIENT_AUTH_INSUFFICIENT` | **U02 ausente** — no hay auth client real | Tests de `clients.spec.ts` usan Supabase Auth real (owner/receptionist/barber tokens) pero **no testean flujo client-auth** |
| `BOOKING_OPERATION_CONFLICT` | **Código huérfano** (GF-01-021) — no aparece en tests | Puede no existir en implementación actual |
| `FORBIDDEN` | Parcial — 403 probado pero code `FORBIDDEN` vs `403` mapping no verificado | Zod validation vs DomainError mapping |
| `BOOKING_QUOTE_EXPIRED` | No probado | Quote TTL 5min — no test de quote expirado en confirm |
| `COMMERCIAL_TERMS_CHANGED` | No probado | Terms version change entre quote y confirm |
| `BOOKING_NOT_AVAILABLE` | No probado explícitamente | Distinto de `SLOT_CONFLICT` / `NO_AVAILABILITY` |
| `BOOKING_NOT_OWNED` | No probado | Guest token inválido para reservation ajena |
| `GUEST_ACCESS_INVALID` / `GUEST_RECOVERY_NOT_VERIFIED` | No probado | Credenciales invitadas |
| `BOOKING_CUTOFF_EXPIRED` | No probado | Cancel/reschedule fuera de cutoff |
| `BOOKING_ALREADY_CANCELLED` | No probado | Doble cancel |
| `RATE_LIMITED` | No probado | Rate limiting en API pública |
| `BOOKING_POLICY_UNAVAILABLE` | No probado | Policy version missing en operación |
| `BOOKING_QUOTE_INVALID` | No probado | Quote HMAC inválido / tampered |
| `BOOKING_OPERATION_NOT_RECOVERABLE` | No probado | Reconciliation impossible |

**Zod 400 vs DomainError 409/403:** Tests validan `VALIDATION_ERROR` (400) para schemas y `IDEMPOTENCY_CONFLICT`/`STALE_REVISION` (409) para domain. **No hay test de boundary** donde Zod pasa pero domain falla.

**Conclusión Q8:** ⚠️ **Cobertura buena en constraints SQL + idempotency + concurrency**. ❌ **Faltan ~15 DomainError codes** del contrato, especialmente flujos guest (quote expiry, terms changed, cutoff, recovery) y rate limiting.

---

## Q9: TESTS QUE PASARÍAN AUN CON BACKEND ROTO

### Hallazgo: **3 tests críticos tienen assertions débiles que podrían pasar con bug real**

| Test | Assertion actual | Bug que NO detectaría | Fix requerido |
|------|------------------|----------------------|---------------|
| **booking-confirm.spec.ts** líneas 50-59 (reconcile) | `expect(reconcileBody.guestToken).toBeTruthy()` | **Token NUEVO generado** en lugar de recuperar el original | Verificar `reconcileBody.guestToken === originalGuestToken` (extraer token del confirm response) |
| **booking-principals.spec.ts** línea 97 (ledger) | `expect(JSON.stringify(row!.responseBody)).toContain("r-ledger")` | **Token filtrado en response_body** | Verificar `!JSON.stringify(row!.responseBody).includes("leakedToken")` o `guestToken` |
| **booking-integrity.spec.ts** líneas 204-212 (rollback) | `expect(count).toBe("0")` solo para `reservations` | **Allocation huérfana** persistida (test no verifica `resource_allocations`) | Ya verifica ambos en F04-04 (líneas 173-174) — **inconsistencia** |
| **availability.spec.ts** línea 60-63 (ANY balancing) | `expect(deterministicCandidateOrder(...)).toEqual(...)` | **Non-determinismo** en producción (SQL ORDER BY distinto) | Test de integración que llama `resolveSlot` 100 veces y verifica distribución proporcional exacta |

**Evidencia del gap en reconcile:**
- `booking-confirm.spec.ts` línea 46: `confirmBody` NO incluye `guestToken` (solo `guestCredentialIssued: true`)
- Token se obtiene en reconcile (línea 58) pero **nunca se compara** con nada
- Si backend genera token nuevo en reconcile, test pasa igual

**Evidencia del gap en ANY balancing:**
- Unit test usa `deterministicCandidateOrder` función pura con seed fijo
- **No test de integración** que verifique `resolveSlot` con carga real produce mismo staff para mismo input

**Conclusión Q9:** ❌ **3 assertions críticas débiles**. Reconciliation token identity, ledger sanitization, ANY determinismo en integración.

---

## Q10: COBERTURA 277/277 VS 141/141

### Hallazgo: **"277" es INFLADO — no corresponde a tests ejecutados en este lote**

**Desglose real:**

| Fuente | Tests contados | Realidad |
|--------|----------------|----------|
| `pnpm exec vitest run tests/h03` (actual) | **141** | ✅ 14 test files, 141 tests PASS |
| `21_GLOBAL_REGRESSION.md` (G21) | 112 | h03 unit + integration **solo** (línea 10) |
| `25_EVIDENCE_INDEX.md` (G25) | 112 | Desglose: 10+6+6+20+8 + 17+2+8+17+24+3 = **112** |
| `client-auth.spec.ts` (unit + integration) | **Skipped** (U02 ausente) | 8 unit + 24 integration = **32 tests NO EJECUTADOS** |
| E2E (Playwright) | **No en vitest** | 4 archivos en `tests/h03/e2e/` — corren con `pnpm playwright test` |
| H01 tests | ~10-15 | No ejecutados en G21 |
| H02 tests | ~50-80 | No ejecutados en G21 |

**Cálculo del "277":**
- 112 (h03 G21) + 32 (client-auth skipped) + ~50 (h02) + ~15 (h01) + ~16 (e2e h03) + ~52 (e2e h02) ≈ **277**
- **Pero:** G21 dice explícitamente "No se ejecutaron suites h01/h02/e2e en este lote"

**Conclusión Q10:** ❌ **"277/277" es métrica histórica agregada, NO resultado de este lote**. El lote G21 = **112/112 h03 (unit+integration)**. El lote actual = **141/141 h03 (unit+integration)** — **29 tests nuevos** añadidos post-G21 (booking-fault-injection 5, booking-confirm 2, booking-principals 8, availability-api 3, clients 24, availability integration 17, etc. — net +29).

---

## MATRIZ DE RIESGO RESUMIDA

| Área | Severidad | Hallazgo | Acción Requerida |
|------|-----------|----------|------------------|
| **Q1 Real vs Mocks** | ✅ BAJA | Integración = PostgreSQL real + API real | Ninguna |
| **Q2 Fixtures/Cleanup** | ⚠️ MEDIA | Tests comparten business dentro de archivo; no TRUNCATE global | Añadir `afterEach` cleanup o usar transacciones por test |
| **Q3 E2E Real** | ✅ BAJA | Playwright = API real + Frontend real + BD real | Ninguna |
| **Q4 Regresiones H01/H02** | ⚠️ **ALTA** | Suites H01/H02 no corridas en lote | Ejecutar `vitest run tests/h01 tests/h02` en CI |
| **Q5 Supabase Assumptions** | ⚠️ MEDIA | Hard dependency contenedor local; sin mock CI | Documentar requisito; evaluar testcontainers |
| **Q6 Fault Injection** | ⚠️ **ALTA** | Faltan: commit uncertainty (token identity), envelope crypto, network partition, deadlock | Añadir 4-5 tests críticos |
| **Q7 Multi-tenant** | ✅ BAJA | Buena cobertura: FK, RLS, idempotency cross-biz | Ninguna |
| **Q8 Error Paths** | ⚠️ MEDIA | ~15 DomainError codes no probados (guest flows, rate limit) | Añadir tests para codes huérfanos |
| **Q9 Weak Assertions** | ⚠️ **ALTA** | 3 tests con assertions que pasan con bug real | Fortalecer: token identity, ledger sanitization, ANY determinismo |
| **Q10 Metric Inflation** | ⚠️ MEDIA | "277" inflado vs 141 real | Corregir reporte; separar métricas por suite |

---

## RECOMENDACIONES PRIORIZADAS

### P0 (Bloqueante para certificación)
1. **Ejecutar suites H01/H02 completas** en CI antes de merge — riesgo de regresión silenciosa
2. **Fortalecer 3 assertions débiles** (Q9): reconcile token identity, ledger sanitization, ANY determinismo integración
3. **Añadir test de "commit uncertainty"**: verificar que reconciliation devuelve **mismo** guestToken, no uno nuevo

### P1 (Alta prioridad)
4. **Añadir fault injection faltantes**: envelope crypto failure, network partition timeout, deadlock simulation, release/replace partial atomicity
5. **Cubrir DomainError codes huérfanos**: `BOOKING_QUOTE_EXPIRED`, `COMMERCIAL_TERMS_CHANGED`, `BOOKING_CUTOFF_EXPIRED`, `RATE_LIMITED`, `GUEST_ACCESS_INVALID`
6. **Mejorar cleanup**: `afterEach` con `TRUNCATE ... CASCADE` en tablas de test o transacciones por test (no solo por archivo)

### P2 (Media prioridad)
7. **Documentar dependencia Supabase local** en README/CI; evaluar testcontainers para CI aislado
8. **Corregir métrica histórica**: separar "h03 unit+integration" (141) de "total monorepo" (277+)
9. **Test de idempotencia response_body**: verificar que `operation_attempts.response_body` NO contiene `guestToken` ni secrets

### P3 (Baja prioridad)
10. **Test Zod 400 vs DomainError 409 boundary**: input que pasa Zod pero falla domain logic
11. **Test ANY balancing determinismo** en integración (100 iteraciones `resolveSlot` mismo input → mismo staff)

---

## VEREDICTO FINAL

| Criterio | Resultado |
|----------|-----------|
| **141/141 PASS es creíble** | ✅ **SÍ** — Tests reales contra PostgreSQL real + API real |
| **Cobertura suficiente para U04** | ⚠️ **PARCIAL** — Gaps en fault injection, error paths, assertions débiles |
| **Regresiones H01/H02 cubiertas** | ❌ **NO** — Suites no ejecutadas |
| **Métrica "277" válida** | ❌ **NO** — Inflada, mezcla suites no corridas + skipped |

**Certificación:** **CONDITIONAL PASS** — Requiere P0 resueltos antes de promover a producción.

---

*Fin del reporte GF-08*