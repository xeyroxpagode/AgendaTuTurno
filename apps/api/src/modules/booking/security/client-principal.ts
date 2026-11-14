/**
 * H03.U02 + U04 · Bridge de autoridad CLIENT → Booking.
 *
 * La autoridad CLIENT proviene EXCLUSIVAMENTE de U02 (`resolveClientPrincipal`):
 * cuenta global validada, AAL2 real, estado de cuenta vigente y sesión viva.
 * Este módulo no reimplementa autenticación ni crea un segundo proveedor Supabase:
 * sólo traduce el `ClientPrincipal` de U02 al `BookingPrincipal` de U04.
 *
 * Reglas congeladas:
 *  - El email/teléfono del body NUNCA es autoridad; el teléfono verificado U02 sí.
 *  - No se crea `ClientProfile` automáticamente ni se fusiona CRM.
 *  - No se crea `StaffMember` ni se adquiere autoridad STAFF.
 *  - Una sesión de recuperación OTP no es una sesión CLIENT activa: U02 ya la
 *    rechaza (`isOtpRecoverySession` / `requireAal2`).
 */
import type { FastifyRequest } from "fastify";
import type { BookingPrincipal } from "@youngkingz/contracts";
import { DomainError } from "@youngkingz/contracts";
import { rows, sql } from "../../../lib/sql.js";

// Local type for U02 ClientPrincipal (returned by dynamic import)
interface U02ClientPrincipal {
  accountId: string;
  clientSessionId: string;
  verifiedPhone: string;
  // other properties from U02 principal
  [key: string]: any;
}

// Dynamic imports for U02 modules (optional dependency)
let resolveProviderIdentityFn: ((request: FastifyRequest) => Promise<any>) | null = null;
let resolveClientPrincipalFn: ((identity: any) => Promise<U02ClientPrincipal>) | null = null;

async function loadU02Modules(): Promise<{ provider: (request: FastifyRequest) => Promise<any>; principal: (identity: any) => Promise<U02ClientPrincipal> } | null> {
  if (resolveProviderIdentityFn && resolveClientPrincipalFn) {
    return { provider: resolveProviderIdentityFn, principal: resolveClientPrincipalFn };
  }
  try {
    const [providerMod, principalMod] = await Promise.all([
      import("../../client-auth/provider.js"),
      import("../../client-auth/service.js"),
    ]);
    resolveProviderIdentityFn = providerMod.resolveProviderIdentity;
    resolveClientPrincipalFn = principalMod.resolveClientPrincipal;
    return { provider: resolveProviderIdentityFn, principal: resolveClientPrincipalFn };
  } catch {
    // U02 modules not available (not deployed)
    return null;
  }
}

export type ClientBookingIdentity = {
  /** Principal U02 (identidad global, sin Business). */
  client: U02ClientPrincipal;
  /** Principal de Booking-U04, ya acotado a un Business. */
  booking: BookingPrincipal;
};

/**
 * Traduce el principal U02 al principal de Booking para un Business concreto.
 * `authSessionId` es la sesión U02 (`iam.client_access_sessions.id`), que es la
 * única sesión viva verificable; el `providerSessionId` es externo y no se usa
 * como autoridad de negocio.
 */
export function toBookingPrincipal(principal: U02ClientPrincipal, businessId: string): BookingPrincipal {
  if (!businessId) throw new DomainError("VALIDATION_ERROR", "A Business scope is required for CLIENT booking", 400);
  return {
    kind: "CLIENT",
    businessId,
    accountId: principal.accountId,
    authSessionId: principal.clientSessionId,
  };
}

/**
 * Resuelve la autoridad CLIENT real desde el Bearer token de U02, sin Business.
 * Falla cerrado con los códigos de dominio de U02 (MFA_REQUIRED,
 * ACCOUNT_RESTRICTED, SESSION_REVOKED, PHONE_UNVERIFIED).
 * Si U02 no está deployado, lanza CLIENT_AUTH_INSUFFICIENT (501).
 */
export async function resolveClientIdentity(request: FastifyRequest): Promise<U02ClientPrincipal> {
  const modules = await loadU02Modules();
  if (!modules) {
    throw new DomainError("CLIENT_AUTH_INSUFFICIENT", "Client booking requires U02 identity service", 501);
  }
  const identity = await modules.provider(request);
  return modules.principal(identity);
}

/**
 * Resuelve la autoridad CLIENT real y la acota a un Business.
 * El Business debe provenir de una fuente ya validada (cotización firmada o
 * reserva existente), nunca de un cuerpo libre del navegador.
 * Si U02 no está deployado, lanza CLIENT_AUTH_INSUFFICIENT (501).
 */
export async function resolveClientBookingPrincipal(request: FastifyRequest, businessId: string): Promise<ClientBookingIdentity> {
  const client = await resolveClientIdentity(request);
  return { client, booking: toBookingPrincipal(client, businessId) };
}

/**
 * Nombre de la persona global U02, para el snapshot de contacto de la reserva.
 * No es autoridad: es sólo presentación histórica congelada.
 */
export async function clientContactSnapshot(principal: U02ClientPrincipal): Promise<{ name: string; phone: string; email: string | null }> {
  const [person] = await rows<{ firstName: string; lastName: string | null; email: string | null }>(sql`
    select p.first_name "firstName", p.last_name "lastName", ua.verified_email::text email
    from iam.persons p join iam.user_accounts ua on ua.person_id = p.id
    where ua.id = ${principal.accountId}`);
  const name = person ? [person.firstName, person.lastName].filter(Boolean).join(" ") : "Cliente";
  return { name, phone: principal.verifiedPhone, email: person?.email ?? null };
}
