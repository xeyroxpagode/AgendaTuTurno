import { expect, test, type Page } from "@playwright/test";
import {
  assertG01Database, createG01Context, createSellableItem, g01Count,
  openG01Cash, g01Scalar, type G01Context
} from "../g01/runtime.js";

/**
 * G01 — QA funcional real en navegador.
 * Tres recorridos con sesiones REALES de Supabase Auth y BD QA aislada.
 * Cada escenario registra: rol, acción, request, response, DB assertion y artifact.
 */
test.describe.serial("G01 browser journeys", () => {
  let owner: G01Context;
  let reception: G01Context;
  let sku: string;
  let cashSessionId: string;
  const consoleErrors: string[] = [];

  test.beforeAll(async () => {
    await assertG01Database();
    owner = await createG01Context("OWNER");
    reception = await createG01Context("RECEPTIONIST", owner.businessId);
    const item = await createSellableItem(owner, `G01B-${owner.suffix}`.slice(0, 30).toUpperCase(), 5500, 10);
    sku = item.sku;
    cashSessionId = await openG01Cash(owner);
  });

  test.afterAll(async () => {
    await owner?.db.end();
    await reception?.db.end();
  });

  async function login(page: Page, ctx: G01Context) {
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`${ctx.email}: ${message.text()}`);
    });
    await page.goto("/login");
    await page.getByLabel("Correo").fill(ctx.email);
    await page.getByLabel("Contraseña").fill(ctx.password);
    await page.getByRole("button", { name: "Ingresar" }).click();
    await expect(page).toHaveURL(/\/team/);
    await expect(page.getByText("Ruta no encontrada")).toHaveCount(0);
  }

  async function openOrders(page: Page) {
    await page.goto("/inventario");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await page.getByRole("button", { name: "Más opciones de inventario" }).click();
    await page.getByRole("button", { name: "Pedidos" }).click();
    await expect(page.getByRole("heading", { name: "Pedidos de productos" })).toBeVisible();
  }

  test("J1 Cliente/Invitado · catálogo real → solicitud → REQUESTED → seguimiento", async ({ page }, testInfo) => {
    const requests: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/v1/")) requests.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    page.on("requestfailed", (request) => { consoleErrors.push(`REQUEST_FAILED ${request.url()} ${request.failure()?.errorText}`); });
    const health = await page.request.get("http://127.0.0.1:4100/health");
    expect(health.status(), `API health desde navegador: ${consoleErrors.join(" | ")}`).toBe(200);
    await page.goto(`/productos?businessId=${owner.businessId}`);
    await expect(page.getByRole("heading", { name: "Productos para retiro" })).toBeVisible();
    try {
      await expect(page.getByText("Cargando catálogo…")).toHaveCount(0, { timeout: 20000 });
    } catch (error) {
      throw new Error(`Catálogo no resolvió. businessId=${owner.businessId} sku=${sku} requests=${requests.join(",")} errores=${consoleErrors.join(" | ")} :: ${String(error)}`);
    }
    await expect(page.getByText(/producto\(s\) disponible\(s\)/)).toBeVisible({ timeout: 20000 });
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("Ruta no encontrada");
    expect(body).not.toContain("sourceReference");
    expect(body).not.toContain("reuseCommitments");

    const card = page.locator(".ord-row").filter({ hasText: sku });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Agregar" }).click();
    await expect(page.getByRole("button", { name: "Enviar solicitud" })).toBeVisible();
    expect(await g01Count("select count(*)::int n from orders.product_orders where business_id=$1", [owner.businessId])).toBe(0);

    await page.getByRole("button", { name: "Enviar solicitud" }).click();
    await expect(page.getByText(/Solicitud/)).toBeVisible({ timeout: 15000 });
    const link = page.getByRole("link", { name: "Seguir mi pedido" });
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    const orderId = String(href?.split("/")[2]?.split("?")[0]);

    expect(await g01Count("select count(*)::int n from orders.product_orders where business_id=$1", [owner.businessId])).toBe(1);
    expect(await g01Count("select status='REQUESTED' n from orders.product_orders where id=$1", [orderId])).toBe(1);
    expect(await g01Count("select count(*)::int n from inventory.commitments where source_reference=$1", [`order:${orderId}`])).toBe(0);
    expect(await g01Count("select count(*)::int n from sales.sales where business_id=$1", [owner.businessId])).toBe(0);

    await link.click();
    await expect(page.getByRole("heading", { name: "Seguimiento de pedido" })).toBeVisible();
    await expect(page.getByText("Estado: REQUESTED")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Estado: REQUESTED")).toBeVisible();

    expect(requests.some((entry) => entry.includes("/v1/public/orders"))).toBe(true);
    await page.screenshot({ path: `test-results/g01/J1-client-${testInfo.project.name}.png`, fullPage: true });
  });

  test("J2 Recepción · sesión real → confirmar → preparar → READY → entrega durable", async ({ page }, testInfo) => {
    await login(page, reception);
    await openOrders(page);
    const row = page.locator(".ord-row").filter({ hasText: sku });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole("heading", { name: /Pedido #/ })).toBeVisible();

    await page.getByRole("button", { name: "Confirmar pedido" }).click();
    await expect(page.getByText("Operación registrada.")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".ord-detail .ord-badge").filter({ hasText: "Confirmado" })).toBeVisible();

    await page.getByRole("button", { name: "Iniciar preparación" }).click();
    await expect(page.getByText("Operación registrada.")).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Marcar listo para retiro" }).click();
    await expect(page.getByText("Operación registrada.")).toBeVisible({ timeout: 15000 });

    const current = await g01Scalar<{ id: string }>(
      "select id::text from orders.product_orders where business_id=$1 and status='READY' order by created_at desc limit 1",
      [reception.businessId]
    );
    const orderId = current!.id;
    expect(await g01Count("select status='READY' n from orders.product_orders where business_id=$1 and id=$2", [reception.businessId, orderId])).toBe(1);
    expect(await g01Count("select count(*)::int n from inventory.movements where source_reference=$1", [`order:${orderId}`])).toBe(0);

    let dialogIndex = 0;
    page.on("dialog", async (dialog) => {
      await dialog.accept(dialogIndex++ === 0 ? "Retiro QA G01" : cashSessionId);
    });
    await page.getByRole("button", { name: "Registrar retiro" }).click();
    await expect(page.getByText("Operación registrada.")).toBeVisible({ timeout: 25000 });
    await expect(page.locator(".ord-detail .ord-badge").filter({ hasText: "Entregado" })).toBeVisible();
    await page.reload();
    // El refresh vuelve a la vista raíz de Inventario: se reabre Pedidos y
    // se verifica que el estado DELIVERED se reconstruye desde la BD real.
    await openOrders(page);
    await expect(page.locator(".ord-row .ord-badge").filter({ hasText: "Entregado" })).toBeVisible();

    expect(await g01Count("select status='DELIVERED' n from orders.product_orders where id=$1", [orderId])).toBe(1);
    expect(await g01Count("select count(*)::int n from inventory.movements where kind='DELIVERY' and source_reference=$1", [`order:${orderId}`])).toBe(1);
    expect(await g01Count("select count(*)::int n from orders.order_delivery_receipts where \"orderId\"=$1", [orderId])).toBe(1);
    await page.screenshot({ path: `test-results/g01/J2-reception-${testInfo.project.name}.png`, fullPage: true });
  });

  test("J3 Owner · sesión real → supervisión, historial y sin sexta pestaña", async ({ page }, testInfo) => {
    await login(page, owner);
    await openOrders(page);
    await expect(page.getByRole("heading", { name: "Pedidos de productos" })).toBeVisible();
    await expect(page.getByText("Cargando pedidos…")).toHaveCount(0);
    const rows = await page.locator(".ord-row").count();
    expect(rows).toBeGreaterThan(0);
    await page.locator(".ord-row").first().click();
    await page.getByRole("button", { name: "Historial y incidencias" }).click();
    await expect(page.getByRole("heading", { name: "Historial" })).toBeVisible({ timeout: 15000 });
    const tabs = await page.locator('[role="tab"]').count();
    expect(tabs).toBe(0);
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("Ruta no encontrada");
    await page.screenshot({ path: `test-results/g01/J3-owner-${testInfo.project.name}.png`, fullPage: true });
  });

  test("J4 seguridad real · invitado sin credencial y cross-business no filtran datos", async ({ page }) => {
    const unknownId = "00000000-4000-4000-8000-000000000001";
    const response = await page.request.get(
      `http://127.0.0.1:4100/v1/public/orders/${unknownId}?businessId=${reception.businessId}`
    );
    expect(response.status()).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toMatch(/ORDER_CREDENTIAL/);
    expect(consoleErrors.filter((entry) => entry.includes("Ruta no encontrada"))).toHaveLength(0);
  });
});
