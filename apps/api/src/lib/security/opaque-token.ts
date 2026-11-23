/**
 * Helpers compartidos de tokens opacos (WP-0 / T005, extensión H03 T-07).
 *
 * Este archivo EXTRAE —sin cambiar el algoritmo— las primitivas que ya usaba
 * `booking/security/guest-access.ts`: 32 bytes aleatorios en base64url,
 * digest SHA-256 en base64url y comparación en tiempo constante. H06 reutiliza
 * exactamente la misma implementación para `clients.order_credentials`, de
 * modo que no existan dos algoritmos de credencial divergentes.
 *
 * El token en claro NUNCA se persiste ni se registra en logs; sólo el digest.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const OPAQUE_TOKEN_BYTES = 32;
export const INTENT_PROOF_BYTES = 32;

/** Token opaco de 256 bits + su digest. Equivalente a `issueGuestToken()`. */
export function issueOpaqueToken(): { token: string; digest: string } {
  const token = randomBytes(OPAQUE_TOKEN_BYTES).toString("base64url");
  return { token, digest: opaqueTokenDigest(token) };
}

/** SHA-256 base64url del token. Idéntico a `guestTokenDigest()`. */
export function opaqueTokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

/** Prueba de intención de alta entropía; el servidor persiste sólo el digest. */
export function createIntentProof(): { intentId: string; proof: string } {
  return { intentId: randomUUID(), proof: randomBytes(INTENT_PROOF_BYTES).toString("base64url") };
}

export function intentProofDigest(proof: string): string {
  return createHash("sha256").update(proof, "utf8").digest("base64url");
}

/** Comparación en tiempo constante de dos digests base64url. */
export function safeEqualOpaqueToken(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
