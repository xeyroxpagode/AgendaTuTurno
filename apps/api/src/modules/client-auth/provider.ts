import type { FastifyRequest } from "fastify";
import { DomainError } from "@youngkingz/contracts";
import { supabaseAdmin } from "../../lib/runtime.js";

type AuthenticationMethodReference = { method?: string; timestamp?: number };
type VerifiedClaims = {
  sub?: string; exp?: number; iat?: number; session_id?: string;
  aal?: "aal1" | "aal2"; amr?: AuthenticationMethodReference[];
};

export interface ProviderIdentity {
  authUserId: string;
  providerSessionId: string;
  verifiedPhone: string | null;
  verifiedEmail: string | null;
  aal: "aal1" | "aal2";
  authenticationMethods: readonly string[];
  expiresAt: Date;
  issuedAt: Date;
  jwtId: string;
  hasVerifiedTotp: boolean;
  bearer: string;
}

export function bearerToken(request: FastifyRequest): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ") || value.length < 16) throw new DomainError("UNAUTHENTICATED", "A valid bearer token is required", 401);
  return value.slice(7);
}

function parseClaims(token: string): VerifiedClaims {
  try { return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as VerifiedClaims; }
  catch { throw new DomainError("UNAUTHENTICATED", "The provider token is malformed", 401); }
}

export async function resolveProviderIdentity(request: FastifyRequest): Promise<ProviderIdentity> {
  const bearer = bearerToken(request);
  const { data, error } = await supabaseAdmin.auth.getUser(bearer);
  if (error || !data.user?.id) throw new DomainError("UNAUTHENTICATED", "Identity verification failed", 401);
  const claims = parseClaims(bearer);
  if (claims.sub !== data.user.id || !claims.session_id || !claims.exp || !claims.iat) throw new DomainError("UNAUTHENTICATED", "Required provider session claims are missing", 401);
  const methods = (claims.amr ?? []).flatMap((entry) => typeof entry.method === "string" ? [entry.method] : []);
  const phoneConfirmed = Boolean(data.user.phone && data.user.phone_confirmed_at);
  const verifiedPhone = phoneConfirmed ? (data.user.phone!.startsWith("+") ? data.user.phone! : `+${data.user.phone}`) : null;
  return {
    authUserId: data.user.id,
    providerSessionId: claims.session_id,
    verifiedPhone,
    verifiedEmail: data.user.email_confirmed_at ? (data.user.email ?? null) : null,
    aal: claims.aal === "aal2" ? "aal2" : "aal1",
    authenticationMethods: methods,
    expiresAt: new Date(claims.exp * 1000), issuedAt: new Date(claims.iat * 1000),
    jwtId: `${claims.session_id}:${claims.iat}`,
    hasVerifiedTotp: (data.user.factors ?? []).some((factor) => factor.factor_type === "totp" && factor.status === "verified"),
    bearer
  };
}

export function requireVerifiedPhone(provider: ProviderIdentity): string {
  if (!provider.verifiedPhone) throw new DomainError("PHONE_UNVERIFIED", "A confirmed phone is required", 403);
  return provider.verifiedPhone;
}

export function requireAal2(provider: ProviderIdentity): void {
  if (provider.aal !== "aal2" || !provider.hasVerifiedTotp) throw new DomainError("MFA_REQUIRED", "A verified authenticator challenge is required", 403);
}

export function isPasswordSession(provider: ProviderIdentity): boolean {
  return provider.authenticationMethods.includes("password");
}

export function isOtpRecoverySession(provider: ProviderIdentity): boolean {
  return provider.aal === "aal1" && provider.authenticationMethods.some((method) => ["otp", "phone", "sms"].includes(method)) && !provider.authenticationMethods.includes("password");
}
