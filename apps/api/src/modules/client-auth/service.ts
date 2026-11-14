import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DomainError, type ChangeClientPasswordInput, type ClientBootstrapInput, type ClientOperationalStatus, type CompleteClientRecoveryInput, type RevokeClientSessionsInput } from "@youngkingz/contracts";
import { database, runtime, supabaseAdmin } from "../../lib/runtime.js";
import { one, rows, sql } from "../../lib/sql.js";
import { isOtpRecoverySession, isPasswordSession, requireAal2, requireVerifiedPhone, type ProviderIdentity } from "./provider.js";

type IdentityStateRow = {
  account_id: string; person_id: string; account_status: string; security_revision: number;
  state_status: string; verified_phone_e164: string | null; revision: number;
  recovery_codes_version: number; recovery_codes_acknowledged_at: Date | null;
  sessions_valid_after: Date | null; first_name: string; last_name: string | null;
};

export interface ClientPrincipal {
  kind: "CLIENT"; accountId: string; personId: string; authUserId: string;
  providerSessionId: string; clientSessionId: string; securityRevision: number;
  verifiedPhone: string; aal: "aal2";
}

function maskPhone(value: string): string {
  const visible = value.slice(-3);
  return `${value.slice(0, Math.min(3, value.length - 3))}${"•".repeat(Math.max(4, value.length - visible.length - 3))}${visible}`;
}

function phoneHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function codeDigest(code: string, salt: string): Buffer { return scryptSync(code, salt, 32); }
function createRecoveryCode(): string { return `YKZ-${randomBytes(16).toString("base64url")}`; }

async function audit(accountId: string | null, provider: ProviderIdentity, eventType: string, outcome: "SUCCEEDED" | "DENIED" | "FAILED" | "UNKNOWN", operationReference?: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await rows(sql`insert into iam.client_security_events(account_id,auth_user_id,event_type,outcome,operation_reference,metadata)
    values (${accountId},${provider.authUserId},${eventType},${outcome},${operationReference ?? null},${JSON.stringify(metadata)}::jsonb)`);
}

async function identityByAuthUser(authUserId: string): Promise<IdentityStateRow | undefined> {
  return one<IdentityStateRow>(sql`select ua.id account_id,ua.person_id,ua.status::text account_status,ua.security_revision,
      cis.status::text state_status,cis.verified_phone_e164,cis.revision,cis.recovery_codes_version,
      cis.recovery_codes_acknowledged_at,sec.sessions_valid_after,p.first_name,p.last_name
    from iam.user_accounts ua join iam.persons p on p.id=ua.person_id
    join iam.client_identity_states cis on cis.account_id=ua.id
    left join iam.account_security_states sec on sec.account_id=ua.id
    where ua.auth_user_id=${authUserId}`);
}

export async function bootstrapClient(provider: ProviderIdentity, input: ClientBootstrapInput): Promise<{ accountId: string; personId: string; status: "PENDING_MFA"; revision: number }> {
  const phone = requireVerifiedPhone(provider);
  if (!isPasswordSession(provider)) throw new DomainError("FORBIDDEN", "Bootstrap requires a password-authenticated session", 403);
  const result = await database.client.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`client-bootstrap:${provider.authUserId}`},0))`;
    const existing = await tx`select id,person_id,status::text status from iam.user_accounts where auth_user_id=${provider.authUserId} for update` as unknown as { id: string; person_id: string; status: string }[];
    let account = existing[0];
    if (!account) {
      const [person] = await tx`insert into iam.persons(first_name,last_name) values (${input.firstName},${input.lastName ?? null}) returning id` as unknown as { id: string }[];
      const [created] = await tx`insert into iam.user_accounts(person_id,auth_user_id,verified_email,status)
        values (${person!.id},${provider.authUserId},${provider.verifiedEmail},'ACTIVE') returning id,person_id,status::text status` as unknown as { id: string; person_id: string; status: string }[];
      account = created!;
    }
    if (["LOCKED","DISABLED"].includes(account.status)) throw new DomainError("ACCOUNT_RESTRICTED", "The global account is restricted", 403);
    await tx`insert into iam.account_security_states(account_id) values (${account.id}) on conflict(account_id) do nothing`;
    await tx`insert into iam.client_identity_states(account_id,status,verified_phone_e164,phone_verified_at)
      values (${account.id},'PENDING_MFA',${phone},now()) on conflict(account_id) do nothing`;
    const [state] = await tx`select status::text status,revision from iam.client_identity_states where account_id=${account.id}` as unknown as { status: string; revision: number }[];
    if (state!.status === "RESTRICTED") throw new DomainError("ACCOUNT_RESTRICTED", "Client access is restricted", 403);
    await tx`insert into iam.client_security_events(account_id,auth_user_id,event_type,outcome,metadata)
      values (${account.id},${provider.authUserId},'CLIENT_BOOTSTRAP','SUCCEEDED','{}'::jsonb)`;
    return { accountId: account.id, personId: account.person_id, status: "PENDING_MFA" as const, revision: Number(state!.revision) };
  });
  // GoTrue v2.188 local passes an empty account name to the TOTP QR
  // generator for phone-only users. Add an unconfirmed, non-routable alias
  // on the same Auth User only in the loopback emulator. It is never treated
  // as a verified email by YoungKingZ and hosted environments skip this.
  // This is best-effort: failure should not break bootstrap (idempotency for concurrent requests).
  const host = new URL(runtime.supabaseUrl).hostname;
  if (!provider.verifiedEmail && ["127.0.0.1", "localhost", "::1"].includes(host)) {
    const updated = await supabaseAdmin.auth.admin.updateUserById(provider.authUserId, {
      email: `${provider.authUserId}@phone.local.invalid`, email_confirm: false
    });
    if (updated.error) {
      // Log but don't fail - this is local-only cosmetic preparation for TOTP QR
      // Failure typically means email already set or transient Supabase issue
      // The account bootstrap has already succeeded.
    }
  }
  return result;
}

export async function clientStatus(provider: ProviderIdentity): Promise<{ status: ClientOperationalStatus; accountId?: string; revision?: number; aal: "aal1" | "aal2"; hasVerifiedTotp: boolean }> {
  if (!provider.verifiedPhone) return { status: "PHONE_VERIFICATION_REQUIRED", aal: provider.aal, hasVerifiedTotp: provider.hasVerifiedTotp };
  const state = await identityByAuthUser(provider.authUserId);
  if (!state) return { status: "BOOTSTRAP_REQUIRED", aal: provider.aal, hasVerifiedTotp: provider.hasVerifiedTotp };
  let status: ClientOperationalStatus;
  if (["LOCKED","DISABLED"].includes(state.account_status) || state.state_status === "RESTRICTED") status = "RESTRICTED";
  else if (state.state_status === "RECOVERY_REQUIRED") status = "RECOVERY_REQUIRED";
  else if (!provider.hasVerifiedTotp || state.state_status === "PENDING_MFA") status = "MFA_SETUP_REQUIRED";
  else if (!state.recovery_codes_acknowledged_at || state.state_status === "RECOVERY_SETUP_REQUIRED") status = "RECOVERY_CODES_REQUIRED";
  else status = "ACTIVE";
  return { status, accountId: state.account_id, revision: Number(state.revision), aal: provider.aal, hasVerifiedTotp: provider.hasVerifiedTotp };
}

export async function issueRecoveryCodes(provider: ProviderIdentity, expectedRevision: number): Promise<{ batchVersion: number; codes: string[]; revision: number }> {
  requireVerifiedPhone(provider); requireAal2(provider);
  const generated = Array.from({ length: 8 }, () => ({ code: createRecoveryCode(), salt: randomBytes(16).toString("base64url") }));
  const result = await database.client.begin(async (tx) => {
    const accounts = await tx`select ua.id,cis.status::text status,cis.revision,cis.recovery_codes_version
      from iam.user_accounts ua join iam.client_identity_states cis on cis.account_id=ua.id
      where ua.auth_user_id=${provider.authUserId} for update` as unknown as { id: string; status: string; revision: number; recovery_codes_version: number }[];
    const account = accounts[0];
    if (!account) throw new DomainError("FORBIDDEN", "Client bootstrap is required", 403);
    if (Number(account.revision) !== expectedRevision) throw new DomainError("STALE_REVISION", "Client security state changed", 409);
    if (!["PENDING_MFA","RECOVERY_SETUP_REQUIRED","ACTIVE","RECOVERY_REQUIRED"].includes(account.status)) throw new DomainError("ACCOUNT_RESTRICTED", "Recovery codes cannot be issued", 403);
    const version = Number(account.recovery_codes_version) + 1;
    await tx`update iam.client_recovery_codes set revoked_at=now() where account_id=${account.id} and used_at is null and revoked_at is null`;
    for (const entry of generated) {
      const hash = codeDigest(entry.code, entry.salt).toString("base64url");
      await tx`insert into iam.client_recovery_codes(account_id,code_hash,salt,batch_version) values (${account.id},${hash},${entry.salt},${version})`;
    }
    const [updated] = await tx`update iam.client_identity_states set status='RECOVERY_SETUP_REQUIRED',mfa_enrolled_at=coalesce(mfa_enrolled_at,now()),
      recovery_codes_version=${version},recovery_codes_acknowledged_at=null,revision=revision+1,updated_at=now()
      where account_id=${account.id} returning revision` as unknown as { revision: number }[];
    await tx`insert into iam.client_security_events(account_id,auth_user_id,event_type,outcome,metadata)
      values (${account.id},${provider.authUserId},'RECOVERY_CODES_ISSUED','SUCCEEDED',${JSON.stringify({ batchVersion: version, count: 8 })}::jsonb)`;
    return { batchVersion: version, revision: Number(updated!.revision) };
  });
  return { ...result, codes: generated.map((entry) => entry.code) };
}

export async function acknowledgeRecoveryCodes(provider: ProviderIdentity, batchVersion: number, expectedRevision: number): Promise<{ status: "ACTIVE"; accountId: string; revision: number }> {
  const phone = requireVerifiedPhone(provider); requireAal2(provider);
  return database.client.begin(async (tx) => {
    const states = await tx`select ua.id,ua.security_revision,cis.revision,cis.recovery_codes_version,cis.status::text status
      from iam.user_accounts ua join iam.client_identity_states cis on cis.account_id=ua.id
      where ua.auth_user_id=${provider.authUserId} for update` as unknown as { id: string; security_revision: number; revision: number; recovery_codes_version: number; status: string }[];
    const state = states[0];
    if (!state) throw new DomainError("FORBIDDEN", "Client bootstrap is required", 403);
    if (Number(state.revision) !== expectedRevision) throw new DomainError("STALE_REVISION", "Client security state changed", 409);
    if (Number(state.recovery_codes_version) !== batchVersion || state.status !== "RECOVERY_SETUP_REQUIRED") throw new DomainError("CONFLICT", "The recovery code batch is not current", 409);
    const counts = await tx`select count(*)::int count from iam.client_recovery_codes where account_id=${state.id} and batch_version=${batchVersion} and used_at is null and revoked_at is null` as unknown as { count: number }[];
    if (Number(counts[0]?.count) !== 8) throw new DomainError("CONFLICT", "The recovery code batch is incomplete", 409);
    const [updated] = await tx`update iam.client_identity_states set status='ACTIVE',verified_phone_e164=${phone},phone_verified_at=now(),
      mfa_enrolled_at=coalesce(mfa_enrolled_at,now()),recovery_codes_acknowledged_at=now(),revision=revision+1,updated_at=now()
      where account_id=${state.id} returning revision` as unknown as { revision: number }[];
    await tx`insert into iam.client_access_sessions(account_id,provider_session_id,expires_at,security_revision_at_creation)
      values (${state.id},${provider.providerSessionId},${provider.expiresAt.toISOString()}::timestamptz,${state.security_revision})
      on conflict(account_id,provider_session_id) do update set expires_at=greatest(iam.client_access_sessions.expires_at,excluded.expires_at),last_seen_at=now()
      where iam.client_access_sessions.revoked_at is null`;
    await tx`insert into iam.client_security_events(account_id,auth_user_id,event_type,outcome,metadata)
      values (${state.id},${provider.authUserId},'CLIENT_ACTIVATED','SUCCEEDED','{}'::jsonb)`;
    return { status: "ACTIVE" as const, accountId: state.id, revision: Number(updated!.revision) };
  });
}

export async function resolveClientPrincipal(provider: ProviderIdentity, allowPhoneProjectionMismatch = false): Promise<ClientPrincipal> {
  const phone = requireVerifiedPhone(provider); requireAal2(provider);
  const state = await identityByAuthUser(provider.authUserId);
  if (!state) throw new DomainError("FORBIDDEN", "Client activation is required", 403);
  if (["LOCKED","DISABLED"].includes(state.account_status) || state.state_status === "RESTRICTED") throw new DomainError("ACCOUNT_RESTRICTED", "The account is restricted", 403);
  if (state.state_status === "RECOVERY_REQUIRED") throw new DomainError("RECOVERY_REQUIRED", "Account recovery security setup is required", 403);
  if (state.state_status !== "ACTIVE") throw new DomainError("MFA_REQUIRED", "Client security onboarding is incomplete", 403);
  if (!allowPhoneProjectionMismatch && state.verified_phone_e164 !== phone) throw new DomainError("PHONE_UNVERIFIED", "The confirmed phone projection is stale", 403);
  if (state.sessions_valid_after && provider.issuedAt < new Date(state.sessions_valid_after)) throw new DomainError("SESSION_REVOKED", "The session predates the latest security change", 401);
  const session = await database.client.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`client-session:${state.account_id}:${provider.providerSessionId}`},0))`;
    const existing = await tx`select id,revoked_at,security_revision_at_creation from iam.client_access_sessions
      where account_id=${state.account_id} and provider_session_id=${provider.providerSessionId}` as unknown as { id: string; revoked_at: Date | null; security_revision_at_creation: number }[];
    if (existing[0]?.revoked_at) throw new DomainError("SESSION_REVOKED", "The client session is revoked", 401);
    if (existing[0] && Number(existing[0].security_revision_at_creation) !== Number(state.security_revision)) throw new DomainError("SESSION_REVOKED", "The client session security revision is stale", 401);
    if (existing[0]) {
      const [updated] = await tx`update iam.client_access_sessions set last_seen_at=now(),expires_at=greatest(expires_at,${provider.expiresAt.toISOString()}::timestamptz) where id=${existing[0].id} returning id` as unknown as { id: string }[];
      return updated!;
    }
    const [created] = await tx`insert into iam.client_access_sessions(account_id,provider_session_id,expires_at,security_revision_at_creation)
      values (${state.account_id},${provider.providerSessionId},${provider.expiresAt.toISOString()}::timestamptz,${state.security_revision}) returning id` as unknown as { id: string }[];
    return created!;
  });
  return { kind: "CLIENT", accountId: state.account_id, personId: state.person_id, authUserId: provider.authUserId,
    providerSessionId: provider.providerSessionId, clientSessionId: session.id,
    securityRevision: Number(state.security_revision), verifiedPhone: phone, aal: "aal2" };
}

export async function clientMe(principal: ClientPrincipal) {
  const item = await one<{ accountId: string; firstName: string; lastName: string | null; status: "ACTIVE"; createdAt: Date; lastSeenAt: Date; expiresAt: Date }>(sql`
    select ua.id "accountId",p.first_name "firstName",p.last_name "lastName",cis.status::text status,
      cas.created_at "createdAt",cas.last_seen_at "lastSeenAt",cas.expires_at "expiresAt"
    from iam.user_accounts ua join iam.persons p on p.id=ua.person_id
    join iam.client_identity_states cis on cis.account_id=ua.id
    join iam.client_access_sessions cas on cas.id=${principal.clientSessionId}
    where ua.id=${principal.accountId}`);
  if (!item) throw new DomainError("FORBIDDEN", "Client identity is unavailable", 403);
  return { accountId: item.accountId, person: { firstName: item.firstName, lastName: item.lastName }, verifiedPhone: maskPhone(principal.verifiedPhone),
    status: item.status, securityRevision: principal.securityRevision,
    session: { id: principal.clientSessionId, createdAt: item.createdAt, lastSeenAt: item.lastSeenAt, expiresAt: item.expiresAt } };
}

export async function clientSecurity(principal: ClientPrincipal) {
  const state = await one<{ mfaEnrolledAt: Date; recoveryCodesVersion: number; recoveryCodesAcknowledgedAt: Date; revision: number }>(sql`
    select mfa_enrolled_at "mfaEnrolledAt",recovery_codes_version "recoveryCodesVersion",
      recovery_codes_acknowledged_at "recoveryCodesAcknowledgedAt",revision
    from iam.client_identity_states where account_id=${principal.accountId}`);
  return { mfaRequired: true, aal: principal.aal, ...state };
}

export async function listClientSessions(principal: ClientPrincipal) {
  const items = await rows<{ id: string; current: boolean; createdAt: Date; lastSeenAt: Date; expiresAt: Date }>(sql`
    select id,(id=${principal.clientSessionId}) current,created_at "createdAt",last_seen_at "lastSeenAt",expires_at "expiresAt"
    from iam.client_access_sessions where account_id=${principal.accountId} and revoked_at is null and expires_at>now()
    order by case when id=${principal.clientSessionId} then 0 else 1 end,last_seen_at desc`);
  return { items };
}

export async function revokeClientSessions(provider: ProviderIdentity, principal: ClientPrincipal, input: RevokeClientSessionsInput) {
  const predicate = input.scope === "CURRENT" ? sql`id=${input.sessionId ?? principal.clientSessionId}` : input.scope === "OTHERS" ? sql`id<>${principal.clientSessionId}` : sql`true`;
  if (input.sessionId && input.sessionId !== principal.clientSessionId) throw new DomainError("FORBIDDEN", "A session identifier cannot target another account session", 403);
  const revoked = await rows<{ id: string }>(sql`update iam.client_access_sessions set revoked_at=now(),revoked_reason='USER_TERMINATED'
    where account_id=${principal.accountId} and revoked_at is null and ${predicate} returning id`);
  if (input.scope === "ALL") {
    await rows(sql`update iam.account_security_states set sessions_valid_after=now(),revision=revision+1,updated_at=now() where account_id=${principal.accountId}`);
    await supabaseAdmin.auth.admin.signOut(provider.bearer, "global");
  }
  await audit(principal.accountId, provider, "CLIENT_SESSIONS_REVOKED", "SUCCEEDED", undefined, { scope: input.scope, count: revoked.length });
  return { terminated: revoked.length };
}

export async function clientLinks(principal: ClientPrincipal) {
  return rows(sql`select cal.id,cal.business_id "businessId",cal.client_profile_id "clientProfileId",b.display_name "businessName",cal.linked_at "linkedAt",cal.auth_method "authMethod"
    from clients.client_account_links cal join business.businesses b on b.id=cal.business_id
    where cal.account_id=${principal.accountId} and cal.revoked_at is null order by cal.linked_at desc`);
}

export async function startPhoneChange(provider: ProviderIdentity, principal: ClientPrincipal, newPhone: string, expectedRevision: number) {
  const state = await one<{ revision: number }>(sql`select revision from iam.client_identity_states where account_id=${principal.accountId}`);
  if (!state || Number(state.revision) !== expectedRevision) throw new DomainError("STALE_REVISION", "Client identity changed", 409);
  await rows(sql`insert into iam.client_phone_change_states(account_id,expected_identity_revision,requested_phone_hash,expires_at)
    values (${principal.accountId},${expectedRevision},${phoneHash(newPhone)},now()+interval '15 minutes')
    on conflict(account_id) do update set expected_identity_revision=excluded.expected_identity_revision,requested_phone_hash=excluded.requested_phone_hash,
      started_at=now(),expires_at=excluded.expires_at,confirmed_at=null
    where iam.client_phone_change_states.confirmed_at is not null or iam.client_phone_change_states.expires_at<=now()`);
  const pending = await one<{ requestedPhoneHash: string }>(sql`select requested_phone_hash "requestedPhoneHash" from iam.client_phone_change_states where account_id=${principal.accountId} and confirmed_at is null and expires_at>now()`);
  if (pending?.requestedPhoneHash !== phoneHash(newPhone)) throw new DomainError("CONFLICT", "A phone change is already in progress", 409);
  await audit(principal.accountId, provider, "PHONE_CHANGE_STARTED", "SUCCEEDED");
  return { accepted: true, expiresInSeconds: 900 };
}

export async function confirmPhoneChange(provider: ProviderIdentity, principal: ClientPrincipal, expectedRevision: number) {
  const newPhone = requireVerifiedPhone(provider);
  const result = await database.client.begin(async (tx) => {
    const pending = await tx`select expected_identity_revision,requested_phone_hash from iam.client_phone_change_states
      where account_id=${principal.accountId} and confirmed_at is null and expires_at>now() for update` as unknown as { expected_identity_revision: number; requested_phone_hash: string }[];
    const change = pending[0];
    if (!change || Number(change.expected_identity_revision) !== expectedRevision || change.requested_phone_hash !== phoneHash(newPhone)) throw new DomainError("CONFLICT", "No matching verified phone change is pending", 409);
    const updated = await tx`update iam.client_identity_states set verified_phone_e164=${newPhone},phone_verified_at=now(),revision=revision+1,updated_at=now()
      where account_id=${principal.accountId} and revision=${expectedRevision} returning revision` as unknown as { revision: number }[];
    if (!updated[0]) throw new DomainError("STALE_REVISION", "Client identity changed", 409);
    const account = await tx`update iam.user_accounts set security_revision=security_revision+1,credentials_changed_at=now(),updated_at=now()
      where id=${principal.accountId} returning security_revision` as unknown as { security_revision: number }[];
    await tx`update iam.client_access_sessions set revoked_at=now(),revoked_reason='PHONE_CHANGED' where account_id=${principal.accountId} and id<>${principal.clientSessionId} and revoked_at is null`;
    await tx`update iam.client_access_sessions set security_revision_at_creation=${account[0]!.security_revision},last_seen_at=now() where id=${principal.clientSessionId}`;
    await tx`update iam.client_phone_change_states set confirmed_at=now() where account_id=${principal.accountId}`;
    return { revision: Number(updated[0].revision), verifiedPhone: maskPhone(newPhone) };
  });
  await supabaseAdmin.auth.admin.signOut(provider.bearer, "others");
  await audit(principal.accountId, provider, "PHONE_CHANGE_CONFIRMED", "SUCCEEDED");
  return result;
}

export async function changeClientPassword(provider: ProviderIdentity, principal: ClientPrincipal, input: ChangeClientPasswordInput) {
  const verifier = createClient(runtime.supabaseUrl, runtime.serviceRoleKey || "local-key-required", {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const verified = await verifier.auth.signInWithPassword({ phone: principal.verifiedPhone, password: input.currentPassword });
  if (verified.error || verified.data.user?.id !== provider.authUserId) {
    throw new DomainError("FORBIDDEN", "Current credential verification failed", 403);
  }
  await verifier.auth.signOut({ scope: "local" });

  const state = await one<{ revision: number }>(sql`select revision from iam.client_identity_states where account_id=${principal.accountId}`);
  if (!state || Number(state.revision) !== input.expectedRevision) throw new DomainError("STALE_REVISION", "Client identity changed", 409);

  const providerUpdate = await supabaseAdmin.auth.admin.updateUserById(provider.authUserId, { password: input.newPassword });
  if (providerUpdate.error) throw new DomainError("EXTERNAL_OUTCOME_UNKNOWN", "Password change requires provider reconciliation", 503);

  try {
    const result = await database.client.begin(async (tx) => {
      const identities = await tx`update iam.client_identity_states set revision=revision+1,updated_at=now()
        where account_id=${principal.accountId} and revision=${input.expectedRevision} returning revision` as unknown as { revision: number }[];
      if (!identities[0]) throw new DomainError("STALE_REVISION", "Client identity changed", 409);
      await tx`update iam.user_accounts set security_revision=security_revision+1,credentials_changed_at=now(),updated_at=now() where id=${principal.accountId}`;
      await tx`update iam.account_security_states set sessions_valid_after=now(),revision=revision+1,updated_at=now() where account_id=${principal.accountId}`;
      await tx`update iam.client_access_sessions set revoked_at=now(),revoked_reason='PASSWORD_CHANGED' where account_id=${principal.accountId} and revoked_at is null`;
      await tx`insert into iam.client_security_events(account_id,auth_user_id,event_type,outcome,metadata)
        values (${principal.accountId},${provider.authUserId},'PASSWORD_CHANGED','SUCCEEDED','{}'::jsonb)`;
      return { revision: Number(identities[0].revision) };
    });
    await supabaseAdmin.auth.admin.signOut(provider.bearer, "global");
    return { accepted: true, next: "LOGIN_REQUIRED" as const, revision: result.revision };
  } catch (error) {
    await audit(principal.accountId, provider, "PASSWORD_CHANGE_PROVIDER_COMMITTED", "UNKNOWN");
    if (error instanceof DomainError) throw error;
    throw new DomainError("EXTERNAL_OUTCOME_UNKNOWN", "Password change requires reconciliation", 503);
  }
}

export async function completeRecovery(provider: ProviderIdentity, input: CompleteClientRecoveryInput, operationId: string) {
  if (!isOtpRecoverySession(provider)) throw new DomainError("FORBIDDEN", "Recovery requires a current phone OTP session", 403);
  const phone = requireVerifiedPhone(provider);
  if (!isOtpRecoverySession(provider)) throw new DomainError("FORBIDDEN", "Recovery requires a phone OTP session", 403);
  const account = await identityByAuthUser(provider.authUserId);
  if (!account || account.verified_phone_e164 !== phone) throw new DomainError("RECOVERY_CODE_INVALID", "Recovery proof is invalid", 403);
  const outcome = await database.client.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`client-recovery:${account.account_id}`},0))`;
    const replay = await tx`select status::text status,safe_result_code from iam.client_recovery_operations where id=${operationId}` as unknown as { status: string; safe_result_code: string | null }[];
    if (replay[0]) {
      if (replay[0].status === "SUCCESS") return { replay: true };
      if (replay[0].status === "UNKNOWN_RECONCILIATION_REQUIRED") throw new DomainError("EXTERNAL_OUTCOME_UNKNOWN", "Recovery requires provider reconciliation", 503);
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Recovery operation is already in progress", 409);
    }
    await tx`insert into iam.client_recovery_operations(id,account_id,provider_session_id,status,expires_at)
      values (${operationId},${account.account_id},${provider.providerSessionId},'RUNNING',now()+interval '15 minutes')`;
    const candidates = await tx`select id,code_hash,salt,used_at,revoked_at from iam.client_recovery_codes where account_id=${account.account_id} for update` as unknown as { id: string; code_hash: string; salt: string; used_at: Date | null; revoked_at: Date | null }[];
    let matched: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      const actual = codeDigest(input.recoveryCode, candidate.salt);
      const expected = Buffer.from(candidate.code_hash, "base64url");
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) matched = candidate;
    }
    if (!matched || matched.revoked_at) {
      await tx`update iam.client_recovery_operations set status='FAILED',resolved_at=now(),safe_result_code='INVALID_PROOF' where id=${operationId}`;
      throw new DomainError("RECOVERY_CODE_INVALID", "Recovery proof is invalid", 403);
    }
    if (matched.used_at) {
      await tx`update iam.client_recovery_operations set status='FAILED',resolved_at=now(),safe_result_code='CODE_USED' where id=${operationId}`;
      throw new DomainError("RECOVERY_CODE_USED", "The recovery code has already been used", 409);
    }
    await tx`update iam.client_recovery_codes set used_at=now() where id=${matched.id} and used_at is null`;
    await tx`update iam.client_identity_states set status='RECOVERY_REQUIRED',mfa_enrolled_at=null,recovery_codes_acknowledged_at=null,revision=revision+1,updated_at=now() where account_id=${account.account_id}`;
    await tx`update iam.client_access_sessions set revoked_at=now(),revoked_reason='CREDENTIAL_RECOVERY' where account_id=${account.account_id} and revoked_at is null`;
    await tx`update iam.user_accounts set security_revision=security_revision+1,credentials_changed_at=now(),updated_at=now() where id=${account.account_id}`;
    await tx`update iam.account_security_states set recovery_required=true,sessions_valid_after=now(),revision=revision+1,updated_at=now() where account_id=${account.account_id}`;
    return { replay: false };
  });
  if (outcome.replay) return { accepted: true, next: "NEW_MFA_REQUIRED", replayed: true };
  try {
    const factors = await supabaseAdmin.auth.admin.mfa.listFactors({ userId: provider.authUserId });
    if (factors.error) throw factors.error;
    for (const factor of factors.data.factors.filter((item) => item.factor_type === "totp")) {
      const removed = await supabaseAdmin.auth.admin.mfa.deleteFactor({ userId: provider.authUserId, id: factor.id });
      if (removed.error) throw removed.error;
    }
    const updated = await supabaseAdmin.auth.admin.updateUserById(provider.authUserId, { password: input.newPassword });
    if (updated.error) throw updated.error;
    await supabaseAdmin.auth.admin.signOut(provider.bearer, "global");
    await rows(sql`update iam.client_recovery_operations set status='SUCCESS',resolved_at=now(),safe_result_code='PASSWORD_UPDATED' where id=${operationId}`);
    await audit(account.account_id, provider, "CLIENT_RECOVERY_COMPLETED", "SUCCEEDED", operationId);
    return { accepted: true, next: "NEW_MFA_REQUIRED", replayed: false };
  } catch {
    await rows(sql`update iam.client_recovery_operations set status='UNKNOWN_RECONCILIATION_REQUIRED',resolved_at=now(),safe_result_code='PROVIDER_OUTCOME_UNKNOWN' where id=${operationId}`);
    await audit(account.account_id, provider, "CLIENT_RECOVERY_PROVIDER_OUTCOME", "UNKNOWN", operationId);
    throw new DomainError("EXTERNAL_OUTCOME_UNKNOWN", "Recovery requires provider reconciliation", 503);
  }
}

export function operationIdFromHeader(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) throw new DomainError("VALIDATION_ERROR", "x-operation-id must be a UUID", 400);
  return candidate;
}
