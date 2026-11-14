# 07 — CONFIRMED DEFECTS (EGM AUDIT)

**Fecha:** 2026-11-09
**Actor:** C — OpenCode V2 + Google Elephant-Goldfish Model
**Fuente:** Reconciliación Elephant (Artifact 06) — 34 defectos únicos

## Lista Maestra de Defectos Confirmados

### P0 — BLOQUEANTES PARA SHIP (8 defectos)

| ID | Título | Archivo:Línea | Comportamiento Esperado | Comportamiento Observado | Impacto | Correctivo Mínimo |
|---|---|---|---|---|---|---|
| **ELEPHANT-001** | Dev keys en producción | `guest-access.ts:56`, `quote.ts:14` | Fallar si `BOOKING_GUEST_KEY_V1`/`BOOKING_QUOTE_SECRET` ausentes | Fallback a hash determinístico conocido → envelopes/quotes descifrables | **Seguridad Crítica** — Secretos expuestos en prod sin env vars | En module init: `if (!process.env.BOOKING_GUEST_KEY_V1) throw new Error("BOOKING_GUEST_KEY_V1 required in production")` |
| **ELEPHANT-003** | Recovery envelope sin AEAD | `recovery.ts:62-65` | Token cifrado con AES-256-GCM + key_version real | `Buffer.from(token, "utf8")` → token en claro, `key_version='recovery'` | **Seguridad/Funcional** — Token expuesto en BD; reconcile incompatible | Usar `encryptEnvelope(JSON.stringify({reservationId, guestToken: token, credentialId: cred.id}), CURRENT_KEY_VERSION)` |
| **ELEPHANT-005** | Crash U02 import estático | `client-principal.ts:19-20` | 501 `CLIENT_AUTH_INSUFFICIENT` si U02 ausente | Import falla load time → **crash 500** app no inicia | **Disponibilidad Crítica** — App inutilizable sin U02 deployado | Dynamic import + feature flag `ENABLE_CLIENT_BOOKING`; 501 en rutas `/v1/client/*` si U02 ausente |
| **ELEPHANT-007** | Accesibilidad WCAG 2.1 AA (4 P0) | `globals.css`, `page.tsx`, `ClientReservations.tsx` | Cumplir WCAG 2.1 AA | 1) Sin `prefers-reduced-motion` 2) Slot buttons 34x34px 3) Sin `aria-label` descriptivo 4) Sin Escape handler | **Legal/Compliance** — No shipable sin corrección | 1) CSS `@media (prefers-reduced-motion: reduce)` 2) `min-height:44px; min-width:44px` 3) `aria-label="13:30, Corte E2E, 30 min"` 4) Escape handler en overlays |
| **ELEPHANT-008** | Regresiones H01/H02 no ejecutadas | CI pipeline | Suites H01/H02 corriendo en CI | G21: "No se ejecutaron suites h01/h02/e2e en este lote" | **Riesgo Regresión Silenciosa** — Cambios H03 pueden romper H01/H02 | Añadir `vitest run tests/h01 tests/h02` a CI pipeline antes de merge |
| **ELEPHANT-011** | TermsOverride faltante en confirm multi-servicio | `confirm.ts:132-140` | `resolveSlot` recibe `termsOverride` con durations/buffers históricos del quote | `termsOverride` no pasado → `resolveSlot` usa términos actuales → `occupiedMinutes` incorrecto | **Integridad Transaccional** — Precio/duración/buffers pueden divergir del quote aceptado | En `confirm.ts:132-140`: `termsOverride: quote.items.map(q => ({ id: q.serviceId, durationMinutes: q.durationMinutes, preBufferMinutes: q.preBufferMinutes, postBufferMinutes: q.postBufferMinutes }))` |
| **ELEPHANT-019** | Guest token expuesto en UI success | `page.tsx:272` | Token ocultable/copiable con warning | Token completo visible en pantalla success | **Seguridad/Privacidad** — Riesgo screenshot sharing | Botón "Copiar" + toggle "Ocultar/Mostrar" + warning "No compartas este token" |

---

### P1 — ALTA PRIORIDAD (12 defectos)

| ID | Título | Archivo:Línea | Comportamiento Esperado | Comportamiento Observado | Impacto | Correctivo Mínimo |
|---|---|---|---|---|---|---|
| **ELEPHANT-002** | Rate limit in-memory no distribuido | `routes.ts:26-38` | Rate limit compartido entre instancias | `Map` local al proceso → bypass en multi-instancia | **Seguridad/Disponibilidad** — DoS posible en prod | Migrar a `@fastify/rate-limit` con Redis store |
| **ELEPHANT-004** | CORS single-origin | `app.ts:29`, `runtime.ts:29` | Allowlist array de orígenes permitidos | `origin: runtime.webOrigin` (string único) | **Seguridad** — Multi-dominio prod falla | `origin: (origin, cb) => { allowlist.includes(origin) ? cb(null, origin) : cb(new Error("CORS")) }` |
| **ELEPHANT-006** | Falta Drizzle booking.ts | `packages/database/src/` | Schema Drizzle para type-safe queries | Solo SQL migración + tipos TS en comandos | **Mantenibilidad/Type Safety** — Sin autocomplete, sin validación constraints en app | Crear `booking.ts` replicando constraints SQL (check, FK, unique partial, RLS triggers) |
| **ELEPHANT-009** | Fault injection: commit uncertainty / token identity | `booking-fault-injection.spec.ts` | Test verifica que reconcile devuelve **mismo** guestToken original | No existe test; assertions débiles en reconcile | **Integridad** — Token nuevo generado en reconcile no detectado | Test: `expect(reconcileBody.guestToken).toBe(originalGuestToken)` + inyectar fallo en `decryptEnvelope` |
| **ELEPHANT-010** | Weak assertions (3 tests críticos) | `booking-confirm.spec.ts:58`, `booking-principals.spec.ts:97`, `availability.spec.ts:60` | Assertions detectan bugs reales | 1) Reconcile token no comparado con original 2) Ledger sanitization no verifica ausencia token 3) ANY determinismo solo unit test | **Testing Credibility** — Bugs pasan tests | 1) Comparar token reconcile vs confirm 2) Verificar `!responseBody.includes("guestToken")` 3) Test integración 100 iteraciones `resolveSlot` mismo input |
| **ELEPHANT-012** | Staff override no pasa `requirePublic=false` | `reschedule.ts:79` | Staff override puede reprogramar servicio despublicado | `requirePublic` no condicionado a `allowStaffOverride` → siempre `true` público | **Funcional** — Staff no puede mover a servicio despublicado | `requirePublic: !input.allowStaffOverride` en llamada `resolveSlot` |
| **ELEPHANT-013** | STAFF_EXCEPTION_APPLIED event no emitido | `staff-exceptions.ts`, `booking.ts:22` | Event type específico para overrides staff | Cancel/reschedule usan `RESERVATION_CANCELLED`/`RESCHEDULED` genéricos | **Auditoría** — Imposible distinguir staff vs client sin inspeccionar principal_type | En `staff-exceptions.ts` emitir `STAFF_EXCEPTION_APPLIED` adicional post cancel/reschedule |
| **ELEPHANT-015** | Validación duplicada cadencia | `queries.ts:104-105` | Una sola validación | Dos `if` idénticos consecutivos (línea 105 muerto) | **Mantenibilidad** — Código muerto confuso | Eliminar línea 105 |
| **ELEPHANT-018** | ProfessionalPreference ANY forzado a SPECIFIC en reschedule | `reschedule.ts:74-77`, `booking.ts` | Según contratos: ¿permitir cambiar profesional en reprogramación pública? | `effectivePreference` fuerza staff original ignorando body | **Spec Ambiguity** — Decisión de diseño no documentada en contratos | Documentar en `availability.ts` o `booking.ts`: "Reprogramación pública preserva profesional original" O permitir cambio si `professionalPreference.type === "ANY"` |
| **ELEPHANT-020** | Drizzle/SQL drift (service_terms, staff_effective_unavailability) | `availability.ts`, `catalog.ts`, `schema.ts` | Drizzle refleja constraints SQL | 1) `catalog_terms_service_version_key` en Drizzle no en SQL 2) `staff_effective_unavailability` unique compuesto en SQL ausente en Drizzle | **Type Safety** — Drizzle no valida constraints reales | Sincronizar: añadir unique a migración SQL o quitar de Drizzle; añadir unique a Drizzle `staffEffectiveUnavailability` |
| **ELEPHANT-028** | ~15 DomainError codes huérfanos no probados | `booking.ts:34-41`, tests | Todos los error codes cubiertos por tests | `BOOKING_QUOTE_EXPIRED`, `COMMERCIAL_TERMS_CHANGED`, `BOOKING_CUTOFF_EXPIRED`, `RATE_LIMITED`, `GUEST_ACCESS_INVALID`, `GUEST_RECOVERY_NOT_VERIFIED`, `BOOKING_NOT_OWNED`, `BOOKING_NOT_AVAILABLE`, `BOOKING_ALREADY_CANCELLED`, `BOOKING_OPERATION_NOT_RECOVERABLE`, `BOOKING_POLICY_UNAVAILABLE`, `BOOKING_QUOTE_INVALID`, `FORBIDDEN`, `BOOKING_OPERATION_CONFLICT` (huérfano), `CLIENT_AUTH_INSUFFICIENT` | **Testing Coverage** — Paths de error no validados | Añadir tests unitarios/integración para cada código huérfano |

---

### P2 — MEDIA PRIORIDAD (10 defectos)

| ID | Título | Archivo:Línea | Correctivo Mínimo |
|---|---|---|---|
| **ELEPHANT-014** | `BOOKING_OPERATION_CONFLICT` código huérfano | `booking.ts:37`, `operations.ts:50` | Eliminar de `bookingErrorCodes` o usar en `operations.ts` para conflicto operación en vuelo |
| **ELEPHANT-016** | Intent proof digest inconsistency recovery | `recovery.ts:62` | Usar digest real (hash del token o proof) en lugar de string literal "recovery" |
| **ELEPHANT-017** | Asimetría validación businessId guest vs client | `confirm.ts:214` vs `244` | Unificar: en `confirmClientBooking` validar `quote.businessId === input.businessId` si se pasa |
| **ELEPHANT-021** | PrincipalRef semántico drift | `operations.ts:21`, `booking.ts:29-30` | Añadir `principalRef?: string` a `STAFF`/`CLIENT` en `BookingPrincipal` o remover de `OperationPrincipal` |
| **ELEPHANT-022** | OpenAPI/Swagger incompleto | `routes.ts` | Añadir `schema: { body: ..., query: ..., params: ..., response: ... }` a cada ruta |
| **ELEPHANT-023** | TTL envelope hardcoded 24h | `confirm.ts:19` | `const ENVELOPE_TTL_HOURS = Number(process.env.BOOKING_ENVELOPE_TTL_HOURS) ?? 24;` |
| **ELEPHANT-024** | Sin cache TTL en resolveClientPrincipal | `service.ts:161-174` | Cache 30s con invalidación por `sessions_valid_after` / `pg_notify` |
| **ELEPHANT-025** | Sin test contrato JWT (aud/iss) | `authorization.ts:27-28` | Test que verifique rechazo token con `aud`/`iss` incorrecto |
| **ELEPHANT-026** | Supabase local hard dependency sin mock CI | `scripts/assert-local-supabase.ps1`, CI | Documentar requisito; evaluar testcontainers para CI aislado |
| **ELEPHANT-027** | Cleanup tests: sin TRUNCATE global | `tests/h03/integration/*.spec.ts` | `afterEach` con `TRUNCATE ... CASCADE` en tablas de test o transacciones por test |

---

### P3 — BAJA PRIORIDAD (4 defectos)

| ID | Título | Archivo:Línea | Correctivo Mínimo |
|---|---|---|---|
| **ELEPHANT-029** | Métrica histórica "277/277" inflada | Reportes G21/G25 | Separar métricas: "h03 unit+integration: 141" vs "total monorepo histórico" |
| **ELEPHANT-030** | Deadlock: sin retry automático | `operations.ts` | Documentar: cliente reintenta en 40P01; evaluar retry automático con backoff |
| **ELEPHANT-031** | Key rotation procedure sin documentar | `guest-access.ts:59-61` | Documentar: nueva versión en KEYRING → deploy → re-encrypt envelopes pendientes |
| **ELEPHANT-032** | DST 36h window sin documentar | `temporal.ts:124-129` | Comentario explicando bucle 13 iteraciones para ventana DST transicion |

---

## Matriz de Verificación de Correctivos

| ID | Test Regresivo Requerido | Verificación Manual |
|---|---|---|
| ELEPHANT-001 | Test: deploy sin env vars → falla build/init | Verificar error claro en logs |
| ELEPHANT-003 | Test: recovery → reconcile → token recuperable | Verificar envelope cifrado en BD |
| ELEPHANT-005 | Test: app inicia sin U02 → 501 en /v1/client/* | Verificar no crash 500 |
| ELEPHANT-007 | Axe accessibility audit en CI | Navegación teclado + screen reader |
| ELEPHANT-008 | CI pipeline ejecuta h01/h02/h03 | Verificar logs CI |
| ELEPHANT-011 | Test: confirm multi-servicio con buffers distintos → occupiedMinutes correcto | Verificar occupied_start/end en BD |
| ELEPHANT-019 | Test: UI success muestra token ocultable | Verificar botón copiar/ocultar + warning |

---

## Resumen de Estado

| Categoría | Total | Pendiente | En Progreso | Completado |
|---|---|---|---|---|
| **P0** | 8 | 8 | 0 | 0 |
| **P1** | 12 | 12 | 0 | 0 |
| **P2** | 10 | 10 | 0 | 0 |
| **P3** | 4 | 4 | 0 | 0 |
| **TOTAL** | **34** | **34** | **0** | **0** |

---

**Próximo:** Evidencia de Reproducción (Artifact 08) → Plan Correctivo (Artifact 09)