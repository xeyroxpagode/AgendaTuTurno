alter table econ.settlement_adjustments
  add column obligation_kind text check (obligation_kind in ('PAYABLE','RECEIVABLE'));

create unique index settlement_adjustments_causal_source
  on econ.settlement_adjustments (business_id, settlement_id, source_type, source_id)
  where source_type in ('REFUND','CORRECTION') and source_id is not null;
