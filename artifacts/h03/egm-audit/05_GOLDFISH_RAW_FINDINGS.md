# 05 — GOLDFISH RAW FINDINGS CONSOLIDATED (EGM AUDIT)

**Fecha:** 2026-11-09
**Actor:** C — OpenCode V2 + Google Elephant-Goldfish Model

## Consolidación de Hallazgos por Goldfish

### GF-01: SEMANTIC FIDELITY (36 hallazgos)

| ID | Severidad | Estado | Resumen |
|---|---|---|---|
| GF-01-001 | P0 | CONFIRMED_DEFECT | `termsOverride` no pasado a `resolveSlot` en confirmación multi-servicio → `occupiedMinutes` puede calcularse mal |
| GF-01-002 | P1 | SPEC_AMBIGUITY | Reprogramación pública ignora `professionalPreference` del body (forza staff original) — no documentado en contratos |
| GF-01-003 | P1 | CONFIRMED_DEFECT | Validación duplicada cadencia en `queries.ts:104-105` (código muerto) |
| GF-01-004 | P0 | CONFIRMED_DEFECT | Asimetría validación `businessId` entre guest/client confirm (guest valida explícito, client confía en quote) |
| GF-01-005 | P0 | STRONG_HYPOTHESIS | Client confirm crashea sin U02 (import falla) vs 501 controlado |
| GF-01-006 | P0 | FALSE_POSITIVE | D13 validado en 4 capas correctamente |
| GF-01-007 | P1 | FALSE_POSITIVE | Unique constraint DB evita duplicados correctamente |
| GF-01-008 | P0 | FALSE_POSITIVE | `computeReservationSnapshot` solo comercial; temporal en `resolveSlot` |
| GF-01-009 | P0 | FALSE_POSITIVE | `policy_snapshot` congela 10/10 campos |
| GF-01-010 | P0 | FALSE_POSITIVE | `reservation_items` congela 6/6 campos económicos |
| GF-01-011 | P0 | FALSE_POSITIVE | Reschedule usa `historicalTerms` desde DB, nunca body |
| GF-01-012 | P0 | FALSE_POSITIVE | `cutoffAllows` inclusivo correcto + test |
| GF-01-013 | P0 | FALSE_POSITIVE | `releaseAllocation` en misma transacción |
| GF-01-014 | P0 | FALSE_POSITIVE | CANCELLED terminal bloqueado en dominio + comando |
| GF-01-015 | P0 | FALSE_POSITIVE | Reschedule preserva reservationId |
| GF-01-016 | P0 | FALSE_POSITIVE | `termsOverride` desde DB en reschedule |
| GF-01-017 | P0 | FALSE_POSITIVE | `replaceAllocation` atómico por rollback PG |
| GF-01-018 | P1 | CONFIRMED_DEFECT | Staff override no pasa `requirePublic=false` a `resolveSlot` → no puede reprogramar servicio despublicado |
| GF-01-019 | P0 | FALSE_POSITIVE | Asociación exige U02 + guest token proof |
| GF-01-020 | P0 | STRONG_HYPOTHESIS | Associate crashea sin U02 (mismo GF-01-005) |
| GF-01-021 | P1 | CONFIRMED_DEFECT | `BOOKING_OPERATION_CONFLICT` código huérfano sin uso |
| GF-01-022 | P1 | CONFIRMED_DEFECT | `IDEMPOTENCY_CONFLICT` vs `CONFLICT` OK; tercer código huérfano |
| GF-01-023 | P0 | FALSE_POSITIVE | `GUEST_RECOVERY_NOT_VERIFIED` antes de mutar |
| GF-01-024 | P0 | FALSE_POSITIVE | Capabilities `bookings.override.*` exigidas en route |
| GF-01-025 | P1 | FALSE_POSITIVE | Bypass cutoff público pero VALIDAN U03 (guard + GiST) |
| GF-01-026 | P1 | CONFIRMED_DEFECT | Event type `STAFF_EXCEPTION_APPLIED` definido pero nunca emitido (cancel/reschedule usan genéricos) |
| GF-01-027 | P1 | FALSE_POSITIVE | Sin código incompleto (TODO/unimplemented) |
| GF-01-028 | P2 | FALSE_POSITIVE | `bookingConfirmClientSchema` tiene path real en route |
| GF-01-029 | P1 | CONFIRMED_DEFECT | Validación duplicada cadencia en `queries.ts:104-105` (línea 105 duplicada) |
| GF-01-030 | P1 | CONFIRMED_DEFECT | Recovery envelope usa `Buffer.from(token, "utf8")` sin cifrado AEAD → incompatible con reconcile endpoint |
| GF-01-031 | P2 | CONFIRMED_DEFECT | `intent_proof_digest` en recovery = "recovery" literal vs digest SHA256 en confirm — inconsistencia semántica |
| GF-01-032 | P1 | FALSE_POSITIVE | INSERT reservation con `current_allocation_id=null` luego UPDATE — OK por trigger DEFERRABLE |
| GF-01-033 | P1 | CONFIRMED_DEFECT | Rate limit in-memory (`Map`) no distribuido — bypassable en multi-instancia |
| GF-01-034 | P2 | CONFIRMED_DEFECT | Dev key fallback inseguro (`localDevKey` hash fijo) en producción si `BOOKING_GUEST_KEY_V1` ausente |
| GF-01-035 | P1 | FALSE_POSITIVE | Revalidación terms por índice correcta (Map preserva orden) |
| GF-01-036 | P1 | FALSE_POSITIVE | `assertWithinHorizon` condicional a `requirePublic` correcto |

---

### GF-02: IAM, SECURITY & ISOLATION (9 hallazgos)

| ID | Severidad | Estado | Resumen |
|---|---|---|---|
| GF-02-P1-01 | P1 | CONFIRMED_DEFECT | Fallback de claves determinísticas en dev (`guest-access.ts`, `quote.ts`) — fallar si env vars ausentes en producción |
| GF-02-P1-02 | P1 | CONFIRMED_DEFECT | Token de recovery almacenado **en claro** en `guest_delivery_envelopes` (key_version='recovery') — usar `encryptEnvelope` |
| GF-02-P1-03 | P1 | CONFIRMED_DEFECT | CORS single-origin string — migrar a allowlist array desde env |
| GF-02-P2-01 | P2 | CONFIRMED_DEFECT | TTL envelope hardcoded 24h (`ENVELOPE_TTL_HOURS = 24`) — hacer configurable |
| GF-02-P2-02 | P2 | CONFIRMED_DEFECT | Rate limit in-memory (`Map`) — no distribuido, memory leak |
| GF-02-P2-03 | P2 | CONFIRMED_DEFECT | Sin cache TTL en `resolveClientPrincipal` — round-trip DB por request |
| GF-02-P2-04 | P2 | CONFIRMED_DEFECT | Validación JWT confía 100% en `supabaseAdmin.auth.getUser()` sin test de contrato |
| GF-02-P2-05 | P2 | CONFIRMED_DEFECT | Logger redaction cubre headers pero `recovery.ts` guarda token plano en envelope |
| GF-02-P3-01 | P3 | CONFIRMED_DEFECT | `principalRef` semántico: mismo accountId como STAFF y CLIENT podría colisionar — diferenciar `"STAFF:${accountId}"` / `"CLIENT:${accountId}"` |
| GF-02-P3-02 | P3 | CONFIRMED_DEFECT | `KEYRING` solo tiene `v1` — documentar procedimiento rotación claves |

**Veredicto GF-02:** PASS (P0=0 accesos indebidos)

---

### GF-03: PERSISTENCE & INTEGRITY (6 hallazgos no bloqueantes)

| ID | Severidad | Estado | Resumen |
|---|---|---|---|
| GF-03-F1 | P2 | CONFIRMED_DEFECT | Falta `packages/database/src/booking.ts` (Drizzle schema para tablas booking) |
| GF-03-F2 | P2 | CONFIRMED_DEFECT | `catalog.service_terms_versions` unique `(business_id, service_id, version_number)` en Drizzle pero no en migración SQL |
| GF-03-F3 | P2 | CONFIRMED_DEFECT | `staff_effective_unavailability` unique compuesto en SQL (U03) ausente en Drizzle |
| GF-03-F4 | P1 | CONFIRMED_DEFECT | `guest_delivery_envelopes.key_version` inconsistente: confirm usa `CURRENT_KEY_VERSION`, recovery usa `'recovery'` |
| GF-03-F5 | - | FALSE_POSITIVE | `reservation_events.principal_type` check coherente con `operation_attempts.principal_kind` |
| GF-03-F6 | P2 | CONFIRMED_DEFECT | `operation_attempts.business_id` nullable en Drizzle (`schema.ts:26`) pero NOT NULL en práctica |

**Veredicto GF-03:** PASS (PostgreSQL no llega a estado inválido)

---

### GF-04: AVAILABILITY & TIME (4 hallazgos menores)

| ID | Severidad | Estado | Resumen |
|---|---|---|---|
| GF-04-MN-01 | P1 | CONFIRMED_DEFECT | Doble `if` idéntico validando cadencia en `queries.ts:104-105` |
| GF-04-MN-02 | P2 | CONFIRMED_DEFECT | `searchAvailability` llama `resolveSlot` en bucle (potencial N+1) |
| GF-04-MN-03 | P2 | CONFIRMED_DEFECT | Bucle DST 13 iteraciones en `temporal.ts:124-129` — documentar ventana 36h |
| GF-04-MN-04 | P2 | CONFIRMED_DEFECT | Falta test explícito frontera cutoff `T-120:00` vs `T-120:01` |

**Veredicto GF-04:** PASS (Quote y Confirm usan misma `resolveSlot` con mismos parámetros)

---

### GF-05: CONCURRENCY & IDEMPOTENCY (3 hallazgos no bloqueantes)

| ID | Severidad | Estado | Resumen |
|---|---|---|---|
| GF5-01 | P2 | CONFIRMED_DEFECT | No hay retry automático ante deadlock `40P01` — PG aborta, cliente debe reintentar |
| GF5-02 | P1 | CONFIRMED_DEFECT | Recovery envelope usa `key_version: 'recovery'` pero `KEYRING` solo tiene `'v1'` — reconcile fallaría (mitigado: recovery es asistido) |
| GF5-03 | P3 | CONFIRMED_DEFECT | `executePrincipalOperation` trata `STARTED` y `FAILED` igual (`CONFLICT`) — correcto pero indiferencia semántica |

**Veredicto GF-05:** PASS

---

### GF-06: UX FUNCTIONAL REAL (15 hallazgos accesibilidad)

| ID | Severidad | Estado | Resumen |
|---|---|---|---|
| GF-06-A11 | P0 | CONFIRMED_DEFECT | **No hay `prefers-reduced-motion`** — transiciones CSS se ejecutan siempre (WCAG 2.3.3) |
| GF-06-A12 | P0 | CONFIRMED_DEFECT | **Slot buttons < 44×44px** — `padding:9px 8px` ≈ 34×34px (WCAG 2.5.5) |
| GF-06-A13 | P0 | CONFIRMED_DEFECT | **Slot buttons sin `aria-label` descriptivo** — solo "13:30" sin contexto fecha/servicio (WCAG 1.3.1) |
| GF-06-A14 | P0 | CONFIRMED_DEFECT | **Sin handler Escape** en date picker / slot grid (WCAG 2.1.2) |
| GF-06-A21 | P1 | CONFIRMED_DEFECT | Professional "ANY" sin explicación de balanceo automático |
| GF-06-A22 | P1 | CONFIRMED_DEFECT | Error messages no sugieren acción concreta |
| GF-06-A23 | P1 | CONFIRMED_DEFECT | Focus order en slot grid no obvio visualmente |
| GF-06-A31 | P2 | CONFIRMED_DEFECT | Quote expiration countdown ausente |
| GF-06-A32 | P2 | CONFIRMED_DEFECT | Touch target `slot-button` insuficiente |
| GF-06-A33 | P2 | CONFIRMED_DEFECT | Recovery codes grid: `code` elements sin `role="listitem"` ni `aria-label` |
| GF-06-C1 | P1 | CONFIRMED_DEFECT | **Guest token mostrado completo en success** — riesgo seguridad (sin copiar/ocultar) |
| GF-06-C2 | P1 | CONFIRMED_DEFECT | Quote TTL 5min hardcoded en UI vs configurable backend |
| GF-06-C3 | P1 | CONFIRMED_DEFECT | Cutoff minutes no visible en UI — usuario lo descubre al fallar |
| GF-06-C4 | P1 | CONFIRMED_DEFECT | Professional "ANY" no explica balanceo |
| GF-06-C5 | P1 | CONFIRMED_DEFECT | Phone validation: UI placeholder vs backend regex E.164 estricto |

**Veredicto GF-06:** R1_REQUIRED (Accesibilidad P0 bloquea ship)

---

### GF-07: ARCHITECTURE & CONTRACTS (6 hallazgos)

| ID | Severidad | Estado | Resumen |
|---|---|---|---|
| GF-07-001 | **P0** | CONFIRMED_DEFECT | `client-principal.ts` importa U02 estáticamente → **crash 500 load time** si U02 ausente (no 501 controlado) |
| GF-07-002 | **P1** | CONFIRMED_DEFECT | Falta `packages/database/src/booking.ts` (Drizzle schema) — no type-safe queries booking |
| GF-07-003 | P2 | CONFIRMED_DEFECT | `OperationPrincipal.principalRef?` vs `BookingPrincipal` sin `principalRef` — drift contrato |
| GF-07-004 | P2 | CONFIRMED_DEFECT | Rutas booking sin `schema` explícito → Swagger/OpenAPI incompleto |
| GF-07-005 | P3 | CONFIRMED_DEFECT | Rate limit in-memory no distribuido (deuda conocida) |
| GF-07-006 | P2 | CONFIRMED_DEFECT | Inconsistencias Drizzle/SQL (F2, F3 de GF-03) — alinear schemas |

**Veredicto GF-07:** R1_REQUIRED (P0 crash U02 + P1 Drizzle missing)

---

### GF-08: TEST CREDIBILITY (Matriz de riesgo - 10 áreas)

| Área | Severidad | Hallazgo Principal |
|---|---|---|
| Q1: Real vs Mocks | ✅ BAJA | Integración = PostgreSQL real + API real — **CREÍBLE** |
| Q2: Fixtures/Cleanup | ⚠️ MEDIA | Tests comparten business dentro de archivo; no TRUNCATE global |
| Q3: E2E Real | ✅ BAJA | Playwright = API real + Frontend real + BD real — **CREÍBLE** |
| Q4: Regresiones H01/H02 | ⚠️ **ALTA** | Suites H01/H02 **no ejecutadas** en lote G21 — riesgo regresión silenciosa |
| Q5: Supabase Assumptions | ⚠️ MEDIA | Hard dependency contenedor local; sin mock CI |
| Q6: Fault Injection | ⚠️ **ALTA** | Faltan: commit uncertainty (token identity), envelope crypto, network partition, deadlock |
| Q7: Multi-tenant | ✅ BAJA | Buena cobertura: FK cross-biz, RLS, idempotency cross-biz |
| Q8: Error Paths | ⚠️ MEDIA | ~15 DomainError codes no probados (guest flows, rate limit) |
| Q9: Weak Assertions | ⚠️ **ALTA** | 3 tests críticos: reconcile token identity, ledger sanitization, ANY determinismo integración |
| Q10: Metric Inflation | ⚠️ MEDIA | "277/277" inflado vs 141 real — mezcla suites no corridas + skipped |

**Veredicto GF-08:** CONDITIONAL PASS — Requiere P0 resueltos antes de producción

---

## Resumen Consolidado por Severidad

| Severidad | GF-01 | GF-02 | GF-03 | GF-04 | GF-05 | GF-06 | GF-07 | GF-08 | TOTAL |
|---|---|---|---|---|---|---|---|---|---|
| **P0** | 12 | 0 | 0 | 0 | 0 | 4 | 1 | 3 | **20** |
| **P1** | 13 | 3 | 0 | 0 | 1 | 2 | 1 | 3 | **23** |
| **P2** | 3 | 5 | 4 | 4 | 1 | 3 | 4 | 3 | **27** |
| **P3** | 0 | 2 | 0 | 0 | 1 | 0 | 0 | 1 | **3** |
| **Total** | 28 | 10 | 4 | 4 | 2 | 9 | 6 | 10 | **73** |

*Nota: GF-01 reporta 36 hallazgos pero 18 son FALSE_POSITIVE; GF-02 reporta 9; GF-03 reporta 6 (todos no bloqueantes); GF-04 reporta 4; GF-05 reporta 3; GF-06 reporta 15 (accesibilidad + contradicciones); GF-07 reporta 6; GF-08 reporta 10 áreas de riesgo.*

---

## Hallazgos P0 Críticos (Top 20 - Requieren Acción Inmediata)

1. **GF-01-001**: `termsOverride` faltante en confirm multi-servicio
2. **GF-01-004**: Asimetría validación businessId guest/client
3. **GF-01-005**: Client confirm crash sin U02
4. **GF-01-018**: Staff override no pasa `requirePublic=false`
5. **GF-01-030**: Recovery envelope sin AEAD cifrado
6. **GF-01-033**: Rate limit in-memory no distribuido
7. **GF-01-034**: Dev key fallback inseguro en producción
8. **GF-06-A11**: Sin `prefers-reduced-motion` (WCAG 2.3.3)
9. **GF-06-A12**: Slot buttons < 44×44px (WCAG 2.5.5)
10. **GF-06-A13**: Slot buttons sin `aria-label` descriptivo (WCAG 1.3.1)
11. **GF-06-A14**: Sin handler Escape en date picker/slot grid (WCAG 2.1.2)
12. **GF-06-C1**: Guest token mostrado completo en success (riesgo seguridad)
13. **GF-07-001**: **CRASH 500 load time** si U02 ausente (import estático)
14. **GF-08-Q4**: Regresiones H01/H02 no ejecutadas
15. **GF-08-Q6**: Fault injection faltante: commit uncertainty (token identity)
16. **GF-08-Q9**: 3 assertions débiles: reconcile token, ledger sanitization, ANY determinismo
17. **GF-02-P1-01**: Dev key fallback en producción
18. **GF-02-P1-02**: Recovery token en claro en envelope
19. **GF-02-P1-03**: CORS single-origin
20. **GF-07-002**: Falta Drizzle booking.ts schema

---

**Próximo:** Reconciliación Elephant (Artifact 06) → Defectos Confirmados (Artifact 07) → Evidencia Reproducción (Artifact 08)