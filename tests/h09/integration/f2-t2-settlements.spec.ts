/**
 * F2 · T2/R-30 — M12/M16 sobre snapshots completos contenidos, sin prorrateo.
 *
 * Reproduce: períodos incluidos, en límites exactos, parciales y ajenos;
 * estimates OPEN_ESTIMATE/NOT_CONFIGURED; liquidación mixta PAYABLE/RECEIVABLE;
 * pago parcial, ajuste posterior y economía propia vs ajena.
 */
import { afterAll, describe, expect, it, beforeAll } from "vitest";
import { commercial, operational } from "../../../apps/api/src/modules/reporting/blocks.js";
import {
  ACCOUNT_OWNER, B1, B2, QA_EMAILS, STAFF_BARBER, STAFF_OWNER,
  authenticateQaActor, qaSql, seedAttempt
} from "../support/f2.js";

const FROM = "2026-10-31";
const TO = "2026-12-02";
const START = "2026-11-05T03:00:00.000Z";
const MID = "2026-11-06T03:00:00.000Z";
const NEXT = "2026-11-07T03:00:00.000Z";
const END = "2026-12-02T03:00:00.000Z";
const AFTER = "2026-12-03T03:00:00.000Z";
const BEFORE = "2026-10-30T03:00:00.000Z";
const EXACT_START = "2026-10-31T03:00:00.000Z";
const STAFF_RECEPTION = "bbbbbbb2-2222-4222-8222-222222222222";
const STAFF_D01 = "dddddd01-0000-4000-8000-000000000001";
const STAFF_D02 = "dddddd02-0000-4000-8000-000000000002";
const STAFF_B2 = "bbbbbbb4-4444-4444-8444-444444444444";
const OWNER_B2 = "66666666-6666-4666-8666-666666666666";
/** Settlement canónico del BARBER ya presente en el clon QA (período amplio). */
const S_BARBER_BASE = "358e958f-a89c-462f-aebc-de8dd395697f";

const S_INCLUDED = "f2200000-0000-4000-8000-000000000101";
const S_EXACT = "f2200000-0000-4000-8000-000000000102";
const S_PARTIAL_START = "f2200000-0000-4000-8000-000000000103";
const S_PARTIAL_END = "f2200000-0000-4000-8000-000000000104";
const S_CONSEC_2 = "f2200000-0000-4000-8000-000000000106";
const S_B2 = "f2200000-0000-4000-8000-000000000107";
const O_PAYABLE = "f2200000-0000-4000-8000-000000000201";
const O_RECEIVABLE = "f2200000-0000-4000-8000-000000000202";
const O_BARBER = "f2200000-0000-4000-8000-000000000209";
const O_EXACT = "f2200000-0000-4000-8000-000000000203";
const O_PARTIAL_START = "f2200000-0000-4000-8000-000000000204";
const O_PARTIAL_END = "f2200000-0000-4000-8000-000000000205";
const O_CONSEC_2 = "f2200000-0000-4000-8000-000000000207";
const O_B2 = "f2200000-0000-4000-8000-000000000208";
const E_OPEN = "f2200000-0000-4000-8000-000000000301";
const E_NOT_CONFIGURED = "f2200000-0000-4000-8000-000000000302";
const E_PARTIAL = "f2200000-0000-4000-8000-000000000303";
const E_B2 = "f2200000-0000-4000-8000-000000000304";
const OP_SETTLEMENT = "f2200000-0000-4000-8000-000000000401";
const OP_SETTLEMENT_EXACT = "f2200000-0000-4000-8000-000000000402";
const OP_SETTLEMENT_PSTART = "f2200000-0000-4000-8000-000000000403";
const OP_SETTLEMENT_PEND = "f2200000-0000-4000-8000-000000000404";
const OP_SETTLEMENT_C2 = "f2200000-0000-4000-8000-000000000406";
const OP_SETTLEMENT_B2 = "f2200000-0000-4000-8000-000000000407";
const OP_OBLIG = "f2200000-0000-4000-8000-000000000411";
const OP_OBLIG_BARBER = "f2200000-0000-4000-8000-000000000419";
const OP_OBLIG_EXACT = "f2200000-0000-4000-8000-000000000412";
const OP_OBLIG_PSTART = "f2200000-0000-4000-8000-000000000413";
const OP_OBLIG_PEND = "f2200000-0000-4000-8000-000000000414";
const OP_OBLIG_C2 = "f2200000-0000-4000-8000-000000000416";
const OP_OBLIG_B2 = "f2200000-0000-4000-8000-000000000417";
const OP_PAYMENT = "f2200000-0000-4000-8000-000000000421";
const OP_ADJUST = "f2200000-0000-4000-8000-000000000422";
const PAYMENT = "f2200000-0000-4000-8000-000000000501";
const ADJUST = "f2200000-0000-4000-8000-000000000502";

describe("F2/T2 · M12/M16 snapshots contenidos, deuda real y estados", () => {
  let sql: Awaited<ReturnType<typeof qaSql>>;
  let owner: Awaited<ReturnType<typeof authenticateQaActor>>;
  let barber: Awaited<ReturnType<typeof authenticateQaActor>>;

  beforeAll(async () => {
    sql = await qaSql();
    owner = await authenticateQaActor(QA_EMAILS.owner);
    barber = await authenticateQaActor(QA_EMAILS.barber);

    for (const [op, business] of [
      [OP_SETTLEMENT, B1], [OP_SETTLEMENT_EXACT, B1], [OP_SETTLEMENT_PSTART, B1],
      [OP_SETTLEMENT_PEND, B1], [OP_SETTLEMENT_C2, B1], [OP_SETTLEMENT_B2, B2],
      [OP_OBLIG, B1], [OP_OBLIG_BARBER, B1], [OP_OBLIG_EXACT, B1], [OP_OBLIG_PSTART, B1],
      [OP_OBLIG_PEND, B1], [OP_OBLIG_C2, B1], [OP_OBLIG_B2, B2],
      [OP_PAYMENT, B1], [OP_ADJUST, B1]
    ] as const) {
      await seedAttempt(sql, op, business, business === B1 ? ACCOUNT_OWNER : OWNER_B2, "econ.fixture", START);
    }

    for (const [id, business, staff, start, end, op] of [
      [S_INCLUDED, B1, STAFF_OWNER, START, MID, OP_SETTLEMENT],
      [S_EXACT, B1, STAFF_RECEPTION, EXACT_START, END, OP_SETTLEMENT_EXACT],
      [S_PARTIAL_START, B1, STAFF_D01, BEFORE, MID, OP_SETTLEMENT_PSTART],
      [S_PARTIAL_END, B1, STAFF_D02, MID, AFTER, OP_SETTLEMENT_PEND],
      [S_CONSEC_2, B1, STAFF_OWNER, MID, NEXT, OP_SETTLEMENT_C2],
      [S_B2, B2, STAFF_B2, START, MID, OP_SETTLEMENT_B2]
    ] as const) {
      await sql`insert into econ.settlements
        (id,business_id,staff_member_id,period_start,period_end,status,terms_hash,source_fingerprint,
         total_payable_minor,total_receivable_minor,snapshot,closed_by_account_id,operation_id,closed_at)
        values (${id},${business},${staff},${start}::timestamptz,${end}::timestamptz,'CLOSED_SNAPSHOT',
                'f2-terms','f2-fingerprint',10000,4000,'{"fixture":"F2"}'::jsonb,
                ${business === B1 ? ACCOUNT_OWNER : OWNER_B2},${op},${MID}::timestamptz)
        on conflict (id) do nothing`;
    }

    for (const [id, business, settlement, op, kind, amount] of [
      [O_PAYABLE, B1, S_INCLUDED, OP_OBLIG, "PAYABLE", 10000],
      [O_RECEIVABLE, B1, S_INCLUDED, OP_OBLIG, "RECEIVABLE", 4000],
      [O_BARBER, B1, S_BARBER_BASE, OP_OBLIG_BARBER, "PAYABLE", 6000],
      [O_EXACT, B1, S_EXACT, OP_OBLIG_EXACT, "PAYABLE", 1200],
      [O_PARTIAL_START, B1, S_PARTIAL_START, OP_OBLIG_PSTART, "PAYABLE", 7777],
      [O_PARTIAL_END, B1, S_PARTIAL_END, OP_OBLIG_PEND, "PAYABLE", 8888],
      [O_CONSEC_2, B1, S_CONSEC_2, OP_OBLIG_C2, "PAYABLE", 800],
      [O_B2, B2, S_B2, OP_OBLIG_B2, "PAYABLE", 99999]
    ] as const) {
      await sql`insert into obligations.expense_obligations
        (id,business_id,operation_id,kind,title,counterparty_name,amount_minor,amount_state,currency,
         due_date,status,revision,actor_account_id,created_at,settlement_id)
        values (${id},${business},${op},${kind},'F2 fixture '||${kind},'Fixture',${amount},'KNOWN','ARS',
                ${"2026-11-30"}::date,'OPEN',1,${business === B1 ? ACCOUNT_OWNER : OWNER_B2},${START}::timestamptz,${settlement})
        on conflict (id) do nothing`;
    }

    await sql`insert into money.money_operations
      (id,business_id,operation_id,kind,status,amount_minor,confirmed_minor,change_minor,currency,
       actor_account_id,obligation_id,revision,created_at,resolved_at)
      values (${PAYMENT},${B1},${OP_PAYMENT},'PAYMENT','SUCCEEDED',2500,2500,0,'ARS',
              ${ACCOUNT_OWNER},${O_PAYABLE},1,${MID}::timestamptz,${MID}::timestamptz)
      on conflict (id) do nothing`;
    await sql`insert into obligations.obligation_payments
      (id,business_id,obligation_id,money_operation_id,amount_minor,kind,actor_account_id,operation_id,created_at)
      values (${PAYMENT},${B1},${O_PAYABLE},${PAYMENT},2500,'PAYMENT',${ACCOUNT_OWNER},${OP_PAYMENT},${MID}::timestamptz)
      on conflict (id) do nothing`;

    for (const [id, staff, state, start, end] of [
      [E_OPEN, STAFF_BARBER, "OPEN_ESTIMATE", START, MID],
      [E_NOT_CONFIGURED, STAFF_D01, "NOT_CONFIGURED", START, MID],
      [E_PARTIAL, STAFF_RECEPTION, "OPEN_ESTIMATE", BEFORE, MID],
      [E_B2, STAFF_B2, "OPEN_ESTIMATE", START, MID]
    ] as const) {
      const business = id === E_B2 ? B2 : B1;
      await sql`insert into econ.estimates
        (id,business_id,staff_member_id,period_start,period_end,state,total_payable_minor,
         total_receivable_minor,source_fingerprint,created_at)
        values (${id},${business},${staff},${start}::timestamptz,${end}::timestamptz,${state},999999,888888,
                'f2-estimate',${START}::timestamptz)
        on conflict (id) do nothing`;
    }

    await sql`insert into econ.settlement_adjustments
      (id,business_id,settlement_id,amount_minor,reason,created_by_account_id,operation_id,created_at)
      values (${ADJUST},${B1},${S_INCLUDED},500,'F2 ajuste sin reescritura',${ACCOUNT_OWNER},${OP_ADJUST},${MID}::timestamptz)
      on conflict (id) do nothing`;
  });

  afterAll(async () => { await sql.end(); });

  it("sólo períodos completos contenidos; límites exactos y consecutivos sin prorrateo", async () => {
    const before = await sql`select total_payable_minor::text minor,snapshot from econ.settlements where id=${S_INCLUDED}`;
    expect(before[0]!.minor).toBe("10000");
    const response = await commercial(owner, { from: FROM, to: TO });
    const debt = response.settlements.data!.realDebt;
    const idsIncluded = debt.map((row) => row.settlementId);
    for (const expected of [S_INCLUDED, S_EXACT, S_CONSEC_2, S_BARBER_BASE]) expect(idsIncluded).toContain(expected);
    for (const excluded of [S_PARTIAL_START, S_PARTIAL_END, S_B2]) expect(idsIncluded).not.toContain(excluded);

    const included = debt.find((row) => row.settlementId === S_INCLUDED && row.kind === "PAYABLE");
    expect(included?.balanceMinor).toBe("7500"); // 10000 − 2500 pagado, sin prorrateo
    expect(debt.find((row) => row.settlementId === S_INCLUDED && row.kind === "RECEIVABLE")?.balanceMinor).toBe("4000");
    expect(debt.filter((row) => row.settlementId === S_INCLUDED)).toHaveLength(2); // pago no duplica deuda
    expect(debt.filter((row) => row.settlementId === S_EXACT && row.kind === "PAYABLE")).toHaveLength(1);
    expect(debt.filter((row) => row.settlementId === S_CONSEC_2)).toHaveLength(1);
    const after = await sql`select total_payable_minor::text minor,snapshot from econ.settlements where id=${S_INCLUDED}`;
    expect(after[0]!.minor).toBe(before[0]!.minor);
    expect(after[0]!.snapshot).toEqual(before[0]!.snapshot); // ajuste no reescribe snapshot
  });

  it("OPEN_ESTIMATE es estado de dominio, nunca deuda; magnitud corriente etiquetada aparte", async () => {
    const response = await commercial(owner, { from: FROM, to: TO });
    const states = response.settlements.data!.estimateStates;
    expect(states).toEqual(expect.arrayContaining(["OPEN_ESTIMATE", "NOT_CONFIGURED"]));
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("999999");
    expect(serialized).not.toContain("888888");
    expect(response.settlements.data!.realDebt.every((row) => row.kind === "PAYABLE" || row.kind === "RECEIVABLE")).toBe(true);
  });

  it("economía propia del BARBER contra ajena; RECEPTIONIST sin agregados", async () => {
    const own = await operational(barber, { from: FROM, to: TO });
    expect(own.economy.state).not.toBe("DENIED");
    const ownIds = own.economy.data!.realDebt.map((row) => row.settlementId);
    expect(ownIds).toContain(S_BARBER_BASE);
    expect(ownIds).not.toContain(S_INCLUDED);
    expect(ownIds).not.toContain(S_B2);
    expect(own.economy.data!.estimateStates).toEqual(["OPEN_ESTIMATE"]);
    await expect(commercial(barber, { from: FROM, to: TO })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
