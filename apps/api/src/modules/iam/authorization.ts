import type { FastifyRequest } from "fastify";
import { DomainError, roleCapabilities, grantableCapabilitiesByRole, type Capability, type GrantScope, type RoleCode } from "@youngkingz/contracts";
import { rows, sql } from "../../lib/sql.js";
import { database, supabaseAdmin } from "../../lib/runtime.js";

/**
 * Actor operativo. `grantScopes` es la autoridad DELEGADA con su alcance:
 *  · `null`  → capability base del rol (Business completo);
 *  · objeto  → capability conferida por grant, restringida a ese scope;
 *  · valor con `staffMemberId = "__CONFLICT__"` → grants incompatibles entre
 *    sí; se niega en lugar de elegir el más permisivo (deny-by-default).
 *
 * El frontend NO puede influir en nada de esto: sólo envía el JWT.
 */
export interface Actor {
  accountId: string; personId: string; businessId: string; staffMemberId: string; accessSessionId: string;
  roleAssignmentId: string; role: RoleCode; contextRevision: number; capabilities: Set<Capability>; email: string;
  grantScopes: Map<Capability, GrantScope | null>;
}

type IdentityRow = {
  account_id: string; person_id: string; business_id: string; staff_member_id: string;
  account_status: string; access_status: string; employment_status: string; verified_email: string;
  recovery_required: boolean | null; sessions_valid_after: Date | null;
};
type RoleRow = { id: string; role: RoleCode };
type GrantRow = { capability: Capability; scope: unknown };

function bearer(request: FastifyRequest): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) throw new DomainError("UNAUTHENTICATED", "A valid bearer token is required", 401);
  return value.slice(7);
}

function tokenClaims(token: string): { exp?: number; iat?: number; session_id?: string } {
  try { return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")); } catch { return {}; }
}

function parseScope(value: unknown): GrantScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return typeof raw.staffMemberId === "string" ? { staffMemberId: raw.staffMemberId } : {};
}

/**
 * H01/H07/H08 · Resolución de Business desde IDENTIDAD VERIFICADA.
 *
 * Se eliminó `order by sm.created_at limit 1`: ese criterio elegía la
 * membresía más antigua y permitía operar sobre un negocio ambiguo. Ahora:
 *   1. si el cliente pide explícitamente `x-business-id`, debe corresponder a
 *      una membresía REAL de la identidad (si no → 403, sin revelar si el
 *      negocio existe);
 *   2. si no, se usa la preferencia de contexto persistida;
 *   3. si no, la sesión del provider ya correlacionada;
 *   4. si no, se exige que la identidad tenga UNA SOLA membresía activa.
 *
 * En ningún caso se acepta un `businessId` recibido sin verificar pertenencia.
 */
async function resolveMembership(request: FastifyRequest, memberships: IdentityRow[], providerSessionId: string | undefined): Promise<IdentityRow> {
  const requested = request.headers["x-business-id"];
  if (typeof requested === "string" && requested.trim()) {
    const match = memberships.find((item) => item.business_id === requested.trim());
    if (!match) throw new DomainError("FORBIDDEN", "Business context is not authorized", 403);
    return match;
  }

  const accountId = memberships[0]!.account_id;
  const preferred = await rows<{ business_id: string }>(sql`select business_id from iam.user_context_preferences where account_id = ${accountId}`);
  for (const pref of preferred) {
    const match = memberships.find((item) => item.business_id === pref.business_id);
    if (match) return match;
  }

  if (providerSessionId) {
    const sessions = await rows<{ business_id: string }>(sql`select business_id from iam.access_sessions where auth_session_id = ${providerSessionId} and revoked_at is null`);
    for (const session of sessions) {
      const match = memberships.find((item) => item.business_id === session.business_id);
      if (match) return match;
    }
  }

  const businessIds = [...new Set(memberships.map((item) => item.business_id))];
  if (businessIds.length === 1) {
    const businessId = businessIds[0]!;
    if (memberships.length === 1) return memberships[0]!;
    const staffIds = memberships.map((item) => item.staff_member_id);
    const withRole = await rows<{ staff_member_id: string }>(sql`
      select staff_member_id from iam.role_assignments
      where business_id = ${businessId} and staff_member_id = any(${staffIds}::uuid[])
        and revoked_at is null and effective_at is not null
      group by staff_member_id`);
    if (withRole.length === 1) {
      const match = memberships.find((item) => item.staff_member_id === withRole[0]!.staff_member_id);
      if (match) return match;
    }
    if (withRole.length === 0) return memberships[0]!; // la comprobación de roles devolverá FORBIDDEN
  }
  throw new DomainError("FORBIDDEN", "Business context is ambiguous; select a business explicitly", 403);
}

export class AuthorizationService {
  async authenticate(request: FastifyRequest): Promise<Actor> {
    const token = bearer(request);
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user?.id || !data.user.email) throw new DomainError("UNAUTHENTICATED", "Identity verification failed", 401);
    const claims = tokenClaims(token);
    const providerSessionId = claims.session_id;

    // Todas las membresías de la identidad verificada. Nunca `limit 1`.
    const memberships = await rows<IdentityRow>(sql`
      select ua.id account_id, ua.person_id, sm.id staff_member_id, sm.business_id,
             ua.status account_status, sm.access_status, sm.employment_status, ua.verified_email,
             sec.recovery_required, sec.sessions_valid_after
      from iam.user_accounts ua join team.staff_members sm on sm.person_id = ua.person_id
      left join iam.account_security_states sec on sec.account_id = ua.id
      where ua.auth_user_id = ${data.user.id}`);
    if (!memberships.length) throw new DomainError("FORBIDDEN", "The authenticated identity is not Staff", 403);
    const identity = await resolveMembership(request, memberships, providerSessionId);

    if (identity.account_status !== "ACTIVE" || identity.access_status !== "ACTIVE" || identity.employment_status !== "ACTIVE") throw new DomainError("ACCESS_RESTRICTED", "Staff access is not active", 403);
    const assignments = await rows<RoleRow>(sql`select id, role::text role from iam.role_assignments where business_id = ${identity.business_id} and staff_member_id = ${identity.staff_member_id} and revoked_at is null and effective_at is not null order by created_at`);
    if (!assignments.length) throw new DomainError("FORBIDDEN", "No active responsibility is assigned", 403);
    if (!providerSessionId) throw new DomainError("UNAUTHENTICATED", "The provider session identifier is missing", 401);
    if (identity.recovery_required) throw new DomainError("ACCESS_RESTRICTED", "Account recovery must be completed", 403);
    if (claims.iat && identity.sessions_valid_after && claims.iat * 1000 < new Date(identity.sessions_valid_after).getTime()) throw new DomainError("SESSION_REVOKED", "Session predates the latest credential security change", 401);

    const session = await database.client.begin(async (tx) => {
      // Una carga de página hace varias peticiones autorizadas en paralelo. La
      // sesión del provider es el límite de correlación: se serializa sólo su
      // primera resolución. Se fija también el negocio resuelto, para que una
      // sesión no pueda migrar entre Businesses.
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${identity.account_id}:${identity.business_id}:${providerSessionId}`}, 0))`;
      const existing = await tx`
        select id,active_role_assignment_id,context_revision from iam.access_sessions
        where account_id=${identity.account_id} and business_id=${identity.business_id}
          and auth_session_id=${providerSessionId} and revoked_at is null
        order by created_at desc limit 1` as unknown as { id: string; active_role_assignment_id: string | null; context_revision: number }[];
      if (existing[0]) {
        const [refreshed] = await tx`
          update iam.access_sessions set expires_at=greatest(expires_at,to_timestamp(${claims.exp ?? Math.floor(Date.now()/1000)+3600})),last_seen_at=now()
          where id=${existing[0].id} returning id,active_role_assignment_id,context_revision` as unknown as { id: string; active_role_assignment_id: string | null; context_revision: number }[];
        return refreshed!;
      }
      const revoked = await tx`select id from iam.access_sessions where account_id=${identity.account_id} and business_id=${identity.business_id} and auth_session_id=${providerSessionId} and revoked_at is not null limit 1`;
      if (revoked.length) throw new DomainError("SESSION_REVOKED", "Operational session has been revoked", 401);
      const preferred = await tx`select role_assignment_id from iam.user_context_preferences where account_id=${identity.account_id} and business_id=${identity.business_id}` as unknown as { role_assignment_id: string }[];
      const active = assignments.find((item) => item.id === preferred[0]?.role_assignment_id) ?? assignments[0]!;
      const [created] = await tx`
        insert into iam.access_sessions(account_id,business_id,staff_member_id,active_role_assignment_id,auth_session_id,expires_at)
        values (${identity.account_id},${identity.business_id},${identity.staff_member_id},${active.id},${providerSessionId},to_timestamp(${claims.exp ?? Math.floor(Date.now()/1000)+3600}))
        returning id,active_role_assignment_id,context_revision` as unknown as { id: string; active_role_assignment_id: string; context_revision: number }[];
      return created!;
    });
    const selected = assignments.find((item) => item.id === session?.active_role_assignment_id) ?? assignments[0]!;
    const grants = await rows<GrantRow>(sql`select capability, scope from iam.capability_grants where role_assignment_id = ${selected.id} and revoked_at is null and valid_from <= now() and (expires_at is null or expires_at > now())`);

    // Compatibilidad rol ↔ capability. Un grant fuera del alcance del rol es
    // INEFICAZ (deny-by-default), igual que en H01/H03.
    const baseline = roleCapabilities[selected.role];
    const grantable = grantableCapabilitiesByRole[selected.role];
    const capabilities = new Set<Capability>(baseline);
    const grantScopes = new Map<Capability, GrantScope | null>();
    for (const capability of baseline) grantScopes.set(capability, null);
    for (const grant of grants) {
      if (!baseline.includes(grant.capability) && !grantable.includes(grant.capability)) continue;
      const scope = parseScope(grant.scope);
      capabilities.add(grant.capability);
      const previous = grantScopes.get(grant.capability);
      if (previous === undefined) grantScopes.set(grant.capability, scope);
      else if (previous === null) continue; // ya tiene autoridad de Business completo
      else if (previous.staffMemberId === scope.staffMemberId) continue;
      else grantScopes.set(grant.capability, { staffMemberId: "__CONFLICT__" }); // denegar ambigüedad
    }
    await databaseTouch(session.id);
    return {
      accountId: identity.account_id, personId: identity.person_id, businessId: identity.business_id,
      staffMemberId: identity.staff_member_id, accessSessionId: session.id, roleAssignmentId: selected.id,
      role: selected.role, contextRevision: Number(session.context_revision), capabilities, grantScopes,
      email: data.user.email
    };
  }

  /**
   * Autoridad efectiva: capability Y scope. `scope.staffMemberId` se compara
   * contra el recurso solicitado; un grant con `'__CONFLICT__'` nunca coincide.
   * La capability de rol (sin grant) conserva su alcance de Business completo.
   */
  require(actor: Actor, capability: Capability, scope?: { staffMemberId?: string }): void {
    if (!actor.capabilities.has(capability)) throw new DomainError("FORBIDDEN", `Missing capability: ${capability}`, 403);
    const grantScope = actor.grantScopes.get(capability);
    if (grantScope?.staffMemberId && grantScope.staffMemberId !== scope?.staffMemberId) {
      throw new DomainError("ECONOMY_FORBIDDEN", `Capability ${capability} is not granted for the requested professional`, 403);
    }
  }
}

async function databaseTouch(id: string) { await rows(sql`update iam.access_sessions set last_seen_at = now() where id = ${id} and revoked_at is null returning id`); }

export const authorizationService = new AuthorizationService();
