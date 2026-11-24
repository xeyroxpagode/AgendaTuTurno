/**
 * H03.U05 · Queries de Agenda Staff.
 *
 * Lee exclusivamente de `booking.reservations` (fuente única de verdad) y
 * `booking.reservation_events` (historial append-only). NO existe una tabla
 * `agenda`: la agenda es una PROYECCIÓN de las reservas (D-03).
 *
 * Todo filtro incluye `business_id = actor.businessId` (RB-10) y el alcance
 * profesional se restringe a `staff_member_id` cuando el actor no tiene
 * `bookings.read` (agenda propia del barbero).
 */
import { DomainError } from "@youngkingz/contracts";
import { rows, sql } from "../../lib/sql.js";
import type { Actor } from "../iam/authorization.js";

export type AgendaScope = { staffMemberId?: string };

/**
 * Alcance de lectura de la agenda.
 * · `bookings.read`      → agenda compartida del Business (todos los profesionales).
 * · `bookings.self.read` → agenda propia: únicamente las reservas del actor.
 */
export function resolveAgendaScope(actor: Actor): AgendaScope {
  if (actor.capabilities.has("bookings.read")) return {};
  if (actor.capabilities.has("bookings.self.read")) return { staffMemberId: actor.staffMemberId };
  throw new DomainError("FORBIDDEN", "Missing capability: bookings.read", 403);
}

export type AgendaQuery = {
  fromDate?: string;
  toDate?: string;
  status: "ALL" | "CONFIRMED" | "CANCELLED" | "NO_SHOW";
  staffMemberId?: string;
  cursor?: string;
  limit: number;
};

export type AgendaRow = {
  id: string;
  status: string;
  revision: number;
  staffMemberId: string;
  startsAt: string;
  endsAt: string;
  localDate: string;
  commercialTotalMinor: number;
  currency: string;
  ownerType: string;
  customerName: string | null;
  serviceNames: string[];
  arrivedAt: string | null;
  noShowAt: string | null;
};

export async function listStaffAgenda(actor: Actor, query: AgendaQuery) {
  const scope = resolveAgendaScope(actor);
  // AC-12: un actor de agenda propia no puede consultar la de otro profesional.
  if (scope.staffMemberId && query.staffMemberId && query.staffMemberId !== scope.staffMemberId) {
    throw new DomainError("FORBIDDEN", "Cannot read another professional's agenda", 403);
  }
  const effectiveStaff = scope.staffMemberId ?? query.staffMemberId;
  const statusFilter = query.status === "ALL" ? sql`` : sql`and r.status = ${query.status}`;
  const staffFilter = effectiveStaff ? sql`and r.staff_member_id = ${effectiveStaff}` : sql``;
  const fromFilter = query.fromDate ? sql`and r.business_local_date >= ${query.fromDate}` : sql``;
  const toFilter = query.toDate ? sql`and r.business_local_date <= ${query.toDate}` : sql``;
  // Cursor compuesto estable: `startsAt|id` permite reanudar exactamente donde
  // terminó la página anterior sin OFFSET ni saltos por empates de timestamp.
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const cursorFilter = cursor
    ? sql`and (r.starts_at, r.id) > (${cursor.startsAt}::timestamptz, ${cursor.id}::uuid)`
    : sql``;

  const items = await rows<AgendaRow>(sql`
    select r.id, r.status, r.revision::int "revision", r.staff_member_id "staffMemberId",
           r.starts_at "startsAt", r.ends_at "endsAt", r.business_local_date "localDate", r.business_timezone_snapshot "businessTimezone",
           r.commercial_total_minor::int "commercialTotalMinor", r.currency, r.owner_type "ownerType",
           r.contact_snapshot->>'name' "customerName",
           coalesce((select array_agg(i.service_name_snapshot order by i.position)
                       from booking.reservation_items i
                      where i.business_id = r.business_id and i.reservation_id = r.id), '{}') "serviceNames",
           (select max(e.occurred_at) from booking.reservation_events e
             where e.business_id = r.business_id and e.reservation_id = r.id
               and e.event_type = 'ARRIVAL_REGISTERED') "arrivedAt",
           r.no_show_at "noShowAt"
      from booking.reservations r
     where r.business_id = ${actor.businessId}
       ${statusFilter} ${staffFilter} ${fromFilter} ${toFilter} ${cursorFilter}
     order by r.starts_at asc, r.id asc
     limit ${query.limit + 1}`);

  const courseOccupancy = query.status === "ALL" || query.status === "CONFIRMED" ? await rows(sql`
    select a.source_id id, a.staff_member_id "staffMemberId", a.local_date "localDate",
           a.visible_start_at "startsAt", a.visible_end_at "endsAt", c.title
    from availability.resource_allocations a
    join courses.course_sessions s on s.business_id=a.business_id and s.id=a.source_id
    join courses.courses c on c.business_id=s.business_id and c.id=s.course_id
    where a.business_id=${actor.businessId} and a.source_type='COURSE_SESSION' and a.status='ACTIVE'
      ${effectiveStaff ? sql`and a.staff_member_id=${effectiveStaff}` : sql``}
      ${query.fromDate ? sql`and a.local_date>=${query.fromDate}` : sql``}
      ${query.toDate ? sql`and a.local_date<=${query.toDate}` : sql``}
    order by a.visible_start_at,a.id limit ${query.limit}`) : [];
  const page = items.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page,
    courseOccupancy,
    nextCursor: items.length > query.limit && last ? encodeCursor(last.startsAt, last.id) : null,
  };
}

function encodeCursor(startsAt: string, id: string): string {
  return Buffer.from(`${startsAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { startsAt: string; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator < 1) throw new DomainError("VALIDATION_ERROR", "Invalid cursor", 400);
  return { startsAt: decoded.slice(0, separator), id: decoded.slice(separator + 1) };
}

export async function getStaffReservationDetail(actor: Actor, reservationId: string) {
  const scope = resolveAgendaScope(actor);
  const [reservation] = await rows<any>(sql`
    select r.id, r.status, r.revision::int "revision", r.staff_member_id "staffMemberId",
           r.starts_at "startsAt", r.ends_at "endsAt", r.business_local_date "localDate", r.business_timezone_snapshot "businessTimezone",
           r.commercial_total_minor::int "commercialTotalMinor", r.currency, r.owner_type "ownerType",
           r.contact_snapshot->'name' "contactName",
           r.contact_snapshot->>'phone' "contactPhone",
           r.contact_snapshot->>'email' "contactEmail",
           r.contact_snapshot->>'name' "customerName",
           r.no_show_at "noShowAt", r.cancelled_at "cancelledAt",
           coalesce((select array_agg(i.service_name_snapshot order by i.position)
                       from booking.reservation_items i
                      where i.business_id = r.business_id and i.reservation_id = r.id), '{}') "serviceNames",
           (select max(e.occurred_at) from booking.reservation_events e
             where e.business_id = r.business_id and e.reservation_id = r.id
               and e.event_type = 'ARRIVAL_REGISTERED') "arrivedAt"
      from booking.reservations r
     where r.business_id = ${actor.businessId} and r.id = ${reservationId}`);
  if (!reservation) throw new DomainError("BOOKING_NOT_FOUND", "Reservation not found", 404);
  if (scope.staffMemberId && reservation.staffMemberId !== scope.staffMemberId) {
    throw new DomainError("FORBIDDEN", "Reservation is not assigned to this professional", 403);
  }

  const items = await rows<any>(sql`
    select position, service_id "serviceId", service_name_snapshot "serviceName",
           duration_minutes "durationMinutes", price_minor::int "priceMinor", currency
      from booking.reservation_items
     where business_id = ${actor.businessId} and reservation_id = ${reservationId}
     order by position`);

  const events = await rows<any>(sql`
    select sequence, event_type "eventType", principal_type "principalType",
           actor_account_id "actorAccountId", occurred_at "occurredAt",
           before_revision::int "beforeRevision", after_revision::int "afterRevision",
           changes, reason_code "reasonCode"
      from booking.reservation_events
     where business_id = ${actor.businessId} and reservation_id = ${reservationId}
     order by sequence`);

  return {
    reservation: {
      ...reservation,
      contact: { name: reservation.contactName ?? null, phone: reservation.contactPhone ?? null, email: reservation.contactEmail ?? null },
    },
    items,
    events,
  };
}
