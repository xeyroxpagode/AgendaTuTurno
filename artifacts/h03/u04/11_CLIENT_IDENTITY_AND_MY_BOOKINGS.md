# 11 — CLIENT IDENTITY AND MY BOOKINGS (G11)

**Estado:** BLOCKED_EXTERNAL_CONVERGENCE

U02 (Identidad Cliente) está ausente en este workspace: vive en el clon `YoungKingZ-H01-Implementation`, rama `feature/h03-u02-implementation`, migración `202611030001_h03_u02_client_identity.sql`. No se copió (prohibición absoluta de movimientos entre repos).

Implementado: adaptador de interfaz y rutas `/v1/client/*` registradas como fail-closed (501 `CLIENT_AUTH_INSUFFICIENT`) para documentar el contrato sin fabricar identidad. Tipos `BookingPrincipal` incluyen `CLIENT`. `Mis reservas` en frontend (`apps/web/src/app/(public)/mis-reservas`) explica el bloqueo.

**No se declara PASS E2E CLIENT.** Requisito para desbloquear: convergencia autorizada de la rama U02 (merge/cherry-pick) o indicación del usuario de otro mecanismo. Ninguna operación Git se realizó.
