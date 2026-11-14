# 08 — G08 Migración U02 aplicada aditivamente

- `supabase migration list --local` mostró exactamente una pendiente (`202611030001`).
- Aplicada con `supabase db push --local --include-all` (sin reset).
- 10/10 migraciones; 7 tablas `iam.client*` + 2 enums.
- Preservados: 149 reservas / 135 cuentas / 136 negocios / 199 allocations; owner_type 149 GUEST / 0 CLIENT.
- Veredicto: G08 PASS.