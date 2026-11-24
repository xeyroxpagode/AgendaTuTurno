alter table obligations.expense_obligations
  add column settlement_id uuid,
  add constraint expense_obligations_settlement_fk
    foreign key (business_id, settlement_id) references econ.settlements(business_id, id);

update obligations.expense_obligations o
set settlement_id = s.id
from econ.settlements s
where s.business_id = o.business_id
  and o.id in (s.payable_obligation_id, s.receivable_obligation_id);

alter table econ.settlement_sources
  add constraint settlement_sources_business_source_key unique (business_id, source_type, source_id);
