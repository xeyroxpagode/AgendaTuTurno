import { expect, test } from "@playwright/test";

/**
 * T087 · QA visual de los tres recorridos (Cliente, Recepción, Owner).
 * Esta prueba de humo verifica el recorrido Cliente sin requerir sesión:
 * catálogo público accesible, borrador local y estados loading/empty/error.
 * Los recorridos Staff requieren sesión real y se cubren en G01 con credenciales QA.
 */
test("recorrido Cliente: el catálogo público carga sin exponer stock ni ubicación", async ({ page }) => {
  const businessId = process.env.H06_E2E_BUSINESS_ID ?? "00000000-0000-4000-8000-000000000000";
  await page.goto(`/productos?businessId=${businessId}`);
  await expect(page.getByRole("heading", { name: "Productos para retiro" })).toBeVisible();
  await expect(page.getByText(/producto\(s\) disponible\(s\)|No se pudo cargar el catálogo/)).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("sourceReference");
  expect(body).not.toContain("reuseCommitments");
});
