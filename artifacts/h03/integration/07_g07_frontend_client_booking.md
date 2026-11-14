# 07 — G07 Frontend CLIENT + Booking

- `apps/web/src/features/client-auth/ClientReservations.tsx` (nuevo): sección "Reservas" real en `ClientThings` con estados loading/empty/not-auth/restricted/MFA/confirmed/cancelled/rescheduled/stale/slot-conflict/network/unknown, cancelar y reprogramar (slot picker por fecha con disponibilidad pública, SPECIFIC con el profesional original).
- `apps/web/src/features/client-auth/flows.tsx`: `errorMessage` ampliado con códigos de booking + red; `ClientPrivateNav` añade "Mis reservas"; sección estática reemplazada por `<ClientReservations />`.
- `apps/web/src/app/(public)/reservar/page.tsx`: bifurcación por sesión CLIENT activa (status ACTIVE + AAL2) → confirmación vía `POST /v1/client/reservations` (sin contacto, snapshot de identidad), sin token de invitado, éxito con enlace a "Mis cosas"; modos `client-mfa`/`restricted` fail-closed; corrección de presentación de horarios en zona horaria del negocio.
- `apps/web/src/app/cliente/mis-reservas/page.tsx` (nuevo): superficie privada de reservas CLIENT.
- `apps/web/src/app/(public)/mis-reservas/page.tsx`: nota cruzada hacia la superficie CLIENT.
- `globals.css`: bloque `H03 U03+U04 · Reservas CLIENT`.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` pasan.
- Veredicto: G07 PASS.