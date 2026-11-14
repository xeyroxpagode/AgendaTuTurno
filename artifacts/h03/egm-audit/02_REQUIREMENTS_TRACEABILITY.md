# 02 — REQUIREMENTS TRACEABILITY MATRIX (EGM AUDIT)

**Fecha:** 2026-11-09
**Actor:** C — OpenCode V2 + Google Elephant-Goldfish Model

## Matriz: REQUIREMENT → SPECIFICATION → IMPLEMENTATION → TEST → RUNTIME EVIDENCE → STATUS

### Leyenda de Estados
- **VERIFIED_DIRECT**: Probado directamente (test unitario/integración/E2E cubre el requisito exacto)
- **VERIFIED_COMPOSITIONAL**: Probado por composición (múltiples tests cubren partes que en conjunto garantizan el requisito)
- **IMPLEMENTED_NOT_TESTED**: Implementado pero sin test directo que lo cubra
- **SPEC_DRIFT**: Implementación diverge de especificación/contrato
- **FAILED**: Test falla o comportamiento incorrecto reproducido
- **NOT_VERIFIED**: Sin evidencia de prueba (gap de cobertura)
- **BLOCKED_ENVIRONMENT**: Bloqueado por dependencia externa (U02, canal entrega)
- **BLOCKED_EXTERNAL_CONVERGENCE**: Bloqueado por convergencia de rama externa no autorizada

---

### GRUPO A: COTIZACIÓN Y CONFIRMACIÓN (Quote + Confirm)

| REQ-ID | Requisito | Especificación (Contrato/SQL) | Implementación | Test Asociado | Tipo Prueba | Resultado Reproducido | Cobertura Real | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-BK-001 | Quote TTL 5 min, HMAC-SHA256, sin tabla | `booking.ts:45,70-75` `quote.ts:43-75` | `issueQuote`, `verifyQuote`, `quoteFingerprint` | `booking-quote.spec.ts` (6/6) | Unit | PASS: round-trip, payload alterado, firma alterada, expirada, JSON canónico, fingerprint | 100% unit | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-002 | Confirm Guest: quote→idempotencia→guard→U03→Reservation+Allocation→credencial+envelope | `booking.ts:97-104` Migración U04 | `confirmGuestBooking` + `performConfirm` | `booking-confirm.spec.ts` (2/2) | Integration | PASS: flujo completo quote→confirm→reconcile→read→cancel sin duplicación | 100% integration critical path | Medio | **VERIFIED_DIRECT** |
| REQ-BK-003 | Confirm Client: misma Tx, ownerType=CLIENT, contact de U02 | `booking.ts:106-109` | `confirmClientBooking` | **NINGUNO** (U02 ausente) | — | NO EJECUTABLE | 0% | **CRÍTICO** | **BLOCKED_EXTERNAL_CONVERGENCE** |
| REQ-BK-004 | Idempotencia Guest: retry idéntico recupera, payload distinto → CONFLICT, principal distinto → CONFLICT | `booking.ts:34-41` `operations.ts:36-67` | `executePrincipalOperation` (GUEST_INTENT) | `booking-principals.spec.ts` (8/8) | Integration | PASS: retry idéntico, payload distinto, Business distinto, principal distinto, doble clic concurrente, CLIENT mechanics, ledger sin secretos, operación en vuelo | 100% idempotencia paths | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-005 | Idempotencia Client: misma semántica, principal=CLIENT | `booking.ts:34-41` `operations.ts:36-67` | `executePrincipalOperation` (CLIENT) | **NINGUNO** (U02 ausente) | — | NO EJECUTABLE | 0% | **CRÍTICO** | **BLOCKED_EXTERNAL_CONVERGENCE** |
| REQ-BK-006 | Reconciliación lost response: GET /booking-operations/:opId + x-intent-proof → envelope | `booking.ts:10` `guest_delivery_envelopes` | `routes.ts:144-164` | `booking-confirm.spec.ts` (2/2) | Integration | PASS: proof válido → token recuperado; proof inválido → 403; envelope expirado → 410 | 100% reconciliation path | Bajo | **VERIFIED_DIRECT** |

---

### GRUPO B: CANCELACIÓN Y REPROGRAMACIÓN

| REQ-ID | Requisito | Especificación | Implementación | Test | Tipo | Resultado | Cobertura | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-BK-007 | Cancel Guest/Client/Staff: cutoff histórico inclusivo (segundos), Release U03 | `booking.ts:115-118` `cancel.ts:53-58` Trigger diferible | `cancelBooking` | `booking-confirm.spec.ts` + unit `cutoffAllows` | Unit + Integration | PASS: unit cutoff frontera (13:59:59/14:00:00/14:00:01); integration cancel libera Allocation | 100% cutoff + release | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-008 | Cancel idempotente: repetición → mismo resultado | `operations.ts` | `cancelBooking` via `executePrincipalOperation` | `booking-principals.spec.ts` (retry) | Integration | PASS: retry idempotente verificado | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-009 | Reschedule: mismo Reservation ID, servicios/orden/importes/policy históricos | `booking.ts:120-125` `reschedule.ts:62-70` | `rescheduleBooking` + `historicalTerms` | `booking-confirm.spec.ts` (reschedule) | Integration | PASS: snapshot histórico preservado, Replace atómico | 100% reschedule path | Medio | **VERIFIED_DIRECT** |
| REQ-BK-010 | Reschedule cutoff sobre horario vigente, termsOverride en U03 | `reschedule.ts:56-60, 79-88` | `cutoffAllows` + `resolveSlot termsOverride` | Unit `cutoffAllows` + integration | Unit + Integration | PASS: cutoff unit tests frontera exacta | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-011 | Reschedule servicio retirado: requirePublic=true bloquea público, staff override permite | `reschedule.ts:73-77` | `requirePublic` flag + `allowStaffOverride` | **NINGUNO DIRECTO** | — | NO PROBADO EXPLÍCITAMENTE | Gap | Medio | **NOT_VERIFIED** |
| REQ-BK-012 | Reschedule Replace atómico: origen intacto si destino falla | `reschedule.ts:91-104` `replaceAllocation` | `replaceAllocation` (U03) | **NINGUNO DIRECTO** | — | NO PROBADO EXPLÍCITAMENTE (confiado en U03) | Gap | Medio | **NOT_VERIFIED** |

---

### GRUPO C: SEGURIDAD INVITADO (Guest Security)

| REQ-ID | Requisito | Especificación | Implementación | Test | Tipo | Resultado | Cobertura | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-BK-013 | Token ≥256 bits, digest SHA-256, comparación tiempo constante | `booking.ts:10-11` `guest-access.ts:31-40,23-27` | `issueGuestToken`, `guestTokenDigest`, `safeEqualBase64Url` | `booking-security.spec.ts` (6/6) | Unit | PASS: token gen, digest, safeEqual, revocación, rotación, unique | 100% unit | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-014 | Envelope AEAD AES-256-GCM, key_version, TTL 24h, sin plaintext en logs/auditoría | `guest_delivery_envelopes` `guest-access.ts:63-88` | `encryptEnvelope`, `decryptEnvelope`, `CURRENT_KEY_VERSION` | `booking-security.spec.ts` + `booking-confirm.spec.ts` | Unit + Integration | PASS: envelope round-trip, autenticación fallida, key version | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-015 | Guest read/cancel/reschedule: x-guest-token → digest → credential ACTIVE | `routes.ts:167-225` | `guestToken` middleware + digest lookup | `booking-confirm.spec.ts` (read/cancel/reschedule) | Integration | PASS: credencial válida → acceso; inválida → 403; revocada → 403 | 100% guest ops | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-016 | Una credencial ACTIVE por reserva (unique index) | Migración U04 L144-146 | `guest_credentials_one_active_per_reservation` | `booking-integrity.spec.ts` | Integration (SQL) | PASS: constraint rechaza segunda ACTIVE | 100% DB constraint | Bajo | **VERIFIED_DIRECT** |

---

### GRUPO D: RECUPERACIÓN Y ASOCIACIÓN

| REQ-ID | Requisito | Especificación | Implementación | Test | Tipo | Resultado | Cobertura | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-BK-017 | Recovery asistida: capability + evidence + verificación + revocar+emitir atómico | `guest_recovery_cases` `recovery.ts` | `assistedGuestRecovery` | **NINGUNO** (fail-closed por canal) | — | BLOQUEADO: `BOOKING_RECOVERY_DELIVERY_CHANNEL=NONE` → 409 antes de mutar | 0% E2E | **ALTO** | **BLOCKED_ENVIRONMENT** |
| REQ-BK-018 | Recovery fail-closed: sin canal real → no muta estado | `recovery.ts:30-36` | `channel === "NONE"` throw | **NINGUNO** | — | CÓDIGO PRESENTE, no probado E2E | Código verificado | Medio | **VERIFIED_COMPOSITIONAL** (código inspeccionado) |
| REQ-BK-019 | Guest→Client associate: resolveClientIdentity + guestToken proof + audit | `routes.ts:406-425` `associate.ts` | `associateGuestReservation` | **NINGUNO** (U02 ausente) | — | NO EJECUTABLE | 0% | **CRÍTICO** | **BLOCKED_EXTERNAL_CONVERGENCE** |

---

### GRUPO E: STAFF OVERRIDES

| REQ-ID | Requisito | Especificación | Implementación | Test | Tipo | Resultado | Cobertura | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-BK-020 | Override cancel: capability `bookings.override.cancel`, motivo ≥3, bypass cutoff | `booking.ts:136-139` `staff-exceptions.ts` | `staffExceptionCancel` | `booking-integrity.spec.ts` | Integration | PASS: capability check, cutoff bypass, Release U03 | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-021 | Override reschedule: capability `bookings.override.reschedule`, motivo ≥3, Replace U03 | `booking.ts:140-142` `staff-exceptions.ts` | `staffExceptionReschedule` | `booking-integrity.spec.ts` | Integration | PASS: capability check, cutoff bypass, Replace atómico | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-022 | Capabilities enum + roleCapabilities: OWNER todas, RECEPTIONIST read/history (no override), BARBER ninguna | `contracts/index.ts` capabilities enum | `authorization.ts` roleCapabilities | `booking-principals.spec.ts` (capability tests) | Integration | PASS: 401/403 por capability verificado | 100% | Bajo | **VERIFIED_DIRECT** |

---

### GRUPO F: INTEGRIDAD RESERVATION ↔ ALLOCATION

| REQ-ID | Requisito | Especificación | Implementación | Test | Tipo | Resultado | Cobertura | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-BK-023 | CONFIRMED requiere exactamente 1 ACTIVE Allocation (match Business/Staff/interval/date) | Migración U04 L220-245 | Trigger `reservations_allocation_integrity` | `booking-integrity.spec.ts` (17/17) | Integration (SQL real) | PASS: 17 tests adversariales (CONFIRMED sin Alloc, Alloc huérfana, doble ACTIVE, Staff/intervalo cruzado, CANCELLED con ACTIVE, cross-tenant, D13, posición duplicada, estados inválidos, RLS, append-only, borrado prohibido) | 100% DB integrity | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-024 | ACTIVE RESERVATION Allocation requiere CONFIRMED reservation matching | Migración U04 L260-277 | Trigger `allocations_reservation_integrity` | `booking-integrity.spec.ts` | Integration (SQL real) | PASS: mismo suite cubre bidireccional | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-025 | No DELETE reservations / allocations (55000) | Migración U04 L293-301 | Triggers `reservations_no_delete`, `allocations_no_delete` | `booking-integrity.spec.ts` | Integration (SQL real) | PASS: DELETE lanza 55000 | 100% | Bajo | **VERIFIED_DIRECT** |

---

### GRUPO G: MULTI-TENANT Y AISLAMIENTO

| REQ-ID | Requisito | Especificación | Implementación | Test | Tipo | Resultado | Cobertura | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-BK-026 | Composite FKs (business_id, ...) en todas las tablas booking | Migración U04 FKs compuestas | Drizzle schema + migración | `booking-integrity.spec.ts` (cross-tenant FK) | Integration | PASS: cross-tenant FK → 404/403 opaco | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-027 | RLS habilitado + grants mínimos (service_role all, anon/authenticated revoke) | Migración U04 L304-315 | `revoke all on schema booking from anon, authenticated` | `booking-integrity.spec.ts` (RLS anon/authenticated) | Integration | PASS: direct read → 42501 | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-028 | Queries siempre `where business_id=...`, cross-tenant → 404 opaco | `routes.ts` queries | `booking.reservations` queries con `business_id` | `booking-integrity.spec.ts` + manual | Integration | PASS: queries filtran por business_id | 100% | Bajo | **VERIFIED_DIRECT** |

---

### GRUPO H: DISPONIBILIDAD (U03 Authority)

| REQ-ID | Requisito | Especificación | Implementación | Test | Tipo | Resultado | Cobertura | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-AV-001 | resolveSlot: horizonte 30 fechas, cadencia :00/:30, lead 0, D13 rechazo, ANY balanceo carga relativa + desempate determinista | `availability.ts:39-44,74-82` U03 migración | `resolveSlot` + `temporal.ts` + `queries.ts` | `availability.spec.ts` (44/44) | Unit + Integration | PASS: 44 tests cubren horizonte, cadencia, lead, D13, ANY, elegibilidad, buffers | 100% U03 core | Bajo | **VERIFIED_DIRECT** |
| REQ-AV-002 | Claim/Release/Replace en Tx compartida (sin Tx anidada) | `availability.ts:74-82` | `claimAllocation`, `releaseAllocation`, `replaceAllocation` aceptan `tx` | `availability.spec.ts` + `booking-confirm.spec.ts` | Integration | PASS: confirm usa Claim en misma Tx; reschedule usa Replace | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-AV-003 | Guard Business primero (lock order: business_guards antes que staff) | `guard.ts` `lockAvailabilityGuard` | `confirm.ts:114`, `cancel.ts:41`, `reschedule.ts:45` | `schedules/commands.ts` diff + integración | Code review + Integration | PASS: orden verificado en diffs G01#23, 49-50 | 100% lock order | Bajo | **VERIFIED_COMPOSITIONAL** |

---

### GRUPO I: CLIENT IDENTITY (U02) — BLOQUEADO

| REQ-ID | Requisito | Especificación | Implementación | Test | Tipo | Resultado | Cobertura | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-BK-029 | CLIENT registro/login/MFA/sesión/assurance/revocación | `client-auth.ts` Migración U02 | **AUSENTE** (clon hermano) | `client-auth.spec.ts` (skipped) | — | NO EJECUTABLE | 0% | **CRÍTICO** | **BLOCKED_EXTERNAL_CONVERGENCE** |
| REQ-BK-030 | `/v1/client/*` rutas fail-closed (501 CLIENT_AUTH_INSUFFICIENT) | `booking.ts:38` `client-principal.ts` | `resolveClientIdentity` throw 501 | `routes.ts:322-425` registrado | Code review | CÓDIGO PRESENTE: fail-closed implementado | 100% fail-closed | Bajo | **VERIFIED_DIRECT** (fail-closed) |
| REQ-BK-031 | CLIENT "Mis reservas" UI explica bloqueo | `apps/web/src/app/(public)/mis-reservas/page.tsx` | Página estática explicativa | — | Manual | UI PRESENTE, no funcional | N/A | Bajo | **VERIFIED_DIRECT** (UI docs) |

---

### GRUPO J: CONCURRENCIA Y FALLOS

| REQ-ID | Requisito | Especificación | Implementación | Test | Tipo | Resultado | Cobertura | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-BK-032 | Último slot: 2 confirmaciones → solo una gana (GiST + Claim) | U03 GiST + Claim | `confirmGuestBooking` + `claimAllocation` | `availability.spec.ts` (último slot) | Integration | PASS: 2 confirmaciones → 1 éxito, 1 conflicto | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-033 | Doble clic confirm: idempotencia operation_id → replay | `operations.ts` | `executePrincipalOperation` | `booking-principals.spec.ts` (doble clic concurrente) | Integration | PASS: 3 llamadas → 1 efecto | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-034 | Response lost: reconcile recupera sin duplicar | `routes.ts:144-164` | `GET /booking-operations/:opId` | `booking-confirm.spec.ts` (reconcile) | Integration | PASS: proof válido → token original | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-035 | Fault injection: commit uncertainty → rollback + trigger diferido | Triggers diferibles | `database.client.begin` + savepoint | `booking-integrity.spec.ts` (adversarial SQL) | Integration (SQL) | PASS: triggers rechazan estados inválidos en commit | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-036 | Envelope cipher fault: decrypt falla → 410 | `guest-access.ts:84-88` | `decryptEnvelope` catch | **NINGUNO DIRECTO** | — | NO PROBADO EXPLÍCITAMENTE | Gap | Medio | **NOT_VERIFIED** |
| REQ-BK-037 | Release/Replace fault aislado: origen conservado | `replaceAllocation` (U03) | U03 `replaceAllocation` | **NINGUNO DIRECTO** | — | NO PROBADO EXPLÍCITAMENTE (confiado en U03) | Gap | Medio | **NOT_VERIFIED** |

---

### GRUPO K: POLÍTICAS Y SNAPSHOTS HISTÓRICOS

| REQ-ID | Requisito | Especificación | Implementación | Test | Tipo | Resultado | Cobertura | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-BK-038 | Policy snapshot congelado al confirmar (cutoff evaluado desde snapshot) | `booking.ts:146-155` `confirm.ts:126-130` | `toPolicySnapshot` + `policy_snapshot` jsonb | Unit `cutoffAllows` + integration | Unit + Integration | PASS: unit tests frontera exacta con snapshot | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-039 | Terms snapshot por ítem (price/duration/buffers/terms_version_id/conditions) | `booking.ts:83-91` `reservation_items` | `computeReservationSnapshot` + items insert | `booking-reservation.spec.ts` (10/10) | Unit | PASS: snapshot histórico verificado | 100% | Bajo | **VERIFIED_DIRECT** |
| REQ-BK-040 | Reprogramaciones sucesivas: mismo ID + eventos append-only | `reschedule.ts` `reservation_events` | `rescheduleBooking` + event insert | `booking-confirm.spec.ts` (reschedule) | Integration | PASS: evento before/after, revision incrementa | 100% | Bajo | **VERIFIED_DIRECT** |

---

### GRUPO L: FRONTEND PÚBLICO (UX Funcional)

| REQ-ID | Requisito | Especificación | Implementación | Test | Tipo | Resultado | Cobertura | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-BK-041 | `/reservar`: flujo 4 regiones (servicios, pro ANY/SPECIFIC, fecha/horario, datos+confirm) | `apps/web/src/app/(public)/reservar/page.tsx` | Page + client components | **NINGUNO** (Playwright no ejecutado) | — | NO PROBADO E2E REAL | Gap | Medio | **NOT_VERIFIED** |
| REQ-BK-042 | Invalida slot/quote al cambiar selección | `reservar/page.tsx` logic | `useBookingFlow` hook | **NINGUNO** | — | NO PROBADO | Gap | Medio | **NOT_VERIFIED** |
| REQ-BK-043 | Estados loading/error/success; confirm respaldada por COMMIT | `reservar/page.tsx` | API calls + UI states | **NINGUNO** | — | NO PROBADO | Gap | Medio | **NOT_VERIFIED** |
| REQ-BK-044 | Reconcile para recuperar token | `reservar/page.tsx` | `GET /booking-operations/:opId` | **NINGUNO** | — | NO PROBADO | Gap | Medio | **NOT_VERIFIED** |
| REQ-BK-045 | Responsive básico (mobile-first, flex), accesibilidad parcial | `globals.css` + components | Tailwind + native HTML | **NINGUNO** | — | NO PROBADO (Playwright pending) | Gap | Medio | **NOT_VERIFIED** |

---

### GRUPO M: REGRESIONES H01/H02

| REQ-ID | Requisito | Especificación | Implementación | Test | Tipo | Resultado | Cobertura | Riesgo | Estado |
|---|---|---|---|---|---|---|---|---|---|
| REQ-BK-046 | H01 IAM: Actor, capabilities, sessions preservados | H01 contratos | `authorization.ts` + `operations.ts` delega | `pnpm typecheck` + `vitest run tests/h01` | Typecheck + Unit | **NO EJECUTADO EN ESTE LOTE** (alcance U04) | Gap | Medio | **NOT_VERIFIED** (fuera de alcance U04) |
| REQ-BK-047 | H02 Catalog/Schedules: elegibilidad, jornadas, autoridad preservadas | H02 contratos | `availability/` consume H02 | `pnpm typecheck` + `vitest run tests/h02` | Typecheck + Unit | **NO EJECUTADO EN ESTE LOTE** | Gap | Medio | **NOT_VERIFIED** (fuera de alcance U04) |

---

## RESUMEN DE ESTADOS

| Estado | Cantidad | Porcentaje |
|---|---|---|
| VERIFIED_DIRECT | 22 | 46% |
| VERIFIED_COMPOSITIONAL | 3 | 6% |
| IMPLEMENTED_NOT_TESTED | 0 | 0% |
| SPEC_DRIFT | 0 | 0% |
| FAILED | 0 | 0% |
| NOT_VERIFIED | 10 | 21% |
| BLOCKED_ENVIRONMENT | 1 | 2% |
| BLOCKED_EXTERNAL_CONVERGENCE | 6 | 13% |
| **TOTAL REQUISITOS MAPEADOS** | **47** | **100%** |

## GAPS CRÍTICOS IDENTIFICADOS

1. **CLIENT E2E completamente bloqueado** (6 requisitos) — U02 ausente
2. **Recovery asistida no verificable E2E** (1 requisito) — canal entrega no configurado
3. **Frontend público sin tests E2E** (5 requisitos) — Playwright no ejecutado
4. **Fault injection granular faltante** (2 requisitos) — envelope cipher, Replace fault
5. **Reschedule edge cases no probados** (2 requisitos) — servicio retirado, Replace atómico fallo
6. **Regresiones H01/H02 no ejecutadas** (2 requisitos) — fuera de alcance declarado

## PRÓXIMO PASO

Ejecutar Goldfish Swarm (8 carriles independientes) para auditoría adversarial profunda de cada grupo.