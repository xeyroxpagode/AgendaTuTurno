# REPORTE DE AUDITORIA EGM — Reviewer GF-U05-02 (Authority & Identity)

**Workspace:** `C:\Users\thega\Desktop\YoungKingZ-U03-Implementation`
**HEAD:** `35aab9e` (rama `feature/h03-u03-implementation`)
**Reviewer ID:** GF-U05-02
**Session ID:** GF-U05-02-2026-11-11-H03-U05
**Modelo usado:** Nemotron 3.5 Super VL 120B A12B (nvidia)
**Modo:** READ-ONLY estricto (investigación y reporte solo, sin modificaciones)
**Unidad auditada:** H03.U05 "Agenda Staff" (derivada de H03.U04 booking + U03/U02)

---

## 0. Resumen ejecutivo

La autoridad de Agenda Staff se implementa en el backend con un modelo de **capabilities por rol** (`roleCapabilities` en `packages/contracts/src/index.ts:79-83`) verificadas por ruta (`requireCapability`) en `apps/api/src/modules/booking/routes.ts`. El actor se resuelve en `apps/api/src/modules/iam/authorization.ts:25` y las capabilities se componen de `roleCapabilities[rol] + capability_grants` vigentes (`authorization.ts:73-74`). El aislamiento es estrictamente por `business_id` en cada consulta SQL y por cuenta de propietario (`owner_account_id`) para el principal CLIENT.

**Hallazgo clave:** NO existe ninguna ruta, página frontend ni capability definida para "Agenda Staff" como operación de gestión de agenda (crear/editar/bloquear horarios del staff). Las capabilities de booking existentes son de lectura (`bookings.read`, `bookings.history.read`) y override de reserva (`bookings.override.cancel`, `bookings.override.reschedule`, `bookings.guest_access.recover`). Ninguna de las tres roles (OWNER, RECEPTIONIST, BARBER) posee estas capabilities por defecto (ver matriz).

**Riesgo P0:** Las capabilities `bookings.override.cancel` / `bookings.override.reschedule` no están asignadas a ningún rol por defecto y no aparecen como `delegableCapabilities`. Sin un `capability_grant` explícito, ninguna ruta STAFF de override es invocable (fail-closed correcto), pero tampoco hay mecanismo documentado para otorgarlas. Riesgo de "operaciones staff imposibles de autorizar" y de otorgamiento ad-hoc fuera del modelo de roles.

---

## 1. Matriz Actor × Operación × Alcance

### 1.1 Actores definidos (Backend)

| Actor | Tipo principal | Origen | Dónde se resuelve |
|-------|---------------|--------|-------------------|
| STAFF | `{kind:"STAFF", businessId, staffMemberId, accountId}` | JWT Bearer + `iam.user_accounts` + `team.staff_members` | `authorization.ts:25-77` |
| CLIENT | `{kind:"CLIENT", businessId, accountId, authSessionId}` | Sesión U02 (AAL2) | `routes.ts:327` (`resolveClientIdentity`) |
| GUEST_INTENT | `{kind:"GUEST_INTENT", businessId, intentId, proofDigest}` | Reserva pública sin cuenta | `confirm.ts:222` |
| GUEST_RESERVATION | `{kind:"GUEST_RESERVATION", businessId, reservationId, credentialId}` | Credencial de invitado activa | `routes.ts:198,221` |

### 1.2 Operaciones de Agenda Staff / Booking y quién las ejecuta

| Operación | Ruta | Capability requerida | Actor principal | Alcance de datos | Backend (archivo:línea) |
|-----------|------|----------------------|-----------------|------------------|-------------------------|
| Listar reservas del business | `GET /v1/staff/bookings` | `bookings.read` | STAFF | `business_id = a.businessId` (TODO el business) | `routes.ts:264-269` |
| Detalle de reserva | `GET /v1/staff/bookings/:id` | `bookings.read` | STAFF | `business_id = a.businessId AND id=:id` | `routes.ts:271-279` |
| Historial de reserva | `GET /v1/staff/bookings/:id/history` | `bookings.history.read` | STAFF | `business_id = a.businessId AND reservation_id=:id` | `routes.ts:281-285` |
| Override cancel (staff) | `POST /v1/staff/bookings/:id/override-cancel` | `bookings.override.cancel` | STAFF (`bypassCutoff: true`) | `business_id = a.businessId` + `staffExceptionCancel` | `routes.ts:288-294` |
| Override reschedule (staff) | `POST /v1/staff/bookings/:id/override-reschedule` | `bookings.override.reschedule` | STAFF (`bypassCutoff: true`, `allowStaffOverride: true`) | `business_id = a.businessId` + `staffExceptionReschedule` | `routes.ts:296-302` |
| Recuperación acceso invitado | `POST /v1/staff/bookings/:id/recover-access` | `bookings.guest_access.recover` | STAFF (`requestingStaffId = a.staffMemberId`) | `business_id = a.businessId` | `routes.ts:305-320` |
| Listar reservas propias CLIENT | `GET /v1/client/reservations` | (ninguna capability STAFF; identidad U02) | CLIENT | `owner_type='CLIENT' AND owner_account_id = client.accountId` | `routes.ts:346-360` |
| Detalle propia reserva CLIENT | `GET /v1/client/reservations/:id` | (ninguna capability STAFF) | CLIENT | `ownedClientReservation(accountId, id)` | `routes.ts:363-370` |
| Cancelar propia CLIENT | `POST /v1/client/reservations/:id/cancel` | (ninguna capability STAFF) | CLIENT (`principal:"CLIENT"`) | `ownedClientReservation` | `routes.ts:373-388` |
| Reprogramar propia CLIENT | `POST /v1/client/reservations/:id/reschedule` | (ninguna capability STAFF) | CLIENT (`principal:"CLIENT"`) | `ownedClientReservation` | `routes.ts:391-407` |
| Asociar invitado→CLIENT | `POST /v1/client/reservations/:id/associate` | (ninguna capability STAFF) | CLIENT + guest token válido | `credential.businessId`, `reservationId=:id` | `routes.ts:410-429` |
| Leer reserva pública (invitado) | `GET /v1/public/reservations/:reservationId` | (ninguna; x-guest-token) | GUEST_RESERVATION | `guest_credentials.token_digest` + `reservations.id=:reservationId` | `routes.ts:170-182` |
| Cancelar/reservar pública (invitado) | `POST /v1/public/reservations/:id/cancel|/reschedule` | (ninguna; x-guest-token) | GUEST_RESERVATION | `credential.reservationId = :reservationId` | `routes.ts:185-228` |

### 1.3 Multi-business

Todas las consultas STAFF filtran por `business_id = a.businessId` donde `a.businessId` proviene del actor autenticado (una sola business por sesión de acceso, `access_sessions.business_id`). No hay consulta que acepte `businessId` desde el cuerpo o query para leer reservas de otro negocio. El parámetro `businessId` en rutas PUBLIC es de solo lectura para cotización/catálogo y no cruza con reservas STAFF. **No se detectó escalamiento horizontal entre businesses en el backend.**

---

## 2. Capabilities reales por rol (no supuestas)

Fuente: `packages/contracts/src/index.ts:79-83` + `authorization.ts:73-74` (grants adicionales por `capability_grants`).

### 2.1 OWNER
`capabilities.filter((capability) => capability !== "iam.security.recover")` → **todas las capabilities excepto `iam.security.recover`**.
Incluye: `bookings.read`, `bookings.history.read`, `bookings.override.cancel`, `bookings.override.reschedule`, `bookings.guest_access.recover`, `bookings.contact.manage`.

### 2.2 RECEPTIONIST
```json
["iam.self.read","iam.self.update","iam.sessions.read","iam.sessions.terminate",
 "iam.contexts.list","iam.contexts.switch","catalog.read","professionals.read",
 "professionals.self.read","professionals.self.update","schedules.read",
 "schedules.self.read","staff-services.read","staff-services.self.read",
 "clients.read","clients.manage","clients.notes.read","clients.notes.manage",
 "clients.links.read","clients.links.manage","availability.read",
 "availability.impacts.read","bookings.read","bookings.history.read"]
```
**No incluye** `bookings.override.cancel`, `bookings.override.reschedule`, `bookings.guest_access.recover`, `bookings.contact.manage`.

### 2.3 BARBER
```json
["iam.self.read","iam.self.update","iam.sessions.read","iam.sessions.terminate",
 "iam.contexts.list","iam.contexts.switch","professionals.self.read",
 "professionals.self.update","schedules.self.read","staff-services.self.read",
 "availability.self.read"]
```
**No incluye ninguna capability de booking** (ni `bookings.read` ni overrides ni recuperación).

### 2.4 Grants adicionales (`capability_grants`)
`authorization.ts:73-74`: `capabilities = [...roleCapabilities[selected.role], ...grants.map(g => g.capability)]`.
Los grants son por `role_assignment_id` (tabla `iam.capability_grants`, `schema.ts:24`), con `scope` (jsonb), `valid_from`, `expires_at`, `revoked_at`. Pueden ampliar capabilities por rol-asignación específica. La semilla de tests (`booking-fixtures.ts`) **no inserta** `role_assignments` ni `capability_grants`, por lo que en tests solo rigen las capabilities por defecto del rol.

### 2.5 Capabilities delegables (`delegableCapabilities`)
`index.ts:40-49`. Incluye `bookings.read`, `bookings.history.read`, `availability.manage`, etc. **No incluye** `bookings.override.cancel`, `bookings.override.reschedule`, `bookings.guest_access.recover`, `bookings.contact.manage`. Esto implica que ni siquiera un OWNER puede delegar (vía grant) estas capabilities de override si el mecanismo de grants se limita a `delegableCapabilities` — aunque el código de `authorization.ts` no filtra grants por `delegableCapabilities` (acepta cualquier `capability` válida en `capabilitySchema`), por lo que un grant directo en BD sí funcionaría. Hábitos no documentados.

---

## 3. Límites de ownership y multi-business

| Límite | Implementación | Archivo:línea | Eficacia |
|--------|---------------|---------------|----------|
| Aislamiento por business (STAFF) | `where r.business_id = ${a.businessId}` en cada consulta STAFF | `routes.ts:268,274,276,277,284,293,301,311` | Alta (servidor) |
| Aislamiento por cuenta (CLIENT) | `where r.owner_type='CLIENT' and r.owner_account_id = ${client.accountId}` | `routes.ts:356,451` + `cancel.ts:46-48` + `reschedule.ts:50-52` | Alta (servidor) |
| Guest token vinculado a reserva | `guest_credentials.token_digest` + `reservation_id = :reservationId` + `status='ACTIVE'` | `routes.ts:175-178,191-192,213-214` | Alta |
| Staff → solo su business | Actor `businessId` inmutable desde `authenticate` | `authorization.ts:76` | Alta |
| Multi-business en una sesión | Una `access_session` tiene un `business_id` fijo | `schema.ts:25`, `authorization.ts:48-69` | Alta |
| Barrera frontend vs backend | Frontend filtra UI; backend aplica `requireCapability` en cada ruta | `routes.ts:48` + `proxy.ts` | Backend es la única fuente de verdad |

**Nota de ownership:** El override STAFF (`principal:"STAFF"`) no valida que el staff sea el `staff_member_id` de la reserva ni que pertenezca al mismo business que la reserva más allá de `business_id = a.businessId`. Cualquier staff con la capability del override puede cancelar/reprogramar **cualquier** reserva CONFIRMED de su business, sea del barbero X o Y, y aunque el cliente sea el propietario. Esto es por diseño (override = excepción staff), pero carece de restricción "solo reservas del staff propio" o "solo reservas del business donde el staff tiene asignación activa".

---

## 4. Dónde se verifica autoridad en servidor (archivo:línea)

| Punto de verificación | Archivo:línea | Qué verifica |
|----------------------|---------------|--------------|
| Autenticación (Bearer → Actor) | `apps/api/src/modules/iam/authorization.ts:25-77` | Token, cuenta/personal/staff activos, sesión no revocada, role_assignment activo, capabilities (rol + grants) |
| requireCapability por ruta | `apps/api/src/modules/booking/routes.ts:48` + cada ruta STAFF (`265,272,282,289,297,306`) | Capability específica del actor |
| Actor extraído del request | `routes.ts:47` (`actor(request)`) | `request.actor` poblado por `authenticate` preHandler |
| Cutoff bypass (staff override) | `cancel.ts:56` (`!input.bypassCutoff`), `reschedule.ts:58` | Staff salta ventana de cancelación/reprogramación |
| Ownership CLIENT (cancel) | `cancel.ts:46-48` | `owner_type='CLIENT' AND owner_account_id = accountId` |
| Ownership CLIENT (reschedule) | `reschedule.ts:50-52` | idem |
| Existencia de reserva | `cancel.ts:44`, `reschedule.ts:47` | `business_id AND id` (for update) |
| Expected revision (optimistic concurrency) | `cancel.ts:51`, `reschedule.ts:54` | `assertExpectedRevision` |
| RLS de BD (anon/authenticated denegado) | `tests/h03/integration/booking-integrity.spec.ts:214-225` | `booking.*` tablas inaccesibles directamente |
| Append-only reservation_events | `tests/h03/integration/booking-integrity.spec.ts:227-238` | trigger 55000 en UPDATE/DELETE |

**No hay** verificación de authority en capa GraphQL/REST intermedia; Fastify + preHandler `authenticate` + `requireCapability` es el único punto de control para STAFF.

---

## 5. Riesgos de seguridad identificados (con archivo:línea)

### R1 — Capabilities de override no asignadas por defecto a ningún rol (P0)
`bookings.override.cancel`, `bookings.override.reschedule`, `bookings.guest_access.recover` **no aparecen** en `roleCapabilities` de OWNER/RECEPTIONIST/BARBER (`index.ts:81-82`), ni en `delegableCapabilities` (`index.ts:40-49`). Sin un `capability_grant` explícito en BD, las rutas STAFF de override son **invocables por nadie** (fail-closed, correcto), pero no hay ruta/documentación para otorgarlas. Riesgo operativo: funcionalidad de Agenda Staff (override) imposible de usar salvo grant manual en BD.
- **Archivo:** `packages/contracts/src/index.ts:79-83,40-49`
- **Confianza:** Alta

### R2 — Override STAFF sin restricción de staff propietario de la reserva (P1)
`staffExceptionCancel`/`staffExceptionReschedule` pasan `principal:"STAFF"` con `accountId = actorAccountId` pero **no verifican** que `reservation.staff_member_id === actor.staffMemberId` ni que el staff tenga asignación sobre ese profesional. Cualquier staff con la capability puede operar cualquier reserva del business.
- **Archivo:** `staff-exceptions.ts:9-58`, `cancel.ts:12-73`, `reschedule.ts:13-131`
- **Confianza:** Alta (inferencia de código; falta el check)

### R3 — Cambio de staff por parámetros en reschedule (P1)
`reschedule.ts:77` (`effectivePreference`) permite `professionalPreference.SPECIFIC.staffMemberId` cuando `allowStaffOverride: true` (override staff). Un staff con override.reschedule puede reasignar la reserva a cualquier profesional disponible del business, incluyendo a sí mismo o a otro barbero, sin verificar que el destino sea un profesional del mismo business o que el staff actuante tenga relación con él.
- **Archivo:** `reschedule.ts:73-77`, `staff-exceptions.ts:32-52`
- **Confianza:** Alta

### R4 — Diferencia frontend guard vs backend enforcement (P2)
El frontend (`apps/web`) no tiene página de "Agenda Staff" ni rutas `/staff/bookings`. Los guards de frontend (`proxy.ts`, `AppShell.tsx`, pages con `useEffect` capability-check) son **solo de navegación**; no reemplazan la autorización del backend. No hay detectada discrepancia de capabilities entre frontend y backend porque el frontend no expone operaciones de override STAFF. Riesgo residual: si se añade una UI de Agenda Staff, debe replicar las mismas capabilities; el backend ya las exige.
- **Archivo:** `apps/web/src/lib/proxy.ts:27-62`, `apps/web/src/components/AppShell.tsx:19-27`
- **Confianza:** Media

### R5 — Auditoría de override registra capability `bookings.read` (no la capability real) (P2)
En `cancel.ts:71` y `reschedule.ts:124` el `audit_events` se inserta con `capability='bookings.read'` en lugar de `bookings.override.cancel` / `bookings.override.reschedule`. Esto dificulta distinguir operaciones de override de lecturas normales en el log de auditoría.
- **Archivo:** `apps/api/src/modules/booking/commands/cancel.ts:71`, `reschedule.ts:124`
- **Confianza:** Alta (código explícito)

### R6 — Escalamiento vertical vía capability_grants sin tope (P2)
`authorization.ts:74` combina `roleCapabilities[rol]` con **todos** los `capability_grants` vigentes de la `role_assignment_id`, sin validar que el grant pertenezca al mismo business ni que no supere el rol (un BARBER podría recibir un grant de `bookings.override.cancel` y escalar). Los grants tienen `business_id` (`schema.ts:24`) pero `authorization.ts:73` filtra solo por `role_assignment_id`, no por `business_id` del grant vs. business del actor.
- **Archivo:** `authorization.ts:73-74`, `schema.ts:24`
- **Confianza:** Media (requiere grant previo; posible pero no explotado en código actual)

### R7 — Revocación de capabilities no inmediata en sesión activa (P2)
Las capabilities se capturan al autenticar (`authorization.ts:74`) y el actor se reusa por request. Una revocación de `capability_grants.revoked_at` o un cambio de rol no afecta sesiones de acceso ya creadas hasta que se renueven (no hay invalidación de `access_sessions` por cambio de grants; solo por `revokedAt` de sesión y `sessions_valid_after`).
- **Archivo:** `authorization.ts:45-71`, `schema.ts:25`
- **Confianza:** Media

### R8 — Filtración de datos en `operation_attempts.response_body` (P3)
El test `booking-principals.spec.ts:86-103` advierte que `executePrincipalOperation` almacena exactamente lo que el handler devuelve sin filtrado automático. Los handlers reales (`confirm.ts`, etc.) devuelven datos sanitizados, pero un handler futuro podría filtrar `guestToken` o `proof`. No aplica directamente a rutas STAFF actuales (no devuelven secretos).
- **Archivo:** `system/operations.ts:36-67`, `booking-principals.spec.ts:86-103`
- **Confianza:** Media

---

## 6. Operaciones de Agenda Staff que requieren nuevas capabilities

La unidad H03.U05 "Agenda Staff" (gestionar agenda/horarios del staff: crear, editar, bloquear, asignar servicios a horarios) **no tiene capacidades definidas** en el modelo actual. Las capabilities existentes de booking son sobre **reservas**, no sobre **agenda del staff**.

Operaciones que requerirían nuevas capabilities (ninguna existe hoy):

1. **Leer agenda del staff** (horarios ocupados/libres por profesional) → nueva capability tipo `staff-schedules.read` o `availability.staff.read`.
2. **Gestionar bloques/horarios del staff** (abrir/cerrar agenda, excepciones de disponibilidad) → nueva capability tipo `staff-schedules.manage` o `availability.staff.manage`.
3. **Asignar servicios a un staff** (staff-services) → ya existe `staff-services.manage` pero está en `delegableCapabilities` y no asignada por defecto a RECEPTIONIST/BARBER (`index.ts:81-82`).
4. **Ver reservas de un staff específico** (filtro por `staff_member_id`) → requeriría ampliar `bookings.read` con alcance por staff o una capability `bookings.read.staff`.
5. **Override de cancel/reschedule de reserva ajena** → ya existen `bookings.override.cancel` / `bookings.override.reschedule` pero **sin asignación por defecto** (R1).

**Recomendación:** Crear capabilities `staff-schedules.read`, `staff-schedules.manage`, asignarlas a OWNER/RECEPTIONIST (no BARBER por defecto), y asignar `bookings.override.cancel` / `bookings.override.reschedule` a OWNER (y opcionalmente RECEPTIONIST) en `roleCapabilities`.

---

## 7. Nivel de confianza de cada hallazgo

| ID | Hallazgo | Confianza | Base |
|----|----------|-----------|------|
| R1 | Capabilities de override no asignadas por defecto | Alta | `index.ts:79-83` lectura directa |
| R2 | Override sin restricción de staff propietario | Alta | `staff-exceptions.ts` + `cancel.ts`/`reschedule.ts` lectura directa |
| R3 | Reasignación de staff en override reschedule | Alta | `reschedule.ts:73-77` lectura directa |
| R4 | Frontend guard vs backend | Media | `proxy.ts` + páginas; no hay UI de agenda staff |
| R5 | Auditoría con capability incorrecta | Alta | `cancel.ts:71`, `reschedule.ts:124` lectura directa |
| R6 | Grants sin tope de rol/business | Medio | `authorization.ts:73-74` + `schema.ts:24` |
| R7 | Revocación no inmediata en sesión | Medio | `authorization.ts:45-71` |
| R8 | Filtración en operation_attempts | Medio | `operations.ts:36-67` + test advertencia |

---

## 8. Limitaciones

- Auditoría **estática (lectura de código)**. No se ejecutó el servidor ni se realizaron llamadas HTTP reales contra endpoints.
- No se inspeccionaron migraciones SQL ni políticas RLS de Supabase directamente (solo el esquema Drizzle en `packages/database/src/` y el test que las referencia).
- No existe frontend para "Agenda Staff"; el análisis del frontend se limitó a guards de navegación y páginas existentes.
- Los tests de H03 (`tests/h03/`) son de H03.U04, no de una U05 independiente; no hay tests que cubran una unidad "Agenda Staff" separada.
- No se verificó el contenido de `artifacts.rar` ni documentos de auditoría previos (`.md` en raíz) como parte del alcance de código, salvo consulta de estructura de directorios.
- El entorno ejecuta PowerShell; comandos combinados con `&&` fallaron, pero todos los archivos requeridos fueron leídos directamente.

---

## 9. Conclusión

El modelo de autoridad para reservas (booking) es **solido en el backend**: capabilities por rol verificadas por ruta, aislamiento por business y cuenta, cutoff aplicable, override con bypassCutoff para staff, y RLS de BD. Sin embargo, para la unidad **H03.U05 "Agenda Staff"** no hay capabilities definidas ni operaciones de gestión de agenda implementadas. Las capabilities de override de reserva existen pero **no están asignadas a ningún rol por defecto**, y el override de reschedule permite reasignación de staff sin restricciones de ownership del profesional. Antes de implementar Agenda Staff se deben definir capabilities nuevas (`staff-schedules.read/manage`), asignar las de override, y añadir checks de ownership del staff en override.

Fin del reporte.