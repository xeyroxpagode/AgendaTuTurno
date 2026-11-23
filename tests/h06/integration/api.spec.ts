import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../../apps/api/src/app.js";
import { assertQaDatabase, createSellableItem, op, seedActor, seedBusiness } from "../support.js";

beforeAll(async () => { await assertQaDatabase(); });

describe("F01 / WP-6 — API HTTP H06 (rutas públicas y mapeo de errores)", () => {
  it("catálogo público responde 200 con {data} y sin stock/ubicación", async () => {
    const businessId = await seedBusiness();
    const actor = await seedActor(businessId, "OWNER", `Owner-${randomUUID().slice(0, 6)}`);
    const item = await createSellableItem(actor, `API-${randomUUID().slice(0, 6)}`, 9000, 3);
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: `/v1/public/businesses/${businessId}/products` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { items: Array<Record<string, unknown>> } };
    expect(body.data.items.some((product) => product.sku === item.sku)).toBe(true);
    const product = body.data.items.find((entry) => entry.sku === item.sku)!;
    expect(Object.keys(product)).not.toContain("stock");
    expect(Object.keys(product)).not.toContain("locationId");
    await app.close();
  });

  it("detalle inexistente responde 404 con cuerpo uniforme", async () => {
    const businessId = await seedBusiness();
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/v1/public/businesses/${businessId}/products/NO-EXISTE-${randomUUID().slice(0, 6)}`
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "ORDER_NOT_FOUND" } });
    await app.close();
  });

  it("x-operation-id inválido ⇒ 400 VALIDATION_ERROR; credencial ausente ⇒ 404", async () => {
    const businessId = await seedBusiness();
    const app = await buildApp();
    const invalid = await app.inject({
      method: "POST", url: "/v1/public/orders",
      headers: { "x-operation-id": "not-a-uuid" },
      payload: { businessId, lines: [{ sku: "SKU-1", quantity: 1 }] }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    const tracking = await app.inject({
      method: "GET", url: `/v1/public/orders/${randomUUID()}?businessId=${businessId}`
    });
    expect(tracking.statusCode).toBe(404);
    expect(tracking.json()).toMatchObject({ error: { code: "ORDER_CREDENTIAL_INVALID" } });
    await app.close();
    void op;
  });
});
