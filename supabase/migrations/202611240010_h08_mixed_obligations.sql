-- A mixed settlement may create one payable and one receivable in the same attempt.
alter table obligations.expense_obligations
  drop constraint expense_obligations_operation_id_key,
  add constraint expense_obligations_operation_kind_key unique (operation_id, kind),
  add constraint obligations_amount_api_range check (amount_minor <= 9007199254740991);

-- An extinguished existing obligation keeps its identity and payment history.
alter table obligations.expense_obligations
  drop constraint obligations_known_amount_positive,
  add constraint obligations_known_amount_positive
    check (amount_minor is null or amount_minor > 0 or (amount_minor = 0 and status = 'SETTLED'));
