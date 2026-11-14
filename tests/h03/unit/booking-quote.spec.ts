import { describe, expect, it } from "vitest";
import { issueQuote, quoteFingerprint, stableStringify, verifyQuote } from "../../../apps/api/src/modules/booking/domain/quote";
import type { BookingQuotePayload } from "@youngkingz/contracts";

const basePayload: Omit<BookingQuotePayload, "v" | "issuedAt" | "expiresAt" | "nonce"> = {
  businessId: "11111111-1111-4111-8111-111111111111",
  serviceIds: ["22222222-2222-4222-8222-222222222222"],
  termsVersionIds: ["33333333-3333-4333-8333-333333333333"],
  professionalPreference: { type: "ANY" },
  localDate: "2026-11-04",
  visibleStartMinute: 960,
  policyVersionId: "44444444-4444-4444-8444-444444444444",
  policyVersionNumber: 1,
  policyRevision: 1,
  currency: "ARS",
  commercialTotalMinor: 1500,
  items: [{ serviceId: "22222222-2222-4222-8222-222222222222", termsVersionId: "33333333-3333-4333-8333-333333333333", durationMinutes: 30, preBufferMinutes: 5, postBufferMinutes: 5, priceMinor: 1500, currency: "ARS" }],
};

describe("H03.U04 booking quote (HMAC-SHA256, TTL 5 min)", () => {
  it("round-trips a valid quote", () => {
    const { token, payload } = issueQuote(basePayload, new Date("2026-11-04T12:00:00.000Z"));
    const verified = verifyQuote(token, new Date("2026-11-04T12:04:59.000Z"));
    expect(verified.businessId).toBe(basePayload.businessId);
    expect(verified.commercialTotalMinor).toBe(1500);
    expect(verified.nonce).toBe(payload.nonce);
  });

  it("rejects a tampered payload", () => {
    const { token } = issueQuote(basePayload);
    const [payloadB64, signature] = token.split(".");
    const tampered = payloadB64!.slice(0, -4) + (payloadB64!.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect(() => verifyQuote(`${tampered}.${signature}`)).toThrowError(/signature|Malformed/);
  });

  it("rejects a tampered signature", () => {
    const { token } = issueQuote(basePayload);
    const [payloadB64] = token.split(".");
    expect(() => verifyQuote(`${payloadB64}.invalidsignature`)).toThrowError(/signature/);
    expect(() => verifyQuote(`${payloadB64}.${"A".repeat(43)}`)).toThrowError(/signature/);
  });

  it("rejects an expired quote", () => {
    const issued = issueQuote(basePayload, new Date("2026-11-04T12:00:00.000Z"));
    expect(() => verifyQuote(issued.token, new Date("2026-11-04T12:05:01.000Z"))).toThrowError(/expired/i);
  });

  it("produces key-order-independent canonical JSON", () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it("fingerprint is stable for identical quotes and differs on any change", () => {
    const { payload } = issueQuote(basePayload);
    const same = quoteFingerprint(payload);
    expect(quoteFingerprint(payload)).toBe(same);
    expect(quoteFingerprint({ ...payload, commercialTotalMinor: 9999 })).not.toBe(same);
  });
});
