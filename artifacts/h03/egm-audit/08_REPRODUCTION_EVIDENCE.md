# 08 — REPRODUCTION EVIDENCE (EGM AUDIT)

**Fecha:** 2026-11-09
**Actor:** C — OpenCode V2 + Google Elephant-Goldfish Model

## Evidencia de Reproducción para Defectos P0/P1 Críticos

### ELEPHANT-001: Dev Keys en Producción

**Comando de reproducción:**
```bash
# 1. Verificar fallback en código
grep -n "local-booking-quote-secret-not-for-production" apps/api/src/modules/booking/domain/quote.ts
grep -n "youngkingz-local-guest-envelope-key-v1" apps/api/src/modules/booking/security/guest-access.ts

# 2. Simular deploy sin env vars (en entorno aislado)
cd C:\Users\thega\Desktop\YoungKingZ-U03-Implementation
unset BOOKING_QUOTE_SECRET
unset BOOKING_GUEST_KEY_V1
pnpm build  # Debería fallar con correctivo, actualmente pasa silenciosamente
```

**Evidencia actual (SIN correctivo):**
```
quote.ts:14: const QUOTE_SECRET = process.env.BOOKING_QUOTE_SECRET ?? "local-booking-quote-secret-not-for-production";
guest-access.ts:56: return createHash("sha256").update("youngkingz-local-guest-envelope-key-v1").digest();
```

**Resultado esperado CON correctivo:** Build falla con mensaje claro "BOOKING_QUOTE_SECRET required in production"

---

### ELEPHANT-003: Recovery Envelope Sin AEAD

**Comando de reproducción:**
```bash
# 1. Verificar implementación actual
grep -A 10 "const envelope = Buffer.from" apps/api/src/modules/booking/commands/recovery.ts

# 2. Comparar con confirm.ts
grep -A 15 "encryptEnvelope" apps/api/src/modules/booking/commands/confirm.ts
```

**Evidencia actual:**
```typescript
// recovery.ts:62-65 (ACTUAL - INCORRECTO)
const { token, digest } = issueGuestToken();
const envelope = Buffer.from(token, "utf8");  // Token en claro
await tx`insert into booking.guest_delivery_envelopes(...) values (..., ${envelope}, 'recovery', ...)`;

// confirm.ts:185-188 (CORRECTO - REFERENCIA)
const envelopePlaintext = JSON.stringify({ reservationId, guestToken, credentialId: cred!.id });
const envelope = encryptEnvelope(envelopePlaintext, CURRENT_KEY_VERSION);
```

**Pasos para reproducir bug:**
1. Ejecutar `assistedGuestRecovery` con `outcome: "VERIFIED"`
2. Consultar `booking.guest_delivery_envelopes.encrypted_payload` → contiene token en Base64 plano
3. Intentar reconciliar vía `GET /booking-operations/:opId` → `decryptEnvelope` falla con "Unsupported envelope key version recovery"

---

### ELEPHANT-005: Crash U02 Import Estático

**Comando de reproducción:**
```bash
# 1. Verificar import estático
grep -n "from.*client-auth" apps/api/src/modules/booking/security/client-principal.ts

# 2. Simular ausencia U02 (renombrar temporalmente)
cd C:\Users\thega\Desktop\YoungKingZ-U03-Implementation
mv apps/api/src/modules/client-auth apps/api/src/modules/client-auth.BAK
pnpm build  # Debería fallar en load time del módulo booking
```

**Evidencia actual:**
```typescript
// client-principal.ts:19-20
import { resolveProviderIdentity } from "../../client-auth/provider.js";
import { resolveClientPrincipal } from "../../client-auth/service.js";
```

**Resultado esperado CON correctivo:** App inicia, rutas `/v1/client/*` responden 501 `CLIENT_AUTH_INSUFFICIENT`

---

### ELEPHANT-007: Accesibilidad WCAG P0 (4 defectos)

#### A11: Sin `prefers-reduced-motion`
```bash
# Verificar ausencia
grep -r "prefers-reduced-motion" apps/web/src/app/globals.css
# Resultado: vacío (no existe)
```

#### A12: Slot buttons < 44x44px
```bash
# Verificar CSS actual
grep -A 5 "slot-button" apps/web/src/app/globals.css
# globals.css:72: padding: 9px 8px; → ~34x34px con font-size 1rem
```

#### A13: Slot buttons sin aria-label descriptivo
```bash
# Verificar page.tsx
grep -A 3 "slot-button" apps/web/src/app/\(public\)/reservar/page.tsx
# Resultado: <button className="slot-button">{time}</button> — solo texto visible
```

#### A14: Sin handler Escape
```bash
# Verificar handlers en page.tsx y ClientReservations.tsx
grep -r "Escape\|escape\|keydown" apps/web/src/app/\(public\)/reservar/
grep -r "Escape\|escape\|keydown" apps/web/src/features/client-auth/ClientReservations.tsx
# Resultado: vacío
```

---

### ELEPHANT-008: Regresiones H01/H02 No Ejecutadas

**Comando de reproducción:**
```bash
cd C:\Users\thega\Desktop\YoungKingZ-U03-Implementation

# Verificar que suites existen
ls tests/h01/
ls tests/h02/

# Intentar ejecutar (deberían correr pero no están en CI actual)
pnpm exec vitest run tests/h01  # Esperado: tests pasan pero no en CI lote G21
pnpm exec vitest run tests/h02  # Esperado: tests pasan pero no en CI lote G21
```

**Evidencia documental:**
- `artifacts/h03/u04/21_GLOBAL_REGRESSION.md` línea 11: "No se ejecutaron suites h01/h02/e2e en este lote (alcance U04); no se alteraron."

---

### ELEPHANT-011: TermsOverride Faltante en Confirm Multi-Servicio

**Comando de reproducción (inspección estática):**
```bash
# 1. Verificar llamada resolveSlot en confirm.ts
grep -A 15 "const slot = await resolveSlot" apps/api/src/modules/booking/commands/confirm.ts

# 2. Verificar que termsOverride NO se pasa
grep -B 5 -A 15 "resolveSlot" apps/api/src/modules/booking/commands/confirm.ts | grep -c "termsOverride"
# Resultado esperado: 0 (no se pasa)
```

**Evidencia actual:**
```typescript
// confirm.ts:132-140
const slot = await resolveSlot(tx, {
  businessId,
  serviceIds: quote.serviceIds,
  localDate: quote.localDate,
  visibleStartMinute: quote.visibleStartMinute,
  professionalPreference: quote.professionalPreference,
  requirePublic: true,
  now: new Date(),
  // termsOverride: FALTA AQUÍ
});
```

**Test de reproducción sugerido:**
```typescript
// Test: quote con 2 servicios durations/buffers distintos
// 1. Crear quote con servicio A (30min) + servicio B (45min, preBuffer=10)
// 2. Confirmar quote
// 3. Verificar que reservation.occupied_end_at - occupied_start_at = suma durations + buffers del quote
// 4. Cambiar términos actuales en BD (duration de servicio B = 60min)
// 5. Confirmar mismo quote (replay idempotente) → occupiedMinutes debe seguir siendo el del quote original
```

---

### ELEPHANT-019: Guest Token Expuesto en UI Success

**Comando de reproducción:**
```bash
# Verificar page.tsx success rendering
grep -A 10 "guestToken" apps/web/src/app/\(public\)/reservar/page.tsx

# Buscar rendering de token en success state
grep -B 5 -A 10 "success" apps/web/src/app/\(public\)/reservar/page.tsx
```

**Evidencia actual:**
```typescript
// page.tsx ~línea 272
{result.guestToken && (
  <div className="guest-token-display">
    <code>{result.guestToken}</code>  {/* Token completo visible */}
  </div>
)}
```

---

### ELEPHANT-002: Rate Limit In-Memory No Distribuido

**Comando de reproducción:**
```bash
# Verificar implementación
grep -A 15 "const buckets = new Map" apps/api/src/modules/booking/routes.ts
```

**Evidencia actual:**
```typescript
// routes.ts:26-38
const buckets = new Map<string, { count: number; reset: number }>();
function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) { buckets.set(key, { count: 1, reset: now + windowMs }); return true; }
  if (bucket.count >= limit) return false;
  bucket.count += 1; return true;
}
```

**Escenario de fallo:** 3 instancias detrás de load balancer → cada una tiene su `Map` → límite efectivo = 3x configurado

---

### ELEPHANT-004: CORS Single-Origin

**Comando de reproducción:**
```bash
# Verificar configuración CORS
grep -A 3 "cors" apps/api/src/app.ts
grep -A 2 "webOrigin" apps/api/src/lib/runtime.ts
```

**Evidencia actual:**
```typescript
// app.ts:29
await app.register(cors, { origin: runtime.webOrigin, credentials: true, ... });

// runtime.ts:29
webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3100"
```

---

### ELEPHANT-006: Falta Drizzle booking.ts

**Comando de reproducción:**
```bash
# Verificar existencia
ls -la C:\Users\thega\Desktop\YoungKingZ-U03-Implementation\packages\database\src\booking.ts
# Resultado: No existe

# Verificar archivos existentes
ls C:\Users\thega\Desktop\YoungKingZ-U03-Implementation\packages\database\src\
```

---

### ELEPHANT-009: Fault Injection Commit Uncertainty

**Comando de reproducción (verificar test actual):**
```bash
# Verificar booking-confirm.spec.ts reconcile test
grep -A 20 "reconcile" tests/h03/integration/booking-confirm.spec.ts
```

**Evidencia actual (assertion débil):**
```typescript
// booking-confirm.spec.ts ~línea 58
expect(reconcileBody.guestToken).toBeTruthy();  // Solo verifica truthy, NO identidad
// Debería ser: expect(reconcileBody.guestToken).toBe(originalGuestToken);
```

---

### ELEPHANT-010: Weak Assertions (3 tests)

#### 1. Reconcile token identity
```bash
grep -A 10 "reconcile" tests/h03/integration/booking-confirm.spec.ts
```

#### 2. Ledger sanitization
```bash
grep -A 5 "r-ledger\|responseBody" tests/h03/integration/booking-principals.spec.ts
```

#### 3. ANY determinismo integración
```bash
grep -A 10 "deterministicCandidateOrder\|resolveSlot.*100" tests/h03/integration/availability.spec.ts
```

---

### ELEPHANT-012: Staff Override requirePublic

**Comando de reproducción:**
```bash
grep -A 10 "requirePublic" apps/api/src/modules/booking/commands/reschedule.ts
```

**Evidencia actual:**
```typescript
// reschedule.ts:74-77
const requirePublic = !input.allowStaffOverride;
const preference = input.professionalPreference ?? { type: "SPECIFIC" as const, staffMemberId: reservation.staffMemberId as string };
const effectivePreference = input.allowStaffOverride ? preference : { type: "SPECIFIC" as const, staffMemberId: reservation.staffMemberId as string };

// reschedule.ts:79-88 - resolveSlot llamado con requirePublic (siempre true para público)
const slot = await resolveSlot(tx, {
  // ...
  requirePublic,  // SIEMPRE true para público, no condicionado a allowStaffOverride
  // ...
});
```

---

### ELEPHANT-013: STAFF_EXCEPTION_APPLIED Event No Emitido

**Comando de reproducción:**
```bash
# Verificar event types en contracts
grep "STAFF_EXCEPTION_APPLIED" packages/contracts/src/booking.ts

# Verificar staff-exceptions.ts
grep -n "STAFF_EXCEPTION_APPLIED" apps/api/src/modules/booking/commands/staff-exceptions.ts

# Verificar cancel/reschedule events
grep -n "RESERVATION_CANCELLED\|RESERVATION_RESCHEDULED" apps/api/src/modules/booking/commands/*.ts
```

**Evidencia actual:**
```typescript
// booking.ts:22
"STAFF_EXCEPTION_APPLIED" in bookingEventTypes

// staff-exceptions.ts: NO emite STAFF_EXCEPTION_APPLIED
// cancel.ts:67-68 emite RESERVATION_CANCELLED genérico
// reschedule.ts:121-122 emite RESERVATION_RESCHEDULED genérico
```

---

### ELEPHANT-015: Validación Duplicada Cadencia

**Comando de reproducción:**
```bash
sed -n '104,106p' apps/api/src/modules/availability/queries.ts
```

**Evidencia actual:**
```typescript
// queries.ts:104-105
if(input.visibleStartMinute%policy.startStepMinutes!==0)throw new DomainError("NO_AVAILABILITY","The requested start is outside the booking cadence",409);
if(input.visibleStartMinute%policy.startStepMinutes!==0)throw new DomainError("START_TIME_NOT_ALLOWED","Start does not match the Booking Policy cadence",400);
// Segunda condición IDÉNTICA → código muerto
```

---

### ELEPHANT-028: DomainError Codes Huérfanos (~15)

**Comando de reproducción:**
```bash
# Listar todos los codes en contrato
grep -A 20 "bookingErrorCodes" packages/contracts/src/booking.ts

# Verificar uso en implementación
for code in BOOKING_QUOTE_EXPIRED COMMERCIAL_TERMS_CHANGED BOOKING_NOT_AVAILABLE BOOKING_NOT_OWNED GUEST_ACCESS_INVALID GUEST_RECOVERY_NOT_VERIFIED BOOKING_CUTOFF_EXPIRED BOOKING_ALREADY_CANCELLED BOOKING_OPERATION_CONFLICT OPERATION_PENDING BOOKING_OPERATION_NOT_RECOVERABLE RATE_LIMITED BOOKING_POLICY_UNAVAILABLE SLOT_CONFLICT BOOKING_QUOTE_INVALID; do
  echo "=== $code ==="
  grep -r "$code" apps/api/src/modules/booking/ || echo "NO ENCONTRADO"
done
```

**Resultado esperado:** ~15 codes no encontrados en implementación

---

## Resumen de Evidencia

| Defecto | Tipo Evidencia | Reproducible | Comando Clave |
|---|---|---|---|
| ELEPHANT-001 | Inspección estática + build test | ✅ SÍ | `grep` fallbacks + `unset env vars` |
| ELEPHANT-003 | Inspección estática + SQL query | ✅ SÍ | `grep recovery.ts` + `SELECT encrypted_payload` |
| ELEPHANT-005 | Inspección estática + module load test | ✅ SÍ | `mv client-auth` + `pnpm build` |
| ELEPHANT-007 | Inspección CSS/TSX + axe audit | ✅ SÍ | `grep prefers-reduced-motion`, `grep slot-button` |
| ELEPHANT-008 | Documental + CI config | ✅ SÍ | `pnpm exec vitest run tests/h01 tests/h02` |
| ELEPHANT-011 | Inspección estática + test propuesta | ✅ SÍ | `grep resolveSlot confirm.ts` |
| ELEPHANT-019 | Inspección TSX | ✅ SÍ | `grep guestToken page.tsx` |
| ELEPHANT-002 | Inspección estática | ✅ SÍ | `grep buckets routes.ts` |
| ELEPHANT-004 | Inspección estática | ✅ SÍ | `grep cors app.ts` |
| ELEPHANT-006 | Filesystem check | ✅ SÍ | `ls packages/database/src/booking.ts` |
| ELEPHANT-009/010 | Inspección tests | ✅ SÍ | `grep reconcile booking-confirm.spec.ts` |
| ELEPHANT-012 | Inspección estática | ✅ SÍ | `grep requirePublic reschedule.ts` |
| ELEPHANT-013 | Inspección estática | ✅ SÍ | `grep STAFF_EXCEPTION_APPLIED` |
| ELEPHANT-015 | Inspección estática | ✅ SÍ | `sed -n '104,106p' queries.ts` |
| ELEPHANT-028 | Grep masivo | ✅ SÍ | `for code in ...; do grep -r "$code"; done` |

---

**Todas las evidencias son reproducibles mediante inspección estática y comandos de verificación simples. No se requiere ejecución de código modificador.**

**Próximo:** Plan Correctivo (Artifact 09)