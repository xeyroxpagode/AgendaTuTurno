# 10 — G10 Matriz de identidad (requests reales)

- `/v1/client/me` con identidad CLIENT real: 200; `/v1/iam/me` para el mismo principal → 403 (separación CLIENT/STAFF).
- Revocación de sesión: `SESSION_REVOKED` 401 tras revocación.
- MFA: `MFA_REQUIRED` 403 con aal1; AAL2 real exigido por `resolveClientPrincipal`.
- Multi-Business: aislamiento por `owner_account_id` + `business_id`; reserva de otra cuenta → `BOOKING_NOT_OWNED` 403.
- Idempotencia por principal y Business: `IDEMPOTENCY_CONFLICT` en retry concurrente (F04-05).
- Guest isolation: reserva invitada no se asocia automáticamente a CRM; association requiere prueba de control (guest token ACTIVE) y emite 2 eventos.
- No CRM auto-merge: `clients.client_account_links` vacío tras bootstrap (verificado en e2e).
- Veredicto: G10 PASS.