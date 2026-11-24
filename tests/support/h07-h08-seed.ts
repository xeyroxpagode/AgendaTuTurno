/**
 * Seed QA H07/H08 — SOLO base aislada youngkingz_h07_* / h08_*.
 * Crea identidades REALES en GoTrue local y las espeja en la BD QA aislada.
 * Nunca se ejecuta contra producción ni contra la BD principal de Supabase.
 */
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile?.(".env");

const QA_PORT = Number(process.env.QA_POSTGRES_PORT ?? 55322);
export const QA_DATABASE = process.env.H07_H08_QA_DATABASE ?? "youngkingz_h07_qa_20261124";
export const QA_PASSWORD = "QaTestPass2026!x";

const ids = {
  b1: "11111111-1111-4111-8111-111111111111",
  b2: "22222222-2222-4222-8222-222222222222",
  owner: "33333333-3333-4333-8333-333333333333",
  reception: "44444444-4444-4444-8444-444444444444",
  barber: "55555555-5555-4555-8555-555555555555",
  ownerB2: "66666666-6666-4666-8666-666666666666",
  personOwner: "aaaaaaa1-1111-4111-8111-111111111111",
  personReception: "aaaaaaa2-2222-4222-8222-222222222222",
  personBarber: "aaaaaaa3-3333-4333-8333-333333333333",
  personOwnerB2: "aaaaaaa4-4444-4444-8444-444444444444",
  staffOwner: "bbbbbbb1-1111-4111-8111-111111111111",
  staffReception: "bbbbbbb2-2222-4222-8222-222222222222",
  staffBarber: "bbbbbbb3-3333-4333-8333-333333333333",
  staffOwnerB2: "bbbbbbb4-4444-4444-8444-444444444444"
};

export async function assertQaDatabase(sql: postgres.Sql) {
  const [{ current_database: name }] = await sql`select current_database()` as unknown as Array<{ current_database: string }>;
  if (!/^youngkingz_h0[78]_/.test(String(name))) throw new Error(`BLOQUEADO: base ${name} no es QA H07/H08 aislada`);
}

export async function seedH07H08Qa() {
  const sql = postgres(`postgresql://postgres:postgres@127.0.0.1:${QA_PORT}/${QA_DATABASE}`, { max: 1 });
  try {
    await assertQaDatabase(sql);
    const supabaseUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY de la instancia QA local");
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const emails = {
      owner: "owner-qa@youngkingz.local", reception: "reception-qa@youngkingz.local",
      barber: "barber-qa@youngkingz.local", ownerB2: "owner-b2-qa@youngkingz.local"
    };
    const authIds: Record<string, string> = {};
    for (const [key, email] of Object.entries(emails)) {
      const { data, error } = await supabase.auth.admin.createUser({ email, password: QA_PASSWORD, email_confirm: true });
      if (error) {
        const listed = await supabase.auth.admin.listUsers({ perPage: 1000 });
        const existing = listed.data.users.find((user) => user.email === email);
        if (!existing) throw error;
        authIds[key] = existing.id;
      } else authIds[key] = data.user.id;
      await sql`insert into auth.users(id,email) values (${authIds[key]!},${email}) on conflict (id) do nothing`;
    }

    await sql`insert into business.businesses(id,provisioning_key,display_name,timezone,status) values
      (${ids.b1},'qa-b1-key','Young KingZ QA B1','America/Argentina/Buenos_Aires','ACTIVE'),
      (${ids.b2},'qa-b2-key','Young KingZ QA B2','America/Argentina/Buenos_Aires','ACTIVE')
      on conflict (id) do nothing`;

    const people = [
      [ids.personOwner, "Owner", "QA", "owner", ids.owner, ids.staffOwner, ids.b1, "OWNER"],
      [ids.personReception, "Recepción", "QA", "reception", ids.reception, ids.staffReception, ids.b1, "RECEPTIONIST"],
      [ids.personBarber, "Barbero", "QA", "barber", ids.barber, ids.staffBarber, ids.b1, "BARBER"],
      [ids.personOwnerB2, "OwnerB2", "QA", "ownerB2", ids.ownerB2, ids.staffOwnerB2, ids.b2, "OWNER"]
    ] as const;
    for (const [personId, first, last, key, accountId, staffId, businessId, role] of people) {
      await sql`insert into iam.persons(id,first_name,last_name) values (${personId},${first},${last}) on conflict (id) do nothing`;
      await sql`insert into iam.user_accounts(id,person_id,auth_user_id,verified_email,status) values (${accountId},${personId},${authIds[key]!},${`${first.toLowerCase()}-qa@youngkingz.local`},'ACTIVE') on conflict (id) do nothing`;
      await sql`insert into team.staff_members(id,business_id,person_id,employment_status,access_status) values (${staffId},${businessId},${personId},'ACTIVE','ACTIVE') on conflict (id) do nothing`;
      await sql`insert into iam.role_assignments(business_id,staff_member_id,role,effective_at) values (${businessId},${staffId},${role},now()) on conflict (staff_member_id,role) where revoked_at is null do nothing`;
    }
    await sql`insert into team.professional_profiles(business_id,staff_member_id,professional_display_name,status)
      select ${ids.b1},${ids.staffBarber},'Barbero QA','ACTIVE'
      where not exists (select 1 from team.professional_profiles where business_id=${ids.b1} and staff_member_id=${ids.staffBarber})`;

    return { ids, emails, authIds, businessIds: { b1: ids.b1, b2: ids.b2 }, staffIds: { owner: ids.staffOwner, reception: ids.staffReception, barber: ids.staffBarber } };
  } finally {
    await sql.end();
  }
}

if (process.argv[1]?.includes("h07-h08-seed")) {
  seedH07H08Qa().then((seed) => console.log(JSON.stringify({ ok: true, businessIds: seed.businessIds, staffIds: seed.staffIds }, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
}
