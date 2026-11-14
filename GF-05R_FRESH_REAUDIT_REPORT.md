# GF-05R FRESH RE-AUDIT REPORT

## Reviewer ID: GF-05R
## Subagent Session ID: [auto]
## Modelo: nvidia/nemotron-3.5-super-vl-120b-a12b
## Timestamp Inicio/Fin: 2026-11-11T18:43:50.787Z / 2026-11-11T18:43:50.787Z

## HALLZGOS

### FINDING GF-05R-001 (Q1) — Tests de fault injection para commit uncertainty: EXISTEN y cubren los 4 sub-escenarios

- **Severidad**: — (sin defecto)
- **Confidence**: HIGH
- **Estado Confirmación**: FIXED_VERIFIED
- **Fuente Normativa**: CP-011 (`booking-fault-injection.spec.ts`)
- **Comportamiento Esperado**: `booking-fault-injection.spec.ts` testa confirmación concurrente, cancel/reschedule concurrente, rollback Reservation→Claim, idempotencia conflict, contra API real + PostgreSQL real, sin duplicados ni huérfanos.
- **Comportamiento Observado**: Los 4 sub-escenarios están presentes:
  - **Confirmación concurrente**: `tests/h03/integration/booking-fault-injection.spec.ts:38-71` (F04-01) → dos `POST /reservations` con `Promise.all` → statuses `[200, 409]`, exactamente 1 allocation ACTIVE, `countAttempts(opA) === 1` y `countAttempts(opB) === 1`.
  - **Cancel/reschedule concurrentes**: `tests/h03/integration/booking-fault-injection.spec.ts:73-119` (F04-02) → `Promise.all` de cancel y reschedule con mismo `expectedRevision` → uno 200, otro 409; estado final consistente (CANCELLED sin allocation ACTIVE, o CONFIRMED con 1 ACTIVE).
  - **Rollback Reservation→Claim**: `tests/h03/integration/booking-fault-injection.spec.ts:157-175` (F04-04) → transacción directa inserta Reservation CONFIRMED sin allocation y lanza error antes del Claim → rollback elimina todo: `count(reservations) = 0` y `count(resource_allocations) = 0` (sin huérfanos). *Nota: simulado por transacción SQL directa, no a través del endpoint HTTP, pero valida la atomicidad del camino Reservation → Claim.*
  - **Idempotencia conflict**: `tests/h03/integration/booking-fault-injection.spec.ts:177-189` (F04-05) → `executePrincipalOperation` con mismo `operationId` y distinto principal → `IDEMPOTENCY_CONFLICT`; el intento original queda `SUCCEEDED`.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `booking-fault-injection.spec.ts`.
- **Impacto**: Ninguno (requisito CP-011 cumplido para commit uncertainty).
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.

---

### FINDING GF-05R-002 (Q2) — Tests de envelope crypto failure: NO existe inyección de fallo en `decryptEnvelope` a través de API real + PostgreSQL real

- **Severidad**: P1
- **Confidence**: HIGH
- **Estado Confirmación**: CONFIRMED_DEFECT
- **Fuente Normativa**: CP-011; REQ-BK-036 ("Envelope cipher fault: decrypt falla → 410")
- **Comportamiento Esperado**: Existe test de fault injection que inyecta fallo en `decryptEnvelope` y verifica manejo graceful (respuesta 410, sin exposición de plaintext, sin corromper estado).
- **Comportamiento Observado**:
  - `tests/h03/integration/booking-fault-injection.spec.ts` (190 líneas, F04-01 a F04-05): **ninguna** prueba inyecta fallo criptográfico en el envelope ni ejercita `decryptEnvelope` por el path de reconciliación.
  - `tests/h03/integration/booking-domain-error-codes.spec.ts` (199 líneas): cubre BOOKING_QUOTE_EXPIRED, COMMERCIAL_TERMS_CHANGED, BOOKING_NOT_OWNED, GUEST_ACCESS_INVALID, BOOKING_CUTOFF_EXPIRED, BOOKING_POLICY_UNAVAILABLE, BOOKING_QUOTE_INVALID — **ninguna** de envelope crypto failure.
  - El manejo graceful **sí existe en código**: `apps/api/src/modules/booking/routes.ts:159-165` — `try { decryptEnvelope(...) } catch { throw new DomainError("BOOKING_OPERATION_NOT_RECOVERABLE", "Envelope could not be opened", 410); }`. Pero esa ruta no está cubierta por test de fault injection contra API real.
  - Cobertura existente solo es unitaria sobre el primitivo: `tests/h03/unit/booking-security.spec.ts:32-44` (payload corrupto, truncado, versión de clave desconocida `v999`) — no es fault injection contra API real + PostgreSQL real.
  - REQ-BK-036 marcado **NOT_VERIFIED** en `artifacts/h03/egm-audit/02_REQUIREMENTS_TRACEABILITY.md:125` ("NINGUNO DIRECTO ... NO PROBADO EXPLÍCITAMENTE").
- **Reproducción**: INSPECCIÓN ESTÁTICA — grep `decryptEnvelope` sobre `tests/` solo da `booking-security.spec.ts`; lectura estática de `routes.ts:159-165`.
- **Impacto**: Medio — si `decryptEnvelope` falla en reconciliación (p. ej. rotación de clave, payload corrupto), el endpoint devuelve 410 por el `catch` de `routes.ts`, pero no hay test que lo demuestre en el camino real; riesgo de regresión no detectado.
- **Causa Probable**: CP-011 implementó tests de concurrencia (F04-01 a F04-05) pero omitió el escenario de fallo criptográfico del envelope.
- **Correctivo Mínimo**: Añadir test de fault injection que inyecte fallo en `decryptEnvelope` (p. ej. payload corrupto en `guest_delivery_envelopes` o clave版本 inválida) y verifique que `GET /booking-operations/:opId` responde 410 `BOOKING_OPERATION_NOT_RECOVERABLE` sin dejar estado inconsistente.

---

### FINDING GF-05R-003 (Q3) — Tests de deadlock: NO existe `Promise.all([txA.then(txB), txB.then(txA)])` ni simulación de inversión de locks

- **Severidad**: P2
- **Confidence**: HIGH
- **Estado Confirmación**: CONFIRMED_DEFECT
- **Fuente Normativa**: CP-011; GF-05 Q9 (GF5-01)
- **Comportamiento Esperado**: Existe test que simula deadlock por inversión de orden de locks, p. ej. `Promise.all([txA.then(txB), txB.then(txA)])`, y verifica que PostgreSQL aborta uno con `40P01` y que la aplicación responde de forma consistente (sin bloqueo infinito).
- **Comportamiento Observado**:
  - `grep 40P01|deadlock|retry` sobre `apps/`: **0 coincidencias** — la aplicación no tiene lógica de deadlock ni código que maneje `40P01`.
  - `tests/h03/integration/booking-fault-injection.spec.ts`: F04-01/F04-02/F04-03 usan `Promise.all` de llamadas API **independientes** serializadas por `lockAvailabilityGuard` (orden consistente Business guard → Reservation → Allocation), no inversión de orden `txA→txB / txB→txA`.
  - PostgreSQL detecta y aborta deadlocks residuales con `40P01`, pero **ningún test lo ejercita**.
  - GF-05 Q9 concluye PASS por orden de locks consistente, pero advierte "Falta: retry automático en aplicación (mitigación, no hallazgo crítico)" y GF5-01 (P2) registra la ausencia de retry.
- **Reproducción**: INSPECCIÓN ESTÁTICA — grep sobre `apps/` y lectura estática de `booking-fault-injection.spec.ts`.
- **Impacto**: Bajo-Medio — ante un deadlock residual, la transacción falla con `40P01` y el cliente recibe error sin reintento automático; sin test de deadlock no se verifica que la respuesta sea consistente y sin bloqueo infinito.
- **Causa Probable**: Los tests de fault injection se centraron en serialización por slot (GiST) y rollback, no en escenarios de inversión de locks.
- **Correctivo Mínimo**: Añadir test que fuerce contención de locks con orden invertido (o mockee un `40P01`) y verifique respuesta 409/500 sin colgar la conexión; considerar retry con backoff en capa de aplicación (ver Q6).

---

### FINDING GF-05R-004 (Q4) — Tests de network partition / timeout tras commit: NO se testa respuesta perdida tras commit exitoso

- **Severidad**: P1
- **Confidence**: HIGH
- **Estado Confirmación**: CONFIRMED_DEFECT
- **Fuente Normativa**: CP-011; GF-08 Q6 (faltan network partition y commit uncertainty)
- **Comportamiento Esperado**: Existe test que simula commit exitoso pero respuesta perdida (cliente no recibe el 200), y verifica que el cliente puede reconciliar vía `GET /booking-operations/:operationId` + `x-intent-proof` recuperando el resultado original **sin duplicar** la operación.
- **Comportamiento Observado**:
  - `tests/h03/integration/booking-fault-injection.spec.ts`: F04-01 a F04-05 **no** simulan commit exitoso con respuesta perdida, ni timeout de red tras commit, ni partición que impida entregar la respuesta.
  - `tests/h03/integration/booking-confirm.spec.ts:50-70` prueba que `GET /booking-operations/:opId` devuelve el **mismo** `guestToken` en llamadas repetidas (reconciliación idempotente, no genera token nuevo) — pero no inyecta pérdida de respuesta tras commit ni timeout de red; es un test de reconciliación nominal, no de fault injection de partición.
  - `apps/api/src/modules/booking/routes.ts:147-167` implementa el endpoint de reconciliación con `decryptEnvelope` protegido por try/catch (410), pero no hay test de fault injection que force "respuesta perdida tras commit exitoso".
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `booking-fault-injection.spec.ts` y `booking-confirm.spec.ts:50-70`.
- **Impacto**: Medio — commit uncertainty no probado por fault injection; si la respuesta se pierde tras commit, no hay evidencia de que el cliente pueda recuperar el resultado idempotentemente bajo fallo de red.
- **Causa Probable**: CP-011 cubrió concurrencia y rollback, pero omitió el escenario de partición de red / pérdida de respuesta post-commit.
- **Correctivo Mínimo**: Añadir test de fault injection que confirme commit exitoso (reserva en DB) pero simule pérdida de respuesta, y verifique que `GET /booking-operations/:opId` recupera el `guestToken`/resultado original sin crear duplicados.

---

### FINDING GF-05R-005 (Q5) — Idempotencia: STARTED y FAILED se tratan de forma IDÉNTICA (ambos → CONFLICT), sin documentación de por qué en el código

- **Severidad**: P3
- **Confidence**: HIGH
- **Estado Confirmación**: CONFIRMED_DEFECT (gap; documentado solo en informe de auditoría GF-05, no en código)
- **Fuente Normativa**: GF-05 Q5 (GF5-03)
- **Comportamiento Esperado**: `executePrincipalOperation` trata STARTED y FAILED de forma distinta **o** documenta explícitamente por qué los trata idénticamente.
- **Comportamiento Observado**:
  - `apps/api/src/modules/system/operations.ts:49-50`:
    ```ts
    if (row.status === "SUCCEEDED") return { ok: true as const, data: row.response_body as T, replayed: true };
    throw new DomainError("CONFLICT", "The operation is already being reconciled", 409);
    ```
    Cualquier `status !== "SUCCEEDED"` (incluido `STARTED` y `FAILED`) lanza `CONFLICT` idéntico: "The operation is already being reconciled". **STARTED y FAILED se tratan de forma idéntica.**
  - No hay comentario en `operations.ts` que justifique la indiferencia entre `STARTED` y `FAILED`.
  - `operations.ts:57-62`: cuando el handler falla, el intento se marca `FAILED`; un reintento posterior con mismo `operationId` encuentra `status = 'FAILED'` → `CONFLICT` (no re-ejecuta, no duplica). El comportamiento es seguro, pero indiferente.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lectura estática de `operations.ts:36-67`.
- **Impacto**: Bajo — el comportamiento es correcto (no duplica, no re-ejecuta en vuelo), pero la falta de distinción/documentación dificulta la operativa (p. ej. diferenciar "reintentable" de "bloqueado") y no cumple estrictamente el requisito Q5 de documentar por qué se tratan igual.
- **Causa Probable**: Diseño deliberado de "cualquier estado no-SUCCEEDED = CONFLICT" sin diferenciar STARTED/FAILED, sin comentario justificativo.
- **Correctivo Mínimo**: O bien diferenciar `STARTED` (permitir reintento/completar) de `FAILED` (CONFLICT, cliente debe reintentar con nuevo operationId), o añadir comentario en `operations.ts:50` documentando por qué ambos → CONFLICT.

---

### FINDING GF-05R-006 (Q6) — Retry automático ante deadlock 40P01: NO existe; se deja que PostgreSQL aborte y el cliente debe reintentar

- **Severidad**: P2
- **Confidence**: HIGH
- **Estado Confirmación**: CONFIRMED_DEFECT (mejora operativa, no bloqueante para release)
- **Fuente Normativa**: GF-05 Q9 (GF5-01, ELEPHANT-030)
- **Comportamiento Esperado**: Existe mecanismo de retry automático (backoff + jitter) ante `40P01` **o** se documenta explícitamente que el cliente debe reintentar.
- **Comportamiento Observado**:
  - `grep 40P01|deadlock|retry` sobre `apps/`: **0 coincidencias** — no hay retry automático, no hay backoff, no hay middleware de reintento de transacción.
  - PostgreSQL detecta y aborta deadlocks con `40P01`; la aplicación deja que el error propague al cliente.
  - La única documentación está en el informe de auditoría GF-05 (GF5-01 P2): "La aplicación deja que PG aborte; cliente debe reintentar. Documentar o añadir retry con backoff." No hay documentación de este comportamiento en el código fuente ni en README/docs del repositorio inspeccionados.
  - ELEPHANT-030 registrado como defecto confirmado (P3 en reconciliación de elefantes, P2 en GF-05).
- **Reproducción**: INSPECCIÓN ESTÁTICA — grep sobre `apps/`; lectura de `GF-05_CONCURRENCY_IDEMPOTENCY_AUDIT_REPORT.md:394` y `402`.
- **Impacto**: Bajo-Medio — ante deadlock residual, el cliente recibe error sin reintento automático; depende del cliente reintentar, pero esto no está documentado en el código ni en la API (no hay cabecera de retry ni guidance).
- **Causa Probable**: El orden global de locks (`lockAvailabilityGuard` primero en todos los módulos) reduce drásticamente la contención, por lo que se consideró el retry automático no crítico.
- **Correctivo Mínimo**: Implementar retry con backoff exponencial + jitter para `40P01` en capa de cliente o middleware de transacción, **o** documentar explícitamente (código + docs) que el cliente debe reintentar ante `40P01`.

---

## RESUMEN

- Total hallazgos: 6
- P0: 0 | P1: 2 | P2: 2 | P3: 1
- FIXED_VERIFIED: 1 (Q1) | CONFIRMED_DEFECT: 5 (Q2, Q3, Q4, Q5, Q6) | (sin) NOT_VERIFIED | (sin) BLOCKED

| ID | Q | Severidad | Estado | Archivo/Línea clave |
|----|---|-----------|--------|---------------------|
| GF-05R-001 | Q1 | — | FIXED_VERIFIED | `tests/h03/integration/booking-fault-injection.spec.ts:38-71, 73-119, 157-175, 177-189` |
| GF-05R-002 | Q2 | P1 | CONFIRMED_DEFECT | `tests/h03/integration/booking-fault-injection.spec.ts` (ausente); `routes.ts:159-165` (manejo graceful sin test); `booking-security.spec.ts:32-44` (solo unitario) |
| GF-05R-003 | Q3 | P2 | CONFIRMED_DEFECT | `tests/h03/integration/booking-fault-injection.spec.ts` (sin inversión de locks); `apps/` sin `40P01`/`deadlock`/`retry` |
| GF-05R-004 | Q4 | P1 | CONFIRMED_DEFECT | `tests/h03/integration/booking-fault-injection.spec.ts` (sin pérdida de respuesta post-commit); `booking-confirm.spec.ts:50-70` (solo reconcile nominal) |
| GF-05R-005 | Q5 | P3 | CONFIRMED_DEFECT | `apps/api/src/modules/system/operations.ts:49-50` (STARTED ≡ FAILED → CONFLICT, sin justificación en código) |
| GF-05R-006 | Q6 | P2 | CONFIRMED_DEFECT | `apps/` sin retry/`40P01`; documento solo en GF-05 GF5-01 |

### Conclusión del re-auditor

CP-011 se cumple en lo relativo a **commit uncertainty por concurrencia** (Q1: F04-01 a F04-05 verificados estáticamente). Sin embargo, el re-audit GF-05R confirma **5 gaps abiertos** del plan correctivo original que permanecen sin cobertura de fault injection: (Q2) fallo criptográfico del envelope no inyectado contra API real; (Q3) ningún test de deadlock por inversión de locks; (Q4) ningún test de partición de red / respuesta perdida tras commit; (Q5) STARTED y FAILED tratados idénticamente sin documentación en código; (Q6) sin retry automático ante `40P01` ni documentación del reintento del cliente en el código fuente. Todos los hallazgos se basan en **inspección estática read-only** (sin ejecución de tests ni shell), por recomendación se ejecuten los tests de integración contra PostgreSQL real para confirmar el estado runtime antes del release.

**Reviewer ID: GF-05R** — EGM Canonical Reviewer — Concurrency & Fault Injection Specialist (RE-AUDIT)
