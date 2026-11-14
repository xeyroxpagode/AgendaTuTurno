/**
 * H03.U06 · IAM — integración con sesiones REALES.
 *
 * Este paquete NO usa actores ficticios construidos desde `roleCapabilities`:
 * crea usuarios reales en el proveedor de identidad local, inicia sesión de
 * verdad, e invoca la API con el Bearer token resultante.
 *
 * Escenario central (CN-06 / IT-IAM-01): un BARBER con un grant
 * `bookings.read` INSERTADO EN LA BASE no debe poder leer la agenda
 * compartida. La compatibilidad rol <-> capability se aplica al calcular el
 * conjunto efectivo de capabilities, no al emitir el grant.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { buildApp } from "../../../apps/api/src/app.js";
import { database } from "../../../apps/api/src/lib/runtime";
import { seedLocalReservation } from "./absence-fixtures";
import { seedStaffAgendaBusiness, destroyStaffAgendaBusiness, type StaffAgendaSeed } from "./staff-agenda-fixtures";

/** Miércoles con horario de fixture, para sembrar reservas reales. */
const IAM_DATE = "2026-12-16";

const supabaseUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const anonKey = process.env.SUPABASE_ANON_KEY ?? serviceKey;
const password = "YoungKingz-Iam!26";

const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

let seed: StaffAgendaSeed;
let app: Awaited<ReturnType<typeof buildApp>>;
const createdEmails: string[] = [];

async function createAuthUser(email: string): Promise<{ authUserId: string; accessToken: string }> {
  createdEmails.push(email);
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const authUserId = created.data.user!.id;

  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  return { authUserId, accessToken: signedIn.data.session!.access_token };
}

async function api(method: string, url: string, token: string, payload?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "x-operation-id": randomUUID() };
  if (payload !== undefined) headers["content-type"] = "application/json";
  const response = await app.inject({ method, url, payload, headers });
  return { status: response.statusCode, body: response.json() };
}

/** Vincula una cuenta global (`iam.user_accounts`) con un usuario del proveedor. */
async function linkAccount(accountId: string, authUserId: string) {
  await database.client`update iam.user_accounts set auth_user_id=${authUserId}, verified_email=(select verified_email from iam.user_accounts where id=${accountId}) where id=${accountId}`;
}

beforeAll(async () => {
  seed = await seedStaffAgendaBusiness("U06 IAM");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await destroyStaffAgendaBusiness(seed);
  for (const email of createdEmails) {
    const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (list.error) continue;
    for (const user of list.data.users.filter((item) => item.email === email)) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("H03.U06 · IAM con sesiones reales (proveedor local)", () => {
  it("IT-IAM-01 / CN-06 · un BARBER con grant `bookings.read` NO lee la agenda compartida", async () => {
    const email = `ykz-iam-barber-${randomUUID()}@example.test`;
    const { authUserId, accessToken } = await createAuthUser(email);
    await linkAccount(seed.barberAccount, authUserId);

    // Reservas reales de dos profesionales distintos del mismo Business.
    const ownReservation = await seedLocalReservation(seed, { staffMemberId: seed.barberStaff, localDate: IAM_DATE, startMinute: 480, customerName: "Cliente Del Barbero" });
    const otherReservation = await seedLocalReservation(seed, { staffMemberId: seed.ownerStaff, localDate: IAM_DATE, startMinute: 600, customerName: "Cliente Del Owner" });

    // Grant insertado directamente en la base: simula un grant preexistente o
    // mal emitido. La API de emisión lo rechaza, pero la DEFENSA debe ser en
    // la capa de autorización, no sólo en la de emisión.
    const [assignment] = await database.client`select id from iam.role_assignments where business_id=${seed.business} and staff_member_id=${seed.barberStaff} and role='BARBER' and revoked_at is null limit 1`;
    await database.client`
      insert into iam.capability_grants(business_id,staff_member_id,role_assignment_id,capability,scope,granted_by_account_id,valid_from)
      values (${seed.business},${seed.barberStaff},${assignment!.id},'bookings.read',${JSON.stringify({ type: "BUSINESS", businessId: seed.business })}::jsonb,${seed.ownerAccount},now())`;

    // La capability del grant NO es efectiva para el BARBER.
    const permissions = await api("GET", "/v1/iam/me/permissions", accessToken);
    expect(permissions.status).toBe(200);
    expect(permissions.body?.role).toBe("BARBER");
    expect(permissions.body?.capabilities).not.toContain("bookings.read");
    expect(permissions.body?.capabilities).toContain("bookings.self.read");

    // La agenda compartida NO le es accesible: sólo ve sus propias reservas.
    const agenda = await api("GET", "/v1/staff/bookings?status=ALL&limit=100", accessToken);
    expect(agenda.status).toBe(200);
    const ids = (agenda.body?.items ?? []).map((item: { id: string }) => item.id);
    expect(ids).toContain(ownReservation.reservationId);
    expect(ids).not.toContain(otherReservation.reservationId);

    // Consultar la agenda de otro profesional es un 403 explícito.
    const foreign = await api("GET", `/v1/staff/bookings?staffMemberId=${seed.ownerStaff}`, accessToken);
    expect(foreign.status).toBe(403);
    expect(foreign.body?.error?.code).toBe("FORBIDDEN");
  });

  it("IT-IAM-02 · las rutas exigen capability en preHandler (403 antes de la lógica)", async () => {
    const email = `ykz-iam-barber2-${randomUUID()}@example.test`;
    const { authUserId, accessToken } = await createAuthUser(email);
    await linkAccount(seed.barberAccount, authUserId);

    // El BARBER no tiene `absence.approve`: la ruta lo rechaza con 403.
    const approve = await api("POST", `/v1/absences/${randomUUID()}/approve`, accessToken, { expectedRevision: 1 });
    expect(approve.status).toBe(403);
    expect(approve.body?.error?.code).toBe("FORBIDDEN");

    // Tampoco puede registrar atenciones sobre otro profesional.
    const attendance = await api("POST", "/v1/attendance", accessToken, {
      reservationId: randomUUID(), walkIn: false, attendedByStaffMemberId: seed.ownerStaff
    });
    expect(attendance.status).toBe(403);
  });

  it("IT-IAM-04 · el OWNER opera ausencias y atenciones dentro de su Business", async () => {
    const email = `ykz-iam-owner-${randomUUID()}@example.test`;
    const { authUserId, accessToken } = await createAuthUser(email);
    await linkAccount(seed.ownerAccount, authUserId);

    const list = await api("GET", "/v1/absences", accessToken);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body?.items)).toBe(true);

    const attendances = await api("GET", "/v1/attendance", accessToken);
    expect(attendances.status).toBe(200);
    expect(Array.isArray(attendances.body?.items)).toBe(true);

    // Puede solicitar una ausencia para cualquier profesional del Business.
    const requested = await api("POST", "/v1/absences", accessToken, {
      staffMemberId: seed.barberStaff, localDate: "2026-12-02", startMinute: 60, endMinute: 120, reason: "Solicitud del Owner"
    });
    expect(requested.status).toBe(200);
    expect(requested.body?.status).toBe("PENDING");

    // Y puede aprobarla y aplicarla (no hay compromisos en conflicto).
    const approved = await api("POST", `/v1/absences/${requested.body.absenceId}/approve`, accessToken, { expectedRevision: 1 });
    expect(approved.status).toBe(200);
    expect(approved.body?.status).toBe("APPROVED");

    const applied = await api("POST", `/v1/absences/${requested.body.absenceId}/apply`, accessToken, { expectedRevision: 2 });
    expect(applied.status).toBe(200);
    expect(applied.body?.status).toBe("APPLIED");
  });

  it("el BARBER no puede aprobar ni aplicar ausencias (segregación de funciones)", async () => {
    const email = `ykz-iam-barber3-${randomUUID()}@example.test`;
    const { authUserId, accessToken } = await createAuthUser(email);
    await linkAccount(seed.barberAccount, authUserId);

    const requested = await api("POST", "/v1/absences", accessToken, {
      staffMemberId: seed.barberStaff, localDate: "2026-12-09", startMinute: 60, endMinute: 120, reason: "Solicitud propia"
    });
    expect(requested.status).toBe(200);

    const approve = await api("POST", `/v1/absences/${requested.body.absenceId}/approve`, accessToken, { expectedRevision: 1 });
    expect(approve.status).toBe(403);

    const apply = await api("POST", `/v1/absences/${requested.body.absenceId}/apply`, accessToken, { expectedRevision: 1 });
    expect(apply.status).toBe(403);
  });

  it("aislamiento multi-Business: una sesión no alcanza datos de otro negocio", async () => {
    const other = await seedStaffAgendaBusiness("U06 IAM Ajeno");
    try {
      const email = `ykz-iam-owner2-${randomUUID()}@example.test`;
      const { authUserId, accessToken } = await createAuthUser(email);
      await linkAccount(seed.ownerAccount, authUserId);

      const foreign = await api("GET", `/v1/businesses/current`, accessToken);
      expect(foreign.status).toBe(200);
      expect(foreign.body?.id).toBe(seed.business);
    } finally {
      await destroyStaffAgendaBusiness(other);
    }
  });
});
