# 14 — GUEST ASSISTED RECOVERY (G14)

**Estado:** BLOCKED (fail-closed implementado; canal de entrega real no disponible)

`modules/booking/commands/recovery.ts` (`assistedGuestRecovery`): exige capability `bookings.guest_access.recover`, evidencia independiente, motivo y auditoría; revoca credenciales ACTIVE y emite nueva en una transacción; registra `guest_recovery_cases` (REQUESTED/VERIFIED/COMPLETED/REJECTED). 

**Fail-closed:** si `BOOKING_RECOVERY_DELIVERY_CHANNEL` no está configurado (default `NONE`), la operación lanza `GUEST_RECOVERY_NOT_VERIFIED` antes de mutar estado. No se finge SMS/email. Para habilitar: configurar un canal real (SMTP/Mailpit) y adaptar la entrega; el contrato queda listo.
Riesgo residual: recuperación asistida no verificable end-to-end en este entorno.
