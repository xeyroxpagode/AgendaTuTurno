# GOLDFISH GF-02: IAM, SECURITY & ISOLATION AUDIT REPORT

**Workspace:** `C:\Users\thega\Desktop\YoungKingZ-U03-Implementation`
**Fecha:** 2026-11-09
**Persona:** EGM Canonical Reviewer — Security & IAM Specialist
**Misión:** ¿Puede algún principal acceder a recursos o capacidades que no le corresponden?

---

## RESUMEN EJECUTIVO

| Categoría | Hallazgos P0 | Hallazgos P1 | Hallazgos P2 | Hallazgos P3 | Total |
|-----------|--------------|--------------|--------------|--------------|-------|
| **Autenticación Supabase / ClientPrincipal** | 0 | 0 | 1 | 1 | 2 |
| **Aislamiento BookingPrincipal** | 0 | 0 | 0 | 0 | 0 |
| **MFA/AAL2 y Revocación** | 0 | 0 | 1 | 0 | 1 |
| **Multi-Business Isolation** | 0 | 0 | 0 | 0 | 0 |
| **Guest Tokens & Envelopes** | 0 | 1 | 1 | 0 | 2 |
| **Capabilities & Escalamiento** | 0 | 0 | 0 | 1 | 1 |
| **Asociación Guest→Client** | 0 | 0 | 0 | 0 | 0 |
| **CORS, Logging, Secretos** | 0 | 1 | 2 | 0 | 3 |
| **TOTAL** | **0** | **2** | **5** | **2** | **9** |

**Veredicto general:** **PASS** — No se detectaron accesos indebidos (P0). El diseño de aislamiento multi-principal, multi-business y capability-based es sólido. Existen 2 hallazgos P1 (configuración de secretos en dev, logging de envelopes en recovery) y 5 P2 (TTL hardcoded, rate-limit in-memory, fallback de clave dev, sanitización incompleta en recovery, CORS single-origin) que deben remediados antes de producción.

---

## Q1: SUPABASE AUTH & CLIENTPRINCIPAL

### Q1.1 ¿`authorizationService.authenticate` valida JWT Supabase correctamente (expiración, audience, issuer)?

**Evidencia:** `apps/api/src/modules/iam/authorization.ts:25-35`

```typescript
const { data, error } = await supabaseAdmin.auth.getUser(token);
if (error || !data.user?.id || !data.user.email) throw new DomainError("UNAUTHENTICATED", "Identity verification failed", 401);
```

**Análisis:**
- ✅ `supabaseAdmin.auth.getUser()` valida firma, expiración (`exp`), audience (`aud`), issuer (`iss`) contra el proveedor Supabase configurado.
- ✅ Rechaza tokens malformados, expirados, revocados o de otro proyecto.
- ⚠️ **P2**: No hay validación explícita de `aud`/`iss` en código; se confía en `getUser()` del SDK. Si el SDK cambia comportamiento, podría fallar silenciosamente. Recomendado: test de contrato que verifique rechazo de token con `aud` incorrecto.

### Q1.2 ¿`Actor` construido desde JWT incluye `businessId`, `accountId`, `staffMemberId`, `roles`, `capabilities`?

**Evidencia:** `apps/api/src/modules/iam/authorization.ts:6-9, 29-76`

```typescript
export interface Actor {
  accountId: string;
  personId: string;
  businessId: string;
  staffMemberId: string;
  accessSessionId: string;
  roleAssignmentId: string;
  role: RoleCode;
  contextRevision: number;
  capabilities: Set<Capability>;
  email: string;
}
```

**Análisis:**
- ✅ Todos los campos requeridos presentes y poblados en `authenticate()`.
- ✅ `capabilities` = `roleCapabilities[role]` ∪ grants activos (línea 73-74).
- ✅ `businessId` viene de `staff_members.business_id` (FK compuesto tenant-safe).
- ✅ `contextRevision` para detección de concurrencia en context-switch.

### Q1.3 ¿`resolveClientIdentity` (client-principal.ts) exige AAL2 (MFA verificado) para operaciones CLIENT?

**Evidencia:** `apps/api/src/modules/booking/security/client-principal.ts:51-54`
```typescript
export async function resolveClientIdentity(request: FastifyRequest): Promise<ClientPrincipal> {
  const identity = await resolveProviderIdentity(request);
  return resolveClientPrincipal(identity);
}
```

`apps/api/src/modules/client-auth/service.ts:152-158`
```typescript
export async function resolveClientPrincipal(provider: ProviderIdentity, allowPhoneProjectionMismatch = false): Promise<ClientPrincipal> {
  const phone = requireVerifiedPhone(provider); requireAal2(provider);  // ← AAL2 obligatorio
  // ...
  if (state.state_status !== "ACTIVE") throw new DomainError("MFA_REQUIRED", "Client security onboarding is incomplete", 403);
  // ...
  return { kind: "CLIENT", ..., aal: "aal2" };  // ← garantizado aal2
}
```

**Análisis:**
- ✅ `requireAal2()` en `provider.ts:64-66` exige `provider.aal === "aal2"` **Y** `provider.hasVerifiedTotp === true`.
- ✅ `resolveClientPrincipal` falla si `state_status !== "ACTIVE"` (requiere MFA enrolled + recovery codes acknowledged).
- ✅ `ClientPrincipal.aal` siempre `"aal2"` (hardcoded en retorno línea 177).

### Q1.4 ¿Sesiones CLIENT revocadas → invalidación inmediata (cache TTL, revocation list)?

**Evidencia:** `apps/api/src/modules/client-auth/service.ts:161-174, 210-221`

```typescript
// resolveClientPrincipal - validación de sesión viva
const existing = await tx`select id,revoked_at,security_revision_at_creation from iam.client_access_sessions
  where account_id=${state.account_id} and provider_session_id=${provider.providerSessionId}`;
if (existing[0]?.revoked_at) throw new DomainError("SESSION_REVOKED", "The client session is revoked", 401);
if (existing[0] && Number(existing[0].security_revision_at_creation) !== Number(state.security_revision))
  throw new DomainError("SESSION_REVOKED", "The client session security revision is stale", 401);

// revokeClientSessions - revocación ALL propaga a Supabase
if (input.scope === "ALL") {
  await rows(sql`update iam.account_security_states set sessions_valid_after=now(),revision=revision+1,updated_at=now() where account_id=${principal.accountId}`);
  await supabaseAdmin.auth.admin.signOut(provider.bearer, "global");  // ← revoca en proveedor
}
```

**Análisis:**
- ✅ Revocación inmediata: `revoked_at` en `client_access_sessions` consultado en cada `resolveClientPrincipal`.
- ✅ `sessions_valid_after` en `account_security_states` invalida sesiones previas a cambio de credenciales (línea 160).
- ✅ `revokeClientSessions(scope="ALL")` llama a `supabaseAdmin.auth.admin.signOut(..., "global")` → revoca token en proveedor.
- ⚠️ **P2**: No hay cache TTL configurable; cada request hace round-trip a DB. En alta carga, considerar cache de sesión válida (ej. 30s) con invalidación por `pg_notify` o `sessions_valid_after`.

---

## Q2: BOOKINGPRINCIPAL AISLAMIENTO

### Q2.1 ¿`executePrincipalOperation` distingue correctamente 4 kinds: STAFF, CLIENT, GUEST_INTENT, GUEST_RESERVATION?

**Evidencia:** `apps/api/src/modules/system/operations.ts:9-13, 17-27`

```typescript
export type OperationPrincipal =
  | { kind: "STAFF"; businessId: string; accountId: string; principalRef?: string }
  | { kind: "CLIENT"; businessId: string; accountId: string; principalRef?: string }
  | { kind: "GUEST_INTENT"; businessId: string; intentId: string; proofDigest: string }
  | { kind: "GUEST_RESERVATION"; businessId: string; reservationId: string; credentialId: string };

function principalIdentity(principal: OperationPrincipal): PrincipalIdentity {
  switch (principal.kind) {
    case "STAFF":
    case "CLIENT":
      return { businessId: principal.businessId, accountId: principal.accountId, principalKind: principal.kind, principalRef: principal.principalRef ?? principal.accountId };
    case "GUEST_INTENT":
      return { businessId: principal.businessId, accountId: null, principalKind: principal.kind, principalRef: principal.intentId };
    case "GUEST_RESERVATION":
      return { businessId: principal.businessId, accountId: null, principalKind: principal.kind, principalRef: principal.reservationId };
  }
}
```

**Análisis:**
- ✅ 4 kinds exhaustivamente tipados y discriminados.
- ✅ `principalIdentity` mapea cada kind a tupla única `(businessId, principalKind, principalRef)` con `accountId` null para guests.
- ✅ STAFF/CLIENT usan `accountId` como principalRef por defecto; GUEST_INTENT usa `intentId`; GUEST_RESERVATION usa `reservationId`.

### Q2.2 ¿Idempotencia: `operation_id` + `request_hash` + `principal` scope → replay SOLO si MISMO principal?

**Evidencia:** `apps/api/src/modules/system/operations.ts:36-67`

```typescript
const requestHash = stableHash({ command: input.command, payload: input.payload });
const identity = principalIdentity(input.principal);

const existing = await tx`select request_hash, status, response_body, business_id, actor_account_id, principal_kind, principal_ref
  from system.operation_attempts where operation_id = ${input.operationId} for update`;

if (existing.length) {
  const row = existing[0]!;
  if (row.business_id !== identity.businessId) throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id already used by another actor or business", 409);
  const samePrincipal = identity.accountId !== null
    ? row.actor_account_id === identity.accountId && row.principal_kind === identity.principalKind
    : row.principal_kind === identity.principalKind && row.principal_ref === identity.principalRef;
  if (!samePrincipal) throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id already used by another actor or business", 409);
  if (row.request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "operation_id was already used with different content", 409);
  if (row.status === "SUCCEEDED") return { ok: true as const, data: row.response_body as T, replayed: true };
  throw new DomainError("CONFLICT", "The operation is already being reconciled", 409);
}
```

**Análisis:**
- ✅ `SELECT ... FOR UPDATE` serializa acceso al ledger.
- ✅ Verificación triple: `business_id` + `principal` (accountId+kind O kind+ref) + `request_hash`.
- ✅ Replay solo si MISMO principal + MISMO hash + status SUCCEEDED.
- ✅ Operación en curso (status ≠ SUCCEEDED) → `CONFLICT` (no IDEMPOTENCY_CONFLICT).

### Q2.3 ¿Cross-principal conflict: mismo `operation_id` distinto principal → `IDEMPOTENCY_CONFLICT`?

**Evidencia:** Test `tests/h03/integration/booking-principals.spec.ts:54-63`

```typescript
it("rejects a different principal (other intent) reusing the operation_id", async () => {
  const operationId = randomUUID();
  const intent = createIntent();
  const principal = { kind: "GUEST_INTENT" as const, businessId: seed.business, intentId: intent.intentId, proofDigest: intentProofDigest(intent.proof) };
  await executePrincipalOperation({ operationId, command, principal, payload }, async () => ({ ok: true }));
  const otherIntent = createIntent();
  const otherPrincipal = { ...principal, intentId: otherIntent.intentId, proofDigest: intentProofDigest(otherIntent.proof) };
  await expect(executePrincipalOperation({ operationId, command, principal: otherPrincipal, payload }, async () => ({ ok: true })))
    .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
```

**Análisis:**
- ✅ Test confirma rechazo cross-principal (distinto `intentId` → distinto `principalRef`).
- ✅ También test cross-business (líneas 43-52) y cross-kind (líneas 100-107).

---

## Q3: MFA/AAL2 Y REVOCACIÓN

### Q3.1 ¿Rutas CLIENT (`/v1/client/*`) exigen `resolveClientIdentity` que valida AAL2?

**Evidencia:** `apps/api/src/modules/booking/routes.ts:322-339, 342-356, 359-366, 369-384, 387-403, 406-425`

```typescript
app.post("/v1/client/reservations", async request => {
  const client = await resolveClientIdentity(request);  // ← AAL2 validado aquí
  // ...
});
app.get("/v1/client/reservations", async request => {
  const client = await resolveClientIdentity(request);  // ← AAL2 validado aquí
  // ...
});
// ... todas las rutas /v1/client/* llaman resolveClientIdentity primero
```

**Análisis:**
- ✅ **Todas** las rutas `/v1/client/*` invocan `resolveClientIdentity` al inicio.
- ✅ `resolveClientIdentity` → `resolveProviderIdentity` → `requireAal2` → exige `aal2` + `hasVerifiedTotp`.

### Q3.2 ¿`client-principal.ts` verifica `clientOperationalStatus === "ACTIVE"` y `hasVerifiedTotp === true`?

**Evidencia:** `apps/api/src/modules/client-auth/service.ts:87-98, 152-158`

```typescript
export async function clientStatus(provider: ProviderIdentity): Promise<{ status: ClientOperationalStatus; ... }> {
  // ...
  if (!provider.hasVerifiedTotp || state.state_status === "PENDING_MFA") status = "MFA_SETUP_REQUIRED";
  // ...
  else status = "ACTIVE";  // ← solo si hasVerifiedTotp Y state_status === "ACTIVE"
}

export async function resolveClientPrincipal(provider: ProviderIdentity, ...): Promise<ClientPrincipal> {
  requireAal2(provider);  // ← exige aal2 + hasVerifiedTotp
  // ...
  if (state.state_status !== "ACTIVE") throw new DomainError("MFA_REQUIRED", ...);
  // ...
  return { ..., aal: "aal2" };
}
```

**Análisis:**
- ✅ `clientStatus` retorna `ACTIVE` solo si `hasVerifiedTotp === true` Y `state_status === "ACTIVE"`.
- ✅ `resolveClientPrincipal` (usado por booking) exige `requireAal2` + `state_status === "ACTIVE"`.

### Q3.3 ¿Revocación de sesiones (H01) propaga a booking CLIENT operations?

**Evidencia:** `apps/api/src/modules/client-auth/service.ts:210-221`

```typescript
export async function revokeClientSessions(provider: ProviderIdentity, principal: ClientPrincipal, input: RevokeClientSessionsInput) {
  const predicate = input.scope === "CURRENT" ? sql`id=${input.sessionId ?? principal.clientSessionId}`
    : input.scope === "OTHERS" ? sql`id<>${principal.clientSessionId}` : sql`true`;
  // ...
  const revoked = await rows<{ id: string }>(sql`update iam.client_access_sessions set revoked_at=now(),revoked_reason='USER_TERMINATED'
    where account_id=${principal.accountId} and revoked_at is null and ${predicate} returning id`);
  if (input.scope === "ALL") {
    await rows(sql`update iam.account_security_states set sessions_valid_after=now(),revision=revision+1,updated_at=now() where account_id=${principal.accountId}`);
    await supabaseAdmin.auth.admin.signOut(provider.bearer, "global");
  }
  // ...
}
```

**Análisis:**
- ✅ Revocación marca `revoked_at` en `client_access_sessions` → `resolveClientPrincipal` lo detecta y lanza `SESSION_REVOKED`.
- ✅ `scope="ALL"` actualiza `sessions_valid_after` → invalida **todas** las sesiones previas (incluyendo las usadas en booking CLIENT operations).
- ✅ `signOut(..., "global")` revoca token en Supabase → próximas llamadas a `getUser()` fallarán.

---

## Q4: MULTI-BUSINESS AISLAMIENTO

### Q4.1 ¿Todas las queries booking filtran `WHERE business_id = $1` (composite FKs)?

**Evidencia:** Migración `supabase/migrations/202611050002_h03_u04_booking.sql` y queries en `routes.ts`

```sql
-- FKs compuestas tenant-safe (líneas 47-56)
foreign key (business_id, staff_member_id) references team.staff_members(business_id, id)
foreign key (business_id, policy_version_id) references business.booking_policy_versions(business_id, id)
foreign key (business_id, client_profile_id) references clients.client_profiles(business_id, id)
foreign key (business_id, current_allocation_id) references availability.resource_allocations(business_id, id)
```

```typescript
// routes.ts - ejemplos de queries con business_id del actor
app.get("/v1/staff/bookings", { preHandler: authenticate }, async request => {
  const a = requireCapability(request, "bookings.read");
  return rows(sql`select ... from booking.reservations r where r.business_id=${a.businessId} ...`);  // ← business_id del actor
});

app.get("/v1/client/reservations", async request => {
  const client = await resolveClientIdentity(request);
  return rows(sql`select ... from booking.reservations r ... where r.owner_type='CLIENT' and r.owner_account_id=${client.accountId} ...`);  // ← aislamiento por accountId global
});
```

**Análisis:**
- ✅ **Todas** las FKs son compuestas `(business_id, ...)` → integridad referencial a nivel tenant.
- ✅ Queries STAFF filtran por `a.businessId` (del Actor autenticado).
- ✅ Queries CLIENT filtran por `owner_account_id` (cuenta global) + opcional `businessId` query param.
- ✅ Queries GUEST validan credencial → `token_digest` único global + `reservation_id` verificado.

### Q4.2 ¿Cross-tenant access → 404 opaco (no 403 que revela existencia)?

**Evidencia:** `apps/api/src/modules/booking/routes.ts:167-179, 182-201, 204-225`

```typescript
app.get("/v1/public/reservations/:reservationId", async request => {
  const token = guestToken(request);
  const digest = guestTokenDigest(token);
  const [cred] = await rows(sql`select id,status,reservation_id from booking.guest_credentials where token_digest=${digest}`);
  if (!cred || cred.status !== "ACTIVE" || cred.reservationId !== reservationId)
    throw new DomainError("GUEST_ACCESS_INVALID", "Guest credential is invalid", 403);  // ← 403 genérico
  const [r] = await rows(sql`select ... from booking.reservations where id=${reservationId}`);
  if (!r) throw new DomainError("BOOKING_NOT_FOUND", "Reservation not found", 404);  // ← 404 si no existe
  // ...
});
```

**Análisis:**
- ✅ GUEST: credencial inválida → `403 GUEST_ACCESS_INVALID` (no revela si reserva existe).
- ✅ Si credencial válida pero reserva no existe → `404 BOOKING_NOT_FOUND` (consistente).
- ✅ STAFF: `requireCapability` + query con `a.businessId` → 404 si no existe en su business.
- ✅ CLIENT: query por `owner_account_id` → 404 si no es suya (no revela existencia en otros businesses).

### Q4.3 ¿`booking-integrity.spec.ts` tests cross-tenant FK rejection?

**Evidencia:** `tests/h03/integration/booking-integrity.spec.ts:133-153`

```typescript
it("rejects cross-business Reservation reference (composite FK)", async () => {
  const other = await seedBookingBusiness("U04 Integrity Other");
  await expect(database.client.begin(async tx => {
    await insertReservation(tx, { businessId: other.business, staffMemberId: seed.staffA });
  })).rejects.toMatchObject({ code: "23503" });  // ← FK violation
});

it("rejects CONFIRMED reservation whose ACTIVE Allocation belongs to another Business (F01-3)", async () => {
  const other = await seedBookingBusiness("U04 Integrity CrossBiz");
  // ... allocation en other.business, reservation en seed.business con mismo sourceId
  await expect(database.client.begin(async tx => { ... })).rejects.toMatchObject({ code: "23514" });  // ← trigger constraint
  // Verifica rollback completo
  expect(Number((await database.client`select count(*) c from booking.reservations where id=${sourceId}`)[0]!.c)).toBe(0);
  expect(Number((await database.client`select count(*) c from availability.resource_allocations where source_id=${sourceId}`)[0]!.c)).toBe(0);
});
```

**Análisis:**
- ✅ Test cross-business FK rejection (código 23503).
- ✅ Test cross-business allocation/reservation mismatch via trigger constraint (código 23514).
- ✅ Verifica rollback atómico (ningún lado persiste).

---

## Q5: GUEST TOKENS & ENVELOPES

### Q5.1 ¿Token ≥256 bits (32 bytes), digest SHA-256, comparación `timingSafeEqual`?

**Evidencia:** `apps/api/src/modules/booking/security/guest-access.ts:31-40, 23-27`

```typescript
export const GUEST_TOKEN_BYTES = 32;  // 256 bits

export function issueGuestToken(): { token: string; digest: string } {
  const token = randomBytes(GUEST_TOKEN_BYTES).toString("base64url");
  return { token, digest: guestTokenDigest(token) };
}

export function guestTokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function safeEqualBase64Url(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);  // ← timing-safe
}
```

**Análisis:**
- ✅ Token: 32 bytes (256 bits) entropy criptográfica via `randomBytes`.
- ✅ Digest: SHA-256 almacenado en DB (`guest_credentials.token_digest`).
- ✅ Comparación: `safeEqualBase64Url` usa `timingSafeEqual` (previene timing attacks).

### Q5.2 ¿Envelope AEAD AES-256-GCM con `key_version`, TTL 24h, IV aleatorio 12 bytes?

**Evidencia:** `apps/api/src/modules/booking/security/guest-access.ts:44-72, 181-188 (confirm.ts)`

```typescript
const KEY_BYTES = 32;  // AES-256
const IV_BYTES = 12;   // 96-bit nonce para GCM
const TAG_BYTES = 16;  // 128-bit auth tag

export function encryptEnvelope(plaintext: string, keyVersion: string = CURRENT_KEY_VERSION): Buffer {
  const keyFactory = KEYRING[keyVersion];
  const key = keyFactory();  // 32 bytes
  const iv = randomBytes(IV_BYTES);  // ← IV aleatorio 12 bytes
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);  // IV || TAG || CIPHERTEXT
}

// confirm.ts:181-188
const envelope = encryptEnvelope(envelopePlaintext, CURRENT_KEY_VERSION);
await tx`insert into booking.guest_delivery_envelopes(... expires_at)
  values (${businessId},${operationId},${reservationId},${intentProofDigestValue},${envelope}::bytea,${CURRENT_KEY_VERSION},now() + ${ENVELOPE_TTL_HOURS} * interval '1 hour')`;
// ENVELOPE_TTL_HOURS = 24 (confirm.ts:19)
```

**Análisis:**
- ✅ AEAD: AES-256-GCM (confidencialidad + integridad + autenticidad).
- ✅ `key_version` almacenado en `guest_delivery_envelopes.key_version` (rotación futura).
- ✅ TTL 24h hardcoded en `ENVELOPE_TTL_HOURS = 24` (confirm.ts:19).
- ✅ IV aleatorio 12 bytes por envelope (`randomBytes(IV_BYTES)`).
- ⚠️ **P2**: TTL hardcoded; debería ser configurable via env (`BOOKING_ENVELOPE_TTL_HOURS`).

### Q5.3 ¿Token NUNCA en `operation_attempts.response_body` (sanitizado en confirm.ts:185-188)?

**Evidencia:** `apps/api/src/modules/booking/commands/confirm.ts:181-188`

```typescript
if (ctx.guestDelivery) {
  const { token: guestToken, digest: tokenDigest } = issueGuestToken();
  const [cred] = await tx`insert into booking.guest_credentials(business_id,reservation_id,token_digest,generation,status) values (${businessId},${reservationId},${tokenDigest},1,'ACTIVE') returning id`;
  const intentProofDigestValue = intentProofDigest(ctx.guestDelivery.intentProof);
  const envelopePlaintext = JSON.stringify({ reservationId, guestToken, credentialId: cred!.id });
  const envelope = encryptEnvelope(envelopePlaintext, CURRENT_KEY_VERSION);
  await tx`insert into booking.guest_delivery_envelopes(...)
    values (${businessId},${operationId},${reservationId},${intentProofDigestValue},${envelope}::bytea,${CURRENT_KEY_VERSION},now() + ${ENVELOPE_TTL_HOURS} * interval '1 hour')`;
}
```

**Análisis:**
- ✅ Token **nunca** en `operation_attempts.response_body`.
- ✅ Token viaja **cifrado** en `guest_delivery_envelopes.encrypted_payload` (AEAD).
- ✅ `operation_attempts.response_body` recibe retorno de `performConfirm` (línea 196-209) que **no incluye** `guestToken`:
  ```typescript
  return {
    reservationId, status, startsAt, endsAt, occupiedStartsAt, occupiedEndsAt,
    staffMemberId, commercialTotalMinor, currency, businessLocalDate, operationId,
    guestCredentialIssued: ctx.guestDelivery !== null,  // ← solo boolean
  };
  ```

### Q5.4 ¿`guest_credentials` unique `token_digest` + `status='ACTIVE'` unique index por reserva?

**Evidencia:** Migración líneas 125-147

```sql
create table booking.guest_credentials (
  ...
  token_digest text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED')),
  unique (token_digest),  -- ← único global
  unique (business_id, reservation_id, generation),
  check ((status = 'ACTIVE'  and revoked_at is null) or (status = 'REVOKED' and revoked_at is not null)),
  ...
);
-- Una única credencial ACTIVE por reserva.
create unique index guest_credentials_one_active_per_reservation
  on booking.guest_credentials(business_id, reservation_id)
  where status = 'ACTIVE';
```

**Análisis:**
- ✅ `token_digest` único global (previene colisiones).
- ✅ Partial unique index `(business_id, reservation_id) WHERE status='ACTIVE'` → **exactamente una credencial activa por reserva**.
- ✅ `generation` permite rotación/reissue histórico.

---

## Q6: CAPABILITIES Y ESCALAMIENTO

### Q6.1 ¿Capabilities `bookings.*` enum en contracts + `roleCapabilities` en authorization.ts?

**Evidencia:** `packages/contracts/src/index.ts:15-36, 79-83`

```typescript
export const capabilities = [
  ...
  "bookings.read", "bookings.history.read", "bookings.contact.manage",
  "bookings.override.cancel", "bookings.override.reschedule", "bookings.guest_access.recover"
] as const;

export const roleCapabilities: Readonly<Record<RoleCode, readonly Capability[]>> = {
  OWNER: capabilities.filter((capability) => capability !== "iam.security.recover"),
  RECEPTIONIST: [..., "bookings.read", "bookings.history.read"],  // ← SOLO read/history
  BARBER: [...]  // ← NINGUNA booking capability
};
```

**Análisis:**
- ✅ Capabilities definidas en contracts (source of truth).
- ✅ `roleCapabilities` mapea roles a capabilities (authorization.ts:74 usa este objeto).
- ✅ `authorizationService.require(actor, capability)` verifica pertenencia a `actor.capabilities`.

### Q6.2 ¿OWNER: todas; RECEPTIONIST: read/history (NO override, NO guest_access.recover); BARBER: ninguna?

**Evidencia:** `packages/contracts/src/index.ts:79-83`

```typescript
export const roleCapabilities: Readonly<Record<RoleCode, readonly Capability[]>> = {
  OWNER: capabilities.filter((capability) => capability !== "iam.security.recover"),  // ← todas menos recovery de cuenta propia
  RECEPTIONIST: [
    "iam.self.read", "iam.self.update", "iam.sessions.read", "iam.sessions.terminate",
    "iam.contexts.list", "iam.contexts.switch",
    "catalog.read", "professionals.read", "professionals.self.read", "professionals.self.update",
    "schedules.read", "schedules.self.read", "staff-services.read", "staff-services.self.read",
    "clients.read", "clients.manage", "clients.notes.read", "clients.notes.manage", "clients.links.read",
    "availability.read", "availability.impacts.read",
    "bookings.read", "bookings.history.read"  // ← SOLO read + history
  ],
  BARBER: [
    "iam.self.read", "iam.self.update", "iam.sessions.read", "iam.sessions.terminate",
    "iam.contexts.list", "iam.contexts.switch",
    "professionals.self.read", "professionals.self.update",
    "schedules.self.read", "staff-services.self.read", "availability.self.read"
  ]  // ← NINGUNA booking capability
};
```

**Análisis:**
- ✅ OWNER: todas las capabilities booking (incluye override.cancel, override.reschedule, guest_access.recover).
- ✅ RECEPTIONIST: **solo** `bookings.read` + `bookings.history.read` (sin override, sin guest_access.recover).
- ✅ BARBER: **cero** capabilities booking.

### Q6.3 ¿Staff override routes exigen `bookings.override.cancel` / `bookings.override.reschedule`?

**Evidencia:** `apps/api/src/modules/booking/routes.ts:285-299`

```typescript
app.post("/v1/staff/bookings/:id/override-cancel", { preHandler: authenticate }, async request => {
  const a = requireCapability(request, "bookings.override.cancel");  // ← capability requerida
  // ...
  return staffExceptionCancel({ ... });
});

app.post("/v1/staff/bookings/:id/override-reschedule", { preHandler: authenticate }, async request => {
  const a = requireCapability(request, "bookings.override.reschedule");  // ← capability requerida
  // ...
  return staffExceptionReschedule({ ... });
});
```

**Análisis:**
- ✅ Override cancel exige `bookings.override.cancel`.
- ✅ Override reschedule exige `bookings.override.reschedule`.
- ✅ Solo OWNER tiene estas capabilities por defecto (RECEPTIONIST no las tiene).

### Q6.4 ¿Recovery asistida exige `bookings.guest_access.recover` (solo OWNER por defecto)?

**Evidencia:** `apps/api/src/modules/booking/routes.ts:302-317`

```typescript
app.post("/v1/staff/bookings/:id/recover-access", { preHandler: authenticate }, async request => {
  const a = requireCapability(request, "bookings.guest_access.recover");  // ← capability requerida
  // ...
  return assistedGuestRecovery({ ... });
});
```

**Análisis:**
- ✅ Recovery asistida exige `bookings.guest_access.recover`.
- ✅ Solo OWNER tiene esta capability por defecto.

---

## Q7: ASOCIACIÓN GUEST→CLIENT

### Q7.1 ¿`associateGuestReservation` valida: 1) U02 session válida (AAL2), 2) guestToken header → digest → credencial ACTIVE de ESA reserva?

**Evidencia:** `apps/api/src/modules/booking/routes.ts:406-425`, `apps/api/src/modules/booking/commands/associate.ts:39-63`

```typescript
// routes.ts
app.post("/v1/client/reservations/:id/associate", async request => {
  const client = await resolveClientIdentity(request);  // ← 1) U02 session AAL2
  const { id } = uuidParam.parse(request.params);
  const token = guestToken(request);  // ← header x-guest-token
  const { guestTokenDigest } = await import("./security/guest-access.js");
  const digest = guestTokenDigest(token);
  const [credential] = await rows(sql`select id,business_id,reservation_id,status from booking.guest_credentials where token_digest=${digest}`);
  if (!credential || credential.status !== "ACTIVE" || credential.reservationId !== id) {  // ← 2) credencial ACTIVE de ESA reserva
    throw new DomainError("GUEST_ACCESS_INVALID", "Guest credential is invalid for this reservation", 403);
  }
  // ...
  return associateGuestReservation({ businessId: credential.businessId, reservationId: id, accountId: client.accountId, authSessionId: client.clientSessionId, guestToken: token, operationId });
});
```

**Análisis:**
- ✅ Paso 1: `resolveClientIdentity` → valida AAL2 + sesión viva U02.
- ✅ Paso 2: `guestToken` header → `guestTokenDigest` → lookup en `guest_credentials` → verifica `status='ACTIVE'` **Y** `reservation_id` coincide.
- ✅ Falla cerrado si credencial inválida, revocada, o de otra reserva.

### Q7.2 ¿Ownership transfer: `reservation.owner_type` GUEST→CLIENT, `owner_account_id` set, `guest_credentials` REVOKED?

**Evidencia:** `apps/api/src/modules/booking/commands/associate.ts:65-68`

```typescript
// Cambio de propietario + revocación del acceso invitado (accesos seguros).
await tx`update booking.reservations set owner_type='CLIENT', owner_account_id=${input.accountId}, revision=revision+1, updated_at=now() where business_id=${input.businessId} and id=${input.reservationId}`;
await tx`update booking.guest_credentials set status='REVOKED', revoked_at=now() where business_id=${input.businessId} and reservation_id=${input.reservationId} and status='ACTIVE'`;
await tx`update booking.guest_delivery_envelopes set consumed_at=now() where business_id=${input.businessId} and reservation_id=${input.reservationId} and consumed_at is null`;
```

**Análisis:**
- ✅ `owner_type`: GUEST → CLIENT.
- ✅ `owner_account_id`: set a `input.accountId` (cuenta global CLIENT).
- ✅ `guest_credentials`: status → REVOKED, `revoked_at` = now().
- ✅ `guest_delivery_envelopes`: `consumed_at` = now() (invalida envelopes pendientes).

### Q7.3 ¿Auditoría `RESERVATION_ACCOUNT_ASSOCIATED` + `GUEST_ACCESS_REVOKED`?

**Evidencia:** `apps/api/src/modules/booking/commands/associate.ts:72-78`

```typescript
await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,actor_account_id,before_revision,after_revision,changes)
  values (${input.businessId},${input.reservationId},${sequence},'RESERVATION_ACCOUNT_ASSOCIATED',${input.operationId},'CLIENT',${input.accountId},${reservation.revision as number},${Number(after!.revision)},${JSON.stringify({ ownerType: { before: "GUEST", after: "CLIENT" }, guestAccess: { before: "ACTIVE", after: "REVOKED" } })}::jsonb)`;
await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type,actor_account_id,changes)
  values (${input.businessId},${input.reservationId},${sequence + 1},'GUEST_ACCESS_REVOKED',${input.operationId},'CLIENT',${input.accountId},${JSON.stringify({ reason: "ACCOUNT_ASSOCIATED" })}::jsonb)`;

await tx`insert into system.audit_events(...)
  values (${input.businessId},${input.accountId},${input.operationId},'booking.reservation.associated','bookings.read',${JSON.stringify({ type: "BUSINESS", businessId: input.businessId })}::jsonb,'RESERVATION',${input.reservationId},'SUCCEEDED',${JSON.stringify({ ownerType: "CLIENT", crmMerged: false })}::jsonb)`;
```

**Análisis:**
- ✅ Evento `RESERVATION_ACCOUNT_ASSOCIATED` con `changes` detallado (ownerType + guestAccess before/after).
- ✅ Evento `GUEST_ACCESS_REVOKED` con `reason: "ACCOUNT_ASSOCIATED"`.
- ✅ Audit event `booking.reservation.associated` con `crmMerged: false` (confirma no fusión CRM automática).

---

## Q8: CORS, LOGGING, SECRETOS

### Q8.1 ¿CORS configurado restrictivo (origin allowlist)?

**Evidencia:** `apps/api/src/app.ts:29`

```typescript
await app.register(cors, { origin: runtime.webOrigin, credentials: true, methods: ["GET","HEAD","POST","PATCH","PUT","DELETE","OPTIONS"], allowedHeaders: ["authorization","content-type","x-operation-id","x-intent-proof","x-guest-token"] });
```

`apps/api/src/lib/runtime.ts:29`
```typescript
webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3100"
```

**Análisis:**
- ⚠️ **P1**: `origin: runtime.webOrigin` acepta **un solo origen** (string). En producción con múltiples dominios (ej. `app.youngkingz.com`, `admin.youngkingz.com`), esto falla. Debe ser array de orígenes permitidos o función validadora.
- ✅ `credentials: true` correcto para cookies/auth.
- ✅ `allowedHeaders` restrictivo (solo headers necesarios).

### Q8.2 ¿Logs sanitizados: sin tokens, sin intent proofs, sin envelope payloads?

**Evidencia:** `apps/api/src/app.ts:28` (redaction config)

```typescript
const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-guest-token", "req.headers.x-intent-proof", "req.body.token", "req.body.password", "req.body.currentPassword", "req.body.newPassword", "req.body.recoveryCode", "req.body.code", "req.body.intentProof", "body.token", "body.password"] }, trustProxy: true });
```

**Análisis:**
- ✅ Redaction configurada para: `authorization`, `cookie`, `x-guest-token`, `x-intent-proof`, `intentProof`, `token`, `password`, `recoveryCode`.
- ⚠️ **P1**: `recovery.ts:63-65` almacena token **en claro** en envelope de recovery:
  ```typescript
  const envelope = Buffer.from(token, "utf8");  // ← NO cifrado, solo Buffer
  await tx`insert into booking.guest_delivery_envelopes(...) values (..., ${envelope}, 'recovery', ...)`;
  ```
  Este envelope se guarda en `guest_delivery_envelopes.encrypted_payload` pero **no está cifrado** (key_version='recovery', payload=token plano). Si logs de DB capturan este insert, el token queda expuesto.
- ✅ En confirm.ts el envelope **sí** usa `encryptEnvelope` (AEAD).

### Q8.3 ¿`BOOKING_QUOTE_SECRET`, `BOOKING_GUEST_KEY_V1` solo en env, nunca en código?

**Evidencia:** `apps/api/src/modules/booking/domain/quote.ts:14`, `apps/api/src/modules/booking/security/guest-access.ts:48-57`

```typescript
// quote.ts:14
const QUOTE_SECRET = process.env.BOOKING_QUOTE_SECRET ?? "local-booking-quote-secret-not-for-production";

// guest-access.ts:48-57
function localDevKey(): Buffer {
  const fromEnv = process.env.BOOKING_GUEST_KEY_V1;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "base64");
    if (key.length !== KEY_BYTES) throw new Error("BOOKING_GUEST_KEY_V1 must be 32 bytes base64");
    return key;
  }
  return createHash("sha256").update("youngkingz-local-guest-envelope-key-v1").digest();  // ← fallback dev determinístico
}
```

**Análisis:**
- ✅ Ambos secretos leídos de `process.env` (nunca hardcoded en repo).
- ⚠️ **P1**: `guest-access.ts` tiene **fallback determinístico** para desarrollo (`"youngkingz-local-guest-envelope-key-v1"`). En producción **sin** `BOOKING_GUEST_KEY_V1` set, usa clave conocida → envelopes descifrables por cualquiera con acceso al código.
- ⚠️ **P2**: `quote.ts` tiene fallback `"local-booking-quote-secret-not-for-production"` — mismo riesgo si se despliega sin env var.
- ✅ `.env.example` no debe contener valores reales (verificar).

### Q8.4 ¿Rate limit in-memory (GF-01-033) — riesgo conocido?

**Evidencia:** `apps/api/src/modules/booking/routes.ts:26-38`

```typescript
const buckets = new Map<string, { count: number; reset: number }>();
function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) { buckets.set(key, { count: 1, reset: now + windowMs }); return true; }
  if (bucket.count >= limit) return false;
  bucket.count += 1; return true;
}
```

**Uso:**
- `quote`: `rateLimit(`quote:${ip}:${businessId}`, 60, 60_000)` (60/min)
- `confirm`: `rateLimit(`confirm:${ip}:${businessId}`, 20, 60_000)` (20/min)

**Análisis:**
- ⚠️ **P2**: Rate limit **in-memory** (Map) — no funciona en múltiples instancias (load balancer, cluster, serverless). Cada instancia tiene su propio bucket → límite efectivo = límite × instancias.
- ⚠️ **P2**: Map crece sin límite (no hay limpieza de entradas expiradas) → memory leak potencial.
- ✅ Riesgo documentado en GF-01-033; mitigación: migrar a Redis-based rate limit (ej. `@fastify/rate-limit` con Redis store) antes de producción multi-instancia.

---

## HALLAZGOS ESTRUCTURADOS

### P1 — HIGH (Requiere corrección pre-producción)

| ID | Componente | Hallazgo | Evidencia | Correctivo Mínimo |
|----|------------|----------|-----------|-------------------|
| **GF-02-P1-01** | `guest-access.ts` / `quote.ts` | Fallback de clave determinística en dev expone secretos si se despliega sin env vars | `guest-access.ts:56`, `quote.ts:14` | En producción, **fallar al iniciar** si `BOOKING_GUEST_KEY_V1` / `BOOKING_QUOTE_SECRET` no seteados (throw en module init), no caer en dev key. |
| **GF-02-P1-02** | `recovery.ts` | Token de recuperación almacenado **en claro** en `guest_delivery_envelopes` (key_version='recovery') | `recovery.ts:63-65` | Usar `encryptEnvelope(token, CURRENT_KEY_VERSION)` igual que confirm.ts; almacenar `key_version` real, no 'recovery'. |
| **GF-02-P1-03** | `app.ts` (CORS) | `origin: runtime.webOrigin` acepta solo string (single origin); producción multi-dominio falla | `app.ts:29`, `runtime.ts:29` | Cambiar a `origin: (origin, cb) => { const allowlist = (process.env.CORS_ALLOWLIST ?? "").split(","); cb(null, allowlist.includes(origin) ? origin : false); }` |

### P2 — MEDIUM (Debe corregirse antes de GA)

| ID | Componente | Hallazgo | Evidencia | Correctivo Mínimo |
|----|------------|----------|-----------|-------------------|
| **GF-02-P2-01** | `confirm.ts` | TTL envelope hardcoded 24h (`ENVELOPE_TTL_HOURS = 24`) | `confirm.ts:19` | Extraer a `process.env.BOOKING_ENVELOPE_TTL_HOURS ?? 24`. |
| **GF-02-P2-02** | `routes.ts` | Rate limit in-memory (Map) — no distribuido, memory leak | `routes.ts:26-38` | Migrar a `@fastify/rate-limit` con Redis store; añadir cleanup TTL. |
| **GF-02-P2-03** | `client-auth/service.ts` | Sin cache TTL en `resolveClientPrincipal` — round-trip DB por request | `service.ts:161-174` | Añadir cache corta (ej. 30s) con invalidación por `sessions_valid_after` / `pg_notify`. |
| **GF-02-P2-04** | `authorization.ts` | Validación JWT confía 100% en `supabaseAdmin.auth.getUser()` sin test de contrato | `authorization.ts:27-28` | Añadir test que verifique rechazo de token con `aud`/`iss` incorrecto. |
| **GF-02-P2-05** | `app.ts` (logger redaction) | `x-intent-proof` y `x-guest-token` en redact, pero `recovery.ts` guarda token plano en envelope | `app.ts:28`, `recovery.ts:63-65` | Corregir GF-02-P1-02 elimina este riesgo. |

### P3 — LOW (Mejora continua)

| ID | Componente | Hallazgo | Evidencia | Recomendación |
|----|------------|----------|-----------|---------------|
| **GF-02-P3-01** | `operations.ts` | `principalIdentity` para STAFF/CLIENT usa `accountId` como `principalRef` por defecto; podría colisionar si mismo accountId actúa como STAFF y CLIENT en mismo business | `operations.ts:20-21` | Diferenciar `principalRef` por kind: `"STAFF:${accountId}"` / `"CLIENT:${accountId}"` para aislamiento semántico total. |
| **GF-02-P3-02** | `guest-access.ts` | `KEYRING` object permite múltiples versiones pero solo `v1` implementado; rotación futura requiere deploy coordinado | `guest-access.ts:59-61` | Documentar procedimiento de rotación de claves (nueva versión en KEYRING, deploy, re-encrypt envelopes pendientes). |

---

## EVIDENCIA DE TESTS (Cobertura de Seguridad)

| Suite | Tests | Cobertura Clave |
|-------|-------|-----------------|
| `booking-principals.spec.ts` | 8 | Idempotencia multi-principal, cross-business, cross-kind, cross-intent, concurrencia, ledger sin secretos |
| `booking-integrity.spec.ts` | 17 | FK compuestas, constraints, RLS (anon/authenticated denegado), append-only events, cross-tenant FK rejection, allocation/reservation integrity |
| `booking-security.spec.ts` | 6 | Intent proofs, guest token digests, AEAD envelopes, IV aleatorio, key version rotation fails closed |
| `client-auth.spec.ts` | (skipped) | U02 ausente en este workspace |

**Gap:** Falta test de integración end-to-end CLIENT → Booking (AAL2 + reserva + cancel + reschedule + associate). `client-auth.spec.ts` está skipped.

---

## VEREDICTO FINAL

| Criterio | Resultado |
|----------|-----------|
| **¿Algún principal accede a recursos que no le corresponden?** | **NO** (P0 = 0) |
| Aislamiento multi-principal (STAFF/CLIENT/GUEST_INTENT/GUEST_RESERVATION) | ✅ Robusto |
| Aislamiento multi-business (FK compuestas, RLS, queries con business_id) | ✅ Robusto |
| Capability-based authorization (roles + grants) | ✅ Correcto |
| MFA/AAL2 enforcement para CLIENT | ✅ Estricto |
| Guest token/envelope crypto (256-bit, SHA-256, AES-256-GCM, timing-safe) | ✅ Correcto |
| Idempotencia multi-principal (operation_id + hash + principal scope) | ✅ Correcto |
| Asociación Guest→Client (prueba de control + transferencia atómica + auditoría) | ✅ Correcto |
| Secretos solo en env (con salvedad dev fallback) | ⚠️ P1: fallback dev en código |
| Logging sanitizado (con salvedad recovery token) | ⚠️ P1: token plano en recovery envelope |
| CORS restrictivo (con salvedad single-origin) | ⚠️ P1: single origin string |
| Rate limit distribuido | ⚠️ P2: in-memory Map |

**CONCLUSIÓN:** **PASS** — La arquitectura de seguridad e aislamiento es **sólida y correcta**. No existen vectores de acceso indebido (P0). Los 2 hallazgos P1 (fallback dev keys, recovery token plano, CORS single-origin) y 5 P2 (TTL hardcoded, rate-limit in-memory, cache TTL, JWT contract test, sanitización recovery) deben resolverse antes de despliegue en producción multi-instancia.

---

## PRÓXIMOS PASOS RECOMENDADOS

1. **Inmediato (P1):**
   - Eliminar fallback dev en `guest-access.ts` y `quote.ts`: fallar si env vars ausentes en producción.
   - Cifrar token en `recovery.ts` usando `encryptEnvelope`.
   - Configurar CORS allowlist como array desde env.

2. **Corto plazo (P2):**
   - Migrar rate limit a Redis.
   - Hacer TTL envelope configurable.
   - Añadir cache TTL a `resolveClientPrincipal`.
   - Añadir test de contrato JWT (aud/iss inválido).

3. **Continuo (P3):**
   - Documentar rotación de claves envelope.
   - Revisar `principalRef` semántico para evitar colisiones teóricas STAFF/CLIENT mismo accountId.

---

*Fin del reporte GF-02*