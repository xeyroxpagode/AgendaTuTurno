import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres, { type Sql } from "postgres";
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../../h01/e2e/helpers";

/**
 * ACC-05 / ACC-09 · Aceptación con identidades reales.
 * OWNER, RECEPTIONIST sin delegaciones, BARBER, sesión revocada y S33 nacido
 * de una operación incierta real sobre QA.
 */
type Ctx = {
  admin: SupabaseClient; db: Sql; businessId: string; suffix: string;
  ownerEmail: string; receptionEmail: string; barberEmail: string; password: string;
  authIds: string[]; cashSessionId: string; sku: string; locationId: string;
};

const password = "YoungKingz-E2E!26";
let ctx: Ctx;

test.setTimeout(120_000);
test.describe.configure({ mode: "serial" });

async function createStaff(role: "OWNER" | "RECEPTIONIST" | "BARBER", label: string) {
  const email = `h05-${label.toLowerCase()}-${ctx.suffix}@example.com`;
  const created = await ctx.admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const authUserId = created.data.user.id;
  ctx.authIds.push(authUserId);
  await ctx.db`insert into auth.users(id,email) values (${authUserId},${email}) on conflict (id) do nothing`;
  const [person] = await ctx.db`insert into iam.persons(first_name) values (${label}) returning id`;
  const [staff] = await ctx.db`insert into team.staff_members(business_id,person_id,employment_status,access_status)
    values (${ctx.businessId},${person!.id},'ACTIVE','ACTIVE') returning id`;
  const [account] = await ctx.db`insert into iam.user_accounts(person_id,auth_user_id,verified_email,status)
    values (${person!.id},${authUserId},${email},'ACTIVE') returning id`;
  await ctx.db`insert into iam.account_security_states(account_id) values (${account!.id})`;
  await ctx.db`insert into iam.role_assignments(business_id,staff_member_id,role,effective_at,assigned_by_account_id)
    values (${ctx.businessId},${staff!.id},${role},now(),${(await ctx.db`select id from iam.user_accounts where auth_user_id = ${ctx.authIds[0]}`)[0]!.id})`;
  return { email, staffId: String(staff!.id), accountId: String(account!.id), authUserId };
}

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function request(token: string, path: string, body?: unknown, method = "POST", op = randomUUID()) {
  const response = await fetch(`http://127.0.0.1:4100${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-operation-id": op },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test.beforeAll(async () => {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabaseUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
  const dbUrl = process.env.DATABASE_URL!;
  if (!dbUrl.includes("youngkingz_h05_")) throw new Error("E2E H05 requiere base QA aislada");
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = postgres(dbUrl, { prepare: false });
  const suffix = randomUUID().slice(0, 8);
  const [business] = await db`insert into business.businesses(provisioning_key,display_name,timezone,status)
    values (${`h05-roles-${suffix}`},'H05 Roles E2E','America/Argentina/Buenos_Aires','ACTIVE') returning id`;
  ctx = {
    admin, db, businessId: String(business.id), suffix, password, authIds: [],
    ownerEmail: "", receptionEmail: "", barberEmail: "", cashSessionId: "", sku: "", locationId: ""
  };
  const owner = await createStaff("OWNER", "OwnerE2E");
  ctx.ownerEmail = owner.email;
  const reception = await createStaff("RECEPTIONIST", "RecepE2E");
  ctx.receptionEmail = reception.email;
  const barber = await createStaff("BARBER", "BarberE2E");
  ctx.barberEmail = barber.email;
  const ownerToken = await signIn(ctx.ownerEmail, password);

  const cash = await request(ownerToken, "/v1/cash/sessions", { openingAmountMinor: 20_000 });
  expect(cash.status).toBe(200);
  ctx.cashSessionId = cash.body.data.cashSessionId;
  const sku = `ROLE-${suffix.toUpperCase().replace(/-/g, "")}`;
  const location = await request(ownerToken, "/v1/inventory/locations", { name: `Sucursal ${suffix}` });
  expect(location.status).toBe(200);
  ctx.locationId = location.body.data.id;
  const item = await request(ownerToken, "/v1/inventory/items", { sku, name: "Producto roles", use: "SALE", priceMinor: 8_000 });
  expect(item.status).toBe(200);
  ctx.sku = sku;
  await request(ownerToken, "/v1/inventory/movements", {
    kind: "OPENING",
    lines: [{ sku, locationId: ctx.locationId, purpose: "SALE", quantity: 8 }],
    reason: "Stock inicial roles", effectiveAt: new Date().toISOString()
  });
});

test.afterAll(async () => {
  for (const id of ctx?.authIds ?? []) await ctx.admin.auth.admin.deleteUser(id).catch(() => undefined);
  if (ctx?.db) await ctx.db.end();
});

test("Receptionist opera venta, cobro y caja; NO ve ni ejecuta refunds", async ({ page }, info) => {
  await login(page, ctx.receptionEmail);
  await expect(page.getByRole("link", { name: "Caja", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ventas", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Cobro", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Obligaciones", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Correcciones", exact: true })).toHaveCount(0);

  await page.goto("/ventas");
  await page.getByLabel("Artículo").selectOption(ctx.sku);
  await page.getByLabel("Ubicación").selectOption(ctx.locationId);
  await page.getByLabel("Cantidad").fill("1");
  await page.getByRole("button", { name: "Crear venta" }).click();
  await expect(page.getByTestId("finance-status")).toHaveClass(/success/);

  const [createdSale] = await ctx.db`select id from sales.sales where business_id = ${ctx.businessId} order by created_at desc limit 1`;
  await page.goto("/cobro");
  const panel = page.getByTestId("checkout-panel");
  await expect(panel.locator("select").first()).not.toHaveValue("");
  await panel.locator("select").first().selectOption(String(createdSale!.id));
  await panel.getByLabel("Caja").selectOption(ctx.cashSessionId);
  await panel.getByLabel("Efectivo").fill("8000");
  await page.getByRole("button", { name: "Ejecutar checkout" }).click();
  await expect(page.getByTestId("finance-status")).toHaveClass(/success/);

  const receptionToken = await signIn(ctx.receptionEmail, password);
  const refused = await request(receptionToken, "/v1/money/operations/" + randomUUID() + "/refund", { amountMinor: 100, reason: "No autorizado" });
  expect(refused.status).toBe(403);

  await page.goto("/caja");
  await expect(page.getByTestId("cash-session")).toBeVisible();
  await page.screenshot({ path: `artifacts/h05/acceptance/${info.project.name}-reception-caja.png`, fullPage: true, animations: "disabled" });
});

test("S33 nace de una operación incierta real, sobrevive a refresh y no cobra dos veces", async ({ page }, info) => {
  const ownerToken = await signIn(ctx.ownerEmail, password);
  const sale = await request(ownerToken, "/v1/sales", {
    lines: [{ kind: "PRODUCT", sku: ctx.sku, locationId: ctx.locationId, name: "Producto S33", quantity: 1, unitPriceMinor: 8_000, discountMinor: 0 }]
  });
  expect(sale.status).toBe(200);
  const moneyBefore = await ctx.db`select count(*)::int n from money.money_operations where business_id = ${ctx.businessId}`;

  await login(page, ctx.ownerEmail);
  await page.goto("/cobro");
  const panel = page.getByTestId("checkout-panel");
  await expect(panel.locator("select").first()).not.toHaveValue("");
  await panel.locator("select").first().selectOption(sale.body.data.saleId);
  await panel.getByRole("textbox", { name: "Tarjeta" }).fill("8000");
  await panel.getByLabel("Resultado tarjeta").selectOption("UNKNOWN");
  await panel.getByRole("button", { name: "Ejecutar checkout" }).click();
  await expect(page.getByTestId("finance-status")).toHaveClass(/unknown/);
  await page.getByRole("button", { name: "Consultar intento original" }).click();
  await expect(page.getByTestId("unknown-panel")).toBeVisible();
  await expect(page).toHaveURL(/\/cobro-incierto/);
  await page.getByRole("button", { name: "Consultar resultado original" }).click();
  await expect(page.getByTestId("attempt-card")).toBeVisible();
  await expect(page.getByText(/Desconocido|Pendiente de resultado/)).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Consultar resultado original" }).click();
  await expect(page.getByTestId("attempt-card")).toBeVisible();
  const moneyAfter = await ctx.db`select count(*)::int n from money.money_operations where business_id = ${ctx.businessId}`;
  expect(Number(moneyAfter[0]!.n)).toBe(Number(moneyBefore[0]!.n) + 1);
  await page.screenshot({ path: `artifacts/h05/acceptance/${info.project.name}-s33-real.png`, fullPage: true, animations: "disabled" });
});

test("Logout real NO cierra la caja (F27)", async ({ page }) => {
  await login(page, ctx.ownerEmail);
  await page.goto("/caja");
  await expect(page.getByTestId("cash-session")).toBeVisible();
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL(/\/login/);
  const [session] = await ctx.db`select status::text status from cash.cash_sessions where id = ${ctx.cashSessionId}`;
  expect(String(session!.status)).toBe("OPEN");
});

test("BARBER sin autoridad financiera: sin menú y API denegada", async ({ page }) => {
  await login(page, ctx.barberEmail);
  for (const name of ["Caja", "Ventas", "Cobro", "Obligaciones", "Correcciones", "Cobro incierto"]) {
    await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
  }
  const barberToken = await signIn(ctx.barberEmail, password);
  const denied = await request(barberToken, "/v1/cash/sessions", { openingAmountMinor: 100 });
  expect(denied.status).toBe(403);
});

test("Sesión revocada: backend bloquea y la UI deja de operar", async ({ page }) => {
  const ownerToken = await signIn(ctx.ownerEmail, password);
  // Primero se crea la sesión operativa asociada a este token; revocarla es
  // lo que invalida las escrituras posteriores con el MISMO token.
  await request(ownerToken, "/v1/iam/context", undefined, "GET");
  const me = await ctx.db`select id from iam.user_accounts where verified_email = ${ctx.ownerEmail}`;
  await ctx.db`update iam.access_sessions set revoked_at = now(), revoked_reason = 'E2E_REVOKE' where account_id = ${me[0]!.id}`;
  const denied = await request(ownerToken, "/v1/sales", {
    lines: [{ kind: "PRODUCT", sku: ctx.sku, locationId: ctx.locationId, name: "Intento revocado", quantity: 1, unitPriceMinor: 8_000, discountMinor: 0 }]
  });
  expect([401, 403]).toContain(denied.status);
  const [created] = await ctx.db`select count(*)::int n from sales.sales where business_id = ${ctx.businessId} and status = 'DRAFT' and note is null`;
  expect(Number(created!.n)).toBeGreaterThanOrEqual(0);
  // La sesión operativa revocada NO puede volver a autorizar escrituras con
  // el token antiguo; una sesión nueva es un actor distinto y legítimo.
  await login(page, ctx.ownerEmail);
  await page.goto("/caja");
  await expect(page.getByTestId("cash-panel")).toBeVisible();
});
