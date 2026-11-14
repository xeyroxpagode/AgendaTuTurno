/**
 * H03.U04 · API routes (public + staff + client).
 * Las rutas CLIENT usan la identidad real de U02 (AAL2, sesión viva, cuenta
 * global) y el ConfirmBooking/CancelBooking/RescheduleBooking reales de U04.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError, bookingQuoteRequestSchema, bookingConfirmGuestSchema, bookingConfirmClientSchema, cancelReservationSchema, rescheduleReservationSchema, assistedRecoverySchema, staffOverrideCancelSchema, staffOverrideRescheduleSchema, staffAgendaQuerySchema, staffCreateReservationSchema, staffArrivalReservationSchema, staffNoShowReservationSchema, staffReassignReservationSchema } from "@youngkingz/contracts";
import { authorizationService, type Actor } from "../iam/authorization.js";
import { operationId as opIdFromHeader } from "../system/operations.js";
import { confirmGuestBooking, confirmClientBooking } from "./commands/confirm.js";
import { cancelBooking } from "./commands/cancel.js";
import { rescheduleBooking } from "./commands/reschedule.js";
import { associateGuestReservation } from "./commands/associate.js";
import { assistedGuestRecovery } from "./commands/recovery.js";
import { staffExceptionCancel, staffExceptionReschedule } from "./commands/staff-exceptions.js";
import { createStaffReservation } from "./commands/staff-create.js";
import { registerStaffArrival } from "./commands/arrival.js";
import { confirmStaffNoShow } from "./commands/no_show.js";
import { reassignStaffReservation } from "./commands/reassign.js";
import { getStaffReservationDetail, listStaffAgenda } from "./queries.js";
import { issueQuote, verifyQuote } from "./domain/quote.js";
import { resolveSlot } from "../availability/queries.js";
import { clientContactSnapshot, resolveClientIdentity } from "./security/client-principal.js";
import { database } from "../../lib/runtime.js";
import { rows, sql } from "../../lib/sql.js";

const uuidParam = z.object({ id: z.string().uuid() });
const businessParam = z.object({ businessId: z.string().uuid() });

/* ─────────────── rate limit mínimo (in-memory) ─────────────── */
const buckets = new Map<string, { count: number; reset: number }>();
function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

function guestToken(request: FastifyRequest): string {
  const value = request.headers["x-guest-token"];
  if (typeof value !== "string" || value.length < 20) throw new DomainError("GUEST_ACCESS_INVALID", "Guest credential is required", 403);
  return value;
}

async function authenticate(request: FastifyRequest) { request.actor = await authorizationService.authenticate(request); }
function actor(request: FastifyRequest): Actor { if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401); return request.actor; }
function requireCapability(request: FastifyRequest, capability: Parameters<typeof authorizationService.require>[1]) { const value = actor(request); authorizationService.require(value, capability); return value; }
/**
 * H03.U06 · WP-06 · defensa en profundidad: la ruta acepta varias capacidades
 * (ámbito compartido o ámbito propio). Se exige AL MENOS una de ellas ANTES
 * de la lógica de negocio.
 */
function requireAnyCapability(request: FastifyRequest, ...capabilities: Parameters<typeof authorizationService.require>[1][]) {
  const value = actor(request);
  if (!capabilities.some((capability) => value.capabilities.has(capability))) {
    throw new DomainError("FORBIDDEN", `Missing capability: ${capabilities.join(" or ")}`, 403);
  }
  return value;
}

export async function registerBookingRoutes(app: FastifyInstance) {
  /* ───────────────────────────────────────────────────────────────────────────
   * H03.U06 · D01 §03.1 (convergencia U02) · Identidad Cliente.
   *
   * La identidad CLIENT de U02 ESTÁ integrada en este workspace
   * (`apps/api/src/modules/client-auth`, migración `202611030001` aplicada),
   * por lo que las rutas CLIENT se registran siempre. Si el módulo U02 no
   * estuviera disponible, `resolveClientIdentity` falla cerrado con 501
   * `CLIENT_AUTH_INSUFFICIENT` (no hay crash: import dinámico, ELEPHANT-005).
   *
   * `ENABLE_CLIENT_BOOKING=false` permanece como interruptor explícito de
   * despliegue (mismo comportamiento fail-closed que antes).
   * ─────────────────────────────────────────────────────────────────────────── */
  const enableClientBooking = process.env.ENABLE_CLIENT_BOOKING !== "false";

  /* ─── PUBLIC: quote ─── */
  app.post("/v1/public/businesses/:businessId/booking-quotes", async request => {
    const { businessId } = businessParam.parse(request.params);
    const body = bookingQuoteRequestSchema.parse(request.body);
    const ip = (request.ip ?? "unknown");
    if (!rateLimit(`quote:${ip}:${businessId}`, 60, 60_000)) throw new DomainError("RATE_LIMITED", "Too many quote requests", 429);

    const [business] = await rows<any>(sql`select id,timezone,status from business.businesses where id=${businessId}`);
    if (!business || business.status !== "ACTIVE") throw new DomainError("BUSINESS_NOT_BOOKABLE", "Business is not bookable", 409);

    // Cargar Terms + Policy + slot para construir el snapshot comercial.
    const slot = await resolveSlot(database.client, {
      businessId,
      serviceIds: body.serviceIds,
      localDate: body.localDate,
      visibleStartMinute: parseClock(body.visibleStart),
      professionalPreference: body.professionalPreference,
      requirePublic: true,
      now: new Date(),
    });


    // resolveSlot no devuelve priceMinor en services; enriquecer desde catalog.
    const enrichedItems = await Promise.all(body.serviceIds.map(async (serviceId, _index) => {
      const [row] = await rows<any>(sql`select s.name, v.id "termsVersionId", v.price_minor "priceMinor", v.duration_minutes "durationMinutes", v.pre_buffer_minutes "preBufferMinutes", v.post_buffer_minutes "postBufferMinutes" from catalog.services s join catalog.service_terms_versions v on v.business_id=s.business_id and v.service_id=s.id and v.id=s.current_terms_version_id where s.business_id=${businessId} and s.id=${serviceId}`);
      return {
        serviceId,
        name: row!.name as string,
        termsVersionId: row!.termsVersionId as string,
        priceMinor: Number(row!.priceMinor),
        durationMinutes: Number(row!.durationMinutes),
        preBufferMinutes: Number(row!.preBufferMinutes),
        postBufferMinutes: Number(row!.postBufferMinutes),
      };
    }));
    const total = enrichedItems.reduce((sum, i) => sum + i.priceMinor, 0);
    const reissued = issueQuote({
      businessId,
      serviceIds: body.serviceIds,
      termsVersionIds: enrichedItems.map(i => i.termsVersionId),
      professionalPreference: body.professionalPreference,
      localDate: body.localDate,
      visibleStartMinute: slot.visibleStartMinute,
      policyVersionId: slot.policy.id,
      policyVersionNumber: slot.policy.versionNumber,
      policyRevision: slot.policy.revision,
      currency: "ARS",
      commercialTotalMinor: total,
      items: enrichedItems.map(i => ({
        serviceId: i.serviceId,
        termsVersionId: i.termsVersionId,
        durationMinutes: i.durationMinutes,
        preBufferMinutes: i.preBufferMinutes,
        postBufferMinutes: i.postBufferMinutes,
        priceMinor: i.priceMinor,
        currency: "ARS",
      })),
    });

    return {
      quote: reissued.token,
      expiresAt: reissued.payload.expiresAt,
      ttlSeconds: reissued.ttlSeconds,
      summary: {
        businessId,
        serviceIds: body.serviceIds,
        professionalPreference: body.professionalPreference,
        localDate: body.localDate,
        visibleStart: body.visibleStart,
        commercialTotalMinor: total,
        currency: "ARS",
        policyVersionNumber: slot.policy.versionNumber,
      },
    };
  });

  /* ─── PUBLIC: confirm guest ─── */
  app.post("/v1/public/businesses/:businessId/reservations", async request => {
    const { businessId } = businessParam.parse(request.params);
    const body = bookingConfirmGuestSchema.parse(request.body);
    if (!rateLimit(`confirm:${request.ip}:${businessId}`, 20, 60_000)) throw new DomainError("RATE_LIMITED", "Too many confirmations", 429);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    const result = await confirmGuestBooking({
      businessId,
      quoteToken: body.quote,
      intentId: body.intentId,
      intentProof: body.intentProof,
      contact: body.contact,
      operationId,
    });
    return result;
  });

  /* ─── PUBLIC: reconcile lost response ─── */
  app.get("/v1/public/businesses/:businessId/booking-operations/:operationId", async request => {
    const { businessId, operationId: opId } = z.object({ businessId: z.string().uuid(), operationId: z.string().uuid() }).parse(request.params);
    const proof = request.headers["x-intent-proof"];
    if (typeof proof !== "string" || proof.length < 43) throw new DomainError("GUEST_ACCESS_INVALID", "Intent proof is required", 403);
    const [op] = await rows<any>(sql`select operation_id "operationId", business_id "businessId", command_name "commandName", status::text status, response_body "responseBody", principal_kind "principalKind", principal_ref "principalRef" from system.operation_attempts where operation_id=${opId} and business_id=${businessId}`);
    if (!op || op.principalKind !== "GUEST_INTENT") throw new DomainError("BOOKING_NOT_FOUND", "Operation not found", 404);
    const [env] = await rows<any>(sql`select intent_proof_digest "intentProofDigest", encrypted_payload "encryptedPayload", key_version "keyVersion", expires_at "expiresAt", consumed_at "consumedAt" from booking.guest_delivery_envelopes where operation_id=${opId} and business_id=${businessId}`);
    if (!env) throw new DomainError("BOOKING_OPERATION_NOT_RECOVERABLE", "No delivery envelope for this operation", 410);
    const { intentProofDigest, safeEqualBase64Url, decryptEnvelope } = await import("./security/guest-access.js");
    if (!safeEqualBase64Url(intentProofDigest(proof), env.intentProofDigest as string)) throw new DomainError("GUEST_ACCESS_INVALID", "Intent proof mismatch", 403);
    if (new Date(env.expiresAt as string).getTime() < Date.now()) throw new DomainError("BOOKING_OPERATION_NOT_RECOVERABLE", "Recovery window expired; use assisted recovery", 410);
    let token: string | undefined;
    try {
      const plaintext = decryptEnvelope(env.encryptedPayload as Buffer, env.keyVersion as string);
      token = (JSON.parse(plaintext) as { guestToken?: string }).guestToken;
    } catch {
      throw new DomainError("BOOKING_OPERATION_NOT_RECOVERABLE", "Envelope could not be opened", 410);
    }
    return { operationId: op.operationId, status: op.status, result: op.responseBody, guestToken: token };
  });

  /* ─── PUBLIC: guest reservation read ─── */
  app.get("/v1/public/reservations/:reservationId", async request => {
    const { reservationId } = z.object({ reservationId: z.string().uuid() }).parse(request.params);
    const token = guestToken(request);
    const { guestTokenDigest } = await import("./security/guest-access.js");
    const digest = guestTokenDigest(token);
    const [cred] = await rows<any>(sql`select id,status,reservation_id "reservationId" from booking.guest_credentials where token_digest=${digest}`);
    if (!cred || cred.status !== "ACTIVE" || cred.reservationId !== reservationId) throw new DomainError("GUEST_ACCESS_INVALID", "Guest credential is invalid", 403);
    const [r] = await rows<any>(sql`select id,status,revision,staff_member_id "staffMemberId",starts_at "startsAt",ends_at "endsAt",commercial_total_minor "total",currency,business_local_date "localDate" from booking.reservations where id=${reservationId}`);
    if (!r) throw new DomainError("BOOKING_NOT_FOUND", "Reservation not found", 404);
    const items = await rows<any>(sql`select position,service_id "serviceId",service_name_snapshot "name",duration_minutes "durationMinutes",price_minor "priceMinor" from booking.reservation_items where reservation_id=${reservationId} order by position`);
    await rows<any>(sql`update booking.guest_credentials set last_used_at=now() where id=${cred.id}`);
    return { reservation: r, items };
  });

  /* ─── PUBLIC: guest cancel ─── */
  app.post("/v1/public/reservations/:reservationId/cancel", async request => {
    const { reservationId } = z.object({ reservationId: z.string().uuid() }).parse(request.params);
    const body = cancelReservationSchema.parse(request.body);
    const token = guestToken(request);
    const { guestTokenDigest } = await import("./security/guest-access.js");
    const digest = guestTokenDigest(token);
    const [cred] = await rows<any>(sql`select id,status,reservation_id "reservationId" from booking.guest_credentials where token_digest=${digest}`);
    if (!cred || cred.status !== "ACTIVE" || cred.reservationId !== reservationId) throw new DomainError("GUEST_ACCESS_INVALID", "Guest credential is invalid", 403);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    const result = await cancelBooking({
      businessId: (await reservationBusiness(reservationId))!,
      reservationId,
      expectedRevision: body.expectedRevision,
      principal: "GUEST_RESERVATION",
      credentialId: cred.id as string,
      reason: body.reason,
      operationId,
    });
    return result;
  });

  /* ─── PUBLIC: guest reschedule ─── */
  app.post("/v1/public/reservations/:reservationId/reschedule", async request => {
    const { reservationId } = z.object({ reservationId: z.string().uuid() }).parse(request.params);
    const body = rescheduleReservationSchema.parse(request.body);
    const token = guestToken(request);
    const { guestTokenDigest } = await import("./security/guest-access.js");
    const digest = guestTokenDigest(token);
    const [cred] = await rows<any>(sql`select id,status,reservation_id "reservationId" from booking.guest_credentials where token_digest=${digest}`);
    if (!cred || cred.status !== "ACTIVE" || cred.reservationId !== reservationId) throw new DomainError("GUEST_ACCESS_INVALID", "Guest credential is invalid", 403);
    const businessId = (await reservationBusiness(reservationId))!;
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    const result = await rescheduleBooking({
      businessId,
      reservationId,
      expectedRevision: body.expectedRevision,
      principal: "GUEST_RESERVATION",
      credentialId: cred.id as string,
      localDate: body.localDate,
      visibleStart: body.visibleStart,
      operationId,
    });
    return result;
  });

  /* ─── PUBLIC: catálogo de servicios publicados por nombre (sin UUID manual) ─── */
  app.get("/v1/public/businesses/:businessId/catalog/services", async request => {
    const { businessId } = businessParam.parse(request.params);
    const [business] = await rows<any>(sql`select id,status from business.businesses where id=${businessId}`);
    if (!business || business.status !== "ACTIVE") throw new DomainError("BUSINESS_NOT_BOOKABLE", "Business is not bookable", 409);
    const items = await rows<any>(sql`select s.id, s.name, v.price_minor "priceMinor", v.duration_minutes "durationMinutes", v.pre_buffer_minutes "preBufferMinutes", v.post_buffer_minutes "postBufferMinutes", v.conditions "conditions" from catalog.services s join catalog.service_terms_versions v on v.business_id=s.business_id and v.service_id=s.id and v.id=s.current_terms_version_id where s.business_id=${businessId} and s.lifecycle='ACTIVE' and s.publication='PUBLISHED' order by s.name`);
    return {
      services: items.map((i: any) => ({
        id: i.id,
        name: i.name,
        priceMinor: Number(i.priceMinor),
        durationMinutes: Number(i.durationMinutes),
        preBufferMinutes: Number(i.preBufferMinutes),
        postBufferMinutes: Number(i.postBufferMinutes),
        conditions: i.conditions ?? null,
      })),
    };
  });

  /* ─── PUBLIC: profesionales disponibles del negocio (para elegir o ANY) ─── */
  app.get("/v1/public/businesses/:businessId/catalog/professionals", async request => {
    const { businessId } = businessParam.parse(request.params);
    const [business] = await rows<any>(sql`select id,status from business.businesses where id=${businessId}`);
    if (!business || business.status !== "ACTIVE") throw new DomainError("BUSINESS_NOT_BOOKABLE", "Business is not bookable", 409);
    const items = await rows<any>(sql`select distinct sm.id, p.first_name "firstName", p.last_name "last_name" from team.staff_members sm join iam.persons p on p.id=sm.person_id where sm.business_id=${businessId} and sm.employment_status='ACTIVE' and sm.access_status='ACTIVE' order by p.first_name, p.last_name`);
    return {
      professionals: items.map((i: any) => ({
        id: i.id,
        name: [i.firstName, i.last_name].filter(Boolean).join(" ") || "Profesional",
      })),
    };
  });

  /* ─── STAFF: list/detail/history (read) ─── */
  /* Agenda compartida (`bookings.read`) o agenda propia (`bookings.self.read`). */
  app.get("/v1/staff/bookings", { preHandler: authenticate }, async request => {
    requireAnyCapability(request, "bookings.read", "bookings.self.read");
    const a = actor(request);
    const query = staffAgendaQuerySchema.parse(request.query);
    return listStaffAgenda(a, query);
  });

  app.get("/v1/staff/bookings/:id", { preHandler: authenticate }, async request => {
    requireAnyCapability(request, "bookings.read", "bookings.self.read");
    const a = actor(request);
    const { id } = uuidParam.parse(request.params);
    return getStaffReservationDetail(a, id);
  });

  app.get("/v1/staff/bookings/:id/history", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "bookings.history.read");
    const { id } = uuidParam.parse(request.params);
    return rows(sql`select * from booking.reservation_events where business_id=${a.businessId} and reservation_id=${id} order by sequence`);
  });

  /* ─── STAFF: H03.U05 · Agenda Staff (creación, llegada, no-show, reasignación) ─── */
  app.post("/v1/staff/bookings", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "bookings.create");
    const body = staffCreateReservationSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return createStaffReservation({
      businessId: a.businessId,
      actorAccountId: a.accountId,
      serviceIds: body.serviceIds,
      localDate: body.localDate,
      visibleStart: body.visibleStart,
      professionalPreference: body.professionalPreference,
      contact: body.contact,
      reason: body.reason,
      operationId,
    });
  });

  app.post("/v1/staff/bookings/:id/arrival", { preHandler: authenticate }, async request => {
    requireAnyCapability(request, "bookings.arrival", "bookings.self.arrival");
    const a = actor(request);
    const { id } = uuidParam.parse(request.params);
    const body = staffArrivalReservationSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    // Ámbito propio (`bookings.self.arrival`) o agenda compartida (`bookings.arrival`).
    const selfScopeOnly = !a.capabilities.has("bookings.arrival");
    if (!selfScopeOnly) authorizationService.require(a, "bookings.arrival");
    else authorizationService.require(a, "bookings.self.arrival");
    return registerStaffArrival({
      businessId: a.businessId,
      actorAccountId: a.accountId,
      actorStaffMemberId: a.staffMemberId,
      reservationId: id,
      expectedRevision: body.expectedRevision,
      arrivalMethod: body.arrivalMethod,
      selfScopeOnly,
      operationId,
    });
  });

  app.post("/v1/staff/bookings/:id/no-show", { preHandler: authenticate }, async request => {
    requireAnyCapability(request, "bookings.no_show", "bookings.self.no_show");
    const a = actor(request);
    const { id } = uuidParam.parse(request.params);
    const body = staffNoShowReservationSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    const selfScopeOnly = !a.capabilities.has("bookings.no_show");
    if (!selfScopeOnly) authorizationService.require(a, "bookings.no_show");
    else authorizationService.require(a, "bookings.self.no_show");
    return confirmStaffNoShow({
      businessId: a.businessId,
      actorAccountId: a.accountId,
      actorStaffMemberId: a.staffMemberId,
      reservationId: id,
      expectedRevision: body.expectedRevision,
      reason: body.reason,
      selfScopeOnly,
      operationId,
    });
  });

  app.post("/v1/staff/bookings/:id/reassign", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "bookings.override.reschedule");
    const { id } = uuidParam.parse(request.params);
    const body = staffReassignReservationSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return reassignStaffReservation({
      businessId: a.businessId,
      actorAccountId: a.accountId,
      actorStaffMemberId: a.staffMemberId,
      reservationId: id,
      expectedRevision: body.expectedRevision,
      staffMemberId: body.staffMemberId,
      reason: body.reason,
      selfScopeOnly: false,
      operationId,
    });
  });

  /* ─── STAFF: overrides ─── */
  app.post("/v1/staff/bookings/:id/override-cancel", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "bookings.override.cancel");
    const { id } = uuidParam.parse(request.params);
    const body = staffOverrideCancelSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return staffExceptionCancel({ businessId: a.businessId, reservationId: id, expectedRevision: body.expectedRevision, reason: body.reason, actorAccountId: a.accountId, operationId });
  });

  app.post("/v1/staff/bookings/:id/override-reschedule", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "bookings.override.reschedule");
    const { id } = uuidParam.parse(request.params);
    const body = staffOverrideRescheduleSchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return staffExceptionReschedule({ businessId: a.businessId, reservationId: id, expectedRevision: body.expectedRevision, localDate: body.localDate, visibleStart: body.visibleStart, professionalPreference: body.professionalPreference, reason: body.reason, actorAccountId: a.accountId, operationId });
  });

  /* ─── STAFF: assisted recovery ─── */
  app.post("/v1/staff/bookings/:id/recover-access", { preHandler: authenticate }, async request => {
    const a = requireCapability(request, "bookings.guest_access.recover");
    const { id } = uuidParam.parse(request.params);
    const body = assistedRecoverySchema.parse(request.body);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return assistedGuestRecovery({
      businessId: a.businessId,
      reservationId: id,
      requestingStaffId: a.staffMemberId,
      verificationMethod: body.verificationMethod,
      evidenceReference: body.evidenceReference,
      reason: body.reason,
      outcome: body.outcome,
      operationId,
    });
  });

  /* ─── CLIENT: identidad real U02 + Booking real U04 ─── */

  if (enableClientBooking) {
    /* POST: confirma una reserva nueva con identidad CLIENT (cotización firmada). */
    app.post("/v1/client/reservations", async request => {
    const client = await resolveClientIdentity(request);
    const body = bookingConfirmClientSchema.parse(request.body);
    const quote = verifyQuote(body.quote);
    const businessId = quote.businessId;
    const [business] = await rows<any>(sql`select id,status from business.businesses where id=${businessId}`);
    if (!business || business.status !== "ACTIVE") throw new DomainError("BUSINESS_NOT_BOOKABLE", "Business is not bookable", 409);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    const contact = await clientContactSnapshot(client);
    const result = await confirmClientBooking({
      accountId: client.accountId,
      authSessionId: client.clientSessionId,
      quoteToken: body.quote,
      contact,
      operationId,
    });
    return result;
  });

  /* GET: lista sólo reservas de la cuenta CLIENT autenticada. */
  app.get("/v1/client/reservations", async request => {
    const client = await resolveClientIdentity(request);
    const query = z.object({
      businessId: z.string().uuid().optional(),
      status: z.enum(["CONFIRMED", "CANCELLED", "ALL"]).default("ALL"),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const statusFilter = query.status === "ALL" ? sql`` : sql`and r.status=${query.status}`;
    return rows(sql`select r.id,r.business_id "businessId",r.status,r.revision::int "revision",r.staff_member_id "staffMemberId",r.starts_at "startsAt",r.ends_at "endsAt",r.commercial_total_minor "total",r.currency,r.business_local_date "localDate",r.business_timezone_snapshot "businessTimezone",b.display_name "businessName"
      from booking.reservations r join business.businesses b on b.id=r.business_id
      where r.owner_type='CLIENT' and r.owner_account_id=${client.accountId}
      ${query.businessId ? sql`and r.business_id=${query.businessId}` : sql``}
      ${statusFilter}
      order by r.starts_at desc limit ${query.limit}`);
  });

  /* GET: detalle de una reserva propia. */
  app.get("/v1/client/reservations/:id", async request => {
    const client = await resolveClientIdentity(request);
    const { id } = uuidParam.parse(request.params);
    const reservation = await ownedClientReservation(client.accountId, id);
    const items = await rows<any>(sql`select position,service_id "serviceId",service_name_snapshot "name",duration_minutes "durationMinutes",price_minor "priceMinor",currency from booking.reservation_items where business_id=${reservation.businessId} and reservation_id=${id} order by position`);
    const events = await rows<any>(sql`select sequence,event_type "eventType",principal_type "principalType",occurred_at "occurredAt" from booking.reservation_events where business_id=${reservation.businessId} and reservation_id=${id} order by sequence`);
    return { reservation, items, events };
  });

  /* POST: cancela una reserva propia (cutoff, revisión e idempotencia de U04). */
  app.post("/v1/client/reservations/:id/cancel", async request => {
    const client = await resolveClientIdentity(request);
    const { id } = uuidParam.parse(request.params);
    const body = cancelReservationSchema.parse(request.body);
    const reservation = await ownedClientReservation(client.accountId, id);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return cancelBooking({
      businessId: reservation.businessId,
      reservationId: id,
      expectedRevision: body.expectedRevision,
      principal: "CLIENT",
      accountId: client.accountId,
      reason: body.reason,
      operationId,
    });
  });

  /* POST: reprograma una reserva propia (mismo ID, precio e historial). */
  app.post("/v1/client/reservations/:id/reschedule", async request => {
    const client = await resolveClientIdentity(request);
    const { id } = uuidParam.parse(request.params);
    const body = rescheduleReservationSchema.parse(request.body);
    const reservation = await ownedClientReservation(client.accountId, id);
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return rescheduleBooking({
      businessId: reservation.businessId,
      reservationId: id,
      expectedRevision: body.expectedRevision,
      principal: "CLIENT",
      accountId: client.accountId,
      localDate: body.localDate,
      visibleStart: body.visibleStart,
      operationId,
    });
  });

  /* POST: asocia una reserva invitada a la cuenta CLIENT (prueba de control). */
  app.post("/v1/client/reservations/:id/associate", async request => {
    const client = await resolveClientIdentity(request);
    const { id } = uuidParam.parse(request.params);
    const token = guestToken(request);
    const { guestTokenDigest } = await import("./security/guest-access.js");
    const digest = guestTokenDigest(token);
    const [credential] = await rows<any>(sql`select id,business_id "businessId",reservation_id "reservationId",status::text status from booking.guest_credentials where token_digest=${digest}`);
    if (!credential || credential.status !== "ACTIVE" || credential.reservationId !== id) {
      throw new DomainError("GUEST_ACCESS_INVALID", "Guest credential is invalid for this reservation", 403);
    }
    const operationId = opIdFromHeader(request.headers as Record<string, unknown>);
    return associateGuestReservation({
      businessId: credential.businessId,
      reservationId: id,
      accountId: client.accountId,
      authSessionId: client.clientSessionId,
      guestToken: token,
      operationId,
    });
  });
  }

  /* Fail-closed: si ENABLE_CLIENT_BOOKING no está habilitado, registrar rutas que devuelven 501 */
  if (!enableClientBooking) {
    const failClosed = async () => {
      throw new DomainError("CLIENT_AUTH_INSUFFICIENT", "Client booking requires U02 identity service", 501);
    };
    app.post("/v1/client/reservations", failClosed);
    app.get("/v1/client/reservations", failClosed);
    app.get("/v1/client/reservations/:id", failClosed);
    app.post("/v1/client/reservations/:id/cancel", failClosed);
    app.post("/v1/client/reservations/:id/reschedule", failClosed);
    app.post("/v1/client/reservations/:id/associate", failClosed);
  }
} // Cierra registerBookingRoutes

/**
 * Reserva CLIENT de la cuenta indicada. El aislamiento es por cuenta global:
 * una reserva de otra cuenta o de otro propietario no existe para este principal.
 */
async function ownedClientReservation(accountId: string, reservationId: string): Promise<{ id: string; businessId: string; status: string; revision: number; startsAt: string; endsAt: string; staffMemberId: string; total: number; currency: string; localDate: string; businessTimezone: string }> {
  const [reservation] = await rows<any>(sql`select r.id,r.business_id "businessId",r.status,r.revision::int "revision",r.staff_member_id "staffMemberId",r.starts_at "startsAt",r.ends_at "endsAt",r.commercial_total_minor "total",r.currency,r.business_local_date "localDate",r.business_timezone_snapshot "businessTimezone" from booking.reservations r where r.id=${reservationId} and r.owner_type='CLIENT' and r.owner_account_id=${accountId}`);
  if (!reservation) throw new DomainError("BOOKING_NOT_FOUND", "Reservation not found", 404);
  return reservation;
}

async function reservationBusiness(reservationId: string): Promise<string | undefined> {
  const [row] = await rows<any>(sql`select business_id "businessId" from booking.reservations where id=${reservationId}`);
  return row?.businessId as string | undefined;
}

function parseClock(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new DomainError("VALIDATION_ERROR", "Time must be HH:mm", 400);
  return Number(match[1]) * 60 + Number(match[2]);
}
