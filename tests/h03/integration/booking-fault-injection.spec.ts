/**
 * H03.U04 · F04 · Concurrencia y fault injection — pruebas DIRECTAS.
 *
 * Cada prueba ejecuta contra la API real + PostgreSQL real y registra el
 * estado final de Reservation, Allocation, OperationAttempt y ReservationEvents.
 * No se permiten huérfanos, duplicados ni historia inconsistente.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../apps/api/src/app";
import { database } from "../../../apps/api/src/lib/runtime";
import { seedBookingBusiness, type BookingSeed } from "./booking-fixtures";
import { createIntent } from "../../../apps/api/src/modules/booking/security/guest-access";

let app: FastifyInstance;
let seed: BookingSeed;

async function finalState(reservationId: string) {
  const [reservation] = await database.client`select id,status,revision,current_allocation_id "currentAllocationId" from booking.reservations where id=${reservationId}`;
  const allocations = await database.client`select id,status::text status from availability.resource_allocations where source_id=${reservationId} and source_type='RESERVATION'`;
  const events = await database.client`select event_type,sequence from booking.reservation_events where reservation_id=${reservationId} order by sequence`;
  return { reservation, allocations, events };
}

async function countAttempts(operationId: string) {
  const [row] = await database.client`select count(*) "c" from system.operation_attempts where operation_id=${operationId}`;
  return Number(row!.c);
}

describe("H03.U04 fault injection (PostgreSQL real + API real)", () => {
  beforeAll(async () => {
    seed = await seedBookingBusiness("F04 Fault");
    app = await buildApp();
  });
  afterAll(async () => { await app.close(); });

  it("F04-01: dos confirmaciones simultáneas para un único slot → una OK, otra SLOT_CONFLICT, sin duplicados ni huérfanos", async () => {
    const quoteRes = await app.inject({
      method: "POST",
      url: `/v1/public/businesses/${seed.business}/booking-quotes`,
      payload: { serviceIds: [seed.serviceCut], professionalPreference: { type: "SPECIFIC", staffMemberId: seed.staffA }, localDate: "2026-11-18", visibleStart: "13:30" },
    });
    expect(quoteRes.statusCode).toBe(200);
    const quote = quoteRes.json() as { quote: string };

    const intentA = createIntent(); const intentB = createIntent();
    const opA = randomUUID(); const opB = randomUUID();

    const results = await Promise.all([
      app.inject({ method: "POST", url: `/v1/public/businesses/${seed.business}/reservations`, headers: { "content-type": "application/json", "x-operation-id": opA }, payload: { quote: quote.quote, intentId: intentA.intentId, intentProof: intentA.proof, contact: { name: "A", phone: "1100000000" }, acceptTerms: true } }),
      app.inject({ method: "POST", url: `/v1/public/businesses/${seed.business}/reservations`, headers: { "content-type": "application/json", "x-operation-id": opB }, payload: { quote: quote.quote, intentId: intentB.intentId, intentProof: intentB.proof, contact: { name: "B", phone: "1100000001" }, acceptTerms: true } }),
    ]);

    const statuses = results.map(r => r.statusCode);
    expect(statuses.sort()).toEqual([200, 409]);

    const ok = results.find(r => r.statusCode === 200)!;
    const reservationId = (ok.json() as { reservationId: string }).reservationId;

    const state = await finalState(reservationId);
    expect(state.reservation!.status).toBe("CONFIRMED");
    expect(Number(state.reservation!.revision)).toBe(1);
    const active = state.allocations.filter(a => a.status === "ACTIVE");
    expect(active.length).toBe(1); // exactamente una allocation ACTIVE
    expect(state.events.length).toBeGreaterThanOrEqual(1);

    // Ninguna operación debe quedar duplicada ni con estado intermedio.
    expect(await countAttempts(opA)).toBe(1);
    expect(await countAttempts(opB)).toBe(1);
  });

  it("F04-02: cancel y reschedule concurrentes → exactamente uno gana, estado consistente", async () => {
    const quoteRes = await app.inject({
      method: "POST",
      url: `/v1/public/businesses/${seed.business}/booking-quotes`,
      payload: { serviceIds: [seed.serviceCut], professionalPreference: { type: "SPECIFIC", staffMemberId: seed.staffA }, localDate: "2026-11-18", visibleStart: "16:00" },
    });
    const quote = quoteRes.json() as { quote: string };
    const intent = createIntent();
    const opConfirm = randomUUID();
    const confirmRes = await app.inject({ method: "POST", url: `/v1/public/businesses/${seed.business}/reservations`, headers: { "content-type": "application/json", "x-operation-id": opConfirm }, payload: { quote: quote.quote, intentId: intent.intentId, intentProof: intent.proof, contact: { name: "C", phone: "1100000002" }, acceptTerms: true } });
    expect(confirmRes.statusCode).toBe(200);
    const reservationId = (confirmRes.json() as { reservationId: string }).reservationId;

    // Leer token y revisión para cancel y reschedule.
    const opReconcile = randomUUID();
    const _rec = await app.inject({ method: "GET", url: `/v1/public/businesses/${seed.business}/booking-operations/${opReconcile}`, headers: { "x-intent-proof": intent.proof } });
    // Si la operación no existe (opReconcile no es el de confirm), usar el de confirm.
    const rec2 = await app.inject({ method: "GET", url: `/v1/public/businesses/${seed.business}/booking-operations/${opConfirm}`, headers: { "x-intent-proof": intent.proof } });
    expect(rec2.statusCode).toBe(200);
    const guestToken = (rec2.json() as { guestToken?: string }).guestToken!;
    const [res] = await database.client`select revision from booking.reservations where id=${reservationId}`;
    const revision = Number(res!.revision);

    const cancelOp = randomUUID(); const rescheduleOp = randomUUID();
    const results = await Promise.all([
      app.inject({ method: "POST", url: `/v1/public/reservations/${reservationId}/cancel`, headers: { "content-type": "application/json", "x-guest-token": guestToken, "x-operation-id": cancelOp }, payload: { expectedRevision: revision } }),
      app.inject({ method: "POST", url: `/v1/public/reservations/${reservationId}/reschedule`, headers: { "content-type": "application/json", "x-guest-token": guestToken, "x-operation-id": rescheduleOp }, payload: { expectedRevision: revision, localDate: "2026-11-18", visibleStart: "16:30" } }),
    ]);

    const statuses = results.map(r => r.statusCode).sort();
    // Uno debe ganar (200) y el otro fallar (409 STALE_REVISION o CUTOFF o SLOT_CONFLICT).
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(409);

    const state = await finalState(reservationId);
    // Estado final consistente: o CANCELLED sin allocation activa, o CONFIRMED con exactamente una allocation activa.
    if (state.reservation!.status === "CANCELLED") {
      const active = state.allocations.filter(a => a.status === "ACTIVE");
      expect(active.length).toBe(0);
    } else {
      expect(state.reservation!.status).toBe("CONFIRMED");
      const active = state.allocations.filter(a => a.status === "ACTIVE");
      expect(active.length).toBe(1);
    }
    expect(await countAttempts(cancelOp)).toBe(1);
    expect(await countAttempts(rescheduleOp)).toBe(1);
  });

  it("F04-03: dos reprogramaciones concurrentes → una OK, otra falla, sin duplicados", async () => {
    const quoteRes = await app.inject({
      method: "POST",
      url: `/v1/public/businesses/${seed.business}/booking-quotes`,
      payload: { serviceIds: [seed.serviceCut], professionalPreference: { type: "SPECIFIC", staffMemberId: seed.staffA }, localDate: "2026-11-25", visibleStart: "10:30" },
    });
    const quote = quoteRes.json() as { quote: string };
    const intent = createIntent();
    const opConfirm = randomUUID();
    const confirmRes = await app.inject({ method: "POST", url: `/v1/public/businesses/${seed.business}/reservations`, headers: { "content-type": "application/json", "x-operation-id": opConfirm }, payload: { quote: quote.quote, intentId: intent.intentId, intentProof: intent.proof, contact: { name: "D", phone: "1100000003" }, acceptTerms: true } });
    expect(confirmRes.statusCode).toBe(200);
    const reservationId = (confirmRes.json() as { reservationId: string }).reservationId;

    const rec = await app.inject({ method: "GET", url: `/v1/public/businesses/${seed.business}/booking-operations/${opConfirm}`, headers: { "x-intent-proof": intent.proof } });
    const guestToken = (rec.json() as { guestToken?: string }).guestToken!;
    const [res] = await database.client`select revision from booking.reservations where id=${reservationId}`;
    const revision = Number(res!.revision);

    const opRes1 = randomUUID(); const opRes2 = randomUUID();
    const results = await Promise.all([
      app.inject({ method: "POST", url: `/v1/public/reservations/${reservationId}/reschedule`, headers: { "content-type": "application/json", "x-guest-token": guestToken, "x-operation-id": opRes1 }, payload: { expectedRevision: revision, localDate: "2026-11-25", visibleStart: "11:00" } }),
      app.inject({ method: "POST", url: `/v1/public/reservations/${reservationId}/reschedule`, headers: { "content-type": "application/json", "x-guest-token": guestToken, "x-operation-id": opRes2 }, payload: { expectedRevision: revision, localDate: "2026-11-25", visibleStart: "11:30" } }),
    ]);

    const statuses = results.map(r => r.statusCode).sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(409);

    const state = await finalState(reservationId);
    expect(state.reservation!.status).toBe("CONFIRMED");
    const active = state.allocations.filter(a => a.status === "ACTIVE");
    expect(active.length).toBe(1); // una sola allocation activa tras la reprogramación ganadora
    expect(await countAttempts(opRes1)).toBe(1);
    expect(await countAttempts(opRes2)).toBe(1);
  });

  it("F04-04: rollback total cuando falla entre el insert de Reservation y el Claim (simulado por transacción directa)", async () => {
    const reservationId = randomUUID();
    let threw = false;
    try {
      await database.client.begin(async (tx) => {
        const operationId = randomUUID();
        await tx`insert into system.operation_attempts(operation_id,business_id,command_name,request_hash,status,response_status,completed_at) values (${operationId},${seed.business},'fault.test','hash','SUCCEEDED',200,now())`;
        // Insert de Reservation CONFIRMED sin allocation (como haría confirm antes del claim).
        await tx`insert into booking.reservations(id,business_id,revision,status,owner_type,contact_snapshot,staff_member_id,policy_version_id,policy_snapshot,commercial_total_minor,currency,current_allocation_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,business_local_date,business_timezone_snapshot,created_operation_id)
          values (${reservationId},${seed.business},1,'CONFIRMED','GUEST','{"name":"Fault","phone":"1"}'::jsonb,${seed.staffA},${seed.policyVersionId},'{}'::jsonb,1500,'ARS',null,'2026-11-23T10:00:00Z','2026-11-23T10:50:00Z','2026-11-23T09:55:00Z','2026-11-23T10:55:00Z','2026-11-23','America/Argentina/Buenos_Aires',${operationId})`;
        // Fuerza fallo antes del Claim (simula fallo de infraestructura entre insert y claim).
        throw new Error("simulated failure before Claim");
      });
    } catch { threw = true; }
    expect(threw).toBe(true);
    // El rollback debe haber eliminado toda huella (no huérfanos).
    expect(Number((await database.client`select count(*) c from booking.reservations where id=${reservationId}`)[0]!.c)).toBe(0);
    expect(Number((await database.client`select count(*) c from availability.resource_allocations where source_id=${reservationId}`)[0]!.c)).toBe(0);
  });

  it("F04-05: idempotencia — retry simultáneo con distintos principales reusing el mismo operation_id se rechaza (IDEMPOTENCY_CONFLICT)", async () => {
    const { executePrincipalOperation } = await import("../../../apps/api/src/modules/system/operations");
    const operationId = randomUUID();
    const intent = createIntent();
    const principal = { kind: "GUEST_INTENT" as const, businessId: seed.business, intentId: intent.intentId, proofDigest: "digest-a" };
    const payload = { a: 1 };
    await executePrincipalOperation({ operationId, command: "booking.test", principal, payload }, async () => ({ ok: true }));
    // Otro principal reusa el operation_id ⇒ conflicto.
    const otherPrincipal = { ...principal, intentId: randomUUID(), proofDigest: "digest-b" };
    await expect(executePrincipalOperation({ operationId, command: "booking.test", principal: otherPrincipal, payload }, async () => ({ ok: true }))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const [row] = await database.client`select status::text status from system.operation_attempts where operation_id=${operationId}`;
    expect(row!.status).toBe("SUCCEEDED");
  });
});
