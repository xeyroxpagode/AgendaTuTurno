/**
 * F2 · T1/R-29 — M05 conserva la sesión completa; M06 separa CURRENT/HISTORY.
 *
 * Reproduce: una sesión OPEN con dos reconciliaciones incompatibles, otra con
 * dos compatibles, otra sin reconciliación, otra con una, una CLOSED con
 * diferencia y una CLOSED con cero, más una sesión ajena de B2.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeCashSession } from "../../../apps/api/src/modules/cash/commands.js";
import { commercial, interventions } from "../../../apps/api/src/modules/reporting/blocks.js";
import {
  ACCOUNT_BARBER, ACCOUNT_OWNER, ACCOUNT_RECEPTION, B1, B2, QA_EMAILS,
  authenticateQaActor, qaSql, seedAttempt
} from "../support/f2.js";

const FROM = "2026-11-25";
const TO = "2026-11-26";
const AT = "2026-11-25T12:00:00.000Z";
const OWNER_B2 = "66666666-6666-4666-8666-666666666666";

const CB_NONE = "f2000000-0000-4000-8000-000000000001";
const CB_SINGLE = "f2000000-0000-4000-8000-000000000002";
const CB_AMBIG = "f2000000-0000-4000-8000-000000000003";
const CB_COMPAT = "f2000000-0000-4000-8000-000000000004";
const CB_CLOSED = "f2000000-0000-4000-8000-000000000005";
const CB_CLOSED_ZERO = "f2000000-0000-4000-8000-000000000006";
const CB_B2 = "f2000000-0000-4000-8000-000000000007";
const S_NONE = "f2000000-0000-4000-8000-000000000101";
const S_SINGLE = "f2000000-0000-4000-8000-000000000102";
const S_AMBIG = "f2000000-0000-4000-8000-000000000103";
const S_COMPAT = "f2000000-0000-4000-8000-000000000104";
const S_CLOSED = "f2000000-0000-4000-8000-000000000105";
const S_CLOSED_ZERO = "f2000000-0000-4000-8000-000000000106";
const S_B2 = "f2000000-0000-4000-8000-000000000107";
const R_SINGLE = "f2000000-0000-4000-8000-000000000201";
const R_AMBIG_A = "f2000000-0000-4000-8000-000000000202";
const R_AMBIG_B = "f2000000-0000-4000-8000-000000000203";
const R_COMPAT_A = "f2000000-0000-4000-8000-000000000204";
const R_COMPAT_B = "f2000000-0000-4000-8000-000000000205";
const R_B2 = "f2000000-0000-4000-8000-000000000206";
const OP_SESSION_NONE = "f2000000-0000-4000-8000-000000000301";
const OP_SESSION_SINGLE = "f2000000-0000-4000-8000-000000000302";
const OP_SESSION_AMBIG = "f2000000-0000-4000-8000-000000000303";
const OP_SESSION_COMPAT = "f2000000-0000-4000-8000-000000000304";
const OP_SESSION_CLOSED = "f2000000-0000-4000-8000-000000000305";
const OP_SESSION_CLOSED_ZERO = "f2000000-0000-4000-8000-000000000306";
const OP_SESSION_B2 = "f2000000-0000-4000-8000-000000000307";
const OP_RECON_SINGLE = "f2000000-0000-4000-8000-000000000311";
const OP_RECON_AMBIG_A = "f2000000-0000-4000-8000-000000000312";
const OP_RECON_AMBIG_B = "f2000000-0000-4000-8000-000000000313";
const OP_RECON_COMPAT_A = "f2000000-0000-4000-8000-000000000314";
const OP_RECON_COMPAT_B = "f2000000-0000-4000-8000-000000000315";
const OP_RECON_B2 = "f2000000-0000-4000-8000-000000000316";
const OP_MOVE_AMBIG = "f2000000-0000-4000-8000-000000000321";
const OP_MOVE_NONE = "f2000000-0000-4000-8000-000000000322";
const OP_CLOSE = "f2000000-0000-4000-8000-000000000323";
const MV_AMBIG = "f2000000-0000-4000-8000-000000000401";
const MV_NONE = "f2000000-0000-4000-8000-000000000402";
describe("F2/T1 · M05/M06 con reconciliación vigente, ambigua y cerrada", () => {
  let sql: Awaited<ReturnType<typeof qaSql>>;
  let owner: Awaited<ReturnType<typeof authenticateQaActor>>;

  beforeAll(async () => {
    sql = await qaSql();
    owner = await authenticateQaActor(QA_EMAILS.owner);

    for (const [box, business, name] of [
      [CB_NONE, B1, "F2 T1 sin recon"], [CB_SINGLE, B1, "F2 T1 una recon"],
      [CB_AMBIG, B1, "F2 T1 ambigua"], [CB_COMPAT, B1, "F2 T1 compatible"],
      [CB_CLOSED, B1, "F2 T1 cerrada"], [CB_CLOSED_ZERO, B1, "F2 T1 cerrada cero"],
      [CB_B2, B2, "F2 T1 B2"]
    ] as const) {
      await sql`insert into cash.cashboxes (id,business_id,name) values (${box},${business},${name}) on conflict do nothing`;
    }

    for (const [op, , business] of [
      [OP_SESSION_NONE, S_NONE, B1], [OP_SESSION_SINGLE, S_SINGLE, B1],
      [OP_SESSION_AMBIG, S_AMBIG, B1], [OP_SESSION_COMPAT, S_COMPAT, B1],
      [OP_SESSION_CLOSED, S_CLOSED, B1], [OP_SESSION_CLOSED_ZERO, S_CLOSED_ZERO, B1],
      [OP_SESSION_B2, S_B2, B2]
    ] as const) {
      await seedAttempt(sql, op, business, business === B1 ? ACCOUNT_OWNER : OWNER_B2, "cash.session.open", AT);
    }

    const closeAt = "2026-11-25T13:00:00.000Z";
    await sql`insert into cash.cash_sessions
      (id,business_id,cashbox_id,status,opened_by_account_id,opening_amount_minor,operation_id,created_at,opened_at,
       closed_at,closed_by_account_id,counted_amount_minor,expected_amount_minor,difference_minor,closure_reason,snapshot,revision)
      values
      (${S_NONE},${B1},${CB_NONE},'OPEN',${ACCOUNT_OWNER},1000,${OP_SESSION_NONE},${AT}::timestamptz,${AT}::timestamptz,
        null,null,null,null,null,null,null,1),
      (${S_SINGLE},${B1},${CB_SINGLE},'OPEN',${ACCOUNT_OWNER},2000,${OP_SESSION_SINGLE},${AT}::timestamptz,${AT}::timestamptz,
        null,null,null,null,null,null,null,1),
      (${S_AMBIG},${B1},${CB_AMBIG},'OPEN',${ACCOUNT_RECEPTION},1000,${OP_SESSION_AMBIG},${AT}::timestamptz,${AT}::timestamptz,
        null,null,null,null,null,null,null,1),
      (${S_COMPAT},${B1},${CB_COMPAT},'OPEN',${ACCOUNT_BARBER},1000,${OP_SESSION_COMPAT},${AT}::timestamptz,${AT}::timestamptz,
        null,null,null,null,null,null,null,1),
      (${S_CLOSED},${B1},${CB_CLOSED},'CLOSED',${ACCOUNT_OWNER},1000,${OP_SESSION_CLOSED},${AT}::timestamptz,${AT}::timestamptz,
        ${closeAt}::timestamptz,${ACCOUNT_OWNER},900,1000,-100,'F2 fixture cierre','{"fixture":"F2"}'::jsonb,2),
      (${S_CLOSED_ZERO},${B1},${CB_CLOSED_ZERO},'CLOSED',${ACCOUNT_OWNER},500,${OP_SESSION_CLOSED_ZERO},${AT}::timestamptz,${AT}::timestamptz,
        ${closeAt}::timestamptz,${ACCOUNT_OWNER},500,500,0,'F2 fixture cierre cero','{"fixture":"F2"}'::jsonb,2),
      (${S_B2},${B2},${CB_B2},'OPEN',${OWNER_B2},9000,${OP_SESSION_B2},${AT}::timestamptz,${AT}::timestamptz,
        null,null,null,null,null,null,null,1)
      on conflict (id) do nothing`;

    for (const [op, movement, session, amount] of [
      [OP_MOVE_AMBIG, MV_AMBIG, S_AMBIG, 500], [OP_MOVE_NONE, MV_NONE, S_NONE, 300]
    ] as const) {
      await seedAttempt(sql, op, B1, ACCOUNT_OWNER, "cash.movement.create", AT);
      await sql`insert into cash.cash_movements
        (id,business_id,cash_session_id,type,amount_minor,reason,actor_account_id,operation_id,created_at)
        values (${movement},${B1},${session},'INCOME',${amount},'F2 fixture movimiento',${ACCOUNT_OWNER},${op},${AT}::timestamptz)
        on conflict (id) do nothing`;
    }

    for (const [op, recon, session, difference] of [
      [OP_RECON_SINGLE, R_SINGLE, S_SINGLE, 250],
      [OP_RECON_AMBIG_A, R_AMBIG_A, S_AMBIG, 100],
      [OP_RECON_AMBIG_B, R_AMBIG_B, S_AMBIG, -75],
      [OP_RECON_COMPAT_A, R_COMPAT_A, S_COMPAT, 50],
      [OP_RECON_COMPAT_B, R_COMPAT_B, S_COMPAT, 50],
      [OP_RECON_B2, R_B2, S_B2, 999]
    ] as const) {
      const business = session === S_B2 ? B2 : B1;
      await seedAttempt(sql, op, business, business === B1 ? ACCOUNT_OWNER : OWNER_B2, "money.reconcile", AT);
      await sql`insert into money.money_reconciliations
        (id,business_id,cash_session_id,expected_amount_minor,observed_amount_minor,difference_minor,reason,actor_account_id,operation_id,created_at)
        values (${recon},${business},${session},1000,${1000 + Number(difference)},${difference},
                'F2 fixture reconciliación',${business === B1 ? ACCOUNT_OWNER : OWNER_B2},${op},${AT}::timestamptz)`;
    }
  });

  // La base QA se re-clona antes de cada corrida F2: movements/cash sessions
  // son append-only/inmutables y no deben borrarse para simular limpieza.
  afterAll(async () => { await sql.end(); });

  it("M05 conserva la sesión completa; M06 declara UNKNOWN sin regla de supersesión", async () => {
    const oracle = await sql<{
      expected: Array<{ cashSessionId: string; amountMinor: string }>;
      current: Array<{ cashSessionId: string; amountMinor: string }>;
      history: Array<{ cashSessionId: string; amountMinor: string }>;
      ambiguous: number;
    }>`
      with sessions as (
        select s.id, s.opening_amount_minor, s.status, s.counted_amount_minor, s.expected_amount_minor
        from cash.cash_sessions s
        where s.business_id=${B1} and s.opened_at>=${FROM}::date::timestamptz+interval '3 hours'
          and s.opened_at<${TO}::date::timestamptz+interval '3 hours'
      ), expected as (
        select s.id, (s.opening_amount_minor+coalesce(sum(case when mv.type in ('INCOME','SALE_CASH')
          then mv.amount_minor else -mv.amount_minor end),0))::text amount_minor
        from sessions s left join cash.cash_movements mv
          on mv.business_id=${B1} and mv.cash_session_id=s.id
        group by s.id,s.opening_amount_minor
      ), counted as (
        select r.cash_session_id, r.difference_minor,
               count(*) over (partition by r.cash_session_id)::int total,
               row_number() over (partition by r.cash_session_id order by r.created_at,r.id) rn
        from money.money_reconciliations r join sessions s on s.id=r.cash_session_id
        where r.business_id=${B1} and s.status='OPEN'
      )
      select
        (select coalesce(jsonb_agg(jsonb_build_object('cashSessionId',id,'amountMinor',amount_minor) order by id),'[]'::jsonb) from expected) expected,
        (select coalesce(jsonb_agg(jsonb_build_object('cashSessionId',cash_session_id,'amountMinor',difference_minor::text) order by cash_session_id),'[]'::jsonb)
           from counted where rn=1 and total=1) current,
        (select coalesce(jsonb_agg(jsonb_build_object('cashSessionId',id,'amountMinor',(counted_amount_minor-expected_amount_minor)::text) order by id),'[]'::jsonb)
           from sessions where status='CLOSED' and counted_amount_minor is not null) history,
        (select count(*)::int from (select cash_session_id from counted where total>1 group by cash_session_id) a) ambiguous`;

    const response = await commercial(owner, { from: FROM, to: TO });
    expect(response.cash.state).toBe("UNKNOWN");
    expect(response.cash.completeness).toBe("UNKNOWN");
    const data = response.cash.data!;
    expect(data.ambiguous).toBe(true);
    expect(data.expected.map((item) => item.cashSessionId).sort()).toEqual(oracle[0]!.expected.map((item) => item.cashSessionId).sort());
    expect(data.currentDifferences.map((item) => [item.cashSessionId, item.amountMinor]).sort())
      .toEqual(oracle[0]!.current.map((item) => [item.cashSessionId, item.amountMinor]).sort());
    expect(data.currentDifferences).toEqual([{ cashSessionId: S_SINGLE, amountMinor: "250" }]);
    expect(data.historicalDifferences.map((item) => [item.cashSessionId, item.amountMinor]).sort())
      .toEqual(oracle[0]!.history.map((item) => [item.cashSessionId, item.amountMinor]).sort());
    expect(data.historicalDifferences).toEqual(expect.arrayContaining([
      { cashSessionId: S_CLOSED, amountMinor: "-100" }, { cashSessionId: S_CLOSED_ZERO, amountMinor: "0" }
    ]));
    expect(data.currentDifferences.some((item) => item.cashSessionId === S_B2)).toBe(false);
    expect(data.expected.some((item) => item.cashSessionId === S_B2)).toBe(false);
  });

  it("sólo la diferencia vigente genera intervención; la ambigua nunca se inventa", async () => {
    const response = await interventions(owner, { type: "CASH_DIFFERENCE" });
    expect(response.items.map((item) => item.objectId).sort()).toEqual([S_SINGLE]);
    for (const item of response.items) expect(item.detail).toContain("differenceMinor=250");
  });

  it("el cierre canónico del dominio dueño resuelve la vigente sin evadir con UNKNOWN", async () => {
    const closed = await closeCashSession(owner, S_SINGLE,
      { countedAmountMinor: 2250, expectedRevision: 1, reason: "F2 cierre canónico" }, OP_CLOSE);
    expect(closed.data.status).toBe("CLOSED");
    const response = await commercial(owner, { from: FROM, to: TO });
    const data = response.cash.data!;
    expect(data.currentDifferences.some((item) => item.cashSessionId === S_SINGLE)).toBe(false);
    expect(data.historicalDifferences).toEqual(expect.arrayContaining([
      { cashSessionId: S_SINGLE, amountMinor: "250" }
    ]));
    expect(data.ambiguous).toBe(true);
  });
});
