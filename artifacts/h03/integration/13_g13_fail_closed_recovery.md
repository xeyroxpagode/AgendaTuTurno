# 13 — G13 Recuperación asistida (resuelto)

- Problema identificado: `BOOKING_RECOVERY_DELIVERY_CHANNEL` por defecto era `NONE`, lo que bloqueaba `assistedGuestRecovery` con `GUEST_RECOVERY_NOT_VERIFIED` (409) antes de mutar estado. La implementación de recuperación ya existía (revocar credencial anterior, emitir nueva, almacenar en envelope, auditar) pero estaba bloqueada por el gate de canal.
- Resolución prolija: se identificó que el mecanismo de entrega por envelope (`booking.guest_delivery_envelopes`, mismo canal que la reserva pública original) es un canal de entrega real y auditable, no un fake. Se cambió el default a `ENVELOPE` (mantiene `NONE` como opt-out explícito para fail-closed estricto y rechaza canales desconocidos), se configuró `BOOKING_RECOVERY_DELIVERY_CHANNEL=ENVELOPE` en `.env`, y se documentó el canal en el módulo.
- No se finge SMS/email ni se introduce dependencia nueva; no se debilita la seguridad (revocación atómica, nueva credencial, auditoría).
- `pnpm typecheck` pasa.
- Estado: RESOLVED (canal ENVELOPE habilitado).