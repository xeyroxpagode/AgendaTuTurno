/**
 * H03.U04 · Cotización firmada (HMAC-SHA256) con TTL de cinco minutos.
 *
 * La cotización NUNCA ocupa ni garantiza disponibilidad: solo transporta las
 * condiciones comerciales aceptadas. La confirmación revalida firma, vigencia,
 * Business, Terms, Policy y disponibilidad real bajo guard (U03).
 *
 * Estrategia elegida (Technical Plan §03): oferta firmada, sin tabla de quotes.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DomainError } from "@youngkingz/contracts";
import { BOOKING_QUOTE_TTL_SECONDS, type BookingQuotePayload } from "@youngkingz/contracts";

const QUOTE_SECRET = (() => {
  const fromEnv = process.env.BOOKING_QUOTE_SECRET;
  if (!fromEnv) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("BOOKING_QUOTE_SECRET must be set in production");
    }
    return "local-booking-quote-secret-not-for-production";
  }
  return fromEnv;
})();
const QUOTE_VERSION = 1 as const;

/** JSON canónico: claves ordenadas recursivamente, sin espacios. */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadB64: string): string {
  return createHmac("sha256", QUOTE_SECRET).update(payloadB64).digest("base64url");
}

export function quoteNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function issueQuote(payload: Omit<BookingQuotePayload, "v" | "issuedAt" | "expiresAt" | "nonce">, now: Date = new Date()): { token: string; payload: BookingQuotePayload; ttlSeconds: number } {
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + BOOKING_QUOTE_TTL_SECONDS * 1000).toISOString();
  const full: BookingQuotePayload = { v: QUOTE_VERSION, ...payload, issuedAt, expiresAt, nonce: quoteNonce() };
  const payloadB64 = base64url(stableStringify(full));
  return { token: `${payloadB64}.${sign(payloadB64)}`, payload: full, ttlSeconds: BOOKING_QUOTE_TTL_SECONDS };
}

export type VerifiedQuote = { payload: BookingQuotePayload };

export function verifyQuote(token: string, now: Date = new Date()): BookingQuotePayload {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) throw new DomainError("BOOKING_QUOTE_INVALID", "Malformed quote token", 400);
  const payloadB64 = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payloadB64);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new DomainError("BOOKING_QUOTE_INVALID", "Quote signature mismatch", 400);
  }
  let payload: BookingQuotePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as BookingQuotePayload;
  } catch {
    throw new DomainError("BOOKING_QUOTE_INVALID", "Quote payload is not valid JSON", 400);
  }
  if (payload.v !== QUOTE_VERSION) throw new DomainError("BOOKING_QUOTE_INVALID", "Unsupported quote version", 400);
  if (Date.parse(payload.expiresAt) <= now.getTime()) {
    throw new DomainError("BOOKING_QUOTE_EXPIRED", "Quote expired; request a fresh one", 409, { expiresAt: payload.expiresAt });
  }
  return payload;
}

/** Huella canónica del snapshot comercial para comparar Terms/Policy al confirmar. */
export function quoteFingerprint(payload: BookingQuotePayload): string {
  return stableStringify({
    businessId: payload.businessId,
    serviceIds: payload.serviceIds,
    termsVersionIds: payload.termsVersionIds,
    professionalPreference: payload.professionalPreference,
    localDate: payload.localDate,
    visibleStartMinute: payload.visibleStartMinute,
    policyVersionId: payload.policyVersionId,
    commercialTotalMinor: payload.commercialTotalMinor,
    currency: payload.currency,
  });
}
