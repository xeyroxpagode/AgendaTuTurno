/**
 * G01 · Runtime QA real: Supabase Auth local + PostgreSQL aislado + API/Next reales.
 * No hay mocks: las sesiones de navegador usan credenciales reales y el API
 * resuelve el Actor desde la BD QA aislada.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { roleCapabilities, type RoleCode } from "@youngkingz/contracts";
import type { Actor } from "../../../apps/api/src/modules/iam/authorization.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/youngkingz_h06_g01_20261122";
const AUTH_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";

export interface G01Context {
  suffix: string;
  email: string;
  password: string;
  businessId: string;
  accountId: string;
  staffId: string;
  authUserId: string;
  db: ReturnType<typeof postgres>;
}

/** Verifica identidad de la base antes de cualquier mutación de prueba. */
export async function assertG01Database(): Promise<string> {
  const db = postgres(DB_URL, { max: 1, prepare: false });
  try {
    const [row] = await db`select current_database() name`;
    const name = String(row!.name);
    if (!name.startsWith("youngkingz_h06_")) throw new Error(`G01 requiere base QA aislada H06; conectada a '${name}'.`);
    return name;
  } finally { await db.end(); }
}

export async function createG01Context(role: RoleCode, sameBusiness?: string): Promise<G01Context> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY para crear sesiones reales.");
  const suffix = randomUUID().slice(0, 8);
  const email = `g01-${role.toLowerCase()}-${suffix}@example.com`;
  const password = "YoungKingz-G01!26";
  const admin = createClient(AUTH_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const authUserId = created.data.user.id;

  const db = postgres(DB_URL, { max: 1, prepare: false });
  let businessId = sameBusiness;
  if (!businessId) {
    const [biz] = await db`
      insert into business.businesses(provisioning_key,display_name,timezone,status)
      values (${`g01-${suffix}`},${`G01 ${role} ${suffix}`},'America/Argentina/Buenos_Aires','ACTIVE')
      returning id`;
    businessId = String(biz.id);
  }
  const [person] = await db`insert into iam.persons(first_name,last_name) values ('G01',${role}) returning id`;
  const [staff] = await db`
    insert into team.staff_members(business_id,person_id,employment_status,access_status)
    values (${businessId!},${person.id},'ACTIVE','ACTIVE') returning id`;
  // El shim `auth.users` de la base QA refleja la identidad creada en GoTrue.
  await db`insert into auth.users(id,email) values (${authUserId},${email}) on conflict do nothing`;
  const [account] = await db`
    insert into iam.user_accounts(person_id,auth_user_id,verified_email,status)
    values (${person.id},${authUserId},${email},'ACTIVE') returning id`;
  await db`insert into iam.account_security_states(account_id) values (${account.id}) on conflict do nothing`;
  await db`insert into team.staff_relationship_periods(business_id,staff_member_id) values (${businessId!},${staff.id}) on conflict do nothing`;
  await db`insert into iam.staff_role_states(business_id,staff_member_id) values (${businessId!},${staff.id}) on conflict do nothing`;
  await db`
    insert into iam.role_assignments(business_id,staff_member_id,role,effective_at,assigned_by_account_id)
    values (${businessId!},${staff.id},${role},now(),${account.id})`;

  return { suffix, email, password, businessId: businessId!, accountId: String(account.id), staffId: String(staff.id), authUserId, db };
}

/** Actor sintético documentado SOLO para sembrar datos QA (no para aceptación). */
export function seedActorOf(ctx: G01Context): Actor {
  const role = "OWNER" as RoleCode;
  return {
    accountId: ctx.accountId, personId: "", staffMemberId: ctx.staffId,
    businessId: ctx.businessId, accessSessionId: "", roleAssignmentId: "",
    role, contextRevision: 1, capabilities: new Set(roleCapabilities[role]), email: ctx.email
  };
}

export async function createSellableItem(ctx: G01Context, sku: string, priceMinor: number, quantity: number): Promise<{ sku: string; locationId: string; itemId: string }> {
  // Siembra por SQL sobre la BD QA aislada. Evita depender del resolver de
  // módulos de Playwright y mantiene el runtime real (mismas constraints y
  // triggers que produce el comando H04).
  const db = postgres(DB_URL, { max: 1, prepare: false });
  try {
    const opId = randomUUID();
    const [location] = await db`
      insert into inventory.locations(business_id,name) values (${ctx.businessId},${`Ubicación ${sku}`}) returning id`;
    const [item] = await db`
      insert into inventory.items(business_id,sku,name,use,price_minor,cost_minor,published)
      values (${ctx.businessId},${sku},${`Artículo ${sku}`},'SALE',${priceMinor},0,true) returning id`;
    await db`
      insert into system.operation_attempts(operation_id,business_id,actor_account_id,command_name,request_hash,status)
      values (${opId},${ctx.businessId},${ctx.accountId},'inventory.movement.seed',${randomUUID()},'STARTED')`;
    await db.begin(async (tx) => {
      const [movement] = await tx`
        insert into inventory.movements(business_id,kind,operation_id,actor_account_id,reason,effective_at)
        values (${ctx.businessId},'OPENING',${opId},${ctx.accountId},'Stock inicial G01',now()) returning id`;
      await tx`
        insert into inventory.entries(business_id,movement_id,sku,location_id,purpose,delta,position_version)
        values (${ctx.businessId},${movement.id},${sku},${location.id},'SALE',${quantity},1)`;
      // El trigger de movimiento exige, al commit, operación SUCCEEDED + auditoría.
      await tx`update system.operation_attempts set status='SUCCEEDED', response_status=200 where operation_id=${opId}`;
      await tx`
        insert into system.audit_events(business_id,actor_account_id,operation_id,action,resource_type,resource_id,outcome,changes)
        values (${ctx.businessId},${ctx.accountId},${opId},'inventory.movement.seed','INVENTORY',${movement.id},'SUCCEEDED','{}'::jsonb)`;
    });
    return { sku, locationId: String(location.id), itemId: String(item.id) };
  } finally { await db.end(); }
}

export async function openG01Cash(ctx: G01Context): Promise<string> {
  const db = postgres(DB_URL, { max: 1, prepare: false });
  try {
    const opId = randomUUID();
    const [box] = await db`
      insert into cash.cashboxes(business_id,name) values (${ctx.businessId},${`Caja G01 ${ctx.suffix}`}) returning id`;
    await db`
      insert into system.operation_attempts(operation_id,business_id,actor_account_id,command_name,request_hash,status)
      values (${opId},${ctx.businessId},${ctx.accountId},'cash.session.seed',${randomUUID()},'SUCCEEDED')`;
    const [session] = await db`
      insert into cash.cash_sessions(business_id,cashbox_id,status,opened_by_account_id,opening_amount_minor,operation_id)
      values (${ctx.businessId},${box.id},'OPEN',${ctx.accountId},10000,${opId}) returning id`;
    return String(session.id);
  } finally { await db.end(); }
}

export async function g01Scalar<T = unknown>(query: string, params: readonly unknown[] = []): Promise<T | undefined> {
  const db = postgres(DB_URL, { max: 1, prepare: false });
  try {
    const rows = await db.unsafe(query, params as never[]);
    return rows[0] as T | undefined;
  } finally { await db.end(); }
}

export async function g01Count(query: string, params: readonly unknown[] = []): Promise<number> {
  const db = postgres(DB_URL, { max: 1, prepare: false });
  try {
    const rows = await db.unsafe(query, params as never[]);
    return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
  } finally { await db.end(); }
}
