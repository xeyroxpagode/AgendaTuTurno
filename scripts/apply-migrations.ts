import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

/**
 * Runner de migraciones de YoungKingz sobre PostgreSQL QA AISLADO.
 *
 * Motivo de existir: en este entorno el CLI de Supabase no puede leer
 * `supabase/config.toml` (clave `local_smtp` no reconocida por la versión
 * instalada), de modo que `supabase db reset` no es utilizable. Este runner
 * aplica EXACTAMENTE los mismos archivos SQL versionados en
 * `supabase/migrations/`, en orden lexicográfico, registrando las versiones
 * aplicadas.
 *
 * Guardas de seguridad (no negociables):
 *  · la configuración debe declarar el proyecto local aislado
 *    `project_id = "youngkingz-h01"` y `port = 55322`;
 *  · la base destino DEBE llamarse `youngkingz_h05_*` (o `youngkingz_h04_*`
 *    para la ruta de upgrade) — nunca `postgres`, nunca producción;
 *  · el host DEBE ser loopback.
 *
 * Uso:
 *   pnpm exec tsx scripts/apply-migrations.ts --database youngkingz_h05_qa_20261116
 *   pnpm exec tsx scripts/apply-migrations.ts --database youngkingz_h05_qa_20261116 --from 202611160001
 */

const EXPECTED_PROJECT = 'project_id = "youngkingz-h01"';
const EXPECTED_PORT = "port = 55322";
const LOOPBACK = /^127\.0\.0\.1$|^localhost$/i;
const ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

interface Arguments {
  database: string;
  from?: string;
  template?: string;
  dryRun: boolean;
}

function optionValue(argv: string[], name: string): string | undefined {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.split("=").slice(1).join("=");
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1] && !argv[index + 1]!.startsWith("--")) return argv[index + 1]!;
  return undefined;
}

function parseArguments(argv: string[]): Arguments {
  const database = optionValue(argv, "--database");
  if (!database) throw new Error("Falta --database <nombre>.");
  const from = optionValue(argv, "--from");
  const template = optionValue(argv, "--template");
  return { database, from, template, dryRun: argv.includes("--dry-run") };
}

async function assertIsolatedTarget(root: string, database: string): Promise<void> {
  const config = await readFile(resolve(root, "supabase/config.toml"), "utf8");
  if (!config.includes(EXPECTED_PROJECT) || !config.includes(EXPECTED_PORT)) {
    throw new Error("Target no verificado: la configuración local de Supabase no declara el proyecto aislado.");
  }
  if (!/^youngkingz_h0[456]_/.test(database)) {
    throw new Error(`Refusing operation: la base '${database}' no es una base QA H04/H05/H06 aislada.`);
  }
  const url = new URL(ADMIN_URL);
  if (!LOOPBACK.test(url.hostname)) {
    throw new Error("Refusing operation: el host de la base QA no es loopback.");
  }
}

async function ensureDatabase(database: string): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    const existing = await admin`select datname from pg_database where datname = ${database}`;
    if (!existing.length) {
      await admin.unsafe(`create database "${database}"`);
      console.log(`Base QA creada: ${database}`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Clona una base QA existente como plantilla de una base nueva.
 * Se usa para reproducir la ruta de upgrade desde H04 sin tocar el original.
 */
async function cloneDatabase(source: string, target: string): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    const existing = await admin`select datname from pg_database where datname = ${target}`;
    if (existing.length) {
      await admin.unsafe(`drop database "${target}" with (force)`);
    }
    await admin.unsafe(`create database "${target}" template "${source}"`);
    console.log(`Base QA clonada: ${target} <- ${source}`);
  } finally {
    await admin.end();
  }
}

/**
 * Shim mínimo de la plataforma para bases QA nuevas.
 *
 * El stack local de Supabase crea el esquema `auth` (GoTrue) en su base
 * principal. Una base QA creada desde cero no lo tiene, y la migración H01
 * declara `auth_user_id uuid references auth.users(id)`. Este shim reproduce
 * exactamente la forma que usa la base QA de H04 (`auth.users` con
 * `id`/`email`/`phone`), sin datos reales de identidad.
 */
async function ensurePlatformShim(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key,
      email text,
      phone text
    );
  `);
}

async function appliedVersions(sql: postgres.Sql): Promise<Set<string>> {
  await sql.unsafe(`
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    );
  `);
  const rows = await sql`select version from supabase_migrations.schema_migrations`;
  return new Set(rows.map((row) => String(row.version)));
}

async function main(): Promise<void> {
  const root = process.cwd();
  const args = parseArguments(process.argv.slice(2));
  await assertIsolatedTarget(root, args.database);
  if (args.template) {
    if (!/^youngkingz_h0[456]_/.test(args.template)) {
      throw new Error(`Refusing operation: la plantilla '${args.template}' no es una base QA H04/H05/H06 aislada.`);
    }
    await cloneDatabase(args.template, args.database);
  } else {
    await ensureDatabase(args.database);
  }

  const directory = resolve(root, "supabase/migrations");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();

  const url = `postgresql://postgres:postgres@127.0.0.1:55322/${args.database}`;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await ensurePlatformShim(sql);
    const applied = await appliedVersions(sql);
    const pending = files.filter((file) => {
      const version = file.split("_")[0]!;
      if (applied.has(version)) return false;
      if (args.from && version < args.from) return false;
      return true;
    });
    // Las migraciones omitidas por `--from` se registran como aplicadas: la
    // base de destino ya las contiene (clon desde H04 QA).
    const skipped = files.filter((file) => {
      const version = file.split("_")[0]!;
      return !applied.has(version) && Boolean(args.from) && version < args.from!;
    });

    console.log(`Base ${args.database} · migraciones totales: ${files.length} · pendientes: ${pending.length}`);
    if (!pending.length) { console.log("Nada que aplicar."); return; }
    if (args.dryRun) { for (const file of pending) console.log(`  - ${file}`); return; }

    for (const file of skipped) {
      const version = file.split("_")[0]!;
      await sql`insert into supabase_migrations.schema_migrations(version) values (${version}) on conflict do nothing`;
    }

    for (const file of pending) {
      const version = file.split("_")[0]!;
      const body = await readFile(resolve(directory, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into supabase_migrations.schema_migrations(version) values (${version}) on conflict do nothing`;
      });
      console.log(`  aplicada ${file}`);
    }
    console.log(`Migración completa en ${args.database}.`);
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
