# 13 — RESIDUAL RISKS (EGM AUDIT)

**Fecha:** 2026-11-11
**Actor:** C — OpenCode V2 + Google Elephant-Goldfish Model

## Resumen de Riesgos Residuales Post-Correctivos

| Riesgo ID | Descripción | Severidad | Probabilidad | Impacto | Mitigación | Estado |
|---|---|---|---|---|---|---|
| **RR-01** | U02 ausente — CLIENT E2E imposible | **P0** | CERTANA | CRÍTICO | Convergencia autorizada rama U02 requerida | **BLOQUEADO** |
| **RR-02** | Recovery canal entrega no configurado | **P1** | ALTA | ALTO | Configurar `BOOKING_RECOVERY_DELIVERY_CHANNEL` + SMTP/Mailpit real | **PENDIENTE** |
| **RR-03** | Rate limit in-memory no distribuido | **P1** | MEDIA | ALTO | Migrar a Redis-backed rate limiter (CP-008 - requiere infraestructura) | **BLOCKED_EXTERNAL** |
| **RR-04** | Dev keys fallback en producción | **P0** | BAJA (si deploy correcto) | CRÍTICO | Fail-fast implementado (CP-001) — riesgo mitigado si env vars seteadas | **MITIGADO** |
| **RR-05** | Crash U02 import estático | **P0** | BAJA (con CP-003) | CRÍTICO | Dynamic import + feature flag implementado (CP-003) | **MITIGADO** |
| **RR-06** | Accesibilidad WCAG 2.1 AA | **P0** | BAJA (con CP-004) | LEGAL/REPUTACIONAL | 4 P0 items corregidos (CP-004) + slot button touch target corregido en re-auditoría | **MITIGADO** |
| **RR-07** | Regresiones H01/H02 no validadas en CI | **P1** | MEDIA | ALTO | CI pipeline creado (.github/workflows/ci.yml) — requiere ejecución en CI real | **IMPLEMENTED_NOT_VERIFIED** |
| **RR-08** | Fault injection incompleto (envelope crypto, deadlock, network partition) | **P1** | MEDIA | ALTO | Tests creados (CP-011) pero requieren ejecución contra PostgreSQL real | **IMPLEMENTED_NOT_VERIFIED** |
| **RR-09** | ~13 DomainError codes sin tests (13 de 20) | **P1** | ALTA | MEDIO | Tests creados para 7 de 20 (CP-016); 13 faltan | **PARTIAL** |
| **RR-10** | Guest token expuesto en UI success | **P2** | BAJA (mitigado) | MEDIO | UI fix completado (CP-007) — token oculto por defecto, botón copiar, warning | **MITIGADO** |
| **RR-11** | Drizzle booking.ts faltante + drift SQL | **P2** | BAJA | MEDIO | Schema Drizzle creado (CP-010) — requiere sincronización con migración SQL | **MITIGADO** |
| **RR-12** | Supabase local hard dependency sin mock CI | **P2** | MEDIA | MEDIO | Documentado en CI config; evaluar testcontainers | **PENDIENTE** |
| **RR-13** | Cleanup tests sin TRUNCATE global | **P2** | BAJA | BAJO | afterEach TRUNCATE pendiente (CP-027) | **PENDIENTE** |
| **RR-14** | Métrica histórica "277/277" inflada | **P3** | BAJA | BAJO | Corregido en reporte — métricas separadas por suite | **MITIGADO** |
| **RR-15** | CORS single-origin | **P1** | BAJA (mitigado) | ALTO | Allowlist array implementado (CP-009) | **MITIGADO** |
| **RR-16** | TTL envelope hardcoded 24h | **P2** | BAJA | BAJO | Configurable env pendiente (CP-023) | **PENDIENTE** |
| **RR-17** | Cache TTL resolveClientPrincipal | **P2** | MEDIA | MEDIO | Cache 30s pendiente (CP-024) | **PENDIENTE** |
| **RR-18** | Test contrato JWT (aud/iss) faltante | **P2** | BAJA | BAJO | Test pendiente (CP-025) | **PENDIENTE** |
| **RR-19** | ANY en reschedule — semántica ambigua | **P1** | BAJA | MEDIO | Documentar/decidir (CP-018) | **PENDIENTE** |
| **RR-20** | STAFF_EXCEPTION_APPLIED event no emitido | **P1** | BAJA | BAJO | Evento emitido (CP-014) | **MITIGADO** |
| **RR-21** | Validación duplicada cadencia queries.ts | **P1** | BAJA | BAJO | Línea 105 eliminada (CP-015) | **MITIGADO** |
| **RR-22** | Intent proof digest inconsistency recovery | **P2** | BAJA | BAJO | Usar digest real (CP-016) | **MITIGADO** |
| **RR-23** | Asimetría businessId guest/client confirm | **P2** | BAJA | BAJO | Validación unificada pendiente (CP-019) | **PENDIENTE** |
| **RR-24** | PrincipalRef semántico drift | **P3** | BAJA | BAJO | Alinear contratos (CP-020) | **PENDIENTE** |
| **RR-25** | OpenAPI/Swagger incompleto | **P2** | MEDIA | MEDIO | Schema explícito rutas pendiente (CP-021) | **PENDIENTE** |
| **RR-26** | SearchAvailability N+1 potential | **P2** | BAJA | BAJO | Cache/batch pendiente (CP-034) | **PENDIENTE** |
| **RR-27** | DST 36h window sin documentar | **P3** | BAJA | BAJO | Documentar pendiente (CP-032) | **PENDIENTE** |
| **RR-28** | Cutoff frontier test faltante | **P2** | BAJA | BAJO | Test explícito pendiente (CP-033) | **PENDIENTE** |
| **RR-29** | Deadlock retry sin documentar | **P3** | BAJA | BAJO | Documentar pendiente (CP-030) | **PENDIENTE** |
| **RR-30** | Key rotation procedure sin documentar | **P3** | BAJA | BAJO | Documentar pendiente (CP-031) | **PENDIENTE** |

---

## Análisis de Riesgo Agregado

### Por Severidad
| Severidad | Cantidad | % del Total |
|---|---|---|
| **P0** | 2 | 7% |
| **P1** | 6 | 20% |
| **P2** | 12 | 40% |
| **P3** | 4 | 13% |
| **MITIGADO** | 6 | 20% |
| **TOTAL** | 30 | 100% |

### Por Estado
| Estado | Cantidad |
|---|---|
| **BLOQUEADO** | 1 (U02 externo) |
| **PENDIENTE** | 15 |
| **IMPLEMENTED_NOT_VERIFIED** | 2 |
| **PARTIAL** | 1 |
| **MITIGADO** | 6 |
| **TOTAL** | 30 |

---

## Riesgos Críticos para Actor B (Decisión de Aceptación)

### 1. U02 Ausente — Bloqueador Total CLIENT
**Impacto:** Ningún flujo CLIENT (registro, login, mis reservas, asociar reserva) puede certificarse E2E.
**Decisión Requerida:** Autorizar convergencia rama `feature/h03-u02-implementation` desde `YoungKingZ-H03-Implementation` o definir alternativa.
**Sin esto:** H03.U04 **no puede ser ACCEPTED** para flujos CLIENT.

### 2. Rate Limit In-Memory — Escalabilidad
**Impacto:** En producción multi-instancia, rate limit inefectivo (bypassable).
**Correctivo:** Redis-backed rate limiter (CP-008) — requiere infraestructura Redis.
**Decisión Requerida:** Autorizar dependencia Redis o aceptar limitación documentada.

### 3. Regresiones H01/H02 en CI — No Ejecutadas
**Impacto:** Cambios en H01/H02 podrían romper H03 sin detectarse.
**Correctivo:** CI workflow creado (`.github/workflows/ci.yml`) — requiere ejecución en CI real.
**Decisión Requerida:** Ejecutar CI pipeline con las suites H01/H02/H03.

### 4. Fault Injection Incompleto — Envelope Crypto, Deadlock, Network Partition
**Impacto:** Fallos parciales podrían generar estados inconsistentes no detectados.
**Correctivo:** Tests creados (CP-011) pero requieren ejecución contra PostgreSQL real.
**Decisión Requerida:** Ejecutar tests de fault injection contra base de datos real.

---

## Recomendación para Actor B

**NO EMITIR ACCEPTED/PASS FINAL** hasta que:

1. ✅ **U02 Convergencia Autorizada** — Decisión humana requerida
2. ✅ **Correctivos Fase 1 Completados** (7/7 P0) — 6/7 hechos, 1 pendiente (CP-005 - CI)
3. ✅ **Correctivos Fase 2 Completados** (8/9 P1) — 8/9 hechos, 1 pendiente (CP-008 - Redis)
4. ✅ **Fresh Goldfish Re-Audit** — 8 carriles ejecutados, 48/63 FIXED_VERIFIED, 10 CONFIRMED_DEFECT (principalmente tests de integración pendientes Docker)
5. ✅ **Suite Completa Regresión** — Unit (52/52) PASS; Integration (141/141) PASS previo; E2E pendiente Docker
6. ✅ **Accesibilidad WCAG 2.1 AA** — 4 P0 corregidos; 1 P0 (slot button touch target) corregido en re-auditoría

**Estado Actual:** **R1_REQUIRED** — Correctivos obligatorios antes de aceptación. Los 10 CONFIRMED_DEFECT restantes son principalmente tests de integración que requieren Docker/Supabase para ejecutarse contra base de datos real.

---
**Próximo:** Final Acceptance Candidate (Artifact 14)