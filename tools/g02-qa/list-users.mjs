import { createClient } from "@supabase/supabase-js";
process.loadEnvFile?.(".env");
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const { data, error } = await s.auth.admin.listUsers({ perPage: 1000 });
console.log(JSON.stringify({ error: error?.message ?? null, users: (data?.users ?? []).map((u) => ({ email: u.email, id: u.id })) }, null, 2));
