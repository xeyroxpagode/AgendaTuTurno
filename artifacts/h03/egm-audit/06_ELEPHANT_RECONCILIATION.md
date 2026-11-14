# 06 — ELEPHANT RECONCILIATION (EGM AUDIT)

**Fecha:** 2026-11-09
**Actor:** C — OpenCode V2 + Google Elephant-Goldfish Model

## Proceso de Reconciliación

### 1. Deduplicación de Hallazgos

| Hallazgo Duplicado | Goldfish Origen | Acción |
|---|---|---|
| Dev key fallback inseguro | GF-01-034, GF-02-P1-01 | **FUSIONADO** → ELEPHANT-001 |
| Rate limit in-memory no distribuido | GF-01-033, GF-02-P2-02, GF-07-005 | **FUSIONADO** → ELEPHANT-002 |
| Recovery token en claro / sin AEAD | GF-01-030, GF-02-P1-02, GF-05-02, GF-03-F4 | **FUSIONADO** → ELEPHANT-003 |
| CORS single-origin | GF-02-P1-03, GF-07-005 (parcial) | **FUSIONADO** → ELEPHANT-004 |
| Client confirm/associate crash sin U02 | GF-01-005, GF-01-020, GF-07-001 | **FUSIONADO** → ELEPHANT-005 |
| Drizzle booking.ts faltante + drift SQL | GF-03-F1, GF-07-002, GF-03-F2, GF-03-F3, GF-07-006 | **FUSIONADO** → ELEPHANT-006 |
| Accesibilidad P0 (reduced-motion, touch targets, aria-label, Escape) | GF-06-A11/A12/A13/A14 | **GRUPO** → ELEPHANT-007 |
| Regresiones H01/H02 no ejecutadas | GF-08-Q4 | **ÚNICO** → ELEPHANT-008 |
| Fault injection commit uncertainty / token identity | GF-08-Q6, GF-08-Q9 | **FUSIONADO** → ELEPHANT-009 |
| Weak assertions (reconcile token, ledger, ANY determinismo) | GF-08-Q9 | **ÚNICO** → ELEPHANT-010 |
| TermsOverride faltante en confirm | GF-01-001 | **ÚNICO** → ELEPHANT-011 |
| Staff override requirePublic=false faltante | GF-01-018 | **ÚNICO** → ELEPHANT-012 |
| STAFF_EXCEPTION_APPLIED event no emitido | GF-01-026 | **ÚNICO** → ELEPHANT-013 |
| BOOKING_OPERATION_CONFLICT código huérfano | GF-01-021 | **ÚNICO** → ELEPHANT-014 |
| Validación duplicada cadencia queries.ts | GF-01-003, GF-01-029, GF-04-MN-01 | **FUSIONADO** → ELEPHANT-015 |
| Intent proof digest inconsistency recovery | GF-01-031 | **ÚNICO** → ELEPHANT-016 |
| Asimetría businessId guest vs client | GF-01-004 | **ÚNICO** → ELEPHANT-017 |
| ProfessionalPreference ANY forzado a SPECIFIC en reschedule | GF-01-002 | **ÚNICO** → ELEPHANT-018 |
| Guest token mostrado completo en UI success | GF-06-C1 | **ÚNICO** → ELEPHANT-019 |
| Drizzle/SQL inconsistencies (service_terms, staff_effective_unavailability) | GF-03-F2/F3, GF-07-006 | **FUSIONADO** → ELEPHANT-020 |
| PrincipalRef semántico drift | GF-02-P3-01, GF-07-003 | **FUSIONADO** → ELEPHANT-021 |
| OpenAPI/Swagger incompleto | GF-07-004 | **ÚNICO** → ELEPHANT-022 |
| TTL envelope hardcoded | GF-02-P2-01 | **ÚNICO** → ELEPHANT-023 |
| Cache TTL resolveClientPrincipal | GF-02-P2-03 | **ÚNICO** → ELEPHANT-024 |
| JWT contract test | GF-02-P2-04 | **ÚNICO** → ELEPHANT-025 |
| Supabase local dependency sin mock CI | GF-08-Q5 | **ÚNICO** → ELEPHANT-026 |
| Fixtures cleanup / TRUNCATE global | GF-08-Q2 | **ÚNICO** → ELEPHANT-027 |
| DomainError codes huérfanos (~15) | GF-08-Q8 | **ÚNICO** → ELEPHANT-028 |
| Métrica histórica inflada 277/277 | GF-08-Q10 | **ÚNICO** → ELEPHANT-029 |
| Deadlock retry automático | GF5-01 | **ÚNICO** → ELEPHANT-030 |
| Key rotation procedure documentation | GF-02-P3-02 | **ÚNICO** → ELEPHANT-031 |
| DST 36h window documentation | GF-04-MN-03 | **ÚNICO** → ELEPHANT-032 |
| Cutoff frontier test missing | GF-04-MN-04 | **ÚNICO** → ELEPHANT-033 |
| SearchAvailability N+1 | GF-04-MN-02 | **ÚNICO** → ELEPHANT-034 |
| PrincipalRef semántico STAFF/CLIENT colisión | GF-02-P3-01, GF-07-003 | **FUSIONADO** → ELEPHANT-021 |
| SearchAvailability N+1 | GF-04-MN-02 | **ÚNICO** → ELEPHANT-034 |

**Total hallazgos reconciliados:** 34 defectos únicos (de 89 originales)

---

### 2. Investigación de Desacuerdos

| Tema | Goldfish A | Goldfish B | Resolución Elephant |
|---|---|---|---|
| `replaceAllocation` atomicidad | GF-01-017 (FALSE_POSITIVE - rollback PG) | GF-05 (PASS - atómico en Tx) | **CONSISTENTE** - Ambos confirman atomicidad por rollback PG nativo |
| `termsOverride` en confirm | GF-01-001 (P0 CONFIRMED_DEFECT) | GF-04 (no detectado) | **VALIDADO GF-01** - GF-04 no auditó confirm path específicamente |
| Client crash sin U02 | GF-01-005 (STRONG_HYPOTHESIS), GF-07-001 (P0 CONFIRMED) | GF-02 (no detectado) | **VALIDADO GF-07** - Crash load time confirmado por import estático |
| Recovery envelope cifrado | GF-01-030 (P1), GF-02-P1-02 (P1), GF-05-02 (P1), GF-03-F4 (P1) | GF-08 (no detectado directamente) | **CONFIRMADO MÚLTIPLE** - 4 Goldfish independientes detectan mismo defecto |
| Rate limit in-memory | GF-01-033 (P1), GF-02-P2-02 (P2), GF-07-005 (P3) | GF-08 (no detectado) | **CONFIRMADO MÚLTIPLE** - 3 Goldfish |
| Drizzle booking.ts faltante | GF-03-F1 (P2), GF-07-002 (P1) | GF-08 (no detectado) | **CONFIRMADO MÚLTIPLE** - 2 Goldfish |
| Accesibilidad P0 | GF-06 (4 P0) | Otros (no auditaron UI) | **ÚNICO DETECTOR** - GF-06 especialista en UX/accesibilidad |

---

### 3. Verificación de Fuentes

Para cada hallazgo crítico (P0/P1), se verificó contra:
- ✅ Contratos TypeScript (`packages/contracts/src/*.ts`)
- ✅ Migraciones SQL (`supabase/migrations/*.sql`)
- ✅ Código de implementación (`apps/api/src/modules/**/*.ts`)
- ✅ Tests existentes (`tests/h03/**/*.spec.ts`)
- ✅ Evidencia runtime (ejecución `pnpm exec vitest run tests/h03` = 141/141 PASS)

---

### 4. Clasificación de Severidades (Post-Reconciliación)

| Severidad | Definición EGM | Cantidad | Ejemplos |
|---|---|---|---|
| **P0** | Pérdida de datos, acceso indebido crítico, doble reserva, corrupción transaccional, crash load time, bloqueador accesibilidad WCAG | **8** | ELEPHANT-001 (dev key prod), 005 (crash U02), 007 (a11y P0x4), 008 (regresiones H01/H02), 011 (termsOverride), 012 (staff override), 019 (guest token UI) |
| **P1** | Comportamiento central roto, autorización defectuosa, incumplimiento grave contrato, security config, fault injection crítico | **12** | ELEPHANT-002 (rate limit), 003 (recovery AEAD), 004 (CORS), 006 (Drizzle missing), 009 (commit uncertainty), 010 (weak assertions), 013 (event missing), 015 (duplicate cadence), 016 (intent proof), 018 (ANY forzado), 020 (Drizzle drift), 028 (DomainError codes) |
| **P2** | Errores funcionales menores, UX problemática, pruebas insuficientes relevantes, deuda técnica | **10** | ELEPHANT-014 (código huérfano), 017 (asimetría businessId), 019 (guest token UI), 021 (principalRef), 022 (OpenAPI), 023 (TTL), 024 (cache), 025 (JWT test), 026 (Supabase mock), 027 (cleanup) |
| **P3** | Deuda menor, mejoras no bloqueantes, documentación | **3** | ELEPHANT-029 (métrica inflada), 030 (deadlock retry), 031 (key rotation doc) |

---

### 5. Causas Raíz Identificadas

| Causa Raíz | Hallazgos Afectados | Descripción |
|---|---|---|
| **Dependencia dura a U02 sin feature flag** | ELEPHANT-005, 007 (parcial) | `client-principal.ts` importa U02 estáticamente → crash load time |
| **Configuración de secretos con fallback inseguro** | ELEPHANT-001, 003 | Dev keys en código; producción falla silenciosamente a valores conocidos |
| **Rate limit in-memory no escalable** | ELEPHANT-002 | `Map` local al proceso; no funciona en multi-instancia |
| **Falta de cifrado AEAD en recovery path** | ELEPHANT-003 | `recovery.ts` usa `Buffer.from(token)` vs `encryptEnvelope` en confirm |
| **CORS single-origin hardcoded** | ELEPHANT-004 | `runtime.webOrigin` string único vs array allowlist |
| **Tests H01/H02 no integrados en CI del lote** | ELEPHANT-008 | G21 explícitamente no los ejecutó; riesgo regresión |
| **Falta fault injection crítico** | ELEPHANT-009, 010 | Commit uncertainty, envelope crypto, deadlock, network partition |
| **Assertions débiles en tests críticos** | ELEPHANT-010 | Reconcile token identity, ledger sanitization, ANY determinismo |
| **Drizzle schema incompleto para booking** | ELEPHANT-006, 020 | Falta `booking.ts`; drift constraints SQL vs Drizzle |
| **Accesibilidad WCAG 2.1 AA no cumplida** | ELEPHANT-007 | reduced-motion, touch targets 44px, aria-label, Escape handler |
| **TermsOverride no propagado a resolveSlot** | ELEPHANT-011 | Confirm multi-servicio usa términos actuales vs históricos del quote |
| **Staff override no puede reprogramar servicio despublicado** | ELEPHANT-012 | `requirePublic` no condicionado a `allowStaffOverride` |
| **Event type STAFF_EXCEPTION_APPLIED no usado** | ELEPHANT-013 | Definido en contrato pero cancel/reschedule usan genéricos |

---

### 6. Evaluación de Impacto Transversal

| Área | Impacto | Hallazgos |
|---|---|---|
| **Seguridad (Confidencialidad/Integridad)** | **ALTO** | Dev keys en prod, recovery token claro, guest token UI expuesto, CORS, rate limit bypass |
| **Disponibilidad** | **MEDIO** | Crash U02 load time, deadlock sin retry, Supabase local hard dependency |
| **Integridad Transaccional** | **BAJO** | TermsOverride faltante (riesgo precio/duración incorrecto multi-servicio) |
| **Cumplimiento Normativo (WCAG)** | **ALTO** | 4 P0 accesibilidad bloquean ship |
| **Mantenibilidad/Deuda Técnica** | **MEDIO** | Drizzle missing, OpenAPI incompleto, código huérfano, métricas infladas |
| **Experiencia Usuario** | **MEDIO** | Guest token visible, cutoff invisible, ANY sin explicación, phone validation mismatch |
| **Testing/Credibilidad** | **ALTO** | Regresiones H01/H02 no corridas, weak assertions, fault injection gaps |

---

### 7. Orden de Correctivos (Priorizado)

| Orden | Hallazgo | Severidad | Esfuerzo | Dependencias |
|---|---|---|---|---|
| 1 | **ELEPHANT-005** Crash U02 import estático | P0 | Bajo (feature flag + dynamic import) | Ninguna |
| 2 | **ELEPHANT-001** Dev keys en producción | P0 | Bajo (fail-fast si env vars ausentes) | Ninguna |
| 3 | **ELEPHANT-003** Recovery envelope sin AEAD | P0 | Bajo (usar `encryptEnvelope` existente) | Ninguna |
| 4 | **ELEPHANT-007** Accesibilidad P0 (4 items) | P0 | Medio (CSS + ARIA attributes) | Ninguna |
| 5 | **ELEPHANT-011** TermsOverride faltante confirm | P0 | Bajo (1 línea en confirm.ts) | Ninguna |
| 6 | **ELEPHANT-012** Staff override requirePublic | P1 | Bajo (1 línea en reschedule.ts) | Ninguna |
| 7 | **ELEPHANT-006** Drizzle booking.ts faltante | P1 | Medio (crear schema completo) | ELEPHANT-020 |
| 8 | **ELEPHANT-008** Regresiones H01/H02 | P1 | Medio (CI pipeline) | Ninguna |
| 9 | **ELEPHANT-009** Fault injection commit uncertainty | P1 | Medio (nuevos tests) | ELEPHANT-010 |
| 10 | **ELEPHANT-010** Weak assertions (3 tests) | P1 | Bajo (fortalecer assertions existentes) | Ninguna |
| 11 | **ELEPHANT-002** Rate limit in-memory | P1 | Alto (Redis-backed) | Infraestructura |
| 12 | **ELEPHANT-004** CORS allowlist | P1 | Bajo (array desde env) | Ninguna |
| 13 | **ELEPHANT-013** STAFF_EXCEPTION_APPLIED event | P1 | Bajo (emitir evento en staff-exceptions) | Ninguna |
| 14 | **ELEPHANT-028** DomainError codes huérfanos | P1 | Medio (tests + implementación) | Ninguna |
| 15 | **ELEPHANT-019** Guest token UI expuesto | P2 | Bajo (botón copiar/ocultar + warning) | Ninguna |
| 16-34 | Restantes P2/P3 | P2/P3 | Variable | Según dependencias |

---

### 8. Matriz Final de Reconciliación

| ELEPHANT-ID | Hallazgos Fusionados | Severidad Final | Estado | Acción Requerida |
|---|---|---|---|---|
| ELEPHANT-001 | GF-01-034, GF-02-P1-01 | **P0** | CONFIRMED_DEFECT | Fail-fast si `BOOKING_GUEST_KEY_V1`/`BOOKING_QUOTE_SECRET` ausentes en producción |
| ELEPHANT-002 | GF-01-033, GF-02-P2-02, GF-07-005 | **P1** | CONFIRMED_DEFECT | Migrar rate limit a Redis-backed (`@fastify/rate-limit` + Redis store) |
| ELEPHANT-003 | GF-01-030, GF-02-P1-02, GF-05-02, GF-03-F4 | **P1** | CONFIRMED_DEFECT | Usar `encryptEnvelope(token, CURRENT_KEY_VERSION)` en `recovery.ts:62-65` |
| ELEPHANT-004 | GF-02-P1-03 | **P1** | CONFIRMED_DEFECT | CORS allowlist array desde `CORS_ALLOWLIST` env var |
| ELEPHANT-005 | GF-01-005, GF-01-020, GF-07-001 | **P0** | CONFIRMED_DEFECT | Dynamic import + feature flag `ENABLE_CLIENT_BOOKING`; 501 si U02 ausente |
| ELEPHANT-006 | GF-03-F1, GF-07-002 | **P1** | CONFIRMED_DEFECT | Crear `packages/database/src/booking.ts` con constraints SQL replicados |
| ELEPHANT-007 | GF-06-A11, A12, A13, A14 | **P0** | CONFIRMED_DEFECT | CSS `@media (prefers-reduced-motion)`, slot buttons 44x44px, `aria-label`, Escape handler |
| ELEPHANT-008 | GF-08-Q4 | **P0** | CONFIRMED_DEFECT | Ejecutar `vitest run tests/h01 tests/h02` en CI antes de merge |
| ELEPHANT-009 | GF-08-Q6, GF-08-Q9 (commit uncertainty) | **P1** | CONFIRMED_DEFECT | Test: reconcile devuelve **mismo** guestToken; inyectar fallo envelope crypto |
| ELEPHANT-010 | GF-08-Q9 (3 weak assertions) | **P1** | CONFIRMED_DEFECT | Fortalecer: reconcile token identity, ledger sanitization, ANY determinismo integración |
| ELEPHANT-011 | GF-01-001 | **P0** | CONFIRMED_DEFECT | Pasar `termsOverride` construido desde `quote.items` a `resolveSlot` en confirm.ts:132-140 |
| ELEPHANT-012 | GF-01-018 | **P1** | CONFIRMED_DEFECT | En `reschedule.ts:79`, pasar `requirePublic: !input.allowStaffOverride` |
| ELEPHANT-013 | GF-01-026 | **P1** | CONFIRMED_DEFECT | Emitir `STAFF_EXCEPTION_APPLIED` event en `staff-exceptions.ts` |
| ELEPHANT-014 | GF-01-021 | **P2** | CONFIRMED_DEFECT | Eliminar `BOOKING_OPERATION_CONFLICT` de `bookingErrorCodes` o usarlo en operations.ts |
| ELEPHANT-015 | GF-01-003, GF-01-029, GF-04-MN-01 | **P1** | CONFIRMED_DEFECT | Eliminar línea 105 duplicada en `queries.ts` |
| ELEPHANT-016 | GF-01-031 | **P2** | CONFIRMED_DEFECT | Usar digest real o hash del token en recovery; documentar "recovery" como valor especial |
| ELEPHANT-017 | GF-01-004 | **P2** | CONFIRMED_DEFECT | Unificar validación businessId: en client validar `quote.businessId === input.businessId` |
| ELEPHANT-018 | GF-01-002 | **P1** | SPEC_AMBIGUITY | Documentar en contratos: reprogramación pública preserva profesional original; o permitir cambio si ANY |
| ELEPHANT-019 | GF-06-C1 | **P2** | CONFIRMED_DEFECT | Botón "Copiar" + "Ocultar/Mostrar" + warning "No compartas este token" en success UI |
| ELEPHANT-020 | GF-03-F2, GF-03-F3, GF-07-006 | **P2** | CONFIRMED_DEFECT | Sincronizar Drizzle `availability.ts` y `client-auth.ts` con migraciones SQL |
| ELEPHANT-021 | GF-02-P3-01, GF-07-003 | **P3** | CONFIRMED_DEFECT | Alinear `principalRef`: añadir a `BookingPrincipal` o remover de `OperationPrincipal` |
| ELEPHANT-022 | GF-07-004 | **P2** | CONFIRMED_DEFECT | Añadir `schema` objects explícitos a cada ruta en `registerBookingRoutes` |
| ELEPHANT-023 | GF-02-P2-01 | **P2** | CONFIRMED_DEFECT | TTL envelope configurable via `BOOKING_ENVELOPE_TTL_HOURS` env |
| ELEPHANT-024 | GF-02-P2-03 | **P2** | CONFIRMED_DEFECT | Cache TTL 30s en `resolveClientPrincipal` con invalidación por `sessions_valid_after` |
| ELEPHANT-025 | GF-02-P2-04 | **P2** | CONFIRMED_DEFECT | Test contrato JWT: rechazo token con `aud`/`iss` incorrecto |
| ELEPHANT-026 | GF-08-Q5 | **P2** | CONFIRMED_DEFECT | Documentar requisito Supabase local; evaluar testcontainers para CI |
| ELEPHANT-027 | GF-08-Q2 | **P2** | CONFIRMED_DEFECT | `afterEach` con `TRUNCATE ... CASCADE` o transacciones por test |
| ELEPHANT-028 | GF-08-Q8 | **P1** | CONFIRMED_DEFECT | Tests para ~15 DomainError codes huérfanos (guest flows, rate limit) |
| ELEPHANT-029 | GF-08-Q10 | **P3** | CONFIRMED_DEFECT | Separar métricas: "h03 unit+integration: 141" vs "total monorepo histórico" |
| ELEPHANT-030 | GF5-01 | **P3** | CONFIRMED_DEFECT | Documentar: cliente debe reintentar en deadlock 40P01; evaluar retry automático |
| ELEPHANT-031 | GF-02-P3-02 | **P3** | CONFIRMED_DEFECT | Documentar procedimiento rotación claves envelope |
| ELEPHANT-032 | GF-04-MN-03 | **P3** | CONFIRMED_DEFECT | Documentar ventana DST 36h en `temporal.ts` |
| ELEPHANT-033 | GF-04-MN-04 | **P2** | CONFIRMED_DEFECT | Test explícito frontera cutoff `T-120:00` vs `T-120:01` |
| ELEPHANT-034 | GF-04-MN-02 | **P2** | CONFIRMED_DEFECT | Evaluar cache/batch en `searchAvailability` para evitar N+1 `resolveSlot` |

---

### 9. Decisiones de Autorización Requeridas

| Hallazgo | Requiere Aprobación Humana | Justificación |
|---|---|---|
| ELEPHANT-002 (Rate limit Redis) | **SÍ** | Nueva dependencia infraestructura (Redis) |
| ELEPHANT-006 (Drizzle booking.ts) | **NO** | Corrección interna type-safety |
| ELEPHANT-008 (H01/H02 CI) | **NO** | Mejora proceso CI |
| ELEPHANT-018 (ANY en reschedule) | **SÍ** | Cambio semántico UX: ¿permitir cambiar profesional en reprogramación pública? |
| ELEPHANT-026 (Supabase mock CI) | **SÍ** | Cambio estrategia testing; evaluar testcontainers |

---

### 10. Veredicto de Reconciliación

**Total defectos únicos reconciliados: 34**
- **P0: 8** | **P1: 12** | **P2: 10** | **P3: 4**

**Bloqueadores para Ship (P0): 8**
1. ELEPHANT-001: Dev keys en producción
2. ELEPHANT-003: Recovery envelope sin AEAD
3. ELEPHANT-005: Crash U02 import estático
4. ELEPHANT-007: Accesibilidad WCAG 2.1 AA (4 P0)
5. ELEPHANT-008: Regresiones H01/H02 no ejecutadas
6. ELEPHANT-011: TermsOverride faltante confirm multi-servicio
6. ELEPHANT-019: Guest token expuesto en UI success

**Estado General:** **R1_REQUIRED** — Correctivos P0 obligatorios antes de aceptar para Actor B.

---

**Reconciliado por:** Elephant (Orquestador EGM)  
**Fecha:** 2026-11-09  
**Próximo:** Defectos Confirmados (Artifact 07) → Evidencia Reproducción (Artifact 08) → Plan Correctivo (Artifact 09)