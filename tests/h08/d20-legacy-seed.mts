// Fixture histórico sintético: ejecutar ANTES de la migración D20, nunca
// deshabilitar triggers para fabricar un histórico después del correctivo.
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const url = new URL(process.env.DATABASE_URL ?? "");
if (!url.pathname.slice(1).startsWith("youngkingz_h08_") || !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Unsafe D20 historical fixture target");
const sql = postgres(url.href, { max: 1 });
const business = "11111111-1111-4111-8111-111111111111";
const owner = "33333333-3333-4333-8333-333333333333";
const staff = "bbbbbbb1-1111-4111-8111-111111111111";
const professional = "bbbbbbb3-3333-4333-8333-333333333333";
try {
  const [schema] = await sql`select to_regclass('money.refund_attributions') present`;
  if (schema!.present) throw new Error("Fixture must precede D20 migration; refusing bypass");
  for (const { marker, amounts, refund, confirmed, linkOrigin } of [
    { marker: "D20-LEGACY-PARTIAL", amounts: [4000], refund: 8000, confirmed: 10000, linkOrigin: false },
    { marker: "D20-LEGACY-MULTI", amounts: [4000, 6000], refund: 3000, confirmed: 10000, linkOrigin: false },
    { marker: "D20-LEGACY-LINKED-EXCESS", amounts: [10000], refund: 5000, confirmed: 20000, linkOrigin: true }
  ]) {
    await sql.begin(async (tx) => {
      const [period] = await tx`select candidate "from", candidate+interval '1 day' "to"
        from generate_series('2490-01-01'::timestamptz,'2520-01-01'::timestamptz,interval '3 days') candidate
        where not exists (select 1 from econ.agreement_versions v join econ.agreements a on a.business_id=v.business_id and a.id=v.agreement_id
          where a.business_id=${business} and a.staff_member_id=${professional} and v.valid_from<candidate+interval '1 day' and v.valid_to>candidate)
        order by candidate limit 1`;
      if (!period) throw new Error("No historical fixture period");
      let [agreement] = await tx`select id from econ.agreements where business_id=${business} and staff_member_id=${professional} and status='ACTIVE'`;
      if (!agreement) [agreement] = await tx`insert into econ.agreements(business_id,staff_member_id,created_by_account_id) values (${business},${professional},${owner}) returning id`;
      const [version] = await tx`select coalesce(max(version),0)+1 next from econ.agreement_versions where agreement_id=${agreement!.id}`;
      await tx`insert into econ.agreement_versions(business_id,agreement_id,version,modality,commission_base,bps,valid_from,valid_to,terms_hash,created_by_account_id)
        values (${business},${agreement!.id},${version!.next},'COMMISSION','COLLECTED',1000,${period.from},${period.to},'QA-D20-LEGACY',${owner})`;
      const attempt = async (command: string) => {
        const id = randomUUID();
        await tx`insert into system.operation_attempts(operation_id,business_id,actor_account_id,command_name,request_hash,principal_kind,principal_ref)
          values (${id},${business},${owner},${command},${randomUUID()},'STAFF',${owner})`;
        return id;
      };
      const paymentOp = await attempt("qa.d20.legacy-payment");
      const allocations: Array<{ sale: string; amount: number }> = [];
      for (const amount of amounts) {
        const attendance = randomUUID(), sale = randomUUID(), saleOp = await attempt("qa.d20.legacy-sale");
        const occurred = new Date(new Date(period.from).getTime() + 3600000).toISOString();
        await tx`insert into attendance.attendances(id,business_id,staff_member_id,attended_by_staff_member_id,walk_in,status,started_at,finished_at,services_performed_snapshot,contact_snapshot)
          values (${attendance},${business},${staff},${professional},true,'COMPLETED',${occurred},${occurred},'[]'::jsonb,'{"name":"QA"}'::jsonb)`;
        await tx`insert into sales.sales(id,business_id,operation_id,status,source,attendance_id,total_minor,actor_account_id,confirmed_at)
          values (${sale},${business},${saleOp},'CONFIRMED','ATTENDANCE',${attendance},10000,${owner},${occurred})`;
        await tx`insert into sales.sale_lines(business_id,sale_id,position,kind,name,quantity,unit_price_minor,discount_minor,line_total_minor)
          values (${business},${sale},1,'SERVICE','QA legacy D20',1,10000,0,10000)`;
        allocations.push({ sale, amount });
      }
      const [payment] = await tx`insert into money.money_operations(business_id,operation_id,kind,status,sale_id,amount_minor,confirmed_minor,actor_account_id,note)
        values (${business},${paymentOp},'PAYMENT','SUCCEEDED',${linkOrigin ? allocations[0]!.sale : null},${confirmed},${confirmed},${owner},${marker}) returning id`;
      for (const { sale, amount } of allocations) await tx`insert into money.money_allocations(business_id,money_operation_id,target_type,target_id,amount_minor,actor_account_id,operation_id)
        values (${business},${payment!.id},'SALE',${sale},${amount},${owner},${paymentOp})`;
      const refundOp = await attempt("qa.d20.legacy-refund");
      await tx`insert into money.money_operations(business_id,operation_id,kind,status,refund_of_id,amount_minor,confirmed_minor,actor_account_id,note)
        values (${business},${refundOp},'REFUND','SUCCEEDED',${payment!.id},${refund},${refund},${owner},${marker})`;
    });
  }
  console.log("D20 legacy fixtures prepared before migration; no guards bypassed");
} finally { await sql.end(); }
