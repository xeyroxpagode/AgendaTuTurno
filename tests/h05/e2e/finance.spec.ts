import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres, { type Sql } from "postgres";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { signIn } from "../../h01/e2e/helpers";

/**
 * H05 · E2E real (Owner) sobre PostgreSQL QA aislado + backend + navegador.
 * Cubre F42 (responsive) y la regla de UX "nunca mostrar éxito antes de la
 * confirmación real del servidor" (S33 / UNKNOWN).
 */
type H05Ctx = {
  admin: SupabaseClient; db: Sql; suffix: string; email: string; password: string;
  authUserId: string; businessId: string;
};

/**
 * Contexto E2E sobre la base QA H05.
 *
 * GoTrue vive en la base local de Supabase; la base QA H05 tiene un shim
 * mínimo `auth.users`. Se inserta la fila espejo para satisfacer la FK de
 * `iam.user_accounts` sin tocar la base de trabajo de Supabase.
 */
async function createH05OwnerContext(): Promise<H05Ctx> {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabaseUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
  const dbUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = postgres(dbUrl, { prepare: false });
  const suffix = randomUUID().slice(0, 8);
  const email = `h05-owner-${suffix}@example.com`;
  const password = "YoungKingz-E2E!26";
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const authUserId = created.data.user.id;
  await db`insert into auth.users(id,email) values (${authUserId},${email}) on conflict (id) do nothing`;
  const [business] = await db`insert into business.businesses(provisioning_key,display_name,timezone,status)
    values (${`h05-e2e-${suffix}`},'H05 E2E','America/Argentina/Buenos_Aires','ACTIVE') returning id`;
  const [person] = await db`insert into iam.persons(first_name,last_name) values ('Owner','H05 E2E') returning id`;
  const [staff] = await db`insert into team.staff_members(business_id,person_id,employment_status,access_status)
    values (${business.id},${person.id},'ACTIVE','ACTIVE') returning id`;
  const [account] = await db`insert into iam.user_accounts(person_id,auth_user_id,verified_email,status)
    values (${person.id},${authUserId},${email},'ACTIVE') returning id`;
  await db`insert into iam.account_security_states(account_id) values (${account.id})`;
  await db`insert into iam.role_assignments(business_id,staff_member_id,role,effective_at,assigned_by_account_id)
    values (${business.id},${staff.id},'OWNER',now(),${account.id})`;
  return { admin, db, suffix, email, password, authUserId, businessId: String(business.id) };
}

let ctx: H05Ctx;
let token: string;
let operationId = "";

test.setTimeout(90_000);
test.describe.configure({ mode: "serial" });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(ctx.email);
  await page.getByLabel("Contraseña").fill(ctx.password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function request(path: string, body?: unknown, method = "POST", op = randomUUID()) {
  const response = await fetch(`http://127.0.0.1:4100${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-operation-id": op },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test.beforeAll(async () => {
  ctx = await createH05OwnerContext();
  token = await signIn(ctx.email, ctx.password);
  const cash = await request("/v1/cash/sessions", { openingAmountMinor: 20_000 });
  expect(cash.status).toBe(200);
  const location = await request("/v1/inventory/locations", { name: `Caja E2E ${ctx.suffix}` });
  expect(location.status).toBe(200);
  const sku = `E2E-${ctx.suffix.toUpperCase().replace(/-/g, "")}`;
  const item = await request("/v1/inventory/items", {
    sku, name: "Producto H05 E2E", use: "SALE", priceMinor: 9_000
  });
  expect(item.status).toBe(200);
  await request("/v1/inventory/movements", {
    kind: "OPENING",
    lines: [{ sku, locationId: location.body.data.id, purpose: "SALE", quantity: 4 }],
    reason: "Stock inicial E2E",
    effectiveAt: new Date().toISOString()
  });
  const sale = await request("/v1/sales", {
    lines: [{ kind: "PRODUCT", sku, locationId: location.body.data.id, name: "Producto H05 E2E", quantity: 1, unitPriceMinor: 9_000, discountMinor: 0 }]
  });
  expect(sale.status).toBe(200);
  operationId = randomUUID();
  const checkout = await request("/v1/checkout", {
    saleId: sale.body.data.saleId,
    components: [{ method: "CARD", amountMinor: 9_000, outcome: "UNKNOWN" }],
    deliver: false
  }, "POST", operationId);
  expect(checkout.status).toBe(200);
  await mkdir("artifacts/h05/e2e", { recursive: true });
});

test.afterAll(async () => {
  // Los hechos H05 quedan como evidencia en la base QA descartable; sólo se
  // retira la identidad efímera de GoTrue.
  if (ctx?.db) await ctx.db.end();
  if (ctx?.authUserId) await ctx.admin.auth.admin.deleteUser(ctx.authUserId).catch(() => undefined);
});

test("Owner navega las superficies H05 con permisos reales", async ({ page }, info) => {
  await login(page);
  await expect(page.getByRole("link", { name: "Caja", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ventas", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Cobro", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Cobro incierto", exact: true })).toBeVisible();

  for (const [path, testid] of [
    ["/caja", "cash-panel"], ["/ventas", "sales-panel"], ["/cobro", "checkout-panel"],
    ["/finanzas", "obligations-panel"], ["/correcciones", "corrections-panel"], ["/cobro-incierto", "unknown-panel"]
  ] as const) {
    await page.goto(path);
    await expect(page.getByTestId(testid)).toBeVisible();
  }

  await page.goto("/caja");
  await expect(page.getByTestId("cash-session")).toBeVisible();
  await page.screenshot({ path: `artifacts/h05/e2e/${info.project.name}-caja.png`, fullPage: true, animations: "disabled", scale: "css" });
  const a11y = await new AxeBuilder({ page }).include('[data-testid="finance-workspace"]').analyze();
  expect(a11y.violations).toEqual([]);
});

test("S33 conserva el attemptId y consulta el resultado original sin cobrar de nuevo", async ({ page }, info) => {
  await login(page);
  await page.goto("/cobro-incierto");
  await page.evaluate((id) => window.sessionStorage.setItem("yk-h05-last-attempt", id), operationId);
  await page.reload();
  await page.getByRole("button", { name: "Consultar resultado original" }).click();
  await expect(page.getByTestId("attempt-card")).toBeVisible();
  await expect(page.getByText(/Desconocido|Pendiente de resultado/)).toBeVisible();

  const before = await ctx.db`select count(*)::int n from money.money_operations where business_id = ${ctx.businessId}`;
  await page.getByRole("button", { name: "Consultar resultado original" }).click();
  const after = await ctx.db`select count(*)::int n from money.money_operations where business_id = ${ctx.businessId}`;
  expect(Number(after[0]!.n)).toBe(Number(before[0]!.n)); // la consulta NO cobra dos veces
  await page.screenshot({ path: `artifacts/h05/e2e/${info.project.name}-s33.png`, fullPage: true, animations: "disabled", scale: "css" });
});

test("La UI no muestra éxito si el servidor no confirmó la operación", async ({ page }) => {
  await login(page);
  await page.goto("/caja");
  await page.route("**/v1/cash/sessions", async (route) => {
    if (route.request().method() === "POST") { await route.abort("failed"); return; }
    await route.continue();
  });
  await page.getByLabel("Fondo inicial (ARS)").fill("30000");
  await page.getByRole("button", { name: "Abrir caja" }).click();
  await expect(page.getByTestId("finance-status")).toHaveClass(/error/);
  await expect(page.getByTestId("finance-status")).not.toContainText("confirmada");
});

for (const viewport of [{ width: 390, height: 844 }, { width: 410, height: 892 }, { width: 1440, height: 900 }]) {
  test(`Responsive ${viewport.width}px sin desbordamiento`, async ({ page }) => {
    await login(page);
    await page.setViewportSize(viewport);
    for (const path of ["/caja", "/ventas", "/cobro", "/cobro-incierto"]) {
      await page.goto(path);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });
}
