# 13 — RESCHEDULE BOOKING (G13)

**Estado:** VERIFIED_PASS

`modules/booking/commands/reschedule.ts` (`rescheduleBooking`): mismo Reservation ID, servicios/orden/importes/policy históricos, cutoff sobre horario vigente, términos históricos cargados desde `reservation_items` (servidor), `termsOverride` en U03 para colocación, Replace atómico (origen intacto si destino falla), profesional concreto, evento antes/después, revision e idempotencia. Servicio retirado no se reprograma públicamente (`requirePublic=true`); staff puede gestionar con override (`allowStaffOverride`).

`AllocationClaimInput.historicalTerms` y `resolveSlot(...termsOverride)` extendidos en U03 (mínimo, aditivo).
