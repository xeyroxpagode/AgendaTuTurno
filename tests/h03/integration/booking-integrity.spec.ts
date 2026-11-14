/**
 * H03.U04 — Integridad física Reservation ↔ Allocation (G08) y constraints (G02).
 * Pruebas SQL adversariales contra PostgreSQL real (local, descartable).
 * Cada caso usa una fecha local única para no colisionar con la constraint GiST.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../../../apps/api/src/lib/runtime";
import { FIXTURE_TIMEZONE, seedBookingBusiness, reservationOperation, type BookingSeed } from "./booking-fixtures";

let seed: BookingSeed;

beforeAll(async () => {
  seed = await seedBookingBusiness("U04 Integrity");
});

type Window = { localDate: string; startsAt: string; endsAt: string; occupiedStartsAt: string; occupiedEndsAt: string };
let dayCounter = 5;
function nextWindow(): Window {
  const localDate = `2026-11-${String(dayCounter++).padStart(2, "0")}`;
  return {
    localDate,
    startsAt: `${localDate}T13:30:00Z`,
    endsAt: `${localDate}T14:20:00Z`,
    occupiedStartsAt: `${localDate}T13:25:00Z`,
    occupiedEndsAt: `${localDate}T14:25:00Z`,
  };
}

type ReservationOverrides = Partial<{
  id: string;
  businessId: string;
  staffMemberId: string;
  status: string;
  ownerType: string;
  ownerAccountId: string | null;
  revision: number;
  window: Window;
  operationId: string;
  policyVersionId: string;
  currentAllocationId: string | null;
}>;

async function insertReservation(tx: typeof database.client | import("../../../apps/api/src/modules/system/operations").Tx, overrides: ReservationOverrides = {}) {
  const id = overrides.id ?? randomUUID();
  const businessId = overrides.businessId ?? seed.business;
  const staffMemberId = overrides.staffMemberId ?? seed.staffA;
  const w = overrides.window ?? nextWindow();
  const operationId = overrides.operationId ?? (await reservationOperation(tx, businessId));
  const policyVersionId = overrides.policyVersionId ?? seed.policyVersionId;
  const status = overrides.status ?? "CONFIRMED";
  const ownerType = overrides.ownerType ?? "GUEST";
  const ownerAccountId = overrides.ownerAccountId ?? null;
  const revision = overrides.revision ?? 1;
  const cancelledAt = status === "CANCELLED" ? new Date().toISOString() : null;
  await tx`insert into booking.reservations(id,business_id,revision,status,owner_type,owner_account_id,contact_snapshot,staff_member_id,policy_version_id,policy_snapshot,commercial_total_minor,currency,current_allocation_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,business_local_date,business_timezone_snapshot,created_operation_id,cancelled_at)
    values (${id},${businessId},${revision},${status},${ownerType},${ownerAccountId},'{"name":"X","phone":"1100000000"}'::jsonb,${staffMemberId},${policyVersionId},'{}'::jsonb,1500,'ARS',${overrides.currentAllocationId ?? null},${w.startsAt},${w.endsAt},${w.occupiedStartsAt},${w.occupiedEndsAt},${w.localDate},${FIXTURE_TIMEZONE},${operationId},${cancelledAt})`;
  return id;
}

async function insertAllocation(tx: typeof database.client | import("../../../apps/api/src/modules/system/operations").Tx, input: { sourceId: string; businessId?: string; staffMemberId?: string; window?: Window }) {
  const businessId = input.businessId ?? seed.business;
  const staffMemberId = input.staffMemberId ?? seed.staffA;
  const w = input.window ?? nextWindow();
  const [row] = await tx`insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at) values (${businessId},${staffMemberId},'RESERVATION',${input.sourceId},${w.localDate},${w.startsAt},${w.endsAt},${w.occupiedStartsAt},${w.occupiedEndsAt}) returning id`;
  return row!.id as string;
}

describe("H03.U04 booking integrity (PostgreSQL real)", () => {
  it("creates a valid reservation + allocation pair with linked current_allocation_id", async () => {
    const w = nextWindow();
    const sourceId = randomUUID();
    let allocationId = "";
    await database.client.begin(async tx => {
      allocationId = await insertAllocation(tx, { sourceId, window: w });
      await insertReservation(tx, { id: sourceId, currentAllocationId: allocationId, window: w });
    });
    const [row] = await database.client`select r.current_allocation_id "alloc" from booking.reservations r where r.id=${sourceId}`;
    expect(row!.alloc).toBe(allocationId);
  });

  it("rejects COMMIT of a CONFIRMED reservation without Allocation", async () => {
    await expect(database.client.begin(async tx => {
      await insertReservation(tx, {});
    })).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects COMMIT of an ACTIVE RESERVATION Allocation without Reservation", async () => {
    await expect(database.client.begin(async tx => {
      await insertAllocation(tx, { sourceId: randomUUID() });
    })).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a second ACTIVE Allocation for the same source (unique partial index)", async () => {
    const w = nextWindow();
    const w2 = { ...w, occupiedStartsAt: `${w.localDate}T15:00:00Z`, occupiedEndsAt: `${w.localDate}T15:30:00Z`, startsAt: `${w.localDate}T15:00:00Z`, endsAt: `${w.localDate}T15:30:00Z` };
    const sourceId = randomUUID();
    await expect(database.client.begin(async tx => {
      await insertAllocation(tx, { sourceId, window: w });
      await insertAllocation(tx, { sourceId, window: w2 });
    })).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects Allocation whose Staff does not match the Reservation", async () => {
    const w = nextWindow();
    const sourceId = randomUUID();
    await expect(database.client.begin(async tx => {
      const allocationId = await insertAllocation(tx, { sourceId, window: w, staffMemberId: seed.staffB });
      await insertReservation(tx, { id: sourceId, window: w, staffMemberId: seed.staffA, currentAllocationId: allocationId });
    })).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects Allocation whose intervals do not match the Reservation", async () => {
    const w = nextWindow();
    const wMisaligned = { ...w, occupiedStartsAt: `${w.localDate}T13:35:00Z`, occupiedEndsAt: `${w.localDate}T14:35:00Z` };
    const sourceId = randomUUID();
    await expect(database.client.begin(async tx => {
      const allocationId = await insertAllocation(tx, { sourceId, window: wMisaligned });
      await insertReservation(tx, { id: sourceId, window: w, currentAllocationId: allocationId });
    })).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects CANCELLED reservation retaining an ACTIVE Allocation", async () => {
    const w = nextWindow();
    const sourceId = randomUUID();
    await expect(database.client.begin(async tx => {
      const allocationId = await insertAllocation(tx, { sourceId, window: w });
      await insertReservation(tx, { id: sourceId, window: w, currentAllocationId: allocationId, status: "CANCELLED" });
    })).rejects.toMatchObject({ code: "23514" });
  });


  it("rejects cross-business Reservation reference (composite FK)", async () => {
    const other = await seedBookingBusiness("U04 Integrity Other");
    await expect(database.client.begin(async tx => {
      await insertReservation(tx, { businessId: other.business, staffMemberId: seed.staffA });
    })).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects CONFIRMED reservation whose ACTIVE Allocation belongs to another Business (F01-3)", async () => {
    const other = await seedBookingBusiness("U04 Integrity CrossBiz");
    const sourceId = randomUUID();
    const w = nextWindow();
    await expect(database.client.begin(async tx => {
      // Allocation ACTIVE en OTRO negocio, referenciando el id de la reserva (sin current_allocation_id para evitar el FK compuesto).
      await insertAllocation(tx, { sourceId, businessId: other.business, staffMemberId: other.staffA, window: w });
      // Reserva CONFIRMED en seed.business apuntando al mismo source id.
      await insertReservation(tx, { id: sourceId, businessId: seed.business, staffMemberId: seed.staffA, window: w, currentAllocationId: null });
    })).rejects.toMatchObject({ code: "23514" });
    // Ningún lado debe haber persistido nada de la transacción rechazada.
    expect(Number((await database.client`select count(*) c from booking.reservations where id=${sourceId}`)[0]!.c)).toBe(0);
    expect(Number((await database.client`select count(*) c from availability.resource_allocations where source_id=${sourceId}`)[0]!.c)).toBe(0);
  });

  it("rejects ReservationItem of a Reservation from another Business", async () => {
    const other = await seedBookingBusiness("U04 Integrity Items");
    const w = nextWindow();
    const sourceId = randomUUID();
    await expect(database.client.begin(async tx => {
      const allocationId = await insertAllocation(tx, { sourceId, window: w });
      await insertReservation(tx, { id: sourceId, window: w, currentAllocationId: allocationId });
      await tx`insert into booking.reservation_items(business_id,reservation_id,position,service_id,service_name_snapshot,terms_version_id,duration_minutes,pre_buffer_minutes,post_buffer_minutes,price_minor,currency) values (${other.business},${sourceId},1,${seed.serviceCut},'Corte',${seed.termsCut},30,5,5,1000,'ARS')`;
    })).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects duplicate service in the same Reservation (D13)", async () => {
    const w = nextWindow();
    const sourceId = randomUUID();
    await expect(database.client.begin(async tx => {
      const allocationId = await insertAllocation(tx, { sourceId, window: w });
      await insertReservation(tx, { id: sourceId, window: w, currentAllocationId: allocationId });
      for (const position of [1, 2]) {
        await tx`insert into booking.reservation_items(business_id,reservation_id,position,service_id,service_name_snapshot,terms_version_id,duration_minutes,pre_buffer_minutes,post_buffer_minutes,price_minor,currency) values (${seed.business},${sourceId},${position},${seed.serviceCut},'Corte',${seed.termsCut},30,5,5,1000,'ARS')`;
      }
    })).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects duplicate position in the same Reservation", async () => {
    const w = nextWindow();
    const sourceId = randomUUID();
    await expect(database.client.begin(async tx => {
      const allocationId = await insertAllocation(tx, { sourceId, window: w });
      await insertReservation(tx, { id: sourceId, window: w, currentAllocationId: allocationId });
      for (const service of [seed.serviceCut, seed.serviceBeard]) {
        const terms = service === seed.serviceCut ? seed.termsCut : seed.termsBeard;
        await tx`insert into booking.reservation_items(business_id,reservation_id,position,service_id,service_name_snapshot,terms_version_id,duration_minutes,pre_buffer_minutes,post_buffer_minutes,price_minor,currency) values (${seed.business},${sourceId},1,${service},'S',${terms},30,5,5,1000,'ARS')`;
      }
    })).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects invalid status, revision, owner mismatch and negative total", async () => {
    await expect(database.client.begin(tx => insertReservation(tx, { status: "PENDING" }))).rejects.toMatchObject({ code: "23514" });
    await expect(database.client.begin(tx => insertReservation(tx, { revision: 0 }))).rejects.toMatchObject({ code: "23514" });
    await expect(database.client.begin(tx => insertReservation(tx, { ownerType: "GUEST", ownerAccountId: seed.account }))).rejects.toMatchObject({ code: "23514" });
    await expect(database.client.begin(tx => insertReservation(tx, { ownerType: "CLIENT", ownerAccountId: null }))).rejects.toMatchObject({ code: "23514" });
    await expect(database.client.begin(async tx => {
      const w = nextWindow();
      const operationId = await reservationOperation(tx, seed.business);
      await tx`insert into booking.reservations(id,business_id,revision,status,owner_type,contact_snapshot,staff_member_id,policy_version_id,policy_snapshot,commercial_total_minor,currency,starts_at,ends_at,occupied_starts_at,occupied_ends_at,business_local_date,business_timezone_snapshot,created_operation_id)
        values (${randomUUID()},${seed.business},1,'CONFIRMED','GUEST','{}'::jsonb,${seed.staffA},${seed.policyVersionId},'{}'::jsonb,-1,'ARS',${w.startsAt},${w.endsAt},${w.occupiedStartsAt},${w.occupiedEndsAt},${w.localDate},${FIXTURE_TIMEZONE},${operationId})`;
    })).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls back the whole transaction when a later statement fails (no partial writes)", async () => {
    const w = nextWindow();
    const sourceId = randomUUID();
    await expect(database.client.begin(async tx => {
      await insertReservation(tx, { id: sourceId, window: w });
      throw new Error("forced failure after reservation insert");
    })).rejects.toThrow("forced failure");
    expect((await database.client`select count(*) count from booking.reservations where id=${sourceId}`)[0]!.count).toBe("0");
  });

  it("RLS denies anon and authenticated direct access to booking tables", async () => {
    for (const table of ["reservations", "reservation_items", "reservation_events", "guest_credentials", "guest_delivery_envelopes", "guest_recovery_cases"]) {
      await expect(database.client.begin(async tx => {
        await tx`set local role anon`;
        await tx.unsafe(`select * from booking.${table}`);
      })).rejects.toMatchObject({ code: "42501" });
      await expect(database.client.begin(async tx => {
        await tx`set local role authenticated`;
        await tx.unsafe(`select * from booking.${table}`);
      })).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("rejects UPDATE and DELETE on reservation_events (append-only)", async () => {
    const w = nextWindow();
    const sourceId = randomUUID();
    await database.client.begin(async tx => {
      const allocationId = await insertAllocation(tx, { sourceId, window: w });
      await insertReservation(tx, { id: sourceId, window: w, currentAllocationId: allocationId });
      const operationId = await reservationOperation(tx, seed.business);
      await tx`insert into booking.reservation_events(business_id,reservation_id,sequence,event_type,operation_id,principal_type) values (${seed.business},${sourceId},1,'RESERVATION_CONFIRMED',${operationId},'GUEST_INTENT')`;
    });
    await expect(database.client`update booking.reservation_events set reason_code='x' where reservation_id=${sourceId}`).rejects.toMatchObject({ code: "55000" });
    await expect(database.client`delete from booking.reservation_events where reservation_id=${sourceId}`).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects DELETE on reservations and allocations", async () => {
    const w = nextWindow();
    const sourceId = randomUUID();
    await database.client.begin(async tx => {
      const allocationId = await insertAllocation(tx, { sourceId, window: w });
      await insertReservation(tx, { id: sourceId, window: w, currentAllocationId: allocationId });
    });
    await expect(database.client`delete from booking.reservations where id=${sourceId}`).rejects.toMatchObject({ code: "55000" });
    // La allocation está referenciada por reservations.current_allocation_id (FK NO ACTION),
    // que rechaza el borrado antes que el trigger difible; ambas vías impiden el borrado.
    await expect(database.client`delete from availability.resource_allocations where source_id=${sourceId} and source_type='RESERVATION'`).rejects.toMatchObject({ code: "23503" });
  });
});
