# 06 — G06 Rutas CLIENT reales (backend)

- Los 6 stubs 501 `/v1/client/reservations*` reemplazados en `booking/routes.ts`:
  - POST create → `bookingConfirmClientSchema` + `verifyQuote` (businessId desde la cotización firmada) + `confirmClientBooking`.
  - GET lista → filtra `owner_type='CLIENT' AND owner_account_id`.
  - GET detalle / POST cancel / POST reschedule → `ownedClientReservation()` + guard de propiedad (CLIENT ⇒ `owner_type='CLIENT' AND owner_account_id=accountId`, sino `BOOKING_NOT_OWNED` 403).
  - POST associate → prueba de control por credencial invitada ACTIVE, 2 eventos.
- `confirm.ts`: `performConfirm(tx, ctx)` núcleo único compartido por guest y client (sólo cambia owner_type/account/principal/guestDelivery).
- `associate.ts`: prueba de control, transacción única, 2 eventos (`RESERVATION_ACCOUNT_ASSOCIATED`, `GUEST_ACCESS_REVOKED`), bug de `nextSeq` duplicado corregido.
- `cancel.ts`/`reschedule.ts`: guard de propiedad CLIENT.
- `business_timezone_snapshot` añadido a los SELECTs (presentación canónica).
- `pnpm typecheck` + `pnpm lint` + `pnpm build` pasan.
- Veredicto: G06 PASS.