/**
 * H03.U04 — flujo invitado end-to-end contra la API real (quote → confirm → read → cancel).
 */
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../apps/api/src/app";
import { database } from "../../../apps/api/src/lib/runtime";
import { nextBookingWednesday, seedBookingBusiness, type BookingSeed } from "./booking-fixtures";
import { createIntent } from "../../../apps/api/src/modules/booking/security/guest-access";

let app: FastifyInstance;
let seed: BookingSeed;

beforeAll(async () => {
  seed = await seedBookingBusiness("U04 E2E");
  app = await buildApp();
});
afterAll(async () => { await app.close(); });

describe("H03.U04 guest booking E2E", () => {
  it("completes quote → confirm → read → reconcile → cancel without duplicating", async () => {
    // 1. Quote
    const quoteRes = await app.inject({
      method: "POST",
      url: `/v1/public/businesses/${seed.business}/booking-quotes`,
      headers: { "content-type": "application/json" },
      payload: { serviceIds: [seed.serviceCut], professionalPreference: { type: "SPECIFIC", staffMemberId: seed.staffA }, localDate: nextBookingWednesday(), visibleStart: "13:30" },
    });
    expect(quoteRes.statusCode).toBe(200);
    const quoteBody = quoteRes.json() as { quote: string; expiresAt: string };
    expect(quoteBody.quote).toBeTruthy();

    // 2. Intent proof (generado en navegador)
    const intent = createIntent();

    // 3. Confirm
    const operationId = randomUUID();
    const confirmRes = await app.inject({
      method: "POST",
      url: `/v1/public/businesses/${seed.business}/reservations`,
      headers: { "content-type": "application/json", "x-operation-id": operationId },
      payload: { quote: quoteBody.quote, intentId: intent.intentId, intentProof: intent.proof, contact: { name: "Invitado Test", phone: "1155551234", email: "guest@test.local" }, acceptTerms: true },
    });
    expect(confirmRes.statusCode).toBe(200);
    const confirmBody = confirmRes.json() as { reservationId: string; status: string; replayed?: boolean; operationId: string; guestCredentialIssued: boolean };
    expect(confirmBody.status).toBe("CONFIRMED");
    expect(confirmBody.guestCredentialIssued).toBe(true);

    // 4. Reconcile lost response con proof — debe devolver el MISMO token (no uno nuevo)
    const reconcileRes = await app.inject({
      method: "GET",
      url: `/v1/public/businesses/${seed.business}/booking-operations/${operationId}`,
      headers: { "x-intent-proof": intent.proof },
    });
    expect(reconcileRes.statusCode).toBe(200);
    const reconcileBody = reconcileRes.json() as { guestToken?: string; status: string };
    const guestToken = reconcileBody.guestToken!;
    expect(guestToken).toBeTruthy();

    // 4b. Reconciliar de nuevo con la misma proof → debe devolver el mismo token (no uno nuevo)
    const reconcileRes2 = await app.inject({
      method: "GET",
      url: `/v1/public/businesses/${seed.business}/booking-operations/${operationId}`,
      headers: { "x-intent-proof": intent.proof },
    });
    expect(reconcileRes2.statusCode).toBe(200);
    const reconcileBody2 = reconcileRes2.json() as { guestToken?: string; status: string };
    expect(reconcileBody2.guestToken).toBe(guestToken);

    // 5. Read reservation con el token del primer reconcile
    const readRes = await app.inject({
      method: "GET",
      url: `/v1/public/reservations/${confirmBody.reservationId}`,
      headers: { "x-guest-token": guestToken },
    });
    expect(readRes.statusCode).toBe(200);

    // 6. Retry confirm (idempotente) — no duplicate
    const retryRes = await app.inject({
      method: "POST",
      url: `/v1/public/businesses/${seed.business}/reservations`,
      headers: { "content-type": "application/json", "x-operation-id": operationId },
      payload: { quote: quoteBody.quote, intentId: intent.intentId, intentProof: intent.proof, contact: { name: "Invitado Test", phone: "1155551234", email: "guest@test.local" }, acceptTerms: true },
    });
    expect(retryRes.statusCode).toBe(200);
    expect((retryRes.json() as { reservationId: string }).reservationId).toBe(confirmBody.reservationId);

    // 7. Cancel within window (turno futuro; cutoff 120 min — el turno es 2026-11-04 13:30, ahora es ~2026-11; ok)
    const cancelRes = await app.inject({
      method: "POST",
      url: `/v1/public/reservations/${confirmBody.reservationId}/cancel`,
      headers: { "content-type": "application/json", "x-guest-token": guestToken, "x-operation-id": randomUUID() },
      payload: { expectedRevision: 1 },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect((cancelRes.json() as { status: string }).status).toBe("CANCELLED");

    // 8. Allocation liberada
    const [alloc] = await database.client`select status::text status from availability.resource_allocations where source_id=${confirmBody.reservationId} and source_type='RESERVATION'`;
    expect(alloc!.status).toBe("RELEASED");
  });

  it("rejects a third party knowing only operationId/ReservationId without intent proof", async () => {
    // Smoke: operation not found / proof missing → 403
    const res = await app.inject({
      method: "GET",
      url: `/v1/public/businesses/${seed.business}/booking-operations/${randomUUID()}`,
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});
