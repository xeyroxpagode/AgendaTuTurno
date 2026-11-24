alter table econ.agreement_versions
  add column period_cadence jsonb,
  add constraint agreement_period_cadence_shape
    check (period_cadence is null or (
      jsonb_typeof(period_cadence) = 'object' and
      period_cadence ?& array['unit','interval','anchorDate'] and
      period_cadence->>'unit' in ('DAYS','MONTHS') and
      jsonb_typeof(period_cadence->'interval') = 'number' and
      jsonb_typeof(period_cadence->'anchorDate') = 'string'
    ));
