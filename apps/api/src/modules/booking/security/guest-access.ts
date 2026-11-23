/**
 * H03.U04 · Seguridad de acceso invitado y prueba de intención.
 *
 * - Token de invitado: ≥256 bits, opaco, digest SHA-256 en DB, nunca en logs.
 * - Prueba de intención: alta entropía; el backend guarda solo el digest.
 * - Envelope de entrega: AES-256-GCM con claves server-side versionadas.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DomainError } from "@youngkingz/contracts";
import {
  INTENT_PROOF_BYTES,
  OPAQUE_TOKEN_BYTES,
  createIntentProof,
  intentProofDigest as sharedIntentProofDigest,
  issueOpaqueToken,
  opaqueTokenDigest,
  safeEqualOpaqueToken,
} from "../../../lib/security/opaque-token.js";

/* ─────────────────────────── Intent proof ─────────────────────────── */

export { INTENT_PROOF_BYTES };

export function createIntent(): { intentId: string; proof: string } {
  return createIntentProof();
}

export function intentProofDigest(proof: string): string {
  return sharedIntentProofDigest(proof);
}

export function safeEqualBase64Url(a: string, b: string): boolean {
  return safeEqualOpaqueToken(a, b);
}

/* ─────────────────────────── Guest token ─────────────────────────── */

export const GUEST_TOKEN_BYTES = OPAQUE_TOKEN_BYTES;

export function issueGuestToken(): { token: string; digest: string } {
  return issueOpaqueToken();
}

export function guestTokenDigest(token: string): string {
  return opaqueTokenDigest(token);
}

/* ─────────────────── Delivery envelope (AEAD) ─────────────────── */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function localDevKey(): Buffer {
  // Clave local de desarrollo; en producción se inyecta BOOKING_GUEST_KEY_V1.
  const fromEnv = process.env.BOOKING_GUEST_KEY_V1;
  if (!fromEnv) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("BOOKING_GUEST_KEY_V1 must be set in production");
    }
    return createHash("sha256").update("youngkingz-local-guest-envelope-key-v1").digest();
  }
  const key = Buffer.from(fromEnv, "base64");
  if (key.length !== KEY_BYTES) throw new Error("BOOKING_GUEST_KEY_V1 must be 32 bytes base64");
  return key;
}

const KEYRING: Record<string, () => Buffer> = { v1: localDevKey };

export const CURRENT_KEY_VERSION = "v1";

export function encryptEnvelope(plaintext: string, keyVersion: string = CURRENT_KEY_VERSION): Buffer {
  const keyFactory = KEYRING[keyVersion];
  if (!keyFactory) throw new DomainError("BOOKING_OPERATION_NOT_RECOVERABLE", `Unsupported envelope key version ${keyVersion}`, 410);
  const key = keyFactory();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptEnvelope(payload: Buffer, keyVersion: string): string {
  const keyFactory = KEYRING[keyVersion];
  if (!keyFactory) throw new DomainError("BOOKING_OPERATION_NOT_RECOVERABLE", `Unsupported envelope key version ${keyVersion}`, 410);
  if (payload.length < IV_BYTES + TAG_BYTES + 1) throw new DomainError("BOOKING_OPERATION_NOT_RECOVERABLE", "Envelope is truncated or corrupt", 410);
  const key = keyFactory();
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new DomainError("BOOKING_OPERATION_NOT_RECOVERABLE", "Envelope authentication failed", 410);
  }
}
