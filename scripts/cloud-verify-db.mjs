// Verificación Cloud read-only: cuenta migraciones y tablas de dominio.
// Uso: DATABASE_URL=... node scripts/cloud-verify-db.mjs
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL requerido");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", max: 1, connect_timeout: 15 });
try {
  const [result] = await sql`
    select
      (select count(*)::int from supabase_migrations.schema_migrations) as migrations,
      (select count(*)::int from information_schema.tables
        where table_schema in ('business','iam','team','catalog','clients','booking','availability',
          'absence','attendance','inventory','sales','money','cash','obligations','corrections',
          'checkout','orders','courses','econ','system')) as domain_tables
  `;
  console.log(`migrations=${result.migrations} domain_tables=${result.domain_tables}`);
} catch (error) {
  console.error(`DB_VERIFY_FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
