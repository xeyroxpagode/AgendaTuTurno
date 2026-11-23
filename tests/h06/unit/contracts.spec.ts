import { describe, expect, it } from "vitest";
import {
  capabilities, capabilitySchema, delegableCapabilities, grantableCapabilitiesByRole,
  roleCapabilities, orderStatuses, orderRequestInput, orderDeliverInput,
  orderSourceReferenceSchema, ORDER_SOURCE_PREFIX, orderErrorCodeStatus
} from "@youngkingz/contracts";

const ORDERS_CAPS = [
  "orders.read", "orders.create", "orders.confirm", "orders.reject",
  "orders.prepare", "orders.ready", "orders.cancel", "orders.deliver",
  "orders.cancel_confirmed", "orders.exception.resolve", "orders.credential.reissue"
] as const;

describe("F01 / WP-0 — contratos y permisos H06", () => {
  it("T001: siete estados comerciales, sin UNKNOWN", () => {
    expect(orderStatuses).toEqual(["REQUESTED", "CONFIRMED", "PREPARING", "READY", "DELIVERED", "REJECTED", "CANCELLED"]);
    expect(orderStatuses).not.toContain("UNKNOWN");
  });

  it("T001: orderRequestInput es estricto y rechaza líneas duplicadas", () => {
    const base = { businessId: "00000000-0000-4000-8000-000000000001", lines: [{ sku: "AB-1", quantity: 2 }] };
    expect(orderRequestInput.parse(base)).toMatchObject({ lines: [{ sku: "AB-1", quantity: 2 }] });
    expect(() => orderRequestInput.parse({ ...base, sourceReference: "order:x" })).toThrow();
    expect(() => orderRequestInput.parse({ ...base, lines: [...base.lines, { sku: "ab-1", quantity: 1 }] })).toThrow();
  });

  it("T001/CORR-04: el contrato de entrega no acepta parámetros internos", () => {
    const input = {
      expectedRevision: 1,
      receiver: { kind: "CUSTOMER", name: "Ana", verificationMethod: "CREDENTIAL" },
      components: [{ method: "CASH", amountMinor: 5000, outcome: "CONFIRMED" }]
    };
    expect(orderDeliverInput.parse(input)).toBeDefined();
    expect(() => orderDeliverInput.parse({ ...input, reuseCommitments: true })).toThrow();
    expect(() => orderDeliverInput.parse({ ...input, sourceReference: "order:x" })).toThrow();
  });

  it("formato exacto de sourceReference: un solo ':' y UUID v4", () => {
    expect(ORDER_SOURCE_PREFIX).toBe("order:");
    expect(orderSourceReferenceSchema.safeParse("order:11111111-1111-4111-8111-111111111111").success).toBe(true);
    expect(orderSourceReferenceSchema.safeParse("order:11111111-1111-1111-8111-111111111111").success).toBe(false);
    expect(orderSourceReferenceSchema.safeParse("order:abc:def").success).toBe(false);
  });

  it("T003: once capabilities orders.* registradas en los cuatro mapas", () => {
    for (const cap of ORDERS_CAPS) expect(capabilities).toContain(cap);
    expect(capabilities.filter((cap) => cap.startsWith("orders."))).toHaveLength(11);
    for (const cap of ORDERS_CAPS) expect(capabilitySchema.safeParse(cap).success).toBe(true);
    expect(delegableCapabilities.filter((cap) => cap.startsWith("orders.")).sort()).toEqual(
      ["orders.cancel_confirmed", "orders.credential.reissue", "orders.exception.resolve", "orders.read"].sort()
    );
    for (const role of ["OWNER", "RECEPTIONIST"] as const) {
      expect(grantableCapabilitiesByRole[role]).toContain("orders.cancel_confirmed");
    }
    expect(grantableCapabilitiesByRole.BARBER).toEqual([]);
    expect(roleCapabilities.BARBER.some((cap) => cap.startsWith("orders."))).toBe(false);
    expect(roleCapabilities.OWNER).toContain("orders.exception.resolve");
    expect(roleCapabilities.RECEPTIONIST).toContain("orders.deliver");
    expect(roleCapabilities.RECEPTIONIST).not.toContain("orders.cancel_confirmed");
  });

  it("T002: códigos ORDER_* con statusCode coherente", () => {
    expect(orderErrorCodeStatus.ORDER_NOT_FOUND).toBe(404);
    expect(orderErrorCodeStatus.ORDER_NOT_OWNED).toBe(404);
    expect(orderErrorCodeStatus.ORDER_STATE_INVALID).toBe(409);
    expect(orderErrorCodeStatus.MONEY_BLOCKS_CANCEL).toBe(409);
    expect(orderErrorCodeStatus.ORDER_EXCEPTION_NOT_AUTHORIZED).toBe(403);
  });
});
