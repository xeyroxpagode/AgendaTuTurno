# 07 — CONFIRM TRANSACTION (G07)

**Estado:** VERIFIED_PASS

`modules/booking/commands/confirm.ts` (`confirmGuestBooking`): valida quote → idempotencia (GUEST_INTENT) → guard Business → revalida Terms/Policy/U03 → resuelve ANY → inserta Reservation + ítems → Claim U03 en la misma Tx → vincula Allocation → credencial Guest + envelope cifrado → evento + auditoría → commit. Cualquier fallo ⇒ rollback (verificado por trigger diferido y por suite).

Pruebas: `tests/h03/integration/booking-confirm.spec.ts` — 2/2 PASS (flujo completo quote→confirm→reconcile→read→cancel sin duplicación; tercero sin proof rechazado).
