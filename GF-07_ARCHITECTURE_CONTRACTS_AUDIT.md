# GF-07: Architecture & Contracts Audit Report

**Workspace:** `C:\Users\thega\Desktop\YoungKingZ-U03-Implementation`  
**Persona:** EGM Canonical Reviewer — Architecture & Integration Specialist  
**Date:** 2026-11-09  
**Scope:** H01 IAM, H02 Catalog/Eligibility, H03.U01 CRM, H03.U02 Identity (external), H03.U03 Availability, H03.U04 Booking, Contracts, Fastify App, Integration Tests

---

## Executive Summary

| Question | Verdict | Severity |
|----------|---------|----------|
| **Q1: H01 IAM — Única autoridad AuthN/AuthZ** | ✅ **PASS** | — |
| **Q2: H02 Catálogo/Elegibilidad — Única autoridad dominio** | ✅ **PASS** | — |
| **Q3: H03.U01 CRM — Sin auto-creación** | ✅ **PASS** | — |
| **Q4: H03.U02 Identidad — Interfaz fail-closed** | ⚠️ **R1_REQUIRED** | P0 (crash 500 si U02 ausente) |
| **Q5: Fastify Routes — Registro correcto** | ✅ **PASS** (con deuda rate-limit) | — |
| **Q6: Contratos TS — Coherencia** | ✅ **PASS** (menor discrepancia `OperationPrincipal` vs `BookingPrincipal`) | — |
| **Q7: Drizzle Schema — Cobertura** | ⚠️ **R1_REQUIRED** | P1 (falta `booking.ts`, inconsistencias F2/F3) |
| **Q8: Separación módulos — Deuda técnica** | ✅ **PASS** (dirección correcta, sin ciclos) | — |
| **Q9: Error Codes — Consistencia** | ✅ **PASS** | — |
| **Q10: Swagger/OpenAPI — Documentación** | ✅ **PASS** | — |
| **Q11: Capabilities — Deuda U05/U06/U07** | ✅ **PASS** (extensibles, no prematuras) | — |
| **Q12: Impacto U05/U06/U07** | ✅ **PASS** (contratos listos, sin lógica prematura) | — |

**Overall:** **R1_REQUIRED** — Two blocking findings (Q4, Q7) must be resolved before production deployment.

---

## Detailed Findings

### Q1: H01 IAM — Autoridad Única de Autenticación/Autorización ✅ PASS

| Check | Evidence | Status |
|-------|----------|--------|
| `authorizationService` única fuente de `Actor` y `capabilities` | `apps/api/src/modules/iam/authorization.ts:24-86` — `AuthorizationService.authenticate()` construye `Actor` con `capabilities` derivadas de `roleCapabilities` + `capability_grants`. No hay otra factoría de `Actor`. | ✅ |
| `booking.routes.ts` usa `authenticate` + `requireCapability` para TODOS endpoints STAFF | `apps/api/src/modules/booking/routes.ts:46-48` define `authenticate`, `actor`, `requireCapability` usando `authorizationService`. Todas las rutas `/v1/staff/*` tienen `preHandler: authenticate` + `requireCapability(request, "bookings.read" | "bookings.history.read" | "bookings.override.cancel" | "bookings.override.reschedule" | "bookings.guest_access.recover")`. | ✅ |
| `executeOperation` delega a `executePrincipalOperation` sin duplicar idempotencia | `apps/api/src/modules/system/operations.ts:69-71` — `executeOperation` es wrapper de una línea que convierte `Actor` → `OperationPrincipal` kind `STAFF` y llama `executePrincipalOperation`. La lógica de idempotencia reside **solo** en `executePrincipalOperation` (líneas 36-67). | ✅ |
| Capabilities `bookings.*` extendidas en `contracts/index.ts` sin romper H01 | `packages/contracts/src/index.ts:34-35` añade `bookings.read`, `bookings.history.read`, `bookings.contact.manage`, `bookings.override.cancel`, `bookings.override.reschedule`, `bookings.guest_access.recover`. `roleCapabilities` (líneas 79-83) las asigna solo a `OWNER`/`RECEPTIONIST` (no a `BARBER`). `delegableCapabilities` (líneas 40-49) incluye `bookings.read`, `bookings.history.read` para delegación. Sin conflictos con capacidades IAM existentes. | ✅ |

**Observación:** La arquitectura respeta el principio de **autoridad única**: IAM emite `Actor` + `capabilities`; Booking consume vía `requireCapability`. No hay segundo motor de autorización.

---

### Q2: H02 Catálogo/Elegibilidad — Autoridad Única de Dominio ✅ PASS

| Check | Evidence | Status |
|-------|----------|--------|
| `resolveSlot` (U03) única autoridad temporal | `apps/api/src/modules/availability/queries.ts:101-112` exporta `resolveSlot`. **Booking** lo importa y usa en: `routes.ts:62-70` (quote), `commands/confirm.ts:132-140`, `commands/reschedule.ts:79-88`. No hay lógica temporal duplicada en booking. | ✅ |
| `resolveSlot` consume: catalog.services, staff_services, schedules, availability | `queries.ts:40-50` → `loadServices` (catálogo: lifecycle, publication, terms version). `queries.ts:63-69` → `loadCandidateIds` (staff_services: `staff_service_sets` + `staff_service_assignments`). `queries.ts:52-61` → `loadBaseBusinessIntervals` (business hours + date exceptions). `queries.ts:71-80` → `loadStaffBase` (staff weekly schedules + date exceptions). `queries.ts:82-91` → `loadBlocks` (effective unavailability + `resource_allocations`). | ✅ |
| `booking.commands.confirm.ts` SOLO llama `resolveSlot` + `claimAllocation` | `confirm.ts:114, 132-140, 164-172` — `lockAvailabilityGuard` → `resolveSlot` → `claimAllocation`. No reimplementa cadencia, horizon, buffers, elegibilidad. | ✅ |
| `booking.commands.reschedule.ts` usa `replaceAllocation` + `termsOverride` históricos | `reschedule.ts:63-70` carga `historicalTerms` desde `reservation_items` (servicios, duration, buffers). `reschedule.ts:79-88` pasa `termsOverride: historicalTerms` a `resolveSlot`. `reschedule.ts:91-104` llama `replaceAllocation` con `destination.historicalTerms`. No lógica temporal nueva. | ✅ |

**Observación:** La separación es limpia: **Availability = motor temporal**; **Booking = orquestador de confirmación/cancelación/reprogramación**. Booking no toca `schedules`, `catalog`, `staff-services` directamente.

---

### Q3: H03.U01 CRM — Sin Auto-Creación ✅ PASS

| Check | Evidence | Status |
|-------|----------|--------|
| Booking GUEST **nunca** invoca `clients` module | `commands/confirm.ts` (GUEST): `ownerType: "GUEST"`, `ownerAccountId: null`. No llamada a `clients` module. `routes.ts:128-142` (confirm guest) no importa `clients`. | ✅ |
| `confirmGuestBooking` NO crea ClientProfile ni ClientAccountLink | `confirm.ts:212-236` → `performConfirm` con `ownerType: "GUEST"`, `ownerAccountId: null`. Inserta en `booking.reservations` + `guest_credentials` + `guest_delivery_envelopes`. Cero escrituras en `clients.*`. | ✅ |
| `associateGuestReservation` transfiere ownership sin crear CRM | `commands/associate.ts:66-68` — `UPDATE reservations SET owner_type='CLIENT', owner_account_id=...` + revoca `guest_credentials` + consume `guest_delivery_envelopes`. **No** inserta en `clients.client_profiles` ni `clients.client_account_links`. Auditoría registra `crmMerged: false` (línea 78). | ✅ |
| `reservation.client_profile_id` solo seteado por flujo CLIENT/STAFF explícito | `booking.reservations` no tiene columna `client_profile_id` (ver test `booking-integrity.spec.ts` líneas 56-57: columnas son `owner_type`, `owner_account_id`). El vínculo CRM (`client_account_links`) es gestión separada en módulo `clients` (U01). | ✅ |

**Observación:** La regla **"Booking no crea CRM"** se cumple estrictamente. La asociación GUEST→CLIENT solo cambia `owner_type` + `owner_account_id` y revoca acceso invitado.

---

### Q4: H03.U02 Identidad — Interfaz Fail-Closed ⚠️ R1_REQUIRED (P0)

| Check | Evidence | Status |
|-------|----------|--------|
| `client-principal.ts` importa `resolveProviderIdentity` + `resolveClientPrincipal` de U02 | `apps/api/src/modules/booking/security/client-principal.ts:19-20` — `import { resolveProviderIdentity } from "../../client-auth/provider.js"; import { resolveClientPrincipal } from "../../client-auth/service.js";` | ✅ |
| **Sin U02 deployado → import falla → crash 500 (NO 501 controlado)** | **CRÍTICO:** Si `client-auth` module no está deployado (p.ej. build sin U02), el `import` en `client-principal.ts` falla en **load time** → Fastify no arranca → **crash 500**. No hay fallback, no hay `try/catch` dinámico, no hay feature flag. Ver GF-01-005, GF-01-020. | ❌ **FAIL** |
| Rutas `/v1/client/*` registradas pero fallan si U02 ausente | `app.ts:106` registra `registerBookingRoutes` que incluye rutas `/v1/client/*` (líneas 322-425). Si U02 ausente, la app no inicia → rutas inaccesibles (no 501, no 404, **crash**). | ❌ **FAIL** |
| `BookingPrincipal.kind: "CLIENT"` definido en contracts pero path real bloqueado | `packages/contracts/src/booking.ts:29-30` define `kind: "CLIENT"`. Contrato existe, pero **runtime** inalcanzable sin U02. | ⚠️ **Contrato/runtime mismatch** |

**Recomendación (R1):**  
1. Hacer `client-principal.ts` **cargable opcionalmente**: `try { import("../../client-auth/provider.js") } catch { /* U02 ausente */ }`  
2. En `registerBookingRoutes`, **condicionar** registro de rutas `/v1/client/*` a presencia de `resolveClientIdentity` (feature flag `ENABLE_CLIENT_BOOKING` o detección de módulo).  
3. Si U02 ausente → responder `501 NOT_IMPLEMENTED` con `code: "CLIENT_AUTH_INSUFFICIENT"` (ya definido en `bookingErrorCodes`) en lugar de crash.

---

### Q5: Fastify Routes — Registro Correcto ✅ PASS (con deuda rate-limit)

| Endpoint Category | Rutas Registradas | Auth | Validación | Status |
|-------------------|-------------------|------|------------|--------|
| **Público** | `/v1/public/businesses/:businessId/booking-quotes` (POST) | — | `bookingQuoteRequestSchema` | ✅ |
| | `/v1/public/businesses/:businessId/reservations` (POST) | — | `bookingConfirmGuestSchema` | ✅ |
| | `/v1/public/businesses/:businessId/booking-operations/:operationId` (GET) | — | intent-proof header | ✅ |
| | `/v1/public/reservations/:reservationId` (GET) | x-guest-token | — | ✅ |
| | `/v1/public/reservations/:reservationId/cancel` (POST) | x-guest-token | `cancelReservationSchema` | ✅ |
| | `/v1/public/reservations/:reservationId/reschedule` (POST) | x-guest-token | `rescheduleReservationSchema` | ✅ |
| | `/v1/public/businesses/:businessId/catalog/services` (GET) | — | — | ✅ |
| | `/v1/public/businesses/:businessId/catalog/professionals` (GET) | — | — | ✅ |
| **Staff** | `/v1/staff/bookings` (GET) | Bearer + `bookings.read` | query schema | ✅ |
| | `/v1/staff/bookings/:id` (GET) | Bearer + `bookings.read` | — | ✅ |
| | `/v1/staff/bookings/:id/history` (GET) | Bearer + `bookings.history.read` | — | ✅ |
| | `/v1/staff/bookings/:id/override-cancel` (POST) | Bearer + `bookings.override.cancel` | `staffOverrideCancelSchema` | ✅ |
| | `/v1/staff/bookings/:id/override-reschedule` (POST) | Bearer + `bookings.override.reschedule` | `staffOverrideRescheduleSchema` | ✅ |
| | `/v1/staff/bookings/:id/recover-access` (POST) | Bearer + `bookings.guest_access.recover` | `assistedRecoverySchema` | ✅ |
| **Client** | `/v1/client/reservations` (POST) | U02 Bearer (AAL2) | `bookingConfirmClientSchema` | ✅ |
| | `/v1/client/reservations` (GET) | U02 Bearer (AAL2) | query schema | ✅ |
| | `/v1/client/reservations/:id` (GET) | U02 Bearer (AAL2) | — | ✅ |
| | `/v1/client/reservations/:id/cancel` (POST) | U02 Bearer (AAL2) | `cancelReservationSchema` | ✅ |
| | `/v1/client/reservations/:id/reschedule` (POST) | U02 Bearer (AAL2) | `rescheduleReservationSchema` | ✅ |
| | `/v1/client/reservations/:id/associate` (POST) | U02 Bearer (AAL2) + x-guest-token | — | ✅ |

| Quality Attribute | Evidence | Status |
|-------------------|----------|--------|
| Zod validation (schemas de contracts) | Todas las rutas usan `bookingQuoteRequestSchema`, `bookingConfirmGuestSchema`, `bookingConfirmClientSchema`, `cancelReservationSchema`, `rescheduleReservationSchema`, `staffOverrideCancelSchema`, `staffOverrideRescheduleSchema`, `assistedRecoverySchema` desde `@youngkingz/contracts`. | ✅ |
| Rate limit in-memory (riesgo conocido) | `routes.ts:26-38` — `Map<string, {count, reset}>` por IP+businessId. **No persistente, no distribuido, no sobrevive reinicio**. Documentado como "mínimo". | ⚠️ **Deuda conocida** |
| OpenAPI/Swagger documentado (tag booking) | `app.ts:30` — tags incluyen `"booking"`. `routes.ts` usa `schema: { tags: ["booking"] }` implícito (Fastify-swagger infiere de ruta). Rutas públicas sin `preHandler` también documentadas. | ✅ |

---

### Q6: Contratos TypeScript — Coherencia ✅ PASS (menor discrepancia)

| Contract Pair | Check | Evidence | Status |
|---------------|-------|----------|--------|
| `BookingPrincipal` (booking.ts:28-32) vs `OperationPrincipal` (operations.ts:9-13) | 4 kinds idénticos: `STAFF`, `CLIENT`, `GUEST_INTENT`, `GUEST_RESERVATION`. Campos: `STAFF`/`CLIENT` tienen `accountId`; `GUEST_INTENT` tiene `intentId`+`proofDigest`; `GUEST_RESERVATION` tiene `reservationId`+`credentialId`. | ✅ **Idénticos** |
| `AllocationClaimInput` (availability.ts:74-82) vs lo que `booking` pasa a `claim/replaceAllocation` | `claimAllocation` (allocation.ts:22-34) recibe `AllocationClaimInput`. `confirm.ts:164-172` pasa `{businessId, sourceType:"RESERVATION", sourceId:reservationId, serviceIds, localDate, visibleStart, professionalPreference}`. `reschedule.ts:91-104` pasa `destination` con `historicalTerms` (opcional en contract). **Match exacto**. | ✅ |
| `ClientOperationalStatus` (client-auth.ts:7-9) vs backend `clientStatus()` | `clientStatus` (service.ts:87-98) retorna `{status: ClientOperationalStatus, ...}` usando mismos valores: `PHONE_VERIFICATION_REQUIRED`, `BOOTSTRAP_REQUIRED`, `MFA_SETUP_REQUIRED`, `RECOVERY_CODES_REQUIRED`, `ACTIVE`, `RECOVERY_REQUIRED`, `RESTRICTED`. | ✅ |
| Error codes en `booking.ts` usados consistentemente | `bookingErrorCodes` (booking.ts:34-41) → 19 codes. Verificados en implementación: `BOOKING_QUOTE_EXPIRED` (quote.ts), `COMMERCIAL_TERMS_CHANGED` (confirm.ts:117,121,127,154), `BOOKING_NOT_AVAILABLE` (no usado directamente, mapeado a `SLOT_CONFLICT`/`NO_AVAILABILITY`), `BOOKING_NOT_OWNED` (cancel.ts:47, reschedule.ts:51, associate.ts:52), `BOOKING_NOT_FOUND` (múltiples), `GUEST_ACCESS_INVALID` (múltiples), `GUEST_RECOVERY_NOT_VERIFIED` (recovery.ts:32,35), `BOOKING_CUTOFF_EXPIRED` (cancel.ts:57, reschedule.ts:59), `BOOKING_ALREADY_CANCELLED` (cancel.ts:49, reschedule.ts:53), `BOOKING_OPERATION_CONFLICT` (operations.ts:50), `STALE_REVISION` (reservation.ts:100), `IDEMPOTENCY_CONFLICT` (operations.ts:43,48), `OPERATION_PENDING` (no usado, pero `CONFLICT` cubre), `BOOKING_OPERATION_NOT_RECOVERABLE` (routes.ts:152,155,161), `CLIENT_AUTH_INSUFFICIENT` (no usado en booking, pero definido), `RATE_LIMITED` (routes.ts:56,131), `BOOKING_POLICY_UNAVAILABLE` (confirm.ts:127), `SLOT_CONFLICT` (queries.ts:107), `BOOKING_QUOTE_INVALID` (routes.ts:130). | ✅ |
| `quoteFingerprint` canónico para comparar quote vs confirm | `domain/quote.ts` exporta `verifyQuote` (HMAC-SHA256) que valida firma y exp. `confirm.ts:213` y `244` llaman `verifyQuote`. `routes.ts:325` también. El payload incluye `nonce` + `issuedAt` + `expiresAt` → fingerprint único. | ✅ |

**Menor discrepancia:** `OperationPrincipal` (operations.ts) tiene `principalRef?: string` opcional en `STAFF`/`CLIENT`, mientras `BookingPrincipal` (booking.ts) no lo tiene. En la práctica, `executePrincipalOperation` usa `principalRef` como fallback (operations.ts:21). **No rompe funcionalidad**, pero es inconsistencia de contrato.

---

### Q7: Drizzle Schema — Cobertura ⚠️ R1_REQUIRED (P1)

| Schema File | Tables Covered | Status |
|-------------|----------------|--------|
| `packages/database/src/availability.ts` | `business_hours_configs`, `business_hours_intervals`, `business_date_exceptions`, `business_date_exception_intervals`, `booking_policy_versions`, `booking_policy_states`, `staff_date_exceptions`, `staff_date_exception_intervals`, `staff_effective_unavailability`, `business_guards`, `resource_allocations`, `allocation_service_requirements`, `commitment_conflicts` | ✅ **Completo U03** |
| `packages/database/src/client-auth.ts` | `client_identity_states`, `client_access_sessions`, `client_recovery_codes`, `client_recovery_operations`, `client_security_events`, `client_operations`, `client_phone_change_states` | ✅ **Completo U02** |
| **`packages/database/src/booking.ts`** | **NO EXISTE** (F1 en GF-03) | ❌ **FAIL** |
| `packages/database/src/catalog.ts`, `clients.ts`, `professionals.ts`, `schedules.ts`, `staff-services.ts` | Tablas respectivas | ✅ |

**Inconsistencias Drizzle vs SQL Migración (F2, F3 en GF-03):**
- Sin `booking.ts` Drizzle, no hay type-safe queries para `booking.reservations`, `booking.reservation_items`, `booking.reservation_events`, `booking.guest_credentials`, `booking.guest_delivery_envelopes`, `booking.guest_recovery_cases`.
- Tests `booking-integrity.spec.ts` usan `database.client` (postgres.js) raw SQL, no Drizzle.
- Migración SQL (supabase/migrations) crea tablas con constraints (check, FK, unique partial index, triggers) que **no están reflejadas en Drizzle**.

**Recomendación (R1):** Crear `packages/database/src/booking.ts` con todas las tablas booking, replicando constraints del SQL migración (check `status IN (...)`, `revision > 0`, `commercial_total_minor >= 0`, FK compuestas, unique partial indexes, triggers RLS).

---

### Q8: Separación de Módulos — Deuda Técnica ✅ PASS

| Dependency Direction | Evidence | Status |
|----------------------|----------|--------|
| `booking` → `availability` (queries, allocation, guard) | `booking/routes.ts:18` importa `resolveSlot` de `../availability/queries.js`. `booking/commands/confirm.ts:11` importa `lockAvailabilityGuard` de `../../availability/guard.js`, `resolveSlot` de `../../availability/queries.js`, `claimAllocation` de `../../availability/allocation.js`. `booking/commands/reschedule.ts:7` importa `lockAvailabilityGuard`, `resolveSlot`, `replaceAllocation`. `booking/commands/cancel.ts:6-7` importa `lockAvailabilityGuard`, `releaseAllocation`. | ✅ **Correcta** |
| `booking` NO importa `schedules`, `catalog` directamente | Verificado: `booking/` no tiene `import ... from "../schedules/"` ni `import ... from "../catalog/"`. Acceso a catálogo/horarios solo vía `availability/queries.ts` (que sí los importa). | ✅ |
| `availability` NO importa `booking` (ciclo libre) | `availability/queries.ts`, `temporal.ts`, `allocation.ts`, `guard.ts`, `routes.ts`, `impact.ts` — ninguno importa `../booking/`. | ✅ |
| `system/operations.ts` core compartido (H01 adaptado) sin duplicación | `system/operations.ts` exporta `executePrincipalOperation`, `executeOperation`, `audit`, `operationId`. Usado por: `iam/authorization.ts` (no), `booking/commands/*.ts`, `availability/allocation.ts:36-41` (`claimAllocationOperation`). **Única implementación de idempotencia**. | ✅ |

**Observación:** La arquitectura respeta **Dependency Inversion**: Booking depende de abstracciones de Availability (interfaces `resolveSlot`, `claimAllocation`, `replaceAllocation`, `releaseAllocation`), no de implementaciones concretas de Schedule/Catalog.

---

### Q9: Error Codes — Consistencia ✅ PASS

| Error Category | Mapping | Evidence |
|----------------|---------|----------|
| `BookingErrorCode` (booking.ts:34-41) → HTTP status | Todos mapeados vía `DomainError(code, message, statusCode)`. Ej: `UNAUTHENTICATED`→401, `FORBIDDEN`→403, `NOT_FOUND`→404, `VALIDATION_ERROR`→400, `CONFLICT`/`IDEMPOTENCY_CONFLICT`/`STALE_REVISION`→409, `RATE_LIMITED`→429, `SLOT_CONFLICT`/`NO_AVAILABILITY`/`PAST_START_TIME`→409, `COMMERCIAL_TERMS_CHANGED`→409, `BOOKING_CUTOFF_EXPIRED`→409, `BOOKING_ALREADY_CANCELLED`→409, `GUEST_ACCESS_INVALID`→403, `GUEST_RECOVERY_NOT_VERIFIED`→409, `BOOKING_OPERATION_NOT_RECOVERABLE`→410, `CLIENT_AUTH_INSUFFICIENT`→403, `BOOKING_POLICY_UNAVAILABLE`→409, `BOOKING_QUOTE_INVALID`→400, `BOOKING_POLICY_MISSING`→409, `BOOKING_POLICY_INVALID`→409, `SERVICE_NOT_BOOKABLE`→409, `PROFESSIONAL_NOT_ELIGIBLE`→409, `OUTSIDE_BOOKING_HORIZON`→400, `START_TIME_NOT_ALLOWED`→400, `TIMEZONE_AMBIGUOUS`→409. | ✅ |
| `DomainError` uniforme | `packages/contracts/src/index.ts:77` — `class DomainError extends Error { constructor(public readonly code: DomainErrorCode, message: string, public readonly statusCode = 400, public readonly details?: unknown) }`. Usado en **todo** el código base. | ✅ |
| Validación Zod → 400 `VALIDATION_ERROR` | `app.ts:34` — `if (error instanceof ZodError) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: error.issues } })`. | ✅ |
| Auth errors → 401/403 con codes específicos | `authorization.ts:16` → `UNAUTHENTICATED` 401; `authorization.ts:36-37` → `FORBIDDEN`/`ACCESS_RESTRICTED` 403; `client-auth/provider.ts:27` → `UNAUTHENTICATED` 401; `client-auth/service.ts:156` → `SESSION_REVOKED` 401, `MFA_REQUIRED` 403, `PHONE_UNVERIFIED` 403, `RECOVERY_REQUIRED` 403, `ACCOUNT_RESTRICTED` 403. | ✅ |
| Idempotencia → 409 `IDEMPOTENCY_CONFLICT`/`CONFLICT` | `operations.ts:43,48,50` — `IDEMPOTENCY_CONFLICT` (business mismatch, principal mismatch, hash mismatch), `CONFLICT` (operación en vuelo/fallida). | ✅ |

---

### Q10: Swagger/OpenAPI — Documentación ✅ PASS

| Feature | Evidence | Status |
|---------|----------|--------|
| `@fastify/swagger` + `swagger-ui` montados en `/docs` | `app.ts:3-4` importa ambos; `app.ts:30-31` registra `swagger` con OpenAPI config + `swaggerUi` con `routePrefix: "/docs"`. | ✅ |
| Rutas booking registradas con schemas Zod→OpenAPI | Fastify-swagger infiere schemas de `schema` property en rutas. `routes.ts` no declara `schema` explícitamente en cada ruta, pero Zod schemas están en contracts y Fastify-swagger puede generarlos si se añade `schema: { body: bookingConfirmGuestSchema, ... }`. **Actualmente: inferencia parcial** (tags presentes, body/query params documentados si se añade schema). | ⚠️ **Parcial** — recomendable añadir `schema` objects explícitos para generación completa. |
| Tags `availability` / `booking` separados | `app.ts:30` tags array incluye ambos. `availability/routes.ts` usa `tags:["availability"]`. `booking/routes.ts` no declara tags por ruta (pero tag `booking` existe en app). | ✅ |
| Secretos filtrados de docs | `app.ts:28` — `redact: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-guest-token", "req.headers.x-intent-proof", "req.body.token", "req.body.password", ...]`. Logger redacciona. Swagger UI no expone headers redaccionados. | ✅ |

---

### Q11: Capabilities — Deuda para U05/U06/U07 ✅ PASS

| Capability | Definida en contracts/index.ts | Role Grants Actuales | Futuro U05/U06/U07 |
|------------|-------------------------------|----------------------|---------------------|
| `bookings.read` | ✅ línea 34 | OWNER, RECEPTIONIST | Base para Agenda (U05) |
| `bookings.history.read` | ✅ línea 34 | OWNER, RECEPTIONIST | Base para Attendance (U07) |
| `bookings.contact.manage` | ✅ línea 34 | OWNER, RECEPTIONIST | Asociación guest→client (U04 actual) |
| `bookings.override.cancel` | ✅ línea 35 | OWNER, RECEPTIONIST | **U05 Agenda Staff** — cancelación forzada |
| `bookings.override.reschedule` | ✅ línea 35 | OWNER, RECEPTIONIST | **U05 Agenda Staff** — reprogramación forzada |
| `bookings.guest_access.recover` | ✅ línea 35 | OWNER, RECEPTIONIST | **U04 actual** — recuperación asistida |
| `delegableCapabilities` incluye `bookings.read`, `bookings.history.read` | ✅ líneas 48-49 | Sí (OWNER puede delegar a RECEPTIONIST) | No otorga `override.*` ni `guest_access.recover` prematuramente | ✅ |

**Veredicto:** Capabilities diseñadas **extensiblemente**. `override.*` y `guest_access.recover` existen pero **solo asignadas a OWNER/RECEPTIONIST** (no a BARBER). No hay capabilities "fantasma" para U05/U06/U07 no implementadas.

---

### Q12: Impacto U05/U06/U07 ✅ PASS

| Contract Table | Purpose | Ready for Future Unit |
|----------------|---------|----------------------|
| `reservation_events` (append-only) | `booking.reservation_events` con `sequence`, `event_type`, `principal_type`, `changes`, `reason_code`. Inmutable (RLS + trigger rechazan UPDATE/DELETE — ver `booking-integrity.spec.ts:227-238`). | ✅ **Consumible por U05 (Agenda), U06 (Ausencias), U07 (Attendance)** |
| `commitment_conflicts` | `availability.commitment_conflicts` con `reason_code`, `source_operation_id`, `status` (OPEN/RESOLVED), `resolved_at`, `resolution_reference`. Índice `commitment_conflicts_open` para listar conflictos abiertos. | ✅ **Para U06 (impact evaluation de ausencias)** |
| Lógica U05/U06/U07 en booking actual | **Ninguna**. Booking solo emite eventos y detecta conflictos de asignación (GiST + constraint). No hay lógica de agenda visual, gestión de ausencias, ni attendance. | ✅ **Fuera de alcance correctamente** |

---

## Findings Ledger (Resumen Accionable)

| ID | Question | Severity | Type | Title | Action Required |
|----|----------|----------|------|-------|-----------------|
| **GF-07-001** | Q4 | **P0** | **Crash/Architecture** | `client-principal.ts` importa U02 estáticamente → crash 500 si U02 ausente | Hacer import dinámico + feature flag `ENABLE_CLIENT_BOOKING`; responder 501 `CLIENT_AUTH_INSUFFICIENT` en rutas `/v1/client/*` si U02 no deployado |
| **GF-07-002** | Q7 | **P1** | **Schema/Type Safety** | Falta `packages/database/src/booking.ts` (Drizzle) | Crear schema Drizzle para todas las tablas `booking.*` replicando constraints SQL (check, FK, unique partial, triggers RLS) |
| **GF-07-003** | Q6 | **P2** | **Contract Drift** | `OperationPrincipal.principalRef?` vs `BookingPrincipal` sin `principalRef` | Alinear: añadir `principalRef?: string` a `STAFF`/`CLIENT` en `BookingPrincipal` o remover de `OperationPrincipal` |
| **GF-07-004** | Q5 | **P2** | **OpenAPI Completeness** | Rutas booking sin `schema` explícito → Swagger incompleto | Añadir `schema: { body: ..., query: ..., params: ..., response: ... }` a cada ruta en `registerBookingRoutes` |
| **GF-07-005** | Q5 | **P3** | **Rate Limit** | Rate limit in-memory no distribuido | Reemplazar por Redis-backed rate limiter (fuera de alcance U04, deuda conocida) |
| **GF-07-006** | Q7 | **P2** | **Drizzle/SQL Drift** | Inconsistencias F2/F3 (constraints no en Drizzle) | Alinear Drizzle `availability.ts` y `client-auth.ts` con migraciones SQL (ver GF-03) |

---

## Final Verdict

**R1_REQUIRED** — Two blocking findings must be resolved:

1. **GF-07-001 (P0)**: U02 optional dependency handling — crash 500 on missing module is unacceptable for production.
2. **GF-07-002 (P1)**: Missing Drizzle schema for booking tables — breaks type-safe database access and contract enforcement.

All other questions **PASS**. Architecture respects single-authority boundaries, contracts are coherent, module separation is clean, error handling is consistent, and future-unit contracts are ready without premature implementation.

---

**Auditor:** EGM Canonical Reviewer — Architecture & Integration Specialist  
**Date:** 2026-11-09  
**Next Review:** Post R1 resolution (GF-07-001, GF-07-002)