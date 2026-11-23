import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { assertG01Database, createG01Context, createSellableItem, openG01Cash } from "../g01/runtime.js";

/** G0b — capturas reales de los estados comerciales para revisión de Actor A. */
test("G0b · capturas de CONFIRMED / PREPARING / READY / DELIVERED", async ({ page }, info) => {
  await assertG01Database();
  const owner = await createG01Context("OWNER");
  const item = await createSellableItem(owner, `VIS-${owner.suffix}`.slice(0, 30).toUpperCase(), 8000, 5);
  const cashSessionId = await openG01Cash(owner);
  const response = await page.request.post("http://127.0.0.1:4100/v1/public/orders", {
    headers: { "content-type": "application/json", "x-operation-id": randomUUID() },
    data: { businessId: owner.businessId, lines: [{ sku: item.sku, quantity: 1 }] }
  });
  expect(response.status()).toBe(200);
  const orderId = String(((await response.json()) as { data: { id: string } }).data.id);

  await page.goto("/login");
  await page.getByLabel("Correo").fill(owner.email);
  await page.getByLabel("Contraseña").fill(owner.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(/\/team/);
  await page.goto("/inventario");
  await page.getByRole("button", { name: "Más opciones de inventario" }).click();
  await page.getByRole("button", { name: "Pedidos" }).click();
  await page.locator(".ord-row").filter({ hasText: orderId.slice(0, 8) }).click();

  async function shot(state: string) {
    await page.screenshot({ path: `test-results/g01/G0B-${state}-${info.project.name}.png`, fullPage: true });
  }
  await shot("REQUESTED");
  await page.getByRole("button", { name: "Confirmar pedido" }).click();
  await expect(page.locator(".ord-detail .ord-badge").filter({ hasText: "Confirmado" })).toBeVisible({ timeout: 15000 });
  await shot("CONFIRMED");
  await page.getByRole("button", { name: "Iniciar preparación" }).click();
  await expect(page.locator(".ord-detail .ord-badge").filter({ hasText: "En preparación" })).toBeVisible({ timeout: 15000 });
  await shot("PREPARING");
  await page.getByRole("button", { name: "Marcar listo para retiro" }).click();
  await expect(page.locator(".ord-detail .ord-badge").filter({ hasText: "Listo para retiro" })).toBeVisible({ timeout: 15000 });
  await shot("READY");

  let dialog = 0;
  page.on("dialog", (d) => d.accept(dialog++ === 0 ? "Receptor G0b" : cashSessionId));
  await page.getByRole("button", { name: "Registrar retiro" }).click();
  await expect(page.locator(".ord-detail .ord-badge").filter({ hasText: "Entregado" })).toBeVisible({ timeout: 25000 });
  await shot("DELIVERED");
  await owner.db.end();
});
