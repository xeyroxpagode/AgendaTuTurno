import type { FastifyRequest } from "fastify";
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile?.(".env");

import { authorizationService, type Actor } from "../../apps/api/src/modules/iam/authorization.js";
import { QA_PASSWORD } from "./h07-h08-seed.js";

/**
 * Autenticación REAL contra GoTrue local. NO se fabrica un Actor ni se omite
 * autenticación: se usa el mismo `AuthorizationService.authenticate` que la API.
 */
export async function authenticateQaActor(email: string, password = QA_PASSWORD): Promise<Actor> {
  const supabase = createClient(
    process.env.SUPABASE_URL ?? "http://127.0.0.1:55321",
    process.env.SUPABASE_ANON_KEY ?? "local-anon-key-required"
  );
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token) throw new Error(`No se pudo autenticar a ${email}: ${error?.message ?? "sin token"}`);
  const request = { headers: { authorization: `Bearer ${data.session.access_token}` } } as unknown as FastifyRequest;
  return authorizationService.authenticate(request);
}

export const QA_EMAILS = {
  owner: "owner-qa@youngkingz.local",
  reception: "reception-qa@youngkingz.local",
  barber: "barber-qa@youngkingz.local",
  ownerB2: "owner-b2-qa@youngkingz.local"
};
