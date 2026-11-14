import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const origin = "http://localhost:3100";
const phone = "+5491100000001";
const password = "YoungKingz-Client!26";
const supabaseUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
const db = postgres(databaseUrl, { prepare: false });
let accountId = "";
let personId = "";
let authUserId = "";

function base32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = "";
  for (const char of value.replace(/=+$/g, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
}
function totp(secret: string): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", base32(secret)).update(counter).digest(); const offset = digest.at(-1)! & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
async function fixtureUser() {
  const result = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  return result.data.users.find((user) => (user.phone ?? "").replace(/^\+/, "") === phone.replace(/^\+/, ""));
}

test.setTimeout(90_000);
test.beforeAll(async () => { const existing = await fixtureUser(); if (existing) await admin.auth.admin.deleteUser(existing.id); });
test.afterAll(async () => {
  const user = await fixtureUser(); if (user) authUserId = user.id;
  if (authUserId && !accountId) { const accounts = await db`select id,person_id from iam.user_accounts where auth_user_id=${authUserId}`; accountId = accounts[0]?.id ?? ""; personId = accounts[0]?.person_id ?? ""; }
  if (accountId) {
    await db`delete from iam.client_security_events where account_id=${accountId}`;
    await db`delete from iam.client_recovery_operations where account_id=${accountId}`;
    await db`delete from iam.client_recovery_codes where account_id=${accountId}`;
    await db`delete from iam.client_phone_change_states where account_id=${accountId}`;
    await db`delete from iam.client_access_sessions where account_id=${accountId}`;
    await db`delete from iam.client_operations where account_id=${accountId}`;
    await db`delete from iam.client_identity_states where account_id=${accountId}`;
    await db`delete from iam.account_security_states where account_id=${accountId}`;
    await db`delete from iam.user_accounts where id=${accountId}`;
  }
  if (personId) await db`delete from iam.persons where id=${personId}`;
  if (user) await admin.auth.admin.deleteUser(user.id);
  await db.end();
});

test("H01-H03/H09-H10 registro completo mobile, TOTP, códigos y cuenta privada", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/cliente/registro`);
  await expect(page.getByRole("heading", { name: "Creá tu cuenta" })).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByLabel("Nombre").fill("E2E");
  await page.getByLabel("Apellido (opcional)").fill("Cliente");
  await page.getByLabel("Teléfono").fill(phone);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByLabel("Confirmar contraseña").fill(password);
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL(/\/cliente\/verificar/);

  await page.getByLabel("Código SMS").fill("111111");
  await page.getByLabel("Contraseña registrada").fill(password);
  await page.getByRole("button", { name: "Verificar y continuar" }).click();
  await expect(page).toHaveURL(/\/cliente\/seguridad\/autenticador/);

  const secret = (await page.locator(".totp-setup code").textContent())!.trim();
  await page.getByLabel("Código de 6 dígitos").fill(totp(secret));
  await page.getByRole("button", { name: "Confirmar autenticador" }).click();
  await expect(page).toHaveURL(/\/cliente\/seguridad\/codigos/);
  await expect(page.locator(".recovery-grid code")).toHaveCount(8);
  await page.getByLabel("Los guardé en un lugar seguro").check();
  await page.getByRole("button", { name: "Activar mi cuenta" }).click();
  await expect(page).toHaveURL(/\/cliente\/mis-cosas/);
  await expect(page.getByRole("heading", { name: "Mis cosas" })).toBeVisible();
  await expect(page.getByText("E2E Cliente")).toBeVisible();

  const account = await db`select id,person_id from iam.user_accounts where auth_user_id=(select id from auth.users where phone=${phone.replace(/^\+/, "")})`;
  accountId = account[0]!.id; personId = account[0]!.person_id;
  const crm = await db`select id from clients.client_account_links where account_id=${accountId}`;
  expect(crm).toHaveLength(0);
});

test("H02 login habitual no solicita SMS y rutas privadas redirigen sin sesión", async ({ browser }) => {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(`${origin}/cliente/ingresar`);
  await expect(page.getByLabel("Teléfono")).toBeVisible();
  await expect(page.getByLabel("Contraseña")).toBeVisible();
  await expect(page.getByLabel("Código SMS")).toHaveCount(0);
  await page.goto(`${origin}/cliente/mis-cosas`);
  await expect(page).toHaveURL(/\/cliente\/ingresar/);
  await context.close();
});
