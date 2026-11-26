/**
 * F2 · T4/R-32 — Oráculos con scopes para M09/M11/M13.
 *
 * Fixtures con dos Business, dos profesionales y roles distintos, con
 * cantidades/importes IGUALES en scopes diferentes para demostrar inclusión,
 * exclusión y aislamiento. Cada oráculo es SQL independiente con SHA fijo.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMovement, setMinimum } from "../../../apps/api/src/modules/inventory/commands.js";
import { commercial, operational } from "../../../apps/api/src/modules/reporting/blocks.js";
import { readUncertain } from "../../../apps/api/src/modules/reporting/queries.js";
import {
  ACCOUNT_BARBER, ACCOUNT_OWNER, ACCOUNT_RECEPTION, B1, B2, QA_EMAILS, STAFF_BARBER,
  authenticateQaActor, qaSql, seedAttempt
} from "../support/f2.js";

const ORACLE_DIR = "C:/Users/thega/Desktop/YKZ-H09-GLOBAL-EXECUTION/11_FINAL_RECOVERY/02_CONTRACT_RESOLUTION/oracles";
const SHAS = {
  "M09_SCOPED.sql": "e498479c2162bc2a136d80010f79e2a60d7781c5451da6d698a7169ff6dc962d",
  "M11_SCOPED.sql": "a81306e7934c0723be1110fcc551159c73b24b226807c9b1506a64c7d32cbee5",
  "M13_SCOPED.sql": "b818f3a52e3424f9b3c524d378f08700228f84114fe7ba4ac1c90b43479eDE75".toLowerCase()
} as const;
const T = "2031-01-01T12:00:00.000Z";
const FROM = "2031-01-01";
const TO = "2031-01-02";
const OWNER_B2 = "66666666-6666-4666-8666-666666666666";
const STAFF_OTHER = "dddddd01-0000-4000-8000-000000000001";
const STAFF_B2 = "bbbbbbb4-4444-4444-8444-444444444444";

const L_OWN = "f2400000-0000-4000-8000-000000000101";
const L_OTHER = "f2400000-0000-4000-8000-000000000102";
const L_B2 = "f2400000-0000-4000-8000-000000000103";
const SKU_MIX = "F2-MIX";
const SKU_NEG = "F2-NEG";
const SKU_ZERO = "F2-ZERO";
const SKU_NOPOS = "F2-NOPOS";
const SKU_UNCONF = "F2-UNCONF";
const COMMIT = "f2400000-0000-4000-8000-000000000201";
const OP_COMMIT = "f2400000-0000-4000-8000-000000000301";
const OBLIG_OVERDUE = "f2400000-0000-4000-8000-000000000401";
const OBLIG_FUTURE = "f2400000-0000-4000-8000-000000000402";
const OBLIG_RECEIVABLE = "f2400000-0000-4000-8000-000000000403";
const OBLIG_UNKNOWN = "f2400000-0000-4000-8000-000000000404";
const OBLIG_B2 = "f2400000-0000-4000-8000-000000000405";
const OBLIG_OPS = [
  "f2400000-0000-4000-8000-000000000411", "f2400000-0000-4000-8000-000000000412",
  "f2400000-0000-4000-8000-000000000413", "f2400000-0000-4000-8000-000000000414",
  "f2400000-0000-4000-8000-000000000415"
] as const;
const OP_OBLIG_B2 = "f2400000-0000-4000-8000-000000000416";
const PAYMENT = "f2400000-0000-4000-8000-000000000421";
const OP_PAYMENT = "f2400000-0000-4000-8000-000000000422";
const M13_OPS = [
  "f2400000-0000-4000-8000-000000000501", "f2400000-0000-4000-8000-000000000502",
  "f2400000-0000-4000-8000-000000000503", "f2400000-0000-4000-8000-000000000504",
  "f2400000-0000-4000-8000-000000000505"
] as const;

function oracleText(name: keyof typeof SHAS): string {
  return readFileSync(`${ORACLE_DIR}/${name}`, "utf8");
}

describe("F2/T4 · oráculos M09/M11/M13 con scopes", () => {
  let sql: Awaited<ReturnType<typeof qaSql>>;
  let owner: Awaited<ReturnType<typeof authenticateQaActor>>;
  let ownerB2: Awaited<ReturnType<typeof authenticateQaActor>>;
  let reception: Awaited<ReturnType<typeof authenticateQaActor>>;
  let barber: Awaited<ReturnType<typeof authenticateQaActor>>;

  beforeAll(async () => {
    sql = await qaSql();
    owner = await authenticateQaActor(QA_EMAILS.owner);
    ownerB2 = await authenticateQaActor(QA_EMAILS.ownerB2);
    reception = await authenticateQaActor(QA_EMAILS.reception);
    barber = await authenticateQaActor(QA_EMAILS.barber);

    // Inventario: dos Business, el MISMO sku/cantidad en B1 y B2.
    await sql`insert into inventory.locations (id,business_id,name,staff_member_id,revision) values
      (${L_OWN},${B1},'F2 own barber',${STAFF_BARBER},1),
      (${L_OTHER},${B1},'F2 other professional',${STAFF_OTHER},1),
      (${L_B2},${B2},'F2 B2 same quantities',${STAFF_B2},1)
      on conflict (id) do nothing`;
    await sql`insert into inventory.location_access (business_id,location_id,staff_member_id) values
      (${B1},${L_OWN},${STAFF_BARBER}) on conflict do nothing`;
    for (const [sku, use, price] of [
      [SKU_MIX, "MIXED", 100], [SKU_NEG, "INTERNAL", null], [SKU_ZERO, "INTERNAL", null],
      [SKU_NOPOS, "INTERNAL", null], [SKU_UNCONF, "INTERNAL", null]
    ] as const) {
      for (const business of [B1, B2]) {
        await sql`insert into inventory.items
          (id,business_id,sku,name,unit,use,price_minor,cost_minor,published,active,revision,created_at)
          values (${randomUUID()},
                  ${business},${sku},'F2 '||${sku},'unidad',${use},${price},0,false,true,1,${T}::timestamptz)
          on conflict (business_id,sku) do nothing`;
      }
    }
    const move = (actor: typeof owner, kind: "OPENING" | "LOSS", sku: string, locationId: string, purpose: "SALE" | "INTERNAL", quantity: number) =>
      createMovement(actor, {
        kind, lines: [{ sku, locationId, purpose, quantity }],
        reason: "F2 T4 fixture físico", effectiveAt: T
      }, randomUUID());
    for (const [business, location, actor] of [[B1, L_OWN, owner], [B1, L_OTHER, owner], [B2, L_B2, ownerB2]] as const) {
      // Las posiciones son proyección de entries: se generan con comandos canónicos.
      if ((await sql`select 1 from inventory.entries where business_id=${business} and sku=${SKU_MIX} and location_id=${location}`).length === 0) {
        await move(actor, "OPENING", SKU_MIX, location, "SALE", business === B1 && location === L_OTHER ? 7 : 5);
        await move(actor, "OPENING", SKU_MIX, location, "INTERNAL", business === B1 && location === L_OTHER ? 2 : 3);
        await move(actor, "OPENING", SKU_NEG, location, "INTERNAL", 1);
        await move(actor, "LOSS", SKU_NEG, location, "INTERNAL", 2); // −1 con discrepancia declarada
        await move(actor, "OPENING", SKU_ZERO, location, "INTERNAL", 1);
        await move(actor, "LOSS", SKU_ZERO, location, "INTERNAL", 1); // posición en 0
        await move(actor, "OPENING", SKU_UNCONF, location, "INTERNAL", 5);
      }
    }
    for (const [actor, location, quantity] of [[owner, L_OWN, 4], [owner, L_OTHER, 10], [ownerB2, L_B2, 4]] as const) {
      await setMinimum(actor, { sku: SKU_MIX, locationId: location, quantity }, randomUUID());
    }
    await seedAttempt(sql, OP_COMMIT, B1, ACCOUNT_OWNER, "inventory.fixture", T);
    await sql`insert into inventory.commitments
      (id,business_id,sku,location_id,quantity,state,operation_id,source_reference)
      values (${COMMIT},${B1},${SKU_MIX},${L_OTHER},2,'ACTIVE',${OP_COMMIT},'F2-T4')
      on conflict (id) do nothing`;

    // Obligaciones: mismos importes en B1 y B2; una vencida pagada parcialmente.
    for (let i = 0; i < OBLIG_OPS.length; i += 1) {
      await seedAttempt(sql, OBLIG_OPS[i]!, B1, ACCOUNT_OWNER, "obligations.fixture", T);
    }
    await seedAttempt(sql, OP_OBLIG_B2, B2, OWNER_B2, "obligations.fixture", T);
    for (const [id, business, op, kind, amount, state, due] of [
      [OBLIG_OVERDUE, B1, OBLIG_OPS[0], "PAYABLE", 10000, "KNOWN", "2026-11-01"],
      [OBLIG_FUTURE, B1, OBLIG_OPS[1], "PAYABLE", 5000, "KNOWN", "2027-01-01"],
      [OBLIG_RECEIVABLE, B1, OBLIG_OPS[2], "RECEIVABLE", 4000, "KNOWN", "2026-11-01"],
      [OBLIG_UNKNOWN, B1, OBLIG_OPS[3], "PAYABLE", null, "UNKNOWN_AMOUNT", "2026-11-01"],
      [OBLIG_B2, B2, OP_OBLIG_B2, "PAYABLE", 10000, "KNOWN", "2026-11-01"]
    ] as const) {
      await sql`insert into obligations.expense_obligations
        (id,business_id,operation_id,kind,title,counterparty_name,amount_minor,amount_state,currency,
         due_date,status,revision,actor_account_id,created_at)
        values (${id},${business},${op},${kind},'F2 T4 '||${kind},'Fixture',${amount},${state},'ARS',
                ${due}::date,'OPEN',1,${business === B1 ? ACCOUNT_OWNER : OWNER_B2},${T}::timestamptz)
        on conflict (id) do nothing`;
    }
    await seedAttempt(sql, OP_PAYMENT, B1, ACCOUNT_OWNER, "obligations.payment.fixture", T);
    await sql`insert into money.money_operations
      (id,business_id,operation_id,kind,status,amount_minor,confirmed_minor,change_minor,currency,
       actor_account_id,obligation_id,revision,created_at,resolved_at)
      values (${PAYMENT},${B1},${OP_PAYMENT},'PAYMENT','SUCCEEDED',2500,2500,0,'ARS',
              ${ACCOUNT_OWNER},${OBLIG_OVERDUE},1,${T}::timestamptz,${T}::timestamptz)
      on conflict (id) do nothing`;
    await sql`insert into obligations.obligation_payments
      (id,business_id,obligation_id,money_operation_id,amount_minor,kind,actor_account_id,operation_id,created_at)
      values (${PAYMENT},${B1},${OBLIG_OVERDUE},${PAYMENT},2500,'PAYMENT',${ACCOUNT_OWNER},${OP_PAYMENT},${T}::timestamptz)
      on conflict (id) do nothing`;

    // M13: acciones iguales en scopes distintos; SUCCEEDED queda fuera.
    for (let i = 0; i < M13_OPS.length; i += 1) {
      const business = i === 4 ? B2 : B1;
      await seedAttempt(sql, M13_OPS[i]!, business,
        i === 0 ? ACCOUNT_OWNER : i === 1 ? ACCOUNT_RECEPTION : i === 2 ? ACCOUNT_BARBER : i === 3 ? ACCOUNT_OWNER : OWNER_B2,
        "f2.uncertain.fixture", T,
        i === 3 ? "SUCCEEDED" : i % 2 === 0 ? "UNKNOWN" : "STARTED");
    }
  });

  afterAll(async () => { await sql.end(); });

  it("los tres oráculos son los certificados V1.2", () => {
    for (const [name, sha] of Object.entries(SHAS)) {
      expect(createHash("sha256").update(oracleText(name as keyof typeof SHAS)).digest("hex")).toBe(sha);
    }
  });

  it("M09: incluidos/excluidos por (sku,location), prioridad y scope BARBER", async () => {
    const ownerRows = await sql.unsafe(oracleText("M09_SCOPED.sql"), [B1, false, null]) as unknown as Array<{
      sku: string; location_id: string; physical: string; minimum: string | null;
      has_position: boolean; sellable: string; criticality: string;
    }>;
    const ownerBlock = (await operational(owner, { from: FROM, to: TO })).stock.data!.items;
    const normalize = (rows: typeof ownerRows) => rows.map((row) => ({
      sku: row.sku, locationId: row.location_id, physical: Number(row.physical),
      minimum: row.minimum === null ? null : Number(row.minimum), hasPosition: Boolean(row.has_position),
      sellable: Number(row.sellable), criticality: row.criticality
    })).sort((a, b) => `${a.sku}:${a.locationId}`.localeCompare(`${b.sku}:${b.locationId}`));
    expect([...ownerBlock].sort((a, b) => `${a.sku}:${a.locationId}`.localeCompare(`${b.sku}:${b.locationId}`)))
      .toEqual(normalize(ownerRows));
    const mixOwn = ownerBlock.find((row) => row.sku === SKU_MIX && row.locationId === L_OWN)!;
    expect(mixOwn).toMatchObject({ physical: 8, sellable: 5, criticality: "OK" });
    const mixOther = ownerBlock.find((row) => row.sku === SKU_MIX && row.locationId === L_OTHER)!;
    expect(mixOther).toMatchObject({ physical: 9, sellable: 5, criticality: "LOW" });
    for (const [sku, criticality] of [[SKU_NEG, "NEGATIVE"], [SKU_ZERO, "ZERO"], [SKU_NOPOS, "NO_POSITION"], [SKU_UNCONF, "UNCONFIGURED"]] as const) {
      expect(ownerBlock.find((row) => row.sku === sku && row.locationId === L_OWN)?.criticality).toBe(criticality);
    }
    expect(ownerBlock.every((row) => row.locationId !== L_B2)).toBe(true);

    const barberRows = await sql.unsafe(oracleText("M09_SCOPED.sql"), [B1, true, STAFF_BARBER]) as unknown as typeof ownerRows;
    const barberBlock = (await operational(barber, { from: FROM, to: TO })).stock.data!.items;
    expect(barberBlock.map((row) => `${row.sku}:${row.locationId}`).sort()).toEqual(
      normalize(barberRows).map((row) => `${row.sku}:${row.locationId}`).sort());
    expect(barberBlock.every((row) => row.locationId !== L_OTHER)).toBe(true);
    const own = barberBlock.find((row) => row.sku === SKU_MIX && row.locationId === L_OWN)!;
    expect(own).toMatchObject({ physical: 3, sellable: 5, criticality: "LOW" });
  });

  it("M11: pendiente/vencido separados, importes conocidos/desconocidos y aislamiento", async () => {
    const oracleRows = await sql.unsafe(oracleText("M11_SCOPED.sql"), [B1, "2026-11-25", true]) as unknown as Array<{
      kind: string; pending_count: string; overdue_count: string; unknown_count: string; balance_minor: string;
    }>;
    const byKind = (await commercial(owner, { from: FROM, to: TO })).obligations.data!.byKind;
    for (const row of oracleRows) {
      const found = byKind.find((item) => item.kind === row.kind)!;
      expect(found).toMatchObject({
        pendingCount: Number(row.pending_count), overdueCount: Number(row.overdue_count),
        unknownCount: Number(row.unknown_count), balanceMinor: row.balance_minor
      });
    }
    // La comparación contra el oráculo absorbe las filas base del clon QA;
    // lo que se certifica aquí es la SEPARACIÓN pendiente/vencido y dirección.
    expect(oracleRows.map((row) => row.kind).sort()).toEqual(["PAYABLE", "RECEIVABLE"]);
    expect(byKind.every((row) => row.overdueCount <= row.pendingCount)).toBe(true);
    expect(byKind.find((row) => row.kind === "PAYABLE")?.unknownCount).toBe(1);
    expect(byKind.find((row) => row.kind === "RECEIVABLE")?.unknownCount).toBe(0);
    expect(byKind.every((row) => row.balanceMinor !== "0" || row.unknownCount === 0)).toBe(true);
  });

  it("M13: un intento por operation_id, sin response_body y con scopes por actor", async () => {
    const oracleRows = await sql.unsafe(oracleText("M13_SCOPED.sql"), [B1, `${FROM}T03:00:00.000Z`, `${TO}T03:00:00.000Z`, null, 100]) as unknown as Array<{
      operation_id: string; status: string; command: string;
    }>;
    const global = (await commercial(owner, { from: FROM, to: TO })).uncertain.data!.items;
    expect(global.map((item) => item.operationId).sort()).toEqual(oracleRows.map((row) => row.operation_id).sort());
    expect(global).toHaveLength(3);
    expect(global.every((item) => ["PREPARED", "UNKNOWN"].includes(item.status))).toBe(true);
    expect(JSON.stringify(global)).not.toMatch(/responseBody|response_body/);

    const fromInstant = new Date(`${FROM}T03:00:00.000Z`);
    const toInstant = new Date(`${TO}T03:00:00.000Z`);
    const interval = {
      fromLocalDate: FROM, toLocalDate: TO, fromInstant, toInstant,
      from: fromInstant.toISOString(), to: toInstant.toISOString(),
      interval: { from: fromInstant.toISOString(), to: toInstant.toISOString(), timezone: "America/Argentina/Buenos_Aires" }
    };
    const ownRows = await sql.unsafe(oracleText("M13_SCOPED.sql"), [B1, fromInstant.toISOString(), toInstant.toISOString(), ACCOUNT_RECEPTION, 100]) as unknown as typeof oracleRows;
    // El bloque comercial globallyDENIED para RECEPTIONIST; el alcance por
    // actor_account_id se certifica en la proyección M13 (oráculo scope-map).
    const receptionBlock = await readUncertain(sql as never, reception, { interval, limit: 100 });
    expect(receptionBlock.items.map((item) => item.operationId)).toEqual(ownRows.map((row) => row.operation_id));
    expect(receptionBlock.items.map((item) => item.operationId)).toEqual([M13_OPS[1]]);
    expect((await commercial(reception, { from: FROM, to: TO })).uncertain.state).toBe("DENIED");
  });
});
