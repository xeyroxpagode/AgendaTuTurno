/**
 * F2 · Soporte de fixtures aislados para la resolución contractual T1–T4.
 *
 * Sólo se usa contra la base QA nueva del suffix h09rec_20261125. Las
 * identidades se obtienen de GoTrue real; nunca se fabrican tokens ni Actors.
 */
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";
import { authorizationService, type Actor } from "../../../apps/api/src/modules/iam/authorization.js";

export const QA_PASSWORD = "QaTestPass2026!x";
export const QA_EMAILS = {
  owner: "owner-qa@youngkingz.local",
  reception: "reception-qa@youngkingz.local",
  barber: "barber-qa@youngkingz.local",
  ownerB2: "owner-b2-qa@youngkingz.local"
} as const;

export const B1 = "11111111-1111-4111-8111-111111111111";
export const B2 = "22222222-2222-4222-8222-222222222222";
export const ACCOUNT_OWNER = "33333333-3333-4333-8333-333333333333";
export const ACCOUNT_RECEPTION = "44444444-4444-4444-8444-444444444444";
export const ACCOUNT_BARBER = "55555555-5555-4555-8555-555555555555";
export const STAFF_BARBER = "bbbbbbb3-3333-4333-8333-333333333333";
export const STAFF_OWNER = "bbbbbbb1-1111-4111-8111-111111111111";

export async function qaSql(): Promise<postgres.Sql> {
  const sql = postgres(process.env.DATABASE_URL!);
  const [{ current_database: name }] = await sql`select current_database()` as unknown as Array<{ current_database: string }>;
  if (!String(name).startsWith("youngkingz_h08_qa_h09rec_20261125")) {
    await sql.end();
    throw new Error(`BLOQUEADO: base ${name} no es la QA nueva de F2`);
  }
  return sql;
}

export async function authenticateQaActor(email: string): Promise<Actor> {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: QA_PASSWORD });
  if (error || !data.session?.access_token) throw new Error(`GoTrue real falló para ${email}: ${error?.message ?? "sin token"}`);
  const request = { headers: { authorization: `Bearer ${data.session.access_token}` } } as unknown as FastifyRequest;
  return authorizationService.authenticate(request);
}

/** Semilla de attempt canónico: todas las FKs reales, sin actores inventados. */
export async function seedAttempt(
  sql: postgres.Sql, operationId: string, businessId: string, actorAccountId: string,
  command: string, createdAt: string, status = "SUCCEEDED"
): Promise<void> {
  await sql`
    insert into system.operation_attempts
      (operation_id, business_id, actor_account_id, command_name, request_hash, status,
       response_status, response_body, error_code, created_at, completed_at, principal_kind)
    values (${operationId}, ${businessId}, ${actorAccountId}, ${command},
            ${`f2-${operationId}`}, ${status}::system.operation_status,
            200, '{}'::jsonb, null, ${createdAt}::timestamptz, ${createdAt}::timestamptz, 'STAFF')
    on conflict (operation_id) do nothing`;
}

export async function deleteFixtures(sql: postgres.Sql, ids: readonly string[]): Promise<void> {
  // Los cashboxes se liberan antes del bucle: sus sesiones pueden aparecer
  // después en la lista de identificadores.
  const all = [...ids] as string[];
  await sql`delete from money.money_reconciliations r using cash.cash_sessions s
    where s.business_id=r.business_id and s.id=r.cash_session_id and s.cashbox_id=any(${all}::uuid[])`;
  await sql`delete from cash.cash_movements mv using cash.cash_sessions s
    where s.business_id=mv.business_id and s.id=mv.cash_session_id and s.cashbox_id=any(${all}::uuid[])`;
  await sql`delete from cash.cash_sessions where cashbox_id=any(${all}::uuid[])`;
  // Orden inverso de dependencias; las tablas de dominio no se tocan fuera de F2.
  for (const id of ids) {
    await sql`delete from obligations.obligation_payments where id=${id}::uuid`;
    await sql`delete from obligations.expense_obligations where id=${id}::uuid`;
    await sql`delete from econ.settlement_adjustments where id=${id}::uuid`;
    await sql`delete from econ.settlements where id=${id}::uuid`;
    await sql`delete from econ.estimates where id=${id}::uuid`;
    await sql`delete from money.money_reconciliations where id=${id}::uuid`;
    await sql`delete from cash.cash_movements where id=${id}::uuid`;
    await sql`delete from cash.cash_sessions where id=${id}::uuid`;
    await sql`delete from cash.cashboxes where id=${id}::uuid`;
    await sql`delete from inventory.commitments where id=${id}::uuid`;
    await sql`delete from inventory.minimums where id=${id}::uuid`;
    await sql`delete from inventory.positions where location_id=${id}::uuid`;
    await sql`delete from inventory.items where id=${id}::uuid`;
    await sql`delete from inventory.locations where id=${id}::uuid`;
    await sql`delete from system.audit_events where id=${id}::uuid`;
    await sql`delete from money.money_operations where id=${id}::uuid`;
    await sql`delete from system.operation_attempts where operation_id=${id}::uuid`;
  }
}

export function asMinor(value: unknown): string { return String(value ?? "0"); }
