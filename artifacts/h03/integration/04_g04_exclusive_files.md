# 04 — G04 Archivos exclusivos tracked + configuración

- `runtime.ts` adoptado de U02 (candidatos `.env` sin sobrescribir `process.env`).
- `layout.tsx` metadata unificada "Young Kingz · Staff y Cliente".
- `page.tsx` landing multirole con tercer enlace `/reservar`.
- `supabase/config.toml` copiado de U02 (SMS `test_otp`, MFA TOTP habilitada).
- `tests/h03/e2e/clients.spec.ts` corregido (dotenv + `test.setTimeout` por test).
- `pnpm typecheck` pasa (contracts/database/ui/config/web/api).
- Veredicto: G04 PASS.