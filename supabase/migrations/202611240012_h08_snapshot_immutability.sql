create or replace function econ.reject_settlement_mutation() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'CLOSED_SNAPSHOT is immutable' using errcode = '23514';
  end if;

  if (to_jsonb(new) - array['status','payable_obligation_id','receivable_obligation_id'])
       is distinct from (to_jsonb(old) - array['status','payable_obligation_id','receivable_obligation_id'])
     or (old.status = 'ADJUSTED' and new.status <> 'ADJUSTED')
     or (old.payable_obligation_id is not null and new.payable_obligation_id is distinct from old.payable_obligation_id)
     or (old.receivable_obligation_id is not null and new.receivable_obligation_id is distinct from old.receivable_obligation_id) then
    raise exception 'CLOSED_SNAPSHOT is immutable' using errcode = '23514';
  end if;

  if (new.payable_obligation_id is distinct from old.payable_obligation_id and not exists (
        select 1 from obligations.expense_obligations o where o.business_id=new.business_id and o.id=new.payable_obligation_id
          and o.settlement_id=new.id and o.operation_id=new.operation_id and o.kind='PAYABLE'
          and o.amount_minor=new.total_payable_minor
      )) or (new.receivable_obligation_id is distinct from old.receivable_obligation_id and not exists (
        select 1 from obligations.expense_obligations o where o.business_id=new.business_id and o.id=new.receivable_obligation_id
          and o.settlement_id=new.id and o.operation_id=new.operation_id and o.kind='RECEIVABLE'
          and o.amount_minor=new.total_receivable_minor
      )) then
    raise exception 'Settlement obligation must be traceable to the original close' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger settlement_snapshot_immutable on econ.settlements;
create trigger settlement_snapshot_immutable
  before update or delete on econ.settlements
  for each row execute function econ.reject_settlement_mutation();
