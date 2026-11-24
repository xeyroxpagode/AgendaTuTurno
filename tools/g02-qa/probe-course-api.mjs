import { createClient } from "@supabase/supabase-js";
process.loadEnvFile?.(".env");
const courseId = process.argv[2];
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const { data, error } = await s.auth.signInWithPassword({ email: "owner-qa@youngkingz.local", password: "QaTestPass2026!x" });
if (error) throw new Error(error.message);
const headers = { authorization: `Bearer ${data.session.access_token}` };
const paths = [`/v1/courses/${courseId}/sessions`, `/v1/courses/${courseId}/history`, `/v1/course-events?courseId=${courseId}`, `/v1/courses`];
for (const p of paths) {
  try {
    const r = await fetch(`http://127.0.0.1:4100${p}`, { headers });
    console.log(p, r.status, (await r.text()).slice(0, 400));
  } catch (e) { console.log(p, "ERROR", e.message); }
}
