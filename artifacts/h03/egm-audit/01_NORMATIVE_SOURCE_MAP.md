# 01 — NORMATIVE SOURCE MAP (EGM AUDIT)

**Fecha:** 2026-11-09
**Actor:** C — OpenCode V2 + Google Elephant-Goldfish Model

## 1. Fuentes Normativas Identificadas

### 1.1 Contratos TypeScript (Autoridad Primaria — Código Ejecutable)

| Archivo | Ubicación | Alcance | Versión |
|---|---|---|---|
| `booking.ts` | `packages/contracts/src/booking.ts` | Estados, principales, errores, quote TTL, schemas mutación, PolicySnapshot | Actual (HEAD) |
| `availability.ts` | `packages/contracts/src/availability.ts` | localDate, professionalPreference, BookingPolicy, AvailabilitySlot, ServiceRequirement, AllocationClaimInput | Actual (HEAD) |
| `client-auth.ts` | `packages/contracts/src/client-auth.ts` | ClientIdentityStatus, ClientOperationalStatus, bootstrap, recovery, phone change, password, sessions | Actual (HEAD) |

**Nota:** Estos contratos son **código ejecutable** (Zod schemas + tipos TypeScript). Son la fuente de verdad para validación de entrada/salida en runtime.

### 1.2 Esquema de Base de Datos (Autoridad Primaria — Persistencia)

| Migración | Ubicación | Alcance |
|---|---|---|
| `202611030001_h03_u02_client_identity.sql` | `supabase/migrations/` | Identidad CLIENT (cuenta global, sesión, MFA, revocación) — **AUSENTE en este workspace** |
| `202611050001_h03_u03_availability.sql` | `supabase/migrations/` | Disponibilidad: business_hours, booking_policy, staff_schedules, resource_allocations, GiST, business_guards |
| `202611050002_h03_u04_booking.sql` | `supabase/migrations/` | Booking: reservations, items, events, guest_credentials, guest_delivery_envelopes, guest_recovery_cases, operation_attempts extensiones, triggers diferibles, RLS |

### 1.3 Documentos de Especificación (Autoridad Normativa — Histórica)

Según `01_CURRENT_CROSSWALK.md` (G01), las fuentes normativas leídas íntegramente fueron:

| Documento | Descripción | Estado en Auditoría |
|---|---|---|
| `01_SPECIFY_H03_U04_V1.0.md` | Specify U04 — reglas de negocio, flujos, invariantes | **NO ENCONTRADO** en workspace — referenciado en crosswalk |
| `02_CLARIFY_STRESS_FREEZE_H03_U04_V1.0.md` | Clarify + Stress Freeze — decisiones finales, reglas congeladas | **NO ENCONTRADO** en workspace — referenciado en crosswalk |
| `03_TECHNICAL_PLAN_H03_U04_V1.0.md` | Technical Plan — arquitectura, módulos, contratos, DB | **NO ENCONTRADO** en workspace — referenciado en crosswalk |
| `04_HANDOFF_CODEX_TASKS_G00_G22_V1.0.md` | Handoff Codex — tareas por gate | **NO ENCONTRADO** en workspace — referenciado en crosswalk |

**CRÍTICO:** Los 4 documentos de especificación U04 **no están presentes en el filesystem del workspace**. Solo existen referencias en el crosswalk G01. La autoridad normativa efectiva son los **contratos TypeScript + migraciones SQL + código de implementación**.

### 1.4 Documentos de Auditoría Previa (Evidencia Histórica)

| Documento | Ubicación | Rol |
|---|---|---|
| `00_BASELINE_AND_WORKSPACE.md` → `25_EVIDENCE_INDEX.md` | `artifacts/h03/u04/` | 26 gates de implementación U04 |
| `01_BASELINE.md` → `15_FINAL_VERDICT.md` | `artifacts/h03/integration/` | 15 gates de convergencia U02+U03+U04 |
| `01_BASELINE.md` → `17_EVIDENCE_INDEX.md` | `artifacts/h03/u03/` | U03 Availability gates |
| `BASELINE.md` → `INFORME_FINAL.md` | `artifacts/h03/u01/` | U01 CRM gates |

### 1.5 Reglas de Negocio Críticas (Extraídas de Contratos + Crosswalk)

| Regla | Fuente | Verificación Requerida |
|---|---|---|
| Horizonte de 30 fechas locales | `availability.ts:17` (`horizonCalendarDates: min 1, max 366`) + crosswalk | Quote/Confirm respetan horizonte |
| Inicio de turnos :00 y :30 | `availability.ts:19` (`startStepMinutes: min 1, max 1440`) + U03 temporal engine | Slots solo en cadencia configurada |
| Lead time cero | `availability.ts:18` (`minLeadMinutes: min 0`) | Confirm permite reserva inmediata |
| Cutoff 120 min inclusivos | `booking.ts:153-154` (`cancelCutoffMinutes`, `rescheduleCutoffMinutes`) + `reservation.ts:cutoffAllows` | `<= start - cutoff*60` (inclusivo en segundos) |
| ANY con balanceo por carga relativa | U03 `resolveSlot` + crosswalk G01#6 | Desempate determinista |
| Reservation ID estable | `reservation.ts` + confirm/reschedule | Mismo ID en reprogramación |
| Snapshots económicos históricos | `reservation_items` + `policy_snapshot` | Precio/duración/buffers/policy congelados al confirmar |
| Atomicidad Reservation + Allocation | Migración U04 triggers diferibles + `confirm.ts` | Una Tx, rollback verificado |
| Guest sin creación automática CRM | `booking.ts:8-9` (`ownerTypes`), crosswalk G01#4 | Booking invitado no invoca CRM |
| CLIENT y STAFF autoridad separada | `booking.ts:28-32` (`BookingPrincipal` 4 kinds) | Aislamiento por principal verificado |
| Acceso por titularidad real | `cancel.ts:46-48`, `reschedule.ts:50-52`, `routes.ts:432-435` | Ownership check por accountId |
| Idempotencia por principal y Business | `operations.ts:36-67` (`executePrincipalOperation`) | `operation_id` + `request_hash` + principal scope |
| Verificación real recuperación/asociación | `guest-access.ts` + `recovery.ts` + `associate.ts` | Proof digest / evidence / audit |

## 2. Jerarquía de Autoridad (Para Resolución de Conflictos)

```
NIVEL 1 (MÁXIMA): Contratos TypeScript (Zod + tipos) + Migraciones SQL aplicadas
    │
    ├── packages/contracts/src/booking.ts
    ├── packages/contracts/src/availability.ts
    ├── packages/contracts/src/client-auth.ts
    ├── supabase/migrations/202611050001_h03_u03_availability.sql
    └── supabase/migrations/202611050002_h03_u04_booking.sql
    │
NIVEL 2: Código de implementación (runtime behavior)
    │
    ├── apps/api/src/modules/booking/**/*
    ├── apps/api/src/modules/availability/**/*
    ├── apps/api/src/modules/system/operations.ts
    └── apps/api/src/modules/iam/authorization.ts
    │
NIVEL 3: Tests (evidencia de comportamiento)
    │
    ├── tests/h03/unit/**/*.spec.ts
    ├── tests/h03/integration/**/*.spec.ts
    └── tests/h03/e2e/**/*.spec.ts
    │
NIVEL 4: Documentos de auditoría/implementación (histórico, no normativo)
    │
    ├── artifacts/h03/u04/**/*.md
    ├── artifacts/h03/integration/**/*.md
    ├── artifacts/h03/u03/**/*.md
    └── artifacts/h03/u01/**/*.md
    │
NIVEL 5 (MÍNIMA): Documentos Specify/Clarify/Technical Plan (NO ENCONTRADOS)
    │
    └── Referenciados en crosswalk G01 pero ausentes en filesystem
```

**Regla de resolución:** Ante contradicción, prevalece el nivel numéricamente menor. Los documentos de especificación ausentes (Nivel 5) **no pueden usarse** como autoridad.

## 3. Matriz de Requisitos Críticos por Fuente

| Requisito ID | Descripción | Contrato (N1) | SQL (N1) | Impl (N2) | Tests (N3) | Doc (N4) |
|---|---|---|---|---|---|---|
| REQ-BK-001 | Quote TTL 5 min, HMAC-SHA256 | `booking.ts:45,70-75` | — | `quote.ts:43-49,53-75` | `booking-quote.spec.ts` | G04 |
| REQ-BK-002 | Confirm Guest: quote → idempotencia → guard → U03 → Reservation+Allocation → credencial+envelope | `booking.ts:97-104` | Migración U04 | `confirm.ts:212-236` | `booking-confirm.spec.ts` | G07 |
| REQ-BK-003 | Confirm Client: misma transacción, ownerType=CLIENT | `booking.ts:106-109` | Migración U04 | `confirm.ts:243-265` | **BLOQUEADO** (U02) | G11 |
| REQ-BK-004 | Cancel: cutoff histórico inclusivo, Release U03 | `booking.ts:115-118` | Trigger diferible | `cancel.ts:26-77` | `booking-confirm.spec.ts` + unit | G12 |
| REQ-BK-005 | Reschedule: mismo ID, términos históricos, Replace atómico | `booking.ts:120-125` | Trigger diferible | `reschedule.ts:30-131` | `booking-confirm.spec.ts` | G13 |
| REQ-BK-006 | Guest token ≥256 bits, digest SHA-256, envelope AEAD | `booking.ts:10-11` | `guest_credentials`, `guest_delivery_envelopes` | `guest-access.ts` | `booking-security.spec.ts` | G09 |
| REQ-BK-007 | Reconciliación lost response: x-intent-proof → envelope | `booking.ts:10` | `guest_delivery_envelopes` | `routes.ts:144-164` | `booking-confirm.spec.ts` | G10 |
| REQ-BK-008 | Recovery asistida: capability + evidence + fail-closed | — | `guest_recovery_cases` | `recovery.ts` | **BLOQUEADO** (canal) | G14 |
| REQ-BK-009 | Staff overrides: capability + bypass cutoff + U03 | `booking.ts:136-142` | — | `staff-exceptions.ts` | `booking-integrity.spec.ts` | G15 |
| REQ-BK-010 | Idempotencia multi-principal (STAFF/CLIENT/GUEST) | `booking.ts:34-41` | `operation_attempts` + cols | `operations.ts:36-67` | `booking-principals.spec.ts` | G05 |
| REQ-BK-011 | Integridad Reservation↔Allocation (triggers diferibles) | — | Migración U04 L208-301 | `confirm.ts`, `cancel.ts`, `reschedule.ts` | `booking-integrity.spec.ts` (17) | G08 |
| REQ-BK-012 | Multi-tenant aislamiento (composite FK + RLS) | — | Migración U04 FKs compuestas | `routes.ts` queries | `booking-integrity.spec.ts` | G16 |
| REQ-BK-013 | Cliente identity (U02) — **AUSENTE** | `client-auth.ts` | Migración U02 **ausente** | `client-principal.ts` fail-closed | `client-auth.spec.ts` skipped | G11/G18 |
| REQ-BK-014 | Guest→Client associate: proof + audit | `booking.ts:19` | `guest_credentials` | `associate.ts` + `routes.ts:406-425` | **BLOQUEADO** (U02) | G11 |
| REQ-AV-001 | resolveSlot: horizonte, cadencia, lead, D13, ANY balanceo | `availability.ts:39-44,74-82` | U03 migración | `queries.ts`, `temporal.ts` | `availability.spec.ts` (44) | G06 |
| REQ-AV-002 | Claim/Release/Replace en Tx compartida | `availability.ts:74-82` | `resource_allocations` GiST | `allocation.ts` | `availability.spec.ts` | G06 |
| REQ-AV-003 | Guard Business primero (lock order) | — | `business_guards` | `guard.ts` + `confirm.ts:114` | `schedules/commands.ts` diff | G01#23 |

## 4. Brechas Documentales Identificadas

| Brecha | Impacto | Acción Requerida |
|---|---|---|
| Specify U04 (4 docs) ausentes en filesystem | No hay fuente normativa escrita separada del código | Usar contratos TypeScript + SQL como autoridad; documentar en auditoría |
| U02 Specify/Clarify ausentes | Imposible auditar requisitos CLIENT completos | Declarar BLOCKED_EXTERNAL_CONVERGENCE; auditar solo interfaces U04 |
| 277 tests reportados vs 141 h03 reales | Discrepancia en reporte histórico | Verificar conteo total (incluir h01/h02); distinguir suites |

## 5. Decisiones de Autoridad para la Auditoría

1. **Contratos TypeScript + Migraciones SQL = Ley**. Son ejecutables y persisten en runtime.
2. **Código de implementación = Comportamiento real**. Se audita contra contratos.
3. **Tests = Evidencia**. 141 tests h03 PASS confirman comportamiento; no sustituyen spec.
4. **Docs de auditoría previa = Contexto histórico**. Útiles para trazabilidad, no normativos.
5. **Specify/Clarify ausentes = No existen**. No se inventan; se audita lo implementado.

**Próximo paso:** Construir matriz de trazabilidad `REQUIREMENT → SPECIFICATION → IMPLEMENTATION → TEST → RUNTIME EVIDENCE → STATUS` (Artifact 02).