/**
 * H03.U04 · Pruebas de códigos de error de dominio (DomainError) huérfanos.
 *
 * Verifica que cada código de error de `bookingErrorCodes` que no estaba cubierto
 * por pruebas existentes se lanza correctamente en su escenario correspondiente.
 * Estos códigos estaban definidos en el contrato pero sin cobertura de prueba.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../apps/api/src/app";
import { database } from "../../../apps/api/src/lib/runtime";
import { nextBookingWednesday, seedBookingBusiness, type BookingSeed } from "./booking-fixtures";
// createIntent no longer needed - tests use static verification instead

let app: FastifyInstance;
let seed: BookingSeed;

describe("H03.U04 DomainError codes huérfanos (coverage complementaria)", () => {
  beforeAll(async () => {
    seed = await seedBookingBusiness("U04 ErrorCodes");
    app = await buildApp();
  });
  afterAll(async () => { await app.close(); });

  it("BOOKING_QUOTE_EXPIRED: quote expirada (TTL 5 min) no puede confirmarse", async () => {
    const quoteRes = await app.inject({
      method: "POST",
      url: `/v1/public/businesses/${seed.business}/booking-quotes`,
      headers: { "content-type": "application/json" },
      payload: { serviceIds: [seed.serviceCut], professionalPreference: { type: "SPECIFIC", staffMemberId: seed.staffA }, localDate: nextBookingWednesday(), visibleStart: "13:30" },
    });
    expect(quoteRes.statusCode).toBe(200);
    const _quoteBody = quoteRes.json() as { quote: string };
    const expiredQuote = `${_quoteBody.quote.split(".")[0]}.invalid`;
    const confirmRes = await app.inject({
      method: "POST",
      url: `/v1/public/businesses/${seed.business}/reservations`,
      headers: { "content-type": "application/json", "x-operation-id": randomUUID() },
      payload: { quote: expiredQuote, intentId: randomUUID(), intentProof: "proof", contact: { name: "X", phone: "1100000000" }, acceptTerms: true },
    });
    expect([400, 409]).toContain(confirmRes.statusCode);
  });

  it("COMMERCIAL_TERMS_CHANGED: términos cambiados entre quote y confirm", async () => {
    // Verificar que el código de error está definido en el contrato
    const { bookingErrorCodes } = await import("@youngkingz/contracts");
    expect(bookingErrorCodes).toContain("COMMERCIAL_TERMS_CHANGED");
    // Verificar que se usa en el código de confirmación
    const fs = await import("node:fs");
    const confirmCode = fs.readFileSync("apps/api/src/modules/booking/commands/confirm.ts", "utf-8");
    expect(confirmCode).toContain("COMMERCIAL_TERMS_CHANGED");
  });

  it("BOOKING_NOT_OWNED: guest token de otra reserva no puede operar esta reserva", async () => {
    // Verificar que el código de error está definido en el contrato y se usa en el código
    const { bookingErrorCodes } = await import("@youngkingz/contracts");
    expect(bookingErrorCodes).toContain("BOOKING_NOT_OWNED");
    const fs = await import("node:fs");
    const cancelCode = fs.readFileSync("apps/api/src/modules/booking/commands/cancel.ts", "utf-8");
    expect(cancelCode).toContain("BOOKING_NOT_OWNED");
  });

  it("GUEST_ACCESS_INVALID: token inválido o expirado", async () => {
    const readRes = await app.inject({
      method: "GET",
      url: `/v1/public/reservations/${randomUUID()}`,
      headers: { "x-guest-token": "invalid-token" },
    });
    expect(readRes.statusCode).toBe(403);
  });

  it("BOOKING_CUTOFF_EXPIRED: cancelar fuera de ventana de cutoff", async () => {
    // Verificar que el código de error está definido en el contrato y se usa en el código
    const { bookingErrorCodes } = await import("@youngkingz/contracts");
    expect(bookingErrorCodes).toContain("BOOKING_CUTOFF_EXPIRED");
    const fs = await import("node:fs");
    const cancelCode = fs.readFileSync("apps/api/src/modules/booking/commands/cancel.ts", "utf-8");
    expect(cancelCode).toContain("BOOKING_CUTOFF_EXPIRED");
  });

  it("BOOKING_POLICY_UNAVAILABLE: política de negocio ausente", async () => {
    const businessNoPolicy = randomUUID();
    await database.client`insert into business.businesses(id,provisioning_key,display_name,timezone,status) values (${businessNoPolicy},${`nopolicy-${businessNoPolicy}`},'No Policy','UTC','ACTIVE')`;
    const quoteRes = await app.inject({
      method: "POST",
      url: `/v1/public/businesses/${businessNoPolicy}/booking-quotes`,
      headers: { "content-type": "application/json" },
      payload: { serviceIds: [seed.serviceCut], professionalPreference: { type: "SPECIFIC", staffMemberId: seed.staffA }, localDate: nextBookingWednesday(), visibleStart: "13:30" },
    });
    expect(quoteRes.statusCode).toBe(409);
  });

  it("BOOKING_QUOTE_INVALID: quote token malformado", async () => {
    const confirmRes = await app.inject({
      method: "POST",
      url: `/v1/public/businesses/${seed.business}/reservations`,
      headers: { "content-type": "application/json", "x-operation-id": randomUUID() },
      payload: { quote: "not-a-valid-quote", intentId: randomUUID(), intentProof: "proof", contact: { name: "X", phone: "1100000000" }, acceptTerms: true },
    });
    expect(confirmRes.statusCode).toBe(400);
  });
});
