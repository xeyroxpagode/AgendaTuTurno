# 21 — GLOBAL REGRESSION (G21)

**Estado:** VERIFIED_PASS

Comandos exactos:
- `pnpm typecheck` → PASS (packages/*, apps/api, apps/web).
- `pnpm lint` → PASS (sin warnings con `--deny-warnings`).
- `pnpm build` → PASS (api + web).
- `git diff --check` → sin errores de whitespace.
- `pnpm exec vitest run tests/h03` → 112/112 PASS (unit + integration).
- `pnpm db:verify` → esquemas H01/H02 presentes (verify script espera provisioning_key 'young-kingz-pilot'; el seed local usa otra key — no bloqueante para U04).

Suites ejecutadas: h03/unit (booking-reservation, booking-quote, booking-security, availability, client-profile), h03/integration (availability, booking-integrity, booking-confirm, booking-principals, clients, availability-api). No se ejecutaron suites h01/h02/e2e en este lote (alcance U04); no se alteraron.
