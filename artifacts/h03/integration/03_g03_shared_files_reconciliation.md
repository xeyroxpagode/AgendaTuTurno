# 03 — G03 Reconciliación de 6 archivos compartidos

- `apps/api/src/app.ts`: `registerClientAuthRoutes` + availability + booking; redacción ampliada (`x-guest-token`, `x-intent-proof`, campos sensibles del body); CORS DELETE + `x-intent-proof` + `x-guest-token`; OpenAPI 2.4.0 con tags `client-auth`, `availability`, `booking`.
- `apps/web/src/app/globals.css`: base común líneas 1–17 idénticas; bloque `.client-shell*` U02 añadido al final; alias CSS (`--border/--surface/--accent/--radius`) para `.availability-*`.
- `apps/web/src/proxy.ts`: `CLIENT_PRIVATE_PREFIXES` = mis-cosas/cuenta/mis-reservas; `CLIENT_PUBLIC_PREFIXES` registro/ingresar/verificar/recuperar; STAFF → `/login`; CLIENT privado → `/cliente/ingresar`.
- `packages/contracts/package.json` + `src/index.ts`: exports `./client-auth`, `./availability`, `./booking` sin duplicados; `DomainErrorCode` unificado (añadidos ACCOUNT_RESTRICTED, PHONE_UNVERIFIED, MFA_REQUIRED, RECOVERY_REQUIRED, RECOVERY_CODE_INVALID, RECOVERY_CODE_USED; `RATE_LIMITED` una vez).
- `packages/database/src/schema.ts` + `index.ts`: añadidos `export * from "./client-auth.js"` y `./availability.js`.
- Veredicto: G03 PASS.