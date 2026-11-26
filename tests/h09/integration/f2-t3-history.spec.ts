/**
 * F2 · T3/R-31 — Oráculo M17 DEFINITIVO, independiente de producción.
 *
 * Ejecuta el SQL de 02_CONTRACT_RESOLUTION/oracles/M17_DEFINITIVE.sql contra
 * la QA nueva, comprueba su SHA y compara la secuencia COMPLETA del DTO
 * paginado: mismos tipo/objeto/sequence/event_id/tiempo/acción/estado, sin
 * duplicados ni omisiones. Incluye empates, sequence NULL/igual/diferente,
 * multipágina, B2, revocación de grants y exclusión de OTHER.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { history } from "../../../apps/api/src/modules/reporting/blocks.js";
import { decodeHistoryCursor } from "../../../apps/api/src/modules/reporting/dto.js";
import {
  ACCOUNT_BARBER, ACCOUNT_OWNER, ACCOUNT_RECEPTION, B1, B2, QA_EMAILS, STAFF_BARBER,
  authenticateQaActor, qaSql, seedAttempt
} from "../support/f2.js";

const ORACLE_PATH = "C:/Users/thega/Desktop/YKZ-H09-GLOBAL-EXECUTION/11_FINAL_RECOVERY/02_CONTRACT_RESOLUTION/oracles/M17_DEFINITIVE.sql";
const ORACLE_SHA = "41aed165a900bc0e80647604c285256c38eb60e592bbf56c09afc8a16cbe99ee";
const FROM = "2030-01-01";
const TO = "2030-01-02";
const T = "2030-01-01T12:00:00.000Z";
const OWNER_B2 = "66666666-6666-4666-8666-666666666666";

const SALE_A = "f2300000-0000-4000-8000-000000000101";
const SALE_B = "f2300000-0000-4000-8000-000000000102";
const SALE_B2 = "f2300000-0000-4000-8000-000000000103";
const MONEY = "f2300000-0000-4000-8000-000000000201";
const ATT = "f2300000-0000-4000-8000-000000000301";
const ATT2 = "f2300000-0000-4000-8000-000000000305";
const AE_1 = "f2300000-0000-4000-8000-000000000302";
const AE_2 = "f2300000-0000-4000-8000-000000000303";
const AE_3 = "f2300000-0000-4000-8000-000000000304";
const AUDIT_ORDER = "f2300000-0000-4000-8000-000000000501";
const AUDIT_OTHER = "f2300000-0000-4000-8000-000000000502";
const AUDIT_B2 = "f2300000-0000-4000-8000-000000000503";
const SETTLEMENT = "f2300000-0000-4000-8000-000000000601";
const ADJUST = "f2300000-0000-4000-8000-000000000602";
const OPS = [
  "f2300000-0000-4000-8000-000000000901", "f2300000-0000-4000-8000-000000000902",
  "f2300000-0000-4000-8000-000000000903", "f2300000-0000-4000-8000-000000000904",
  "f2300000-0000-4000-8000-000000000905", "f2300000-0000-4000-8000-000000000906",
  "f2300000-0000-4000-8000-000000000907", "f2300000-0000-4000-8000-000000000908",
  "f2300000-0000-4000-8000-000000000909", "f2300000-0000-4000-8000-000000000910"
] as const;

type OracleRow = {
  business_id: string; type: string; object_id: string; sequence: string | null;
  event_id: string; occurred_at: string | Date; action: string | null; state: string | null;
};

async function runOracle(sql: Awaited<ReturnType<typeof qaSql>>, params: unknown[]): Promise<OracleRow[]> {
  const text = readFileSync(ORACLE_PATH, "utf8");
  return sql.unsafe(text, params) as unknown as Promise<OracleRow[]>;
}

function canonical(row: OracleRow) {
  return {
    type: row.type, objectId: row.object_id,
    sequence: row.sequence === null ? null : Number(row.sequence),
    eventId: row.event_id, occurredAt: new Date(row.occurred_at).toISOString(),
    action: row.action, state: row.state
  };
}

describe("F2/T3 · M17 oráculo definitivo y secuencia paginada", () => {
  let sql: Awaited<ReturnType<typeof qaSql>>;
  let owner: Awaited<ReturnType<typeof authenticateQaActor>>;
  let barber: Awaited<ReturnType<typeof authenticateQaActor>>;

  beforeAll(async () => {
    sql = await qaSql();
    owner = await authenticateQaActor(QA_EMAILS.owner);
    barber = await authenticateQaActor(QA_EMAILS.barber);

    for (let i = 0; i < OPS.length; i += 1) {
      const business = i === 2 || i === 9 ? B2 : B1;
      await seedAttempt(sql, OPS[i]!, business, business === B1 ? ACCOUNT_OWNER : OWNER_B2, "f2.history.fixture", T);
    }

    for (const [id, actor] of [[SALE_A, ACCOUNT_OWNER], [SALE_B, ACCOUNT_RECEPTION], [SALE_B2, OWNER_B2]] as const) {
      const business = id === SALE_B2 ? B2 : B1;
      const op = id === SALE_A ? OPS[0]! : id === SALE_B ? OPS[1]! : OPS[2]!;
      await sql`insert into sales.sales
        (id,business_id,operation_id,status,source,currency,total_minor,revision,confirmed_at,actor_account_id,created_at,updated_at)
        values (${id},${business},${op},'CONFIRMED','DIRECT','ARS',1000,1,${T}::timestamptz,${actor},${T}::timestamptz,${T}::timestamptz)
        on conflict (id) do nothing`;
    }

    await sql`insert into money.money_operations
      (id,business_id,operation_id,kind,status,amount_minor,confirmed_minor,change_minor,currency,
       actor_account_id,revision,created_at,resolved_at)
      values (${MONEY},${B1},${OPS[3]!},'PAYMENT','SUCCEEDED',1000,1000,0,'ARS',${ACCOUNT_OWNER},1,${T}::timestamptz,${T}::timestamptz)
      on conflict (id) do nothing`;

    for (const attendance of [ATT, ATT2]) {
      await sql`insert into attendance.attendances
        (id,business_id,staff_member_id,attended_by_staff_member_id,walk_in,status,started_at,finished_at,
         services_performed_snapshot,contact_snapshot,revision,created_at,updated_at)
        values (${attendance},${B1},${STAFF_BARBER},${STAFF_BARBER},true,'COMPLETED',${T}::timestamptz,
                ${T}::timestamptz+interval '30 minutes','[]'::jsonb,'{"name":"F2"}'::jsonb,1,
                ${T}::timestamptz,${T}::timestamptz)
        on conflict (id) do nothing`;
    }
    for (const [event, attendance, sequence, type] of [
      [AE_1, ATT, 1, "ATTENDANCE_COMPLETED"],
      [AE_2, ATT2, 1, "ATTENDANCE_CORRECTED"],
      [AE_3, ATT, 2, "ATTENDANCE_REGISTERED"]
    ] as const) {
      await sql`insert into attendance.attendance_events
        (id,business_id,attendance_id,sequence,event_type,operation_id,principal_type,actor_account_id,staff_member_id,occurred_at,changes)
        values (${event},${B1},${attendance},${sequence},${type},${OPS[4]!},'STAFF',${ACCOUNT_BARBER},${STAFF_BARBER},${T}::timestamptz,'{}'::jsonb)
        on conflict (id) do nothing`;
    }

    // system.audit_events alimenta las vistas Orders (sin changes PII leídos)
    // y la rama OTHER, que jamás duplica el hecho de dominio.
    await sql`insert into system.audit_events
      (id,business_id,actor_account_id,operation_id,action,capability,resource_type,resource_id,outcome,changes,occurred_at)
      values
      (${AUDIT_ORDER},${B1},${ACCOUNT_OWNER},${OPS[6]!},'order.confirmed','orders.read','PRODUCT_ORDER',${SALE_A},'SUCCEEDED','{"toStatus":"CONFIRMED"}'::jsonb,${T}::timestamptz),
      (${AUDIT_OTHER},${B1},${ACCOUNT_OWNER},${OPS[7]!},'admin.role.assigned','iam.audit.read','STAFF_MEMBER',${ATT},'SUCCEEDED','{}'::jsonb,${T}::timestamptz),
      (${AUDIT_B2},${B2},${OWNER_B2},${OPS[9]!},'order.confirmed','orders.read','PRODUCT_ORDER',${SALE_B2},'SUCCEEDED','{"toStatus":"CONFIRMED"}'::jsonb,${T}::timestamptz)
      on conflict (id) do nothing`;

    await sql`insert into econ.settlements
      (id,business_id,staff_member_id,period_start,period_end,status,terms_hash,source_fingerprint,
       total_payable_minor,total_receivable_minor,snapshot,closed_by_account_id,operation_id,closed_at)
      values (${SETTLEMENT},${B1},${STAFF_BARBER},${T}::timestamptz,${T}::timestamptz+interval '1 day',
              'CLOSED_SNAPSHOT','f2-terms','f2-fingerprint',100,0,'{"fixture":"F2"}'::jsonb,
              ${ACCOUNT_OWNER},${OPS[8]!},${T}::timestamptz)
      on conflict (id) do nothing`;
    await sql`insert into econ.settlement_adjustments
      (id,business_id,settlement_id,amount_minor,reason,created_by_account_id,operation_id,created_at)
      values (${ADJUST},${B1},${SETTLEMENT},50,'F2 oracle adjustment',${ACCOUNT_OWNER},${OPS[8]!},${T}::timestamptz)
      on conflict (id) do nothing`;
  });

  afterAll(async () => { await sql.end(); });

  it("el oráculo es el certificado V1.2 y es independiente", () => {
    const text = readFileSync(ORACLE_PATH, "utf8");
    expect(createHash("sha256").update(text).digest("hex")).toBe(ORACLE_SHA);
    expect(text).not.toMatch(/from ["'].*reporting|readHistory|decodeHistoryCursor/i);
    expect(text).not.toMatch(/\bae\.changes\b/i);
    expect(text).toContain("NOT EXISTS (SELECT 1 FROM order_events");
  });

  it("secuencia completa multipágina contra el oráculo, sin duplicados ni omisiones", async () => {
    const oracle = await runOracle(sql, [B1, `${FROM}T03:00:00.000Z`, `${TO}T03:00:00.000Z`,
      true, true, true, true, null, null, null, null, null, null, 100, null, null, null]);
    const expected = oracle.map(canonical);
    expect(expected.length).toBeGreaterThan(4);
    const keys = new Set(expected.map((row) => row.eventId));
    expect(keys.size).toBe(expected.length);
    for (const type of ["SALE_CONFIRMED", "MONEY_CONFIRMED", "ATTENDANCE", "ORDER_TRANSITION", "OTHER", "ECONOMY_EVENT"]) {
      expect(expected.some((row) => row.type === type), `falta ${type}`).toBe(true);
    }
    expect(expected.some((row) => row.sequence === null)).toBe(true);
    expect(expected.some((row) => row.sequence === 1)).toBe(true);
    expect(expected.some((row) => row.sequence === 2)).toBe(true);
    expect(expected.every((row) => row.occurredAt === T)).toBe(true);

    const seen: ReturnType<typeof canonical>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 12; page += 1) {
      const response = await history(owner, { from: FROM, to: TO, limit: 2, cursor });
      for (const item of response.items) {
        expect(item).not.toHaveProperty("changes");
        seen.push({ type: item.type, objectId: item.objectId, sequence: item.sequence,
          eventId: item.eventId, occurredAt: item.occurredAt, action: item.action, state: item.state });
      }
      if (!response.nextCursor) break;
      expect(decodeHistoryCursor(response.nextCursor).eventId).toBeTruthy();
      cursor = response.nextCursor;
    }
    expect(seen).toEqual(expected);
    expect(new Set(seen.map((row) => row.eventId)).size).toBe(seen.length);
  });

  it("BARBER/B2 quedan fuera: scopes de fuente y OTHER exigen autoridad", async () => {
    const restricted = await runOracle(sql, [B1, `${FROM}T03:00:00.000Z`, `${TO}T03:00:00.000Z`,
      false, false, false, false, STAFF_BARBER, ACCOUNT_BARBER,
      null, null, null, null, 100, null, null, null]);
    expect(restricted.some((row) => row.business_id === B2)).toBe(false);
    expect(restricted.some((row) => row.type === "OTHER")).toBe(false);
    expect(restricted.some((row) => row.type === "OBLIGATION_CHANGE" || row.type === "ORDER_TRANSITION" || row.type === "STOCK_MOVEMENT")).toBe(false);
    const response = await history(barber, { from: FROM, to: TO, limit: 100 });
    for (const type of ["SALE_CONFIRMED", "MONEY_CONFIRMED", "OTHER", "ORDER_TRANSITION"]) {
      expect(response.items.some((item) => item.type === type)).toBe(false);
    }
  });

  it("revocación en caliente se refleja aunque la Tx de lectura reintente", async () => {
    const before = await history(owner, { from: FROM, to: TO, limit: 100 });
    expect(before.items.some((item) => item.type === "ORDER_TRANSITION")).toBe(true);
    expect(before.items.some((item) => item.type === "OTHER")).toBe(true);
    const assignment = await sql<{ id: string }[]>`
      select id from iam.role_assignments where business_id=${B1} and role='OWNER' and revoked_at is null limit 1`;
    const roleAssignmentId = assignment[0]!.id;
    await sql`update iam.role_assignments set revoked_at=now() where id=${roleAssignmentId}`;
    try {
      // OWNER posee orders.read/iam.audit.read por rol: la revocación que
      // realmente debe cerrar el acceso es la del rol, no un grant opcional.
      await expect(history(owner, { from: FROM, to: TO, limit: 100 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(history(owner, { from: FROM, to: TO, type: "OTHER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await sql`update iam.role_assignments set revoked_at=null where id=${roleAssignmentId}`;
    }
    const restored = await history(owner, { from: FROM, to: TO, limit: 100 });
    expect(restored.items.some((item) => item.type === "ORDER_TRANSITION")).toBe(true);
  });
});
