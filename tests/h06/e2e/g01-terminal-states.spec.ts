import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  assertG01Database, createG01Context, createSellableItem, g01Count, g01Scalar,
  type G01Context
} from "../g01/runtime.js";

/** FC-01 — estados terminales ejecutados en navegador real con sesiones reales. */
test.describe.serial("G01 terminal states (REJECTED / CANCELLED)", () => {
  let owner: G01Context;
  let sku: string;

  test.beforeAll(async () => {
    await assertG01Database();
    owner = await createG01Context("OWNER");
    const item = await createSellableItem(owner, `TER-${owner.suffix}`.slice(0, 30).toUpperCase(), 7000, 10);
    sku = item.sku;
  });
  test.afterAll(async () => { await owner?.db.end(); });

  async function createGuestOrder(page: Page): Promise<string> {
    const response = await page.request.post("http://127.0.0.1:4100/v1/public/orders", {
      headers: { "content-type": "application/json", "x-operation-id": randomUUID() },
      data: { businessId: owner.businessId, lines: [{ sku, quantity: 1 }] }
    });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { data: { id: string; status: string } };
    expect(body.data.status).toBe("REQUESTED");
    return body.data.id;
  }

  async function loginAndOpen(page: Page) {
    await page.goto("/login");
    await page.getByLabel("Correo").fill(owner.email);
    await page.getByLabel("Contraseña").fill(owner.password);
    await page.getByRole("button", { name: "Ingresar" }).click();
    await expect(page).toHaveURL(/\/team/);
    await page.goto("/inventario");
    await page.getByRole("button", { name: "Más opciones de inventario" }).click();
    await page.getByRole("button", { name: "Pedidos" }).click();
    await expect(page.getByRole("heading", { name: "Pedidos de productos" })).toBeVisible();
    await expect(page.getByText("Cargando pedidos…")).toHaveCount(0);
  }

  test("FC-01a REQUESTED → REJECTED con motivo, persistencia, historial y refresh", async ({ page }, info) => {
    const orderId = await createGuestOrder(page);
    await loginAndOpen(page);
    const row = page.locator(".ord-row").filter({ hasText: orderId.slice(0, 8) });
    await expect(row).toBeVisible();
    await row.click();
    page.once("dialog", (dialog) => dialog.accept("Producto sin stock permanente - QA"));
    await page.getByRole("button", { name: "Rechazar" }).click();
    await expect(page.getByText("Operación registrada.")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".ord-detail .ord-badge").filter({ hasText: "Rechazado" })).toBeVisible();

    expect(await g01Count("select status='REJECTED' n from orders.product_orders where id=$1", [orderId])).toBe(1);
    expect(await g01Count("select rejection_reason is not null n from orders.product_orders where id=$1", [orderId])).toBe(1);
    expect(await g01Count("select count(*)::int n from orders.order_transitions where \"orderId\"=$1 and \"toStatus\"='REJECTED'", [orderId])).toBe(1);
    await page.reload();
    await page.goto("/inventario");
    await page.getByRole("button", { name: "Más opciones de inventario" }).click();
    await page.getByRole("button", { name: "Pedidos" }).click();
    await expect(page.locator(".ord-row").filter({ hasText: orderId.slice(0, 8) }).locator(".ord-badge").filter({ hasText: "Rechazado" })).toBeVisible();
    await page.screenshot({ path: `test-results/g01/REJECTED-${info.project.name}.png`, fullPage: true });
  });

  test("FC-01b CONFIRMED → CANCELLED con liberación de commitments y refresh", async ({ page }, info) => {
    const orderId = await createGuestOrder(page);
    await loginAndOpen(page);
    const row = page.locator(".ord-row").filter({ hasText: orderId.slice(0, 8) });
    await expect(row).toBeVisible();
    await row.click();
    await page.getByRole("button", { name: "Confirmar pedido" }).click();
    await expect(page.getByText("Operación registrada.")).toBeVisible({ timeout: 15000 });
    expect(await g01Count("select count(*)::int n from inventory.commitments where source_reference=$1 and state='ACTIVE'", [`order:${orderId}`])).toBe(1);

    const apiErrors: string[] = [];
    page.on("response", async (response) => {
      if (response.status() >= 400 && response.url().includes("/v1/")) {
        apiErrors.push(`${response.status()} ${new URL(response.url()).pathname} ${(await response.text().catch(() => "")).slice(0, 400)}`);
      }
    });
    page.once("dialog", (dialog) => dialog.accept("Cancelación autorizada QA"));
    await page.getByRole("button", { name: "Cancelar" }).click();
    try {
      await expect(page.getByText("Operación registrada.")).toBeVisible({ timeout: 15000 });
    } catch (error) {
      throw new Error(`Cancel UI error: ${apiErrors.join(" | ")} :: ${String(error)}`);
    }
    await expect(page.locator(".ord-detail .ord-badge").filter({ hasText: "Cancelado" })).toBeVisible();

    expect(await g01Count("select status='CANCELLED' n from orders.product_orders where id=$1", [orderId])).toBe(1);
    expect(await g01Count("select count(*)::int n from inventory.commitments where source_reference=$1 and state='ACTIVE'", [`order:${orderId}`])).toBe(0);
    expect(await g01Count("select count(*)::int n from inventory.commitments where source_reference=$1 and state='RELEASED'", [`order:${orderId}`])).toBe(1);
    expect(await g01Count("select count(*)::int n from orders.order_transitions where \"orderId\"=$1 and \"toStatus\"='CANCELLED'", [orderId])).toBe(1);
    await page.reload();
    await page.goto("/inventario");
    await page.getByRole("button", { name: "Más opciones de inventario" }).click();
    await page.getByRole("button", { name: "Pedidos" }).click();
    await expect(page.locator(".ord-row").filter({ hasText: orderId.slice(0, 8) }).locator(".ord-badge").filter({ hasText: "Cancelado" })).toBeVisible();
    await page.screenshot({ path: `test-results/g01/CANCELLED-${info.project.name}.png`, fullPage: true });
    void g01Scalar;
  });
});
