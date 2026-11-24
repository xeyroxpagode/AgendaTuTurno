import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
process.loadEnvFile?.(".env");
const sql = postgres("postgresql://postgres:postgres@127.0.0.1:56022/youngkingz_h07_qa_20261124", { max: 1 });
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const { data } = await s.auth.signInWithPassword({ email: "owner-qa@youngkingz.local", password: "QaTestPass2026!x" });
const [row] = await sql`select s.id,s.status::text,c.title from courses.course_sessions s join courses.courses c on c.id=s.course_id where c.title like 'QA J07 Ciclo%' order by s.created_at desc limit 1`;
console.log("BEFORE", row);
if (row) {
  const r = await fetch(`http://127.0.0.1:4100/v1/course-sessions/${row.id}/confirm`, { method: "POST", headers: { authorization: `Bearer ${data.session.access_token}`, "x-operation-id": crypto.randomUUID() } });
  console.log("API", r.status, (await r.text()).slice(0, 400));
  const [after] = await sql`select id,status::text,revision from courses.course_sessions where id=${row.id}`;
  console.log("AFTER", after);
}
await sql.end();
