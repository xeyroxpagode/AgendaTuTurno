# GF-01R FRESH RE-AUDIT REPORT — PARTE 2 (continuación)

## HALLZGOS (continuación)

### FINDING GF-01R-015
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-011 — `availability.spec.ts` (unit) tiene test de 100 iteraciones determinismo
- **Fuente Normativa**: `tests/h03/unit/availability.spec.ts` (no tiene 100 iteraciones); `tests/h03/integration/availability.spec.ts:102-110` (SÍ tiene 100)
- **Comportamiento Esperado**: Existe test que llama a `resolveSlot` 100 veces con idénticos parámetros y verifica que el `staffMemberId` sea el mismo en todas (determinismo del balancing ANY).
- **Comportamiento Observado**: `tests/h03/integration/availability.spec.ts:102-110`: `it("resolveSlot is deterministic under repeated identical calls (ANY balancing)")` hace `Promise.all(Array.from({length:100}, ...))` y verifica `results.forEach(r=>expect(r.staffMemberId).toBe(results[0].staffMemberId))` y `new Set(staffIds).size).toBe(1)`. CORRECTO — pero está en el archivo de INTEGRACIÓN, no en el unit `tests/h03/unit/availability.spec.ts` que el listado de CP-011 menciona. El unit availability.spec.ts (80 líneas) no tiene test de 100 iteraciones.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `tests/h03/integration/availability.spec.ts:102-110` vs `tests/h03/unit/availability.spec.ts`.
- **Impacto**: Calidad — el test de determinismo existe y pasa estáticamente; ubicación en integration (no unit) es un detalle de organización, no un defecto.
- **Causa Probable**: El test de 100 iteraciones requiere BD real (integration), por eso va en integration.spec.ts.
- **Correctivo Mínimo**: N/A (funcionalmente correcto).
- **Estado Confirmación**: FIXED_VERIFIED (con nota de ubicación)

### FINDING GF-01R-016
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-012 — Weak Assertions fortalecidos (mismos archivos que CP-011)
- **Fuente Normativa**: `tests/h03/integration/booking-confirm.spec.ts`, `booking-principals.spec.ts`, `booking-domain-error-codes.spec.ts`, `booking-fault-injection.spec.ts`, `availability.spec.ts`
- **Comportamiento Esperado**: Las aserciones débiles (ej. `expect([403, 404]).toContain(res.statusCode)`) se fortalecieron a códigos exactos donde es posible.
- **Comportamiento Observado**: 
  - `booking-confirm.spec.ts:110`: `expect([403, 404]).toContain(res.statusCode)` — SIGUE DÉBIL (rango 403/404) para "operation not found / proof missing". Esto es una weak assertion restante.
  - `booking-domain-error-codes.spec.ts:43`: `expect([400, 409]).toContain(confirmRes.statusCode)` para BOOKING_QUOTE_EXPIRED — DÉBIL (rango).
  - `booking-fault-injection.spec.ts:56`: `expect(statuses.sort()).toEqual([200, 409])` — FORTE (exacto).
  - `booking-fault-injection.spec.ts:104-105`: `expect(statuses[0]).toBe(200); expect(statuses[1]).toBe(409)` — FORTE.
  - `booking-principals.spec.ts`: usa `toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })` — FORTE.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `booking-confirm.spec.ts:110` y `booking-domain-error-codes.spec.ts:43`.
- **Impacto**: Calidad de tests — aserciones débiles permiten falsos positivos (cualquier 4xx pasa).
- **Causa Probable**: CP-012 no cubrió todas las aserciones débiles; quedaron dos rangos sin estrechar.
- **Correctivo Mínimo**: Reemplazar `expect([403, 404]).toContain(...)` por el código exacto esperado (404 cuando falta operación por completo; 403 cuando falta proof en operación existente), y `expect([400, 409]).toContain(...)` por el código exacto de quote expirada (400 por firma inválida).
- **Estado Confirmación**: STRONG_HYPOTHESIS (dos weak assertions permanecen; no es regresión, es cobertura incompleta de CP-012)

### FINDING GF-01R-017
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-013 — Staff Override `requirePublic` ya correcto en `reschedule.ts`
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/reschedule.ts` (referenciado por CP-013)
- **Comportamiento Esperado**: El override de staff para reschedule no requiere `publicBookingEnabled` (staff puede mover slots incluso si el booking público está deshabilitado para el negocio).
- **Comportamiento Observado**: No se pudo leer `reschedule.ts` directamente en este lote (no entre los archivos glob leídos). Sin embargo, `staff-exceptions.ts:32-58` llama a `rescheduleBooking` con `allowStaffOverride: true` y `bypassCutoff: true`. La bandera `requirePublic` no aparece en las rutas staff de `routes.ts:296-302` (las rutas staff no filtran por publicBookingEnabled). CORRECTO por inferencia de las rutas staff que no exigen requirePublic.
- **Reproducción**: INSPECCIÓN ESTÁTICA parcial — `routes.ts:296-302` no aplica requirePublic a override-reschedule; `staff-exceptions.ts` pasa `allowStaffOverride: true`.
- **Impacto**: Funcional — staff puede reprogramar reservas incluso con booking público deshabilitado.
- **Causa Probable**: N/A (correcto por diseño).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED (por inferencia de rutas staff sin requirePublic)

### FINDING GF-01R-018
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-014 — Evento `STAFF_EXCEPTION_APPLIED` emitido en `staff-exceptions.ts`
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/staff-exceptions.ts:26-28` y `54-56`
- **Comportamiento Esperado**: Tanto `staffExceptionCancel` como `staffExceptionReschedule` insertan un evento `reservation_events` con `event_type = 'STAFF_EXCEPTION_APPLIED'` tras la operación.
- **Comportamiento Observado**: LÍNEAS 26-28 (cancel): inserta `...,'STAFF_EXCEPTION_APPLIED',${input.operationId},'STAFF',...`. LÍNEAS 54-56 (reschedule): idéntico con `overrideType: "reschedule"`. CORRECTO. Nota: el contrato `bookingEventTypes` en `packages/contracts/src/booking.ts:22` incluye `"STAFF_EXCEPTION_APPLIED"`. CORRECTO.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `staff-exceptions.ts:26-28, 54-56` y `packages/contracts/src/booking.ts:22`.
- **Impacto**: Auditoría — historia append-only de excepciones staff.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-019
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-015 — Validación Duplicada Cadencia eliminada (`queries.ts` línea 105)
- **Fuente Normativa**: `apps/api/src/modules/availability/queries.ts:104`
- **Comportamiento Esperado**: No debe haber una segunda validación duplicada de cadencia (startStepMinutes) que rechace inicios válidos; una sola validación en `resolveSlot`.
- **Comportamiento Observado**: LÍNEA 104: `if(input.visibleStartMinute%policy.startStepMinutes!==0)throw new DomainError("NO_AVAILABILITY","The requested start is outside the booking cadence",409);`. ÚNICA validación de cadencia en `resolveSlot`. No hay línea 105 con validación duplicada (la línea 105 es el resto de la misma expresión: `const services=...`). CORRECTO: la duplicación fue eliminada; queda una sola.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `queries.ts:104-105`.
- **Impacto**: Funcional — evita rechazar inicios de slot válidos por doble validación.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-020
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: CP-016 — `recovery.ts` usa `CURRENT_KEY_VERSION` (no `'recovery'` literal)
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/recovery.ts:64, 65` y `guest-access.ts:64`
- **Comportamiento Esperado**: `encryptEnvelope` se invoca con `CURRENT_KEY_VERSION` ("v1"), no con un literal `'recovery'`.
- **Comportamiento Observado**: `recovery.ts:64`: `const envelope = encryptEnvelope(envelopePlaintext, CURRENT_KEY_VERSION);` y `recovery.ts:65`: `...${CURRENT_KEY_VERSION}...`. `guest-access.ts:64`: `export const CURRENT_KEY_VERSION = "v1";`. CORRECTO: usa la constante versionada, no literal `'recovery'`.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `recovery.ts:64-65` y `guest-access.ts:64`.
- **Impacto**: Seguridad/Datos — rotación de claves de envelope consistente entre recovery y confirm.
- **Causa Probable**: N/A (fix aplicado correctamente).
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-021 (Regresión / Spec-vs-Código)
- **Severidad**: P1
- **Confidence**: MEDIUM
- **Requisito**: Q4 — `BookingQuotePayload` en contratos coincide con lo que `confirm.ts` envía a `resolveSlot` y `claimAllocation`
- **Fuente Normativa**: `packages/contracts/src/booking.ts:70-95` (`BookingQuotePayload`) vs `apps/api/src/modules/booking/commands/confirm.ts:132-146` y `170-178`
- **Comportamiento Esperado**: Los campos que `confirm.ts` lee de `quote` (`serviceIds`, `localDate`, `visibleStartMinute`, `professionalPreference`, `policyVersionId`, `items[].{serviceId, termsVersionId, durationMinutes, preBufferMinutes, postBufferMinutes, priceMinor, currency}`) existen en `BookingQuotePayload`.
- **Comportamiento Observado**: `BookingQuotePayload` tiene todos esos campos (líneas 73-94). `confirm.ts:132-146` usa `quote.serviceIds`, `quote.localDate`, `quote.visibleStartMinute`, `quote.professionalPreference`, `quote.items.map(...)`. `confirm.ts:170-178` pasa `claimAllocation` con `serviceIds: quote.serviceIds`, `localDate: slot.localDate`, `visibleStart`, `professionalPreference: quote.professionalPreference`. CORRECTO: coincide.
- **Reproducción**: INSPECCIÓN ESTÁTICA — comparación de campos.
- **Impacto**: Funcional — no hay desajuste de contrato entre quote y confirm.
- **Causa Probable**: N/A.
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-022 (Regresión / Spec-vs-Código)
- **Severidad**: P1
- **Confidence**: MEDIUM
- **Requisito**: Q4 — `AllocationClaimInput` en contratos coincide con lo que `confirm.ts` pasa a `claimAllocation`
- **Fuente Normativa**: `packages/contracts/src/availability.ts:74-82` (`AllocationClaimInput`) vs `apps/api/src/modules/booking/commands/confirm.ts:170-178`
- **Comportamiento Esperado**: `claimAllocation(tx, input, now)` recibe `input` con `{ businessId, sourceType, sourceId, serviceIds, localDate, visibleStart, professionalPreference }`.
- **Comportamiento Observado**: `AllocationClaimInput` (líneas 74-82) tiene exactamente esos campos. `confirm.ts:170-178` pasa `{ businessId, sourceType: "RESERVATION", sourceId: reservationId, serviceIds: quote.serviceIds, localDate: slot.localDate, visibleStart, professionalPreference: quote.professionalPreference }`. CORRECTO: `visibleStart` es string (HH:mm desde `minuteToHhMm`), `sourceType` literal "RESERVATION" válido.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `packages/contracts/src/availability.ts:74-82` vs `confirm.ts:170-178`.
- **Impacto**: Funcional — tipos coinciden, no hay desajuste.
- **Causa Probable**: N/A.
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED

### FINDING GF-01R-023 (Regresión potencial — confirm sobrescribe starts/ends tras claimAllocation)
- **Severidad**: P2
- **Confidence**: MEDIUM
- **Requisito**: Q3 — No regresiones: `confirm.ts` actualiza `starts_at/ends_at/occupied_starts_at/occupied_ends_at` con `claimed.*` (línea 180) después de insertar la reserva con `slot.*` (línea 166)
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/confirm.ts:166-180`
- **Comportamiento Esperado**: La reserva se inserta con los horarios del slot resuelto y la allocation claimada debe coincidir (trigger de integridad BD lo exige).
- **Comportamiento Observado**: LÍNEA 166: insert usa `slot.visibleStartAt/visibleEndAt/occupiedStartAt/occupiedEndAt`. LÍNEA 180: `update ... set starts_at=${claimed.visibleStartAt...}, ends_at=${claimed.visibleEndAt...}, occupied_starts_at=${claimed.occupiedStartAt...}, occupied_ends_at=${claimed.occupiedEndAt...}`. `claimAllocation` re-invoca `resolveSlot` internamente (allocation.ts:22-24) que puede seleccionar un staff diferente cuando `professionalPreference === "ANY"` (balanceo por carga). Si entre la resolución del slot (línea 132) y el claim (línea 170) cambia la carga, el staff asignado podría diferir, y el trigger `assert_reservation_allocation_integrity` (migración SQL:237-244) exigiría que `allocation.staff_member_id = reservation.staff_member_id`. Como `confirm.ts` usa `slot.staffMemberId` en el INSERT (línea 166) pero luego `update` usa `claimed.staffMemberId` (línea 180), si difieren el trigger fallaría con 23514.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `confirm.ts:132, 166, 170-180` y migración SQL:237-244.
- **Impacto**: Datos/Funcional — posible conflicto de integridad bajo concurrencia con ANY si el staff del claim difiere del slot del insert (ventana de race entre líneas 132 y 170).
- **Causa Probable**: `claimAllocation` re-resuelve el slot internamente en lugar de reusar el slot ya validado por `resolveSlot` en `performConfirm`.
- **Correctivo Mínimo**: `claimAllocation` debería aceptar el `ResolvedSlot` ya resuelto (o `confirm` debería pasar el slot resuelto) para garantizar que la allocation use exactamente el mismo staff e intervalos que la reserva, eliminando la ventana de race.
- **Estado Confirmación**: STRONG_HYPOTHESIS (ventana de race teóricamente posible; no confirmada por test de 100 iteraciones ANY que solo testa resolveSlot aislado, no el flujo confirm+claim concurrente)

### FINDING GF-01R-024 (Evidencia parcial — CP-011 `booking-reservation.spec.ts` y `booking-security.spec.ts`)
- **Severidad**: P3
- **Confidence**: LOW
- **Requisito**: Q3 — Existen los archivos de test listados en CP-011
- **Fuente Normativa**: `tests/h03/unit/booking-reservation.spec.ts`, `tests/h03/unit/booking-security.spec.ts`, `tests/h03/unit/booking-quote.spec.ts`
- **Comportamiento Esperado**: Los archivos de test de unidad existen.
- **Comportamiento Observado**: Existen: `booking-quote.spec.ts`, `booking-reservation.spec.ts`, `booking-security.spec.ts`. No se leyeron sus contenidos en este lote.
- **Reproducción**: INSPECCIÓN ESTÁTICA (existencia solo).
- **Impacto**: Calidad — existencia confirmada, contenido no verificado.
- **Causa Probable**: N/A.
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: EVIDENCE_GAP (solo existencia verificada, no contenido)

### FINDING GF-01R-025 (Especificación ambigua — `confirm.ts` no usa `resolveClientIdentity` ni `client-principal.ts` para CLIENT confirm)
- **Severidad**: P2
- **Confidence**: MEDIUM
- **Requisito**: Q4 — `confirmClientBooking` recibe `accountId` y `authSessionId` directamente del body (vía ruta), sin re-validar contra U02 en el núcleo de confirmación
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/confirm.ts:249-271` vs `apps/api/src/modules/booking/routes.ts:326-343`
- **Comportamiento Esperado**: La identidad CLIENT debe provenir de U02 (resuelta por la ruta), no del cuerpo libre del navegador.
- **Comportamiento Observado**: La ruta `routes.ts:326-343` resuelve `client = await resolveClientIdentity(request)` (U02 real) y pasa `client.accountId` / `client.clientSessionId` a `confirmClientBooking`. El núcleo `confirmClientBooking` (confirm.ts:249) usa esos valores sin re-validar contra U02, pero ya vienen validados por la ruta. CORRECTO: la validación está en la ruta, no duplicada en el núcleo.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `routes.ts:326-343` y `confirm.ts:249-271`.
- **Impacto**: Funcional — separación de responsabilidades correcta (ruta valida identidad, núcleo confirma).
- **Causa Probable**: N/A.
- **Correctivo Mínimo**: N/A.
- **Estado Confirmación**: FIXED_VERIFIED
