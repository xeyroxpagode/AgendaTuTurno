import { createClient } from "@supabase/supabase-js";
process.loadEnvFile?.(".env");
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const email = "owner-qa@youngkingz.local";
const password = "QaTestPass2026!x";
const { data, error } = await s.auth.signInWithPassword({ email, password });
console.log(JSON.stringify({ ok: !!data?.session, error: error ? { message: error.message, status: error.status, code: error.code } : null }, null, 2));
