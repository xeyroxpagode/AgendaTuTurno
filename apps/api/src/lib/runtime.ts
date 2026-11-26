import { config } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createDatabase } from "@youngkingz/database";

/**
 * H03.U02 · Resolución de `.env` por candidatos, sin sobrescribir valores ya
 * presentes en el entorno. `dotenv` no pisa variables preexistentes, por lo que
 * `ENV_FILE` y las variables del proceso mandan sobre el archivo.
 */
const envCandidates = [
  process.env.ENV_FILE,
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", ".env"),
  path.resolve(process.cwd(), "..", "..", ".env"),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env")
].filter(Boolean) as string[];
const envPath = envCandidates.find((candidate) => existsSync(candidate));
if (envPath) config({ path: envPath });

export const runtime = {
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
  supabaseUrl: process.env.SUPABASE_URL ?? "http://127.0.0.1:55321",
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  // Cloud (Render) inyecta HOST/PORT. API_HOST/API_PORT se conservan para QA local.
  host: process.env.API_HOST ?? process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 4100),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3100",
  corsAllowlist: (process.env.CORS_ALLOWLIST ?? "http://localhost:3100").split(",").map((o) => o.trim()).filter(Boolean)
};

export const database = createDatabase(runtime.databaseUrl);
export const supabaseAdmin = createClient(runtime.supabaseUrl, runtime.serviceRoleKey || "local-key-required", { auth: { autoRefreshToken: false, persistSession: false } });
