# GF-01R FRESH RE-AUDIT REPORT

## Reviewer ID: GF-01R
## Subagent Session ID: [auto]
## Modelo: nvidia/nemotron-3.5-super-vl-120b-a12b
## Timestamp Inicio/Fin: 2026-11-11T15:33:10Z / [pendiente]

## HALLZGOS

### FINDING GF-01R-001
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: CP-001 — Fail-fast dev keys en producción para `BOOKING_GUEST_KEY_V1` en `guest-access.ts`
- **Fuente Normativa**: `apps/api/src/modules/booking/security/guest-access.ts:48-60`
- **Comportamiento Esperado**: En producción (`NODE_ENV === "production"`), si falta `BOOKING_GUEST_KEY_V1`, la función `localDevKey()` debe lanzar error (fail-fast) antes de permitir cualquier cifrado/descifrado de envelope.
- **Comportamiento Observado**: LÍNEAS 51-55: `if (!fromEnv) { if (process.env.NODE_ENV === "production") { throw new Error("BOOKING_GUEST_KEY_V1 must be set in production"); } return createHash(...).digest(); }`. El throw solo ocurre dentro del bloque `if (!fromEnv)` cuando `NODE_ENV === "production"`. Si `fromEnv` está presente pero inválida (longitud != 32 bytes), lanza en la línea 58. CORRECTO: fail-fast implementado.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `guest-access.ts:48-60`.
- **Impacto**: Seguridad — evita claves por defecto predecibles en producción.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-002
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: CP-001 — Fail-fast dev keys en producción para `BOOKING_QUOTE_SECRET` en `quote.ts`
- **Fuente Normativa**: `apps/api/src/modules/booking/domain/quote.ts:14-23`
- **Comportamiento Esperado**: En producción, si falta `BOOKING_QUOTE_SECRET`, la evaluación del secreto debe lanzar error antes de firmar/verificar cualquier quote.
- **Comportamiento Observado**: LÍNEAS 14-23: `QUOTE_SECRET` es una IIFE que lee `process.env.BOOKING_QUOTE_SECRET`; si faltase y `NODE_ENV === "production"`, lanza `throw new Error("BOOKING_QUOTE_SECRET must be set in production")` (líneas 17-18). CORRECTO: fail-fast implementado.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `quote.ts:14-23`.
- **Impacto**: Seguridad — evita firmar quotes con secreto por defecto predecible en producción.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-003
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: CP-002 — Recovery envelope con AEAD (`encryptEnvelope`, no `Buffer.from` plano)
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/recovery.ts:64` y `apps/api/src/modules/booking/commands/confirm.ts:192`
- **Comportamiento Esperado**: El payload del envelope de recuperación y confirmación debe cifrarse con `encryptEnvelope` (AES-256-GCM AEAD), no con `Buffer.from` plano sin cifrar.
- **Comportamiento Observado**: `recovery.ts:64`: `const envelope = encryptEnvelope(envelopePlaintext, CURRENT_KEY_VERSION);` y `confirm.ts:192`: `const envelope = encryptEnvelope(envelopePlaintext, CURRENT_KEY_VERSION);`. Ambos usan AEAD. CORRECTO.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `recovery.ts:64` y `confirm.ts:192`.
- **Impacto**: Seguridad/Datos — credenciales de invitado protegidas con cifrado autenticado.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-004
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: CP-003 — U02 Dynamic Import + Feature Flag; `client-principal.ts` usa import dinámico con fallback a 501
- **Fuente Normativa**: `apps/api/src/modules/booking/security/client-principal.ts:34-50, 81-88`
- **Comportamiento Esperado**: `loadU02Modules()` intenta import dinámico de módulos U02; si fallan (no desplegado), retorna `null` y `resolveClientIdentity` lanza `CLIENT_AUTH_INSUFFICIENT` (501).
- **Comportamiento Observado**: LÍNEAS 34-50: `loadU02Modules()` usa `Promise.all([import(...), import(...)])` con `try/catch` que retorna `null` en fallo. LÍNEAS 81-88: `resolveClientIdentity` lanza `DomainError("CLIENT_AUTH_INSUFFICIENT", ..., 501)` si `!modules`. CORRECTO.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `client-principal.ts:34-50, 81-88`.
- **Impacto**: Funcional — fail-closed cuando U02 no disponible, sin exponer endpoints cliente sin identidad real.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-005
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: CP-003 — `routes.ts` tiene feature flag `ENABLE_CLIENT_BOOKING`
- **Fuente Normativa**: `apps/api/src/modules/booking/routes.ts:52, 324-443`
- **Comportamiento Esperado**: Las rutas CLIENT solo se registran si `process.env.ENABLE_CLIENT_BOOKING === "true"`; si no, se registran rutas fail-closed 501.
- **Comportamiento Observado**: LÍNEA 52: `const enableClientBooking = process.env.ENABLE_CLIENT_BOOKING === "true";`. LÍNEAS 324-430: bloque `if (enableClientBooking) { ... }` con rutas cliente reales. LÍNEAS 433-443: `if (!enableClientBooking)` registra 6 rutas con `failClosed` que lanza `CLIENT_AUTH_INSUFFICIENT` (501). CORRECTO.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `routes.ts:52, 324-443`.
- **Impacto**: Funcional/Seguridad — endpoints cliente expuestos solo cuando el flag está activo.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-006
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-006 — `confirm.ts` pasa `termsOverride` a `resolveSlot`
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/confirm.ts:132-146`
- **Comportamiento Esperado**: Al confirmar, `resolveSlot` recibe `termsOverride` construido desde `quote.items` para forzar cadencia/duración de los términos aceptados en la quote, no los términos actuales del catálogo.
- **Comportamiento Observado**: LÍNEAS 132-146: `resolveSlot(tx, { ..., termsOverride: quote.items.map(q => ({ id: q.serviceId, durationMinutes: q.durationMinutes, preBufferMinutes: q.preBufferMinutes, postBufferMinutes: q.postBufferMinutes })) })`. CORRECTO.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `confirm.ts:132-146`.
- **Impacto**: Funcional/Datos — evita que cambios de términos en catálogo alteren la reserva confirmada (fidelidad al quote).
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-007
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: CP-007 — Guest token UI con show/hide + copiar + warning en `page.tsx` (reserva pública)
- **Fuente Normativa**: `apps/web/src/app/(public)/reservar/page.tsx:41-42, 196-211, 291-323`
- **Comportamiento Esperado**: Tras confirmar como invitado, el token se muestra oculto, con botón Mostrar/Ocultar, botón Copiar al portapapeles y warning de seguridad ("⚠️ Quien tenga este token puede acceder a tu reserva").
- **Comportamiento Observado**: LÍNEAS 41-42: estados `guestToken` y `showToken`. LÍNEAS 202-211: `copyToken` usa `navigator.clipboard.writeText`. LÍNEAS 291-323: render condicional del token con `showToken ? guestToken : "•".repeat(...)`, botón Mostrar/Ocultar, botón Copiar, y warning `⚠️ Quien tenga este token puede acceder a tu reserva. No lo compartas.` CORRECTO.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `reservar/page.tsx`.
- **Impacto**: UX/Seguridad — control del usuario sobre exposición del token y advertencia de riesgo.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-008
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-004 — `globals.css` tiene `prefers-reduced-motion` y slot buttons 44x44px
- **Fuente Normativa**: `apps/web/src/app/globals.css:76-83` y `apps/web/src/app/globals.css:72`
- **Comportamiento Esperado**: Media query `prefers-reduced-motion: reduce` que anula animaciones/transiciones; botones de slot con `min-height:44px` y `min-width:44px` (toque accesible).
- **Comportamiento Observado**: LÍNEAS 76-83: `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; ... } }`. LÍNEA 72: `.slot-button` tiene `min-height:44px; min-width:44px;`. CORRECTO.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `globals.css:72, 76-83`.
- **Impacto**: Accesibilidad WCAG 2.1 AA (movimiento reducido y target size 44px).
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-009
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-009 — CORS Allowlist Array (no single origin)
- **Fuente Normativa**: `apps/api/src/lib/runtime.ts:30` y `apps/api/src/src/app.ts:29`
- **Comportamiento Esperado**: `runtime.corsAllowlist` es un array derivado de `CORS_ALLOWLIST` dividido por comas; el handler CORS usa `allowlist.includes(origin)`.
- **Comportamiento Observado**: `runtime.ts:30`: `corsAllowlist: (process.env.CORS_ALLOWLIST ?? "http://localhost:3100").split(",").map((o) => o.trim()).filter(Boolean)`. `app.ts:29`: `origin: (origin, cb) => { const allowlist = runtime.corsAllowlist; if (!origin || allowlist.includes(origin)) { cb(null, true); } ... }`. CORRECTO: es array, no single string.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `runtime.ts:30` y `app.ts:29`.
- **Impacto**: Seguridad — solo orígenes en la allowlist pueden hacer CORS; evita reflector de cualquier origen.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-010
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: CP-010 — `packages/database/src/booking.ts` existe y es consistente con migración SQL
- **Fuente Normativa**: `packages/database/src/booking.ts` (Drizzle schema) vs `supabase/migrations/202611050002_h03_u04_booking.sql`
- **Comportamiento Esperado**: El schema Drizzle refleja las tablas y columnas de la migración SQL (reservations, reservation_items, reservation_events, guest_credentials, guest_delivery_envelopes, guest_recovery_cases).
- **Comportamiento Observado**: `packages/database/src/booking.ts` existe (líneas 1-165). Define `reservations` (línea 16), `reservation_items` (línea 58), `reservation_events` (línea 85), `guest_credentials` (línea 108), `guest_delivery_envelopes` (línea 127), `guest_recovery_cases` (línea 144). Columnas coinciden con SQL: `id`, `business_id`, `revision`, `status`, `owner_type`, `owner_account_id`, `contact_snapshot`, `staff_member_id`, `policy_version_id`, `policy_snapshot`, `commercial_total_minor`, `currency`, `current_allocation_id`, `starts_at`, `ends_at`, `occupied_starts_at`, `occupied_ends_at`, `business_local_date`, `business_timezone_snapshot`, `created_operation_id`. FKs compuestas tenant-safe presentes. CORRECTO.
- **Reproducción**: INSPECCIÓN ESTÁTICA — comparación de `packages/database/src/booking.ts` con `supabase/migrations/202611050002_h03_u04_booking.sql`.
- **Impacto**: Datos — consistencia entre ORM y BD real.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-011
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-011 — `booking-fault-injection.spec.ts` existe y prueba concurrencia
- **Fuente Normativa**: `tests/h03/integration/booking-fault-injection.spec.ts`
- **Comportamiento Esperado**: Existe archivo con pruebas de fault injection contra API real + PostgreSQL real; verifica sin duplicados ni huérfanos bajo concurrencia.
- **Comportamiento Observado**: Archivo existe (190 líneas). Pruebas: F04-01 (dos confirmaciones simultáneas → una OK 200, otra 409, exactamente una allocation ACTIVE), F04-02 (cancel/reschedule concurrentes), F04-03 (dos reprogramaciones concurrentes), F04-04 (rollback total sin huérfanos), F04-05 (idempotencia con distintos principales). CORRECTO.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `booking-fault-injection.spec.ts`.
- **Impacto**: Calidad/Confianza — cobertura de concurrencia e integridad transaccional.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-012
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-011/CP-016 — `booking-domain-error-codes.spec.ts` existe y cubre códigos huérfanos
- **Fuente Normativa**: `tests/h03/integration/booking-domain-error-codes.spec.ts`
- **Comportamiento Esperado**: Existe archivo que verifica cada código de error de `bookingErrorCodes` sin cobertura previa; lanza el código correcto en su escenario.
- **Comportamiento Observado**: Archivo existe (199 líneas). Pruebas: BOOKING_QUOTE_EXPIRED, COMMERCIAL_TERMS_CHANGED, BOOKING_NOT_OWNED, GUEST_ACCESS_INVALID, BOOKING_CUTOFF_EXPIRED, BOOKING_POLICY_UNAVAILABLE, BOOKING_QUOTE_INVALID. CORRECTO.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `booking-domain-error-codes.spec.ts`.
- **Impacto**: Calidad — cobertura de códigos de error de dominio.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-013
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-011 — `booking-confirm.spec.ts` verifica token identidad en reconcile
- **Fuente Normativa**: `tests/h03/integration/booking-confirm.spec.ts:50-70`
- **Comportamiento Esperado**: El reconcile (`GET /booking-operations/:operationId` con `x-intent-proof`) devuelve el MISMO guestToken en llamadas repetidas (no genera uno nuevo), probando identidad del token.
- **Comportamiento Observado**: LÍNEAS 50-70: `reconcileRes` obtiene `guestToken`; `reconcileRes2` con la misma proof espera `reconcileBody2.guestToken).toBe(guestToken)`. CORRECTO.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `booking-confirm.spec.ts:50-70`.
- **Impacto**: Funcional/Seguridad — el token de entrega es estable y vinculado a la operación, no re-emitiendo credenciales.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-014
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-011 — `booking-principals.spec.ts` verifica ledger sin secretos
- **Fuente Normativa**: `tests/h03/integration/booking-principals.spec.ts:86-101`
- **Comportamiento Esperado**: El ledger (`system.operation_attempts`) registra `principal_kind` y `principal_ref` pero NO secretos (token, proof) en `response_body`.
- **Comportamiento Observado**: LÍNEAS 86-101: prueba que `responseBody` contiene "r-ledger" pero no contiene "leakedToken" ni `intent.proof`. CORRECTO.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `booking-principals.spec.ts:86-101`.
- **Impacto**: Seguridad — no filtración de secretos en el ledger de operaciones.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED
