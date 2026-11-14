import { describe, expect, it } from "vitest";
import {
  CURRENT_KEY_VERSION, createIntent, decryptEnvelope, encryptEnvelope, guestTokenDigest,
  intentProofDigest, issueGuestToken, safeEqualBase64Url,
} from "../../../apps/api/src/modules/booking/security/guest-access";
import { DomainError } from "@youngkingz/contracts";

describe("H03.U04 guest security primitives", () => {
  it("issues high-entropy intent proofs and binds them by digest only", () => {
    const { intentId, proof } = createIntent();
    expect(intentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(proof.length).toBeGreaterThanOrEqual(43);
    expect(intentProofDigest(proof)).toBe(intentProofDigest(proof));
    expect(intentProofDigest(proof)).not.toBe(proof);
  });

  it("digests guest tokens without exposing them", () => {
    const { token, digest } = issueGuestToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(guestTokenDigest(token)).toBe(digest);
    expect(safeEqualBase64Url(guestTokenDigest(token), digest)).toBe(true);
    expect(safeEqualBase64Url(guestTokenDigest("other"), digest)).toBe(false);
  });

  it("encrypts and decrypts envelopes with AEAD", () => {
    const secret = "guest-token-plaintext-123";
    const payload = encryptEnvelope(secret, CURRENT_KEY_VERSION);
    expect(payload).not.toContain(secret);
    expect(decryptEnvelope(payload, CURRENT_KEY_VERSION)).toBe(secret);
  });

  it("rejects corrupt envelopes (authentication failure)", () => {
    const payload = encryptEnvelope("secret", CURRENT_KEY_VERSION);
    const corrupt = Buffer.from(payload);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0x01;
    expect(() => decryptEnvelope(corrupt, CURRENT_KEY_VERSION)).toThrowError(DomainError);
    const truncated = payload.subarray(0, 10);
    expect(() => decryptEnvelope(truncated, CURRENT_KEY_VERSION)).toThrowError();
  });

  it("rejects envelopes under an unknown key version (rotation fails closed)", () => {
    const payload = encryptEnvelope("secret", CURRENT_KEY_VERSION);
    expect(() => decryptEnvelope(payload, "v999")).toThrowError(/Unsupported envelope key version/);
  });

  it("two envelopes of the same plaintext differ (random IV) but both decrypt", () => {
    const a = encryptEnvelope("same", CURRENT_KEY_VERSION);
    const b = encryptEnvelope("same", CURRENT_KEY_VERSION);
    expect(a.equals(b)).toBe(false);
    expect(decryptEnvelope(a, CURRENT_KEY_VERSION)).toBe("same");
    expect(decryptEnvelope(b, CURRENT_KEY_VERSION)).toBe("same");
  });
});
