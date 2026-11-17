import { describe, expect, it } from "vitest";
import {
  cashComponentSchema, cardComponentSchema, deriveObligationBalance, deriveSaleBalance,
  formatMinor, moneyComponentSchema, moneyOperationInputSchema, saleLineInputSchema,
  sumChangeAmounts, sumConfirmedAmounts, transferComponentSchema
} from "@youngkingz/contracts";

/**
 * H05 · pruebas unitarias de contratos y aritmética exacta.
 * Cubre la capa de esquemas sin tocar PostgreSQL (D11/D27, B-DEC-08).
 */
describe("H05 contratos compartidos", () => {
  it("rechaza importes con decimales y moneda distinta de ARS", () => {
    expect(() => saleLineInputSchema.parse({
      kind: "PRODUCT", sku: "A", locationId: "00000000-0000-0000-0000-000000000001",
      name: "A", quantity: 1, unitPriceMinor: 10.5, discountMinor: 0
    })).toThrow();
    expect(() => cashComponentSchema.parse({ method: "CASH", amountMinor: 100, changeMinor: 0 })).not.toThrow();
    expect(() => moneyOperationInputSchema.parse({
      components: [{ method: "CASH", amountMinor: 100, changeMinor: 0, currency: "USD" }]
    })).toThrow();
  });

  it("el efectivo neto debe ser exacto y el vuelto nunca negativo", () => {
    expect(() => cashComponentSchema.parse({ method: "CASH", amountMinor: 8000, tenderedMinor: 10000, changeMinor: 2000 })).not.toThrow();
    expect(() => cashComponentSchema.parse({ method: "CASH", amountMinor: 8000, tenderedMinor: 10000, changeMinor: 2001 })).toThrow();
    expect(() => cashComponentSchema.parse({ method: "CASH", amountMinor: 8000, tenderedMinor: 1000, changeMinor: 2000 })).toThrow();
  });

  it("una transferencia no acreditada no es dinero confirmado", () => {
    const accredited = transferComponentSchema.parse({ method: "TRANSFER", amountMinor: 5000, accredited: true, reference: "OP-1", evidenceReference: "EV-OP-1" });
    const pending = transferComponentSchema.parse({ method: "TRANSFER", amountMinor: 5000, accredited: false });
    expect(() => transferComponentSchema.parse({ method: "TRANSFER", amountMinor: 5000, accredited: true })).toThrow();
    expect(sumConfirmedAmounts([accredited, pending])).toBe(5000);
  });

  it("una tarjeta UNKNOWN no cuenta como dinero confirmado", () => {
    const confirmed = cardComponentSchema.parse({ method: "CARD", amountMinor: 5000, outcome: "CONFIRMED", reference: "TERM-1", evidenceReference: "EV-TERM-1" });
    const unknown = cardComponentSchema.parse({ method: "CARD", amountMinor: 5000, outcome: "UNKNOWN" });
    expect(sumConfirmedAmounts([confirmed, unknown])).toBe(5000);
    expect(sumConfirmedAmounts([unknown])).toBe(0);
  });

  it("el vuelto se suma exactamente y nunca es negativo", () => {
    const components = moneyComponentSchema.array().parse([
      { method: "CASH", amountMinor: 8000, tenderedMinor: 10000, changeMinor: 2000 },
      { method: "CARD", amountMinor: 4000, outcome: "CONFIRMED", reference: "T-1", evidenceReference: "EV-T-1" }
    ]);
    expect(sumChangeAmounts(components)).toBe(2000);
    expect(sumConfirmedAmounts(components)).toBe(12000);
  });

  it("el descuento no puede superar la base comercial (B-DEC-01)", () => {
    expect(() => saleLineInputSchema.parse({
      kind: "PRODUCT", sku: "A", locationId: "00000000-0000-0000-0000-000000000001",
      name: "A", quantity: 2, unitPriceMinor: 1000, discountMinor: 2001, discountReason: "Excedido"
    })).toThrow();
    expect(() => saleLineInputSchema.parse({
      kind: "PRODUCT", sku: "A", locationId: "00000000-0000-0000-0000-000000000001",
      name: "A", quantity: 2, unitPriceMinor: 1000, discountMinor: 500
    })).toThrow();
  });

  it("el saldo de la venta es derivado, nunca un importe editable", () => {
    expect(deriveSaleBalance(10_000, 0)).toBe("PENDING");
    expect(deriveSaleBalance(10_000, 4_000)).toBe("PARTIAL");
    expect(deriveSaleBalance(10_000, 10_000)).toBe("SETTLED");
    expect(deriveSaleBalance(10_000, 12_000)).toBe("SETTLED");
  });

  it("UNKNOWN_AMOUNT nunca es cero ni saldado (D22/F28)", () => {
    expect(deriveObligationBalance(null, 0).balanceMinor).toBeNull();
    expect(deriveObligationBalance(null, 0).status).toBe("OPEN");
    expect(deriveObligationBalance(null, 5_000).status).toBe("PARTIAL");
    expect(deriveObligationBalance(null, 5_000).balanceMinor).toBeNull();
    expect(deriveObligationBalance(10_000, 4_000).balanceMinor).toBe(6_000);
  });

  it("la presentación ARS redondea sólo al mostrar, nunca al calcular", () => {
    expect(formatMinor(0)).toBe("0.00");
    expect(formatMinor(1)).toBe("0.01");
    expect(formatMinor(12_345)).toBe("123.45");
    expect(formatMinor(-250)).toBe("-2.50");
  });
});
