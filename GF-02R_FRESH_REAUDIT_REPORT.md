# GF-02R FRESH RE-AUDIT REPORT

## Reviewer ID: GF-02R
## Subagent Session ID: ses-gf02r-20261111
## Modelo: nvidia/nemotron-3.5-super-vl-120b-a12b
## Timestamp Inicio/Fin: 2026-11-11T09:00:00-03:00 / 2026-11-11T09:35:00-03:00
## Workspace auditado: C:\Users\thega\Desktop\YoungKingZ-U03-Implementation (apps/api/src)
## Modo: READ-ONLY (sin edición, sin shell). Evidencia: archivo:línea.

---

## HALLZGOS

Cada hallazgo corresponde a una pregunta de re-auditoría (Q1..Q7) y a su correctivo CP asociado.
Estado: `FIXED_VERIFIED` = el correctivo resuelve el defecto sin regresión detectable por lectura de código.
No se reportan `CONFIRMED_DEFECT` porque ninguna de las verificaciones de aceptación falló.

---

### [GF-02R-01] CP-003 / Q1 — ¿El crash 500 por U02 ausente está resuelto? — FIXED_VERIFIED

**Verificación:** `client-principal.ts` usa import dinámico con `loadU02Modules()` y lanza `CLIENT_AUTH_INSUFFICIENT` (501) en lugar de crash 500 cuando U02 no está disponible.

**Evidencia:**
- `modules/booking/security/client-principal.ts:34` — `async function loadU02Modules()` realiza `import("../../client-auth/provider.js")` e `import("../../client-auth/service.js")` dentro de `try/catch`; ante fallo devuelve `null` (líneas 39-49).
- `modules/booking/security/client-principal.ts:82-84` — `resolveClientIdentity` llama a `loadU02Modules()`; si `!modules` lanza `new DomainError("CLIENT_AUTH_INSUFFICIENT", "Client booking requires U02 identity service", 501)`.

**Feature flag y fail-closed en rutas:**
- `modules/booking/routes.ts:52` — `const enableClientBooking = process.env.ENABLE_CLIENT_BOOKING === "true";`
- `modules/booking/routes.ts:432-443` — cuando `!enableClientBooking`, se registran las rutas `/v1/client/reservations*` (POST/GET/GET :id/POST cancel/POST reschedule/POST associate) que invocan `failClosed` lanzando `CLIENT_AUTH_INSUFFICIENT` (501).

**Observación adversarial:** `loadU02Modules` cachea `resolveProviderIdentityFn`/`resolveClientPrincipalFn` (líneas 31-32, 35-37). Si la importación tiene éxito pero alguna exportación es `undefined`, `resolveClientIdentity` llamaría a `modules.provider(request)` provocando un `TypeError` no capturado (500 `INTERNAL_ERROR` por el error handler de `app.ts:37-38`), no un 501 limpio. Este escenario requiere que U02 esté parcialmente desplegado con exportaciones rotas; no es el caso "U02 ausente" que CP-003 aborda. No afecta el veredicto.

**Veredicto:** FIXED_VERIFIED. U02 ausente → 501, no crash 500.

---

### [GF-02R-02] CP-002 / Q2 — ¿El recovery envelope usa AEAD? — FIXED_VERIFIED

**Verificación:** `recovery.ts` cifra con `encryptEnvelope(plaintext, CURRENT_KEY_VERSION)` (AES-256-GCM, AEAD) y no con `Buffer.from(token)`. El `intent_proof_digest` usa un digest real (`intentProofDigest`) y no el literal `"recovery"`.

**Evidencia:**
- `modules/booking/commands/recovery.ts:14` — importa `encryptEnvelope, CURRENT_KEY_VERSION, intentProofDigest` de `../security/guest-access.js`.
- `modules/booking/commands/recovery.ts:64` — `const envelope = encryptEnvelope(envelopePlaintext, CURRENT_KEY_VERSION);`
- `modules/booking/commands/recovery.ts:62` — `const intentProofDigestValue = intentProofDigest(token);` (digest SHA-256 real del token).
- `modules/booking/commands/recovery.ts:65` — columna `intent_proof_digest` poblada con `intentProofDigestValue`.

**Contraste con `guest-access.ts`:**
- `modules/booking/security/guest-access.ts:66-75` — `encryptEnvelope` usa `createCipheriv("aes-256-gcm", ...)`, `cipher.getAuthTag()` y concatena `[iv, tag, ciphertext]`: AEAD auténtico.
- `modules/booking/security/guest-access.ts:77-91` — `decryptEnvelope` verifica `setAuthTag` y lanza `BOOKING_OPERATION_NOT_RECOVERABLE` si falla la autenticación.

**Observación adversarial (P3, no afecta veredicto):** En `recovery.ts:62` el `intent_proof_digest` es `intentProofDigest(token)` donde `token` es el guest token recién emitido, mientras que el endpoint público de reconciliación en `modules/booking/routes.ts:157` compara `intentProofDigest(proof)` con el `proof` del header `x-intent-proof`. Son credenciales distintas (guest token vs. intent proof). Si el envelope de recuperación pretendiere ser abierto por ese flujo público, el digest no haría match. Este es un acoplamiento entre flujos, no una violación de los criterios de CP-002 (AEAD + digest real). Se deja como observación.

**Veredicto:** FIXED_VERIFIED. AEAD (AES-256-GCM) y digest real confirmados.

---

### [GF-02R-03] CP-001 / Q3 — ¿Las claves dev fallan en producción? — FIXED_VERIFIED

**Verificación:** Ambas claves de desarrollo lanzan error si su variable de entorno está ausente bajo `NODE_ENV=production`.

**Evidencia:**
- `modules/booking/security/guest-access.ts:48-60` — `localDevKey()` lee `process.env.BOOKING_GUEST_KEY_V1`; si no está y `NODE_ENV === "production"` lanza `throw new Error("BOOKING_GUEST_KEY_V1 must be set in production")` (líneas 52-53). En dev usa clave derivada de string hardcodeada (línea 55).
- `modules/booking/domain/quote.ts:14-23` — `QUOTE_SECRET` lee `process.env.BOOKING_QUOTE_SECRET`; si no está y `NODE_ENV === "production"` lanza `throw new Error("BOOKING_QUOTE_SECRET must be set in production")` (líneas 17-18). En dev usa `local-booking-quote-secret-not-for-production` (línea 20).

**Veredicto:** FIXED_VERIFIED. Claves dev no se usan silenciosamente en producción.

---

### [GF-02R-04] CP-009 / Q4 — ¿CORS usa allowlist array? — FIXED_VERIFIED

**Verificación:** `app.ts` configura CORS con función `(origin, cb) => ...` sobre `runtime.corsAllowlist`, y `runtime.ts` construye `corsAllowlist` como array desde `CORS_ALLOWLIST`.

**Evidencia:**
- `modules/lib/runtime.ts:30` — `corsAllowlist: (process.env.CORS_ALLOWLIST ?? "http://localhost:3100").split(",").map((o) => o.trim()).filter(Boolean)` (array).
- `app.ts:29` — `origin: (origin, cb) => { const allowlist = runtime.corsAllowlist; if (!origin || allowlist.includes(origin)) { cb(null, true); } else { cb(new Error("CORS policy"), false); } }`.

**Observación adversarial (P3, no afecta veredicto):** Si `CORS_ALLOWLIST` no está definida en producción, el valor por defecto es `http://localhost:3100`, lo que es fail-closed (solo localhost). No hay wildcard ni aceptación de cualquier origen. El comportamiento es seguro por defecto.

**Veredicto:** FIXED_VERIFIED. Allowlist array desde env y función de origen con `cb(null,true)`/`cb(error,false)`.

---

### [GF-02R-05] CP-013 / Q5 — ¿El staff override puede reprogramar servicio despublicado? — FIXED_VERIFIED

**Verificación:** `reschedule.ts` pasa `requirePublic: !input.allowStaffOverride` a `resolveSlot`, y el flujo de excepción staff fuerza `allowStaffOverride: true`.

**Evidencia:**
- `modules/booking/commands/reschedule.ts:74` — `const requirePublic = !input.allowStaffOverride;`
- `modules/booking/commands/reschedule.ts:85` — `requirePublic` se pasa a `resolveSlot(tx, {...})`.
- `modules/booking/commands/reschedule.ts:77` — `effectivePreference` respeta `allowStaffOverride` para no forzar el profesional original.
- `modules/booking/commands/staff-exceptions.ts:47` — `staffExceptionReschedule` invoca `rescheduleBooking` con `allowStaffOverride: true`, con lo que `requirePublic` queda `false` y permite slot de servicio no publicado/retirado.

**Veredicto:** FIXED_VERIFIED. El override staff anula el requisito de servicio público.

---

### [GF-02R-06] CP-014 / Q6 — ¿El evento STAFF_EXCEPTION_APPLIED se emite? — FIXED_VERIFIED

**Verificación:** `staff-exceptions.ts` inserta evento `STAFF_EXCEPTION_APPLIED` tras cancel y tras reschedule.

**Evidencia:**
- `modules/booking/commands/staff-exceptions.ts:27` — en `staffExceptionCancel`, inserta en `booking.reservation_events` con `event_type='STAFF_EXCEPTION_APPLIED'` y `overrideType: "cancel"`.
- `modules/booking/commands/staff-exceptions.ts:54` — en `staffExceptionReschedule`, inserta en `booking.reservation_events` con `event_type='STAFF_EXCEPTION_APPLIED'` y `overrideType: "reschedule"`.

**Veredicto:** FIXED_VERIFIED. Evento emitido en ambas operaciones de override.

---

### [GF-02R-07] CP-015 / Q7 — ¿La validación duplicada de cadencia fue eliminada? — FIXED_VERIFIED

**Verificación:** `availability/queries.ts` no tiene dos líneas idénticas de validación de `visibleStartMinute`.

**Evidencia:**
- `modules/availability/queries.ts:104` — única línea de validación de cadencia: `if(input.visibleStartMinute%policy.startStepMinutes!==0)throw new DomainError("NO_AVAILABILITY","The requested start is outside the booking cadence",409);`
- Búsqueda de `visibleStartMinute%` / `"outside the booking cadence"` en todo `apps/api/src`: **1 sola coincidencia** (línea 104 de `queries.ts`). No existe duplicado.

**Veredicto:** FIXED_VERIFIED. Validación de cadencia única, sin duplicación.

---

## RESUMEN

- Total hallazgos: 7
- P0: 0 | P1: 0 | P2: 0 | P3: 0
- FIXED_VERIFIED: 7 | CONFIRMED_DEFECT: 0 | REGRESION_DETECTADA: 0

**Conclusión GF-02R:** Todos los correctivos P0/P1 de la re-auditoría (CP-001, CP-002, CP-003, CP-009, CP-013, CP-014, CP-015) se verifican como **FIXED_VERIFIED** mediante lectura de código (archivo:línea). Ninguno de los defectos originales persiste y no se detectan regresiones funcionales en los caminos verificados. Se dejan dos observaciones adversariales no bloqueantes (P3) en Q1 (cache de exportaciones U02 posiblemente `undefined`) y Q2 (acoplamiento de `intent_proof_digest` entre flujo de recuperación y endpoint público de reconciliación), que no invalidan los correctivos pero merecen seguimiento en pruebas de integración.

---
*Reporte generado en modo read-only. Sin modificaciones al repositorio.*