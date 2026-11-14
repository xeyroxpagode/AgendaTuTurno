# 05 — G05 Bridge CLIENT → Booking

- `apps/api/src/modules/booking/security/client-principal.ts`: `toBookingPrincipal()` (`authSessionId = principal.clientSessionId`), `resolveClientIdentity()`, `resolveClientBookingPrincipal()`, `clientContactSnapshot()`.
- Sin segundo proveedor Supabase; email/teléfono del body nunca es autoridad.
- `pnpm typecheck` pasa.
- Veredicto: G05 PASS.