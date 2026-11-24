import { createClient } from "@supabase/supabase-js";
process.loadEnvFile?.(".env");
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const { data, error } = await s.auth.signInWithPassword({ email: "owner-qa@youngkingz.local", password: "QaTestPass2026!x" });
if (error) throw new Error(error.message);
const r = await fetch("http://127.0.0.1:4100/v1/professionals?limit=100", { headers: { authorization: `Bearer ${data.session.access_token}` } });
const body = await r.text();
console.log(JSON.stringify({ status: r.status, body: body.slice(0, 2000) }, null, 2));
