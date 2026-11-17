import type { Sql } from "postgres";

/**
 * Harness QA de inyección de fallos — NO forma parte del código productivo.
 * Instala disparadores temporales que se activan sólo cuando un `stage` está
 * explícitamente habilitado por el test, y los elimina al finalizar.
 */
export const QA_FAULT_STAGES = [
  "sale_confirm",
  "money_operation",
  "money_allocation",
  "cash_movement",
  "commitment",
  "delivery_movement"
] as const;
export type QaFaultStage = (typeof QA_FAULT_STAGES)[number];

const TRIGGERS: Array<{ name: string; table: string; stage: QaFaultStage; event: string }> = [
  { name: "qa_fault_sale_confirm", table: "sales.sales", stage: "sale_confirm", event: "UPDATE" },
  { name: "qa_fault_money_operation", table: "money.money_operations", stage: "money_operation", event: "INSERT" },
  { name: "qa_fault_money_allocation", table: "money.money_allocations", stage: "money_allocation", event: "INSERT" },
  { name: "qa_fault_cash_movement", table: "cash.cash_movements", stage: "cash_movement", event: "INSERT" },
  { name: "qa_fault_commitment", table: "inventory.commitments", stage: "commitment", event: "INSERT" },
  { name: "qa_fault_delivery_movement", table: "inventory.movements", stage: "delivery_movement", event: "INSERT" }
];

export async function installQaFaults(db: Sql): Promise<void> {
  await db.unsafe(`
    create schema if not exists qa_faults;
    create table if not exists qa_faults.sentinel(stage text primary key);
    create or replace function qa_faults.raise_if_enabled() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from qa_faults.sentinel s where s.stage = tg_argv[0]) then
        raise exception 'QA fault injection at stage %', tg_argv[0] using errcode = '23514';
      end if;
      return new;
    end $$;
  `);
  for (const trigger of TRIGGERS) {
    await db.unsafe(`drop trigger if exists ${trigger.name} on ${trigger.table}`);
    await db.unsafe(`create trigger ${trigger.name} before ${trigger.event} on ${trigger.table}
      for each row execute function qa_faults.raise_if_enabled('${trigger.stage}')`);
  }
  await db`truncate qa_faults.sentinel`;
}

export async function setQaFault(db: Sql, stage: QaFaultStage): Promise<void> {
  await db`insert into qa_faults.sentinel(stage) values (${stage}) on conflict (stage) do update set stage = excluded.stage`;
}

export async function clearQaFaults(db: Sql): Promise<void> {
  await db`truncate qa_faults.sentinel`;
}

export async function removeQaFaults(db: Sql): Promise<void> {
  for (const trigger of TRIGGERS) {
    await db.unsafe(`drop trigger if exists ${trigger.name} on ${trigger.table}`);
  }
  await db.unsafe(`drop function if exists qa_faults.raise_if_enabled()`);
  await db.unsafe(`drop table if exists qa_faults.sentinel`);
  await db.unsafe(`drop schema if exists qa_faults cascade`);
}
