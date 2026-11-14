# 09 — CORRECTIVE PLAN (EGM AUDIT)

**Fecha:** 2026-11-09
**Actor:** C — OpenCode V2 + Google Elephant-Goldfish Model
**Basado en:** Defectos Confirmados (Artifact 07) + Evidencia Reproducción (Artifact 08)

## Estrategia Correctiva

### Principios
1. **Mínimo viable**: Cambio más pequeño que resuelve el defecto
2. **Sin regresiones**: Cada correctivo incluye test regresivo
3. **Orden de dependencias**: Correctivos independientes primero
4. **Autorización explícita**: Cambios de arquitectura/semántica requieren aprobación

---

## FASE 1: P0 BLOQUEANTES (Semana 1 — Correctivos Inmediatos)

### CP-001: Fail-Fast Dev Keys en Producción [ELEPHANT-001]
**Archivos:** `guest-access.ts`, `quote.ts`
**Cambio:**
```typescript
// guest-access.ts:48-57 — REEMPLAZAR localDevKey()
function localDevKey(): Buffer {
  const fromEnv = process.env.BOOKING_GUEST_KEY_V1;
  if (!fromEnv) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("BOOKING_GUEST_KEY_V1 must be set in production");
    }
    return createHash("sha256").update("youngkingz-local-guest-envelope-key-v1").digest();
  }
  const key = Buffer.from(fromEnv, "base64");
  if (key.length !== KEY_BYTES) throw new Error("BOOKING_GUEST_KEY_V1 must be 32 bytes base64");
  return key;
}

// quote.ts:14 — REEMPLAZAR
const QUOTE_SECRET = process.env.BOOKING_QUOTE_SECRET;
if (!QUOTE_SECRET) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("BOOKING_QUOTE_SECRET must be set in production");
  }
  QUOTE_SECRET = "local-booking-quote-secret-not-for-production";
}
```
**Test Regresivo:** `pnpm build` sin env vars en `NODE_ENV=production` → falla con mensaje claro
**Riesgo:** Bajo — Solo afecta configuración incorrecta

---

### CP-002: Recovery Envelope con AEAD [ELEPHANT-003]
**Archivo:** `recovery.ts:62-65`
**Cambio:**
```typescript
// ANTES:
const envelope = Buffer.from(token, "utf8");
await tx`insert into booking.guest_delivery_envelopes(...) values (..., ${envelope}, 'recovery', ...)`;

// DESPUÉS:
const envelopePlaintext = JSON.stringify({ reservationId, guestToken: token, credentialId: cred!.id });
const envelope = encryptEnvelope(envelopePlaintext, CURRENT_KEY_VERSION);
await tx`insert into booking.guest_delivery_envelopes(...) values (..., ${envelope}::bytea, ${CURRENT_KEY_VERSION}, ...)`;
```
**Test Regresivo:** Test integración recovery → reconcile → verificar token recuperable idéntico
**Riesgo:** Bajo — Usa función `encryptEnvelope` ya probada en confirm.ts

---

### CP-003: U02 Dynamic Import + Feature Flag [ELEPHANT-005]
**Archivos:** `client-principal.ts`, `routes.ts`
**Cambio:**
```typescript
// client-principal.ts — REEMPLAZAR imports estáticos
let resolveClientIdentityFn: (request: FastifyRequest) => Promise<ClientPrincipal> | null = null;

async function loadClientIdentityModule() {
  if (resolveClientIdentityFn) return resolveClientIdentityFn;
  try {
    const mod = await import("../../client-auth/service.js");
    resolveClientIdentityFn = mod.resolveClientIdentity;
  } catch {
    resolveClientIdentityFn = null; // U02 ausente
  }
  return resolveClientIdentityFn;
}

export async function resolveClientIdentity(request: FastifyRequest): Promise<ClientPrincipal> {
  const fn = await loadClientIdentityModule();
  if (!fn) throw new DomainError("CLIENT_AUTH_INSUFFICIENT", "Client booking requires U02 identity service", 501);
  return fn(request);
}

// routes.ts:322-339 — WRAP registro rutas /v1/client/*
if (process.env.ENABLE_CLIENT_BOOKING === "true") {
  // registrar rutas /v1/client/*
} else {
  // rutas fail-closed 501
  app.post("/v1/client/reservations", async () => { throw new DomainError("CLIENT_AUTH_INSUFFICIENT", "Client booking not enabled", 501); });
  // ... resto rutas client
}
```
**Test Regresivo:** 
1. App inicia sin U02 deployado → no crash
2. `POST /v1/client/reservations` → 501 `CLIENT_AUTH_INSUFFICIENT`
3. Con `ENABLE_CLIENT_BOOKING=true` y U02 mockeado → 200
**Riesgo:** Medio — Cambia comportamiento runtime; requiere testing E2E

---

### CP-004: Accesibilidad WCAG 2.1 AA (4 P0) [ELEPHANT-007]
**Archivos:** `globals.css`, `page.tsx`, `ClientReservations.tsx`, `ClientFrame.tsx`
**Cambios:**

1. **`prefers-reduced-motion`** en `globals.css`:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

2. **Slot buttons 44x44px** en `globals.css`:
```css
.slot-button {
  min-height: 44px;
  min-width: 44px;
  padding: 12px 16px; /* Ajustar para touch target */
}
```

3. **`aria-label` descriptivo** en `page.tsx` y `ClientReservations.tsx`:
```tsx
<button 
  className="slot-button" 
  aria-label={`${time}, ${serviceName}, ${duration} min`}  // Construir string contextual
>
  {time}
</button>
```

4. **Escape handler** en componentes con overlay:
```tsx
useEffect(() => {
  const handleEscape = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
  document.addEventListener("keydown", handleEscape);
  return () => document.removeEventListener("keydown", handleEscape);
}, [onClose]);
```

**Test Regresivo:** `pnpm exec playwright test` con Axe accessibility audit en CI
**Riesgo:** Bajo — Solo CSS/ARIA; no cambia lógica negocio

---

### CP-005: Regresiones H01/H02 en CI [ELEPHANT-008]
**Archivo:** `.github/workflows/ci.yml` (o equivalente)
**Cambio:** Añadir step en CI pipeline:
```yaml
- name: Run H01/H02/H03 regression
  run: |
    pnpm exec vitest run tests/h01 tests/h02 tests/h03 --reporter=junit
```
**Test Regresivo:** Verificar que pipeline CI ejecuta y pasa las 3 suites
**Riesgo:** Bajo — Solo configuración CI

---

### CP-006: TermsOverride en Confirm Multi-Servicio [ELEPHANT-011]
**Archivo:** `confirm.ts:132-140`
**Cambio:**
```typescript
const slot = await resolveSlot(tx, {
  businessId,
  serviceIds: quote.serviceIds,
  localDate: quote.localDate,
  visibleStartMinute: quote.visibleStartMinute,
  professionalPreference: quote.professionalPreference,
  requirePublic: true,
  now: new Date(),
  termsOverride: quote.items.map(q => ({  // AGREGAR
    id: q.serviceId,
    durationMinutes: q.durationMinutes,
    preBufferMinutes: q.preBufferMinutes,
    postBufferMinutes: q.postBufferMinutes,
  })),
});
```
**Test Regresivo:** Test integración: quote 2 servicios con durations/buffers distintos → confirmar → verificar `occupiedMinutes` coincide con quote (no términos actuales si cambiaron)
**Riesgo:** Muy Bajo — 1 línea, usa datos ya disponibles en `quote.items`

---

### CP-007: Guest Token UI — Copiar/Ocultar + Warning [ELEPHANT-019]
**Archivo:** `page.tsx` (success rendering)
**Cambio:** Reemplazar rendering de token por componente con:
- Toggle mostrar/ocultar (default oculto)
- Botón "Copiar" con feedback visual
- Warning "⚠️ No compartas este token. Quien lo tenga puede acceder a tu reserva."
**Test Regresivo:** Test E2E Playwright: flujo reserva → success → verificar token oculto por default, botón copiar funciona, warning visible
**Riesgo:** Bajo — Solo UI

---

## FASE 2: P1 ALTA PRIORIDAD (Semana 2-3)

### CP-008: Rate Limit Redis-Backed [ELEPHANT-002] — **REQUIERE APROBACIÓN**
**Dependencia:** Infraestructura Redis
**Cambio:** Migrar `routes.ts:26-38` a `@fastify/rate-limit` con Redis store
**Esfuerzo:** Alto — Nueva dependencia, configuración Redis
**Test Regresivo:** Load test multi-instancia verificando rate limit compartido

### CP-009: CORS Allowlist Array [ELEPHANT-004]
**Archivos:** `app.ts`, `runtime.ts`
**Cambio:**
```typescript
// runtime.ts
corsAllowlist: (process.env.CORS_ALLOWLIST ?? "http://localhost:3100").split(",")

// app.ts
origin: (origin, cb) => {
  const allowlist = runtime.corsAllowlist;
  if (!origin || allowlist.includes(origin)) cb(null, true);
  else cb(new Error("CORS policy"), false);
},
```

### CP-010: Drizzle booking.ts Schema [ELEPHANT-006]
**Archivo:** `packages/database/src/booking.ts` (NUEVO)
**Cambio:** Crear schema completo replicando constraints SQL:
- Tablas: `reservations`, `reservation_items`, `reservation_events`, `guest_credentials`, `guest_delivery_envelopes`, `guest_recovery_cases`
- Check constraints, FK compuestas, unique partial indexes, RLS triggers
**Esfuerzo:** Medio — Requiere sincronización con migración SQL

### CP-011: Fault Injection Commit Uncertainty [ELEPHANT-009]
**Archivo:** `booking-fault-injection.spec.ts` (NUEVOS TESTS)
**Tests a añadir:**
1. **Token identity reconciliation:** `expect(reconcileBody.guestToken).toBe(originalGuestToken)`
2. **Envelope crypto failure:** Inyectar fallo en `decryptEnvelope` → verificar manejo graceful
3. **Network partition:** Simular timeout tras commit → verificar reconcile funciona
4. **Deadlock:** `Promise.all([txA.then(txB), txB.then(txA)])` → verificar retry/recovery

### CP-012: Weak Assertions Fortalecimiento [ELEPHANT-010]
**Archivos:** `booking-confirm.spec.ts`, `booking-principals.spec.ts`, `availability.spec.ts`
**Cambios:**
1. `booking-confirm.spec.ts:58`: `expect(reconcileBody.guestToken).toBe(originalGuestToken)`
2. `booking-principals.spec.ts:97`: `expect(JSON.stringify(row.responseBody)).not.toContain("guestToken")`
3. `availability.spec.ts`: Nuevo test integración 100 iteraciones `resolveSlot` mismo input → mismo staff

### CP-013: Staff Override requirePublic [ELEPHANT-012]
**Archivo:** `reschedule.ts:79`
**Cambio:**
```typescript
// ANTES:
requirePublic,  // siempre true para público

// DESPUÉS:
requirePublic: !input.allowStaffOverride,
```

### CP-014: STAFF_EXCEPTION_APPLIED Event [ELEPHANT-013]
**Archivo:** `staff-exceptions.ts`
**Cambio:** Tras `cancelBooking`/`rescheduleBooking`, emitir evento adicional:
```typescript
await tx`insert into booking.reservation_events(...) values (..., 'STAFF_EXCEPTION_APPLIED', ..., ${JSON.stringify({ overrideType: "cancel" | "reschedule", reason: input.reason })}::jsonb)`;
```

### CP-015: Validación Duplicada Cadencia [ELEPHANT-015]
**Archivo:** `queries.ts:105`
**Cambio:** Eliminar línea 105 (duplicada)

### CP-016: ~15 DomainError Codes Tests [ELEPHANT-028]
**Archivos:** Tests unitarios/integración nuevos
**Codes a cubrir:** `BOOKING_QUOTE_EXPIRED`, `COMMERCIAL_TERMS_CHANGED`, `BOOKING_CUTOFF_EXPIRED`, `RATE_LIMITED`, `GUEST_ACCESS_INVALID`, `GUEST_RECOVERY_NOT_VERIFIED`, `BOOKING_NOT_OWNED`, `BOOKING_NOT_AVAILABLE`, `BOOKING_ALREADY_CANCELLED`, `BOOKING_OPERATION_NOT_RECOVERABLE`, `BOOKING_POLICY_UNAVAILABLE`, `BOOKING_QUOTE_INVALID`, `FORBIDDEN`, `CLIENT_AUTH_INSUFFICIENT`

---

## FASE 3: P2 MEDIA PRIORIDAD (Semana 3-4)

### CP-017: BOOKING_OPERATION_CONFLICT Cleanup [ELEPHANT-014]
**Archivo:** `booking.ts:37` — Eliminar code huérfano O usarlo en `operations.ts:50`

### CP-018: Intent Proof Digest Consistency [ELEPHANT-016]
**Archivo:** `recovery.ts:62` — Usar `createHash("sha256").update(token).digest("base64url")` en lugar de "recovery"

### CP-019: Asimetría BusinessId Guest/Client [ELEPHANT-017]
**Archivo:** `confirm.ts:244` — Añadir validación `if (quote.businessId !== input.businessId) throw...`

### CP-020: PrincipalRef Alignment [ELEPHANT-021]
**Archivos:** `booking.ts:29-30`, `operations.ts:9-13` — Añadir `principalRef?: string` a `STAFF`/`CLIENT` en `BookingPrincipal`

### CP-021: OpenAPI Explicit Schemas [ELEPHANT-022]
**Archivo:** `routes.ts` — Añadir `schema: { body: ..., query: ..., params: ..., response: ... }` a cada ruta

### CP-023: Cache TTL resolveClientPrincipal [ELEPHANT-024]
**Archivo:** `service.ts:161-174` — Cache 30s con invalidación por `sessions_valid_after`

### CP-025: Test JWT Contract [ELEPHANT-025]
**Archivo:** `tests/h01/integration/auth-contract.spec.ts` (NUEVO) — Test rechazo token `aud`/`iss` inválido

### CP-026: Supabase Mock CI Evaluation [ELEPHANT-026]
**Documento:** `docs/TESTING_STRATEGY.md` — Documentar requisito; evaluar testcontainers

### CP-027: Cleanup Tests TRUNCATE [ELEPHANT-027]
**Archivos:** `tests/h03/integration/*.spec.ts` — `afterEach` con `TRUNCATE ... CASCADE` o transacciones por test

---

## FASE 4: P3 BAJA PRIORIDAD (Backlog)

### CP-029: Métrica Histórica Separada [ELEPHANT-029]
### CP-030: Deadlock Retry Documentation [ELEPHANT-030]
### CP-031: Key Rotation Procedure Doc [ELEPHANT-031]
### CP-032: DST 36h Window Doc [ELEPHANT-032]
### CP-033: Cutoff Frontier Test [ELEPHANT-033]
### CP-034: SearchAvailability N+1 Optimization [ELEPHANT-034]

---

## Matriz de Autorización

| Correctivo | Requiere Aprobación | Justificación |
|---|---|---|
| CP-001 a CP-007 | **NO** | Correctivos internos, sin cambio semántico |
| CP-008 | **SÍ** | Nueva dependencia Redis |
| CP-009 a CP-016 | **NO** | Correctivos internos / tests |
| CP-018 a CP-027 | **NO** | Correctivos internos / tests / docs |
| CP-018 (ANY en reschedule) | **SÍ** | Cambio semántico UX: ¿permitir cambiar profesional en reprogramación pública? |

---

## Cronograma Estimado

| Semana | Foco | Entregables |
|---|---|---|
| **Semana 1** | P0 Blocking | CP-001 a CP-007 completados + tests regresivos |
| **Semana 2** | P1 Core | CP-009 a CP-016 (excluyendo CP-008 pendiente aprobación) |
| **Semana 3** | P1 Remaining + P2 | CP-008 (si aprobado), CP-017 a CP-027 |
| **Semana 4** | P3 + Validación | CP-029 a CP-034 + Fresh Goldfish Re-Audit |

---

## Criterios de Finalización Fase 1 (P0)

- [ ] CP-001: Build falla sin env vars en producción
- [ ] CP-002: Recovery envelope usa AEAD + reconcile funciona
- [ ] CP-003: App inicia sin U02 → 501 en rutas client
- [ ] CP-004: Axe accessibility audit pasa WCAG 2.1 AA (4 P0 resueltos)
- [ ] CP-005: CI ejecuta h01/h02/h03
- [ ] CP-006: TermsOverride pasado a resolveSlot en confirm
- [ ] CP-007: Guest token UI con copiar/ocultar + warning

**Próximo:** Corrective Execution (Artifact 10) → Regression Results (Artifact 11) → Fresh Goldfish Re-Audit (Artifact 12)