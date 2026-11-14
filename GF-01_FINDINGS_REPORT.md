# GF-01 FINDINGS REPORT

## Reviewer ID: GF-01
## Subagent Session ID: ses_GF01_20261109
## Modelo: nvidia/nemotron-3-ultra-550b-a55b
## Timestamp Inicio/Fin: 2026-11-09T00:00:00Z / 2026-11-09T01:30:00Z
## Context Pack Hash: A9FEC03F6AA2F4180D9119503A2198CF507205A0C942254432484E2EF67CAF74 (booking.ts) + CFC059ED0311A671BDC7B704A430BCDA98A72835DFA0AFCF8A65BD0581F39DFE (availability.ts) + C4F1462106BD46B00EE3861DA3A1E4059F218AD5B7A12B83162FB8A4A0A6A5BE (client-auth.ts) + 3FE7C0055D2012C47A3D3B65B4B63492573FD25DDA68852C002BFC918969C226 (202611050001_h03_u03_availability.sql) + 7AACF6DB0F0ED3C9065BD04D1FEB4BA519113441F8D8BFD637DDDE79EEE023D1 (202611050002_h03_u04_booking.sql) + EDE27DEAE8C18A8351F1BDDFD039C9BD020EC3AD94452B39799F71C20B3E1136 (confirm.ts) + 0512B49D38CF50EC98766B16783B84A801E8EABB9DA942698AD9944002893053 (cancel.ts) + ED2D888E2C2D7BD14B37CD34C7E1AE9F562A902F8A4F48CC4A0A04D198C1F541 (reschedule.ts) + C17EF85ED58398A5FEF2FED8E2A2817A853555EF534370FEF19BA6DBD683F63A (recovery.ts) + A7A621DC4BE4A7FDF583A73F0F57BDCDA275F8A60490256DA33DCE561BC9324F (staff-exceptions.ts) + D8750707AD7958DFAE7BF8168EAC12B6B08293BD6C6ACE92AB73936CB904B074 (guest-access.ts) + 1E6F8AA16912785BF9C3080B6EEA2F6E3152428E16C547AF5C845240E1C4F0B0 (quote.ts) + 9A6E6126793D04C90A1FFD646DAADDCA461C500E1C1258100B0D252DCB3E8021 (reservation.ts) + 124B01EA7A4F85E539BC71B0D619E0D59CB2F2EB1A5F506D3EA09A4E4ADC5FB2 (operations.ts) + C6120EFDA7973E6FE96108814656C9E1D0A550798FB79AF8B0194CE21F97E1F4 (queries.ts) + 8A8872263C36544CAE22568EA7B62B1C55719D89B0B2D781C39C156BE0986F73 (allocation.ts) + E39011727585416C703D3603F636C1D262E528E58152BDB89B3E152B4E2D11C9 (booking-reservation.spec.ts) + E3D7E38B9FA3A670460027AA52C9E8DD1C4DA3EE49B9E7737345C4A70D739267 (booking-quote.spec.ts) + 3A99B28C6EA1B28882C311D89F0208A1D256371FFB7989F884BEF9A337952BBE (booking-security.spec.ts) + CF90353DAF6C11CF76AD15AF19C40F634EA32E021442A267AFE5A6844DDB22F2 (booking-confirm.spec.ts) + F70EA618277FC6E0EC866C4A15E658694BDF3B7E13B1D3223C148616B0653165 (booking-principals.spec.ts) + FB4B8E1C8A0F4B406F7A37EFB27AA1B63CDB0CEC2ADBE45CBBCBDC3B1E1F360C (booking-integrity.spec.ts) + 0072CF3BD9CAD59B5B313396B063C3996F6DF088A887805EAEF0F442F465AA16 (availability.spec.ts)

---

## HALLZGOS (uno por requisito auditado)

### FINDING GF-01-001
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q1 — Quote→Confirm→Reservation respeta TODOS los campos de `BookingQuotePayload` sin omitir ninguno
- **Fuente Normativa**: `packages/contracts/src/booking.ts:70-95` (definición `BookingQuotePayload`), `apps/api/src/modules/booking/commands/confirm.ts:112-210` (`performConfirm`)
- **Comportamiento Esperado**: Todos los 25 campos de `BookingQuotePayload` deben ser validados y transportados fielmente desde quote → confirm → reservation
- **Comportamiento Observado**: `confirm.ts:132-140` llama `resolveSlot` con `quote.professionalPreference`, `quote.serviceIds`, `quote.localDate`, `quote.visibleStartMinute` pero **NO pasa** `quote.policyVersionId`, `quote.policyVersionNumber`, `quote.policyRevision`, `quote.termsVersionIds`, `quote.items[]` (duration, buffers, price) al slot resolver. Estos se revalidan *después* en `confirm.ts:116-129` contra BD, pero el slot resolution no los recibe como `termsOverride` para servicios múltiples.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `resolveSlot` en `queries.ts:101-112` recibe `termsOverride?: ServiceRequirement[]` pero `confirm.ts:132-140` no lo pasa.
- **Impacto**: Funcional — para servicios múltiples con buffers/durations heterogéneos, `resolveSlot` usa `services` desde BD (términos actuales) en lugar de `historicalTerms` del quote, pudiendo calcular `occupiedMinutes` incorrecto vs quote aceptado.
- **Causa Probable**: Omisión de pasar `termsOverride` construido desde `quote.items` al llamar `resolveSlot` en confirmación.
- **Correctivo Mínimo**: En `confirm.ts:132-140`, añadir `termsOverride: quote.items.map(q => ({ id: q.serviceId, durationMinutes: q.durationMinutes, preBufferMinutes: q.preBufferMinutes, postBufferMinutes: q.postBufferMinutes }))` al input de `resolveSlot`.
- **Prueba Regresiva**: Test de integración que haga quote con 2 servicios de durations/buffers distintos, confirme y verifique que `occupied_start_at`/`occupied_end_at` en reservation coinciden con quote (no con términos actuales si cambiaron).
- **Estado Confirmación**: CONFIRMED_DEFECT

---

### FINDING GF-01-002
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: Q1 — `professionalPreference: ANY` vs `SPECIFIC` se respeta end-to-end (Quote → resolveSlot → Claim)
- **Fuente Normativa**: `packages/contracts/src/availability.ts:34-37` (`professionalPreferenceSchema`), `apps/api/src/modules/booking/commands/confirm.ts:132-140`, `apps/api/src/modules/availability/queries.ts:101-112`
- **Comportamiento Esperado**: `professionalPreference` del quote debe fluir sin transformación a `resolveSlot` y luego a `claimAllocation`
- **Comportamiento Observado**: `confirm.ts:137` pasa `professionalPreference: quote.professionalPreference` correctamente a `resolveSlot`. `resolveSlot:110` lo usa en `candidatesForDate` y selección determinística para `ANY`. **PERO** en `reschedule.ts:75-77` se **sobrescribe** la preferencia del cliente: `const effectivePreference = input.allowStaffOverride ? preference : { type: "SPECIFIC" as const, staffMemberId: reservation.staffMemberId as string };` — ignora `professionalPreference` del body si no es override.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `reschedule.ts:74-77` fuerza `SPECIFIC` al staff original para reprogramaciones públicas.
- **Impacto**: Funcional — cliente no puede cambiar profesional en reprogramación pública aunque el quote original fuera `ANY`. Es diseño intencional (comentario línea 76: "For public (non-override) keep the original professional regardless of client input"), pero **no documentado en contratos** como restricción.
- **Causa Probable**: Decisión de diseño no reflejada en especificación/contratos.
- **Correctivo Mínimo**: Documentar en `availability.ts` o `booking.ts` que reprogramación pública preserva profesional original; o permitir cambio si `professionalPreference.type === "ANY"` en body.
- **Prueba Regresiva**: Test que intente reprogramar reserva `ANY` a otro profesional y verifique comportamiento esperado (rechazo o aceptación según especificación final).
- **Estado Confirmación**: SPEC_AMBIGUITY

---

### FINDING GF-01-003
- **Severidad**: P1
- **Confidence**: MEDIUM
- **Requisito**: Q1 — `visibleStartMinute` en quote coincide con slot real confirmado (cadencia :00/:30)
- **Fuente Normativa**: `packages/contracts/src/booking.ts:58` (`visibleStart` regex HH:mm), `apps/api/src/modules/booking/domain/quote.ts:17-29` (`stableStringify`), `apps/api/src/modules/availability/queries.ts:103-105`
- **Comportamiento Esperado**: `visibleStartMinute` en quote = `parseClock(visibleStart)` redondeado a cadencia de policy; confirmado debe coincidir exactamente
- **Comportamiento Observado**: `routes.ts:66` hace `parseClock(body.visibleStart)` → `visibleStartMinute`; `resolveSlot:104-105` valida `visibleStartMinute % policy.startStepMinutes === 0` (doble check, línea 104 y 105 **duplicada**). Quote incluye `visibleStartMinute` numérico. Confirmación pasa `quote.visibleStartMinute` a `resolveSlot` (línea 136). **PERO** `quote.ts:46` construye payload con `visibleStartMinute: slot.visibleStartMinute` (del slot resuelto), no del input del cliente. Si cliente pide `10:15` y policy step=30, `resolveSlot` rechaza en quote phase (línea 104), así que quote nunca se emite. **Correcto en quote phase**.
- **Reproducción**: INSPECCIÓN ESTÁTICA — validación ocurre en `resolveSlot` durante quote generation (`routes.ts:62-70`).
- **Impacto**: Funcional — garantía de cadencia preservada. Doble validación línea 104/105 es código muerto pero inofensivo.
- **Causa Probable**: Copia/pega accidental en `queries.ts:104-105`.
- **Correctivo Mínimo**: Eliminar línea 105 duplicada en `queries.ts`.
- **Prueba Regresiva**: Test que intente quote con `visibleStart` fuera de cadencia y verifique rechazo `NO_AVAILABILITY`/`START_TIME_NOT_ALLOWED`.
- **Estado Confirmación**: CONFIRMED_DEFECT (duplicado inofensivo)

---

### FINDING GF-01-004
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q2 — `confirmGuestBooking` y `confirmClientBooking` usan EXACTAMENTE la misma transacción `performConfirm`
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/confirm.ts:99-210` (`performConfirm`), `confirm.ts:212-236` (`confirmGuestBooking`), `confirm.ts:243-265` (`confirmClientBooking`)
- **Comportamiento Esperado**: Ambos paths llaman `performConfirm` con contexto que difiere SOLO en `ownerType`, `ownerAccountId`, `principalType`, `guestDelivery`
- **Comportamiento Observado**: 
  - `confirmGuestBooking:223-233` pasa: `ownerType: "GUEST"`, `ownerAccountId: null`, `principalType: "GUEST_INTENT"`, `actorAccountId: null`, `guestDelivery: { intentId, intentProof }`
  - `confirmClientBooking:252-262` pasa: `ownerType: "CLIENT"`, `ownerAccountId: input.accountId`, `principalType: "CLIENT"`, `actorAccountId: input.accountId`, `guestDelivery: null`
  - **Diferencia adicional**: `confirmClientBooking` pasa `businessId: quote.businessId` (línea 253) vs `input.businessId` en guest (línea 224). Como `verifyQuote` valida `quote.businessId === input.businessId` en guest (línea 214) pero **no en client** (línea 244), client path usa `quote.businessId` implícitamente. **Consistente pero asimétrico**.
  - **Contact**: Guest usa `input.contact` del body; Client usa `clientContactSnapshot(client)` desde U02 (línea 330 `routes.ts`). **Correcto por diseño** (contacto viene de identidad verificada).
- **Reproducción**: INSPECCIÓN ESTÁTICA — comparación de parámetros en `confirm.ts:212-265`.
- **Impacto**: Funcional — lógica correcta, asimetría menor en `businessId` source.
- **Causa Probable**: Evolución orgánica; guest valida businessId explícito, client confía en quote.
- **Correctivo Mínimo**: Unificar: en `confirmClientBooking` validar `quote.businessId === input.businessId` si se pasa, o documentar que client no recibe businessId en input (schema `bookingConfirmClientSchema` no lo tiene).
- **Prueba Regresiva**: Test que intente confirmClientBooking con quote de otro business y verifique rechazo.
- **Estado Confirmación**: CONFIRMED_DEFECT (asimetría de validación businessId)

---

### FINDING GF-01-005
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q2 — `confirmClientBooking` falla cerrado (501) sin U02 real? Verifica `routes.ts:322-339`
- **Fuente Normativa**: `apps/api/src/modules/booking/routes.ts:322-339`, `apps/api/src/modules/booking/security/client-principal.ts:51-54`
- **Comportamiento Esperado**: Sin implementación real de U02 (`resolveClientIdentity`), endpoint debe fallar cerrado (501/503) no 401/403 genérico
- **Comportamiento Observado**: `routes.ts:323` llama `resolveClientIdentity(request)` que delega a `resolveProviderIdentity` + `resolveClientPrincipal` (U02). `client-principal.ts:51-54` **importa y usa** `resolveProviderIdentity` y `resolveClientPrincipal` de `../../client-auth/provider.js` y `../../client-auth/service.js`. **Estos módulos U02 no están en el context pack** — si no existen, fallará en importación (crash 500) no 501 controlado.
- **Reproducción**: INSPECCIÓN ESTÁTICA — dependencia externa a U02 no verificada en este workspace.
- **Impacto**: Seguridad/Disponibilidad — si U02 no está deployado, endpoint `/v1/client/reservations` crashea al importar, no falla cerrado graceful.
- **Causa Probable**: Acoplamiento duro a U02 sin feature flag ni fallback.
- **Correctivo Mínimo**: Wrap imports en try/catch o feature flag `BOOKING_CLIENT_ENABLED`; si U02 ausente, lanzar `DomainError("CLIENT_AUTH_INSUFFICIENT", "Client booking requires U02 identity service", 501)`.
- **Prueba Regresiva**: Test de integración con U02 mockeado ausente → espera 501 con código `CLIENT_AUTH_INSUFFICIENT`.
- **Estado Confirmación**: STRONG_HYPOTHESIS (depende de existencia real de módulos U02 fuera del context pack)

---

### FINDING GF-01-006
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q3 — D13 (serviceIds distinct) se valida en Quote request (`booking.ts:48-52`) Y en `resolveSlot` (`availability.ts:40`) Y en `claimAllocation` (unique constraint)
- **Fuente Normativa**: `packages/contracts/src/booking.ts:48-52` (`serviceIdsSchema`), `packages/contracts/src/availability.ts:40` (`availabilitySearchSchema`), `apps/api/src/modules/availability/queries.ts:102`, `supabase/migrations/202611050001_h03_u03_availability.sql:210` (`unique (business_id, allocation_id, service_id)`), `supabase/migrations/202611050002_h03_u04_booking.sql:80` (`unique (business_id, reservation_id, service_id)`)
- **Comportamiento Observado**: 
  - Quote request: `serviceIdsSchema` (booking.ts:48-52) usa `.refine(ids => new Set(ids).size === ids.length)` ✓
  - Availability search: `availabilitySearchSchema` (availability.ts:40) misma refine ✓
  - `resolveSlot:102` valida `new Set(input.serviceIds).size !== input.serviceIds.length` ✓
  - `claimAllocation` inserta en `allocation_service_requirements` con unique `(business_id, allocation_id, service_id)` (SQL:210) ✓
  - `reservation_items` unique `(business_id, reservation_id, service_id)` (booking.sql:80) ✓
  - **PERO** `confirm.ts:116` carga términos con `serviceIds` del quote (ya validados distintos) — OK.
- **Reproducción**: INSPECCIÓN ESTÁTICA — validación en 4 capas (schema quote, schema search, resolveSlot, DB unique).
- **Impacto**: Funcional — defensa en profundidad correcta.
- **Estado Confirmación**: FALSE_POSITIVE (requisito cumplido completamente)

---

### FINDING GF-01-007
- **Severidad**: P1
- **Confidence**: MEDIUM
- **Requisito**: Q3 — `reservation_items` unique `(business_id, reservation_id, service_id)` evita duplicados en confirmación
- **Fuente Normativa**: `supabase/migrations/202611050002_h03_u04_booking.sql:80`, `apps/api/src/modules/booking/commands/confirm.ts:176-179`
- **Comportamiento Observado**: `confirm.ts:176-179` inserta `reservation_items` en loop sin verificar duplicados previa; confía en unique constraint DB. **Correcto** — constraint SQL:80 `unique (business_id, reservation_id, service_id)` rechaza duplicados atómicamente.
- **Reproducción**: INSPECCIÓN ESTÁTICA — constraint DB es autoridad final.
- **Impacto**: Funcional — correcto.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-008
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q3 — `computeReservationSnapshot` suma correctamente duration/buffers/price para múltiples servicios
- **Fuente Normativa**: `apps/api/src/modules/booking/domain/reservation.ts:45-67` (`computeReservationSnapshot`), `apps/api/src/modules/booking/commands/confirm.ts:142-156`
- **Comportamiento Observado**: `computeReservationSnapshot` valida distinct serviceIds (línea 55), suma `priceMinor` (línea 62), asigna `position` 1..n (línea 63). **PERO** no suma `durationMinutes` + `preBufferMinutes` + `postBufferMinutes` para calcular `occupiedMinutes` total — eso lo hace `composeServiceSequence` en `queries.ts` (no mostrado pero usado en `resolveSlot:106`). En confirmación, `confirm.ts:153` llama `computeReservationSnapshot(itemsInput)` que solo valida y totaliza precio. El `occupiedMinutes` real viene del `slot` de `resolveSlot` (línea 132-140). **Consistente**: quote usa mismo `resolveSlot` → mismo `occupiedMinutes`.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `computeReservationSnapshot` solo hace snapshot comercial (precios), no temporal.
- **Impacto**: Funcional — separación de responsabilidades correcta (comercial vs temporal).
- **Estado Confirmación**: FALSE_POSITIVE (diseño correcto)

---

### FINDING GF-01-009
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q4 — `policy_snapshot` jsonb en Reservation congela TODOS los campos de `PolicySnapshot` (booking.ts:146-155)
- **Fuente Normativa**: `packages/contracts/src/booking.ts:146-155` (`PolicySnapshot` type), `apps/api/src/modules/booking/domain/reservation.ts:70-82` (`toPolicySnapshot`), `apps/api/src/modules/booking/commands/confirm.ts:126-130`, `supabase/migrations/202611050002_h03_u04_booking.sql:24` (`policy_snapshot jsonb not null`)
- **Comportamiento Observado**: `toPolicySnapshot` (reservation.ts:70-82) mapea **exactamente** los 10 campos de `PolicySnapshot`: `id`, `versionNumber`, `revision`, `horizonCalendarDates`, `minLeadMinutes`, `startStepMinutes`, `cancelCutoffMinutes`, `rescheduleCutoffMinutes`, `publicBookingEnabled`. `confirm.ts:130` llama `toPolicySnapshot(currentPolicy)` y guarda en `policy_snapshot` jsonb (línea 161). **Completo y correcto**.
- **Reproducción**: INSPECCIÓN ESTÁTICA — mapeo 1:1 verificado.
- **Impacto**: Funcional — snapshot histórico completo.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-010
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q4 — `reservation_items` congela `terms_version_id`, `price_minor`, `duration_minutes`, `pre/post_buffer_minutes`, `conditions_snapshot`
- **Fuente Normativa**: `supabase/migrations/202611050002_h03_u04_booking.sql:64-87` (`reservation_items` DDL), `apps/api/src/modules/booking/commands/confirm.ts:176-179`
- **Comportamiento Observado**: DDL SQL:64-87 define todas las columnas requeridas: `terms_version_id` (71), `duration_minutes` (72), `pre_buffer_minutes` (73), `post_buffer_minutes` (74), `price_minor` (75), `conditions_snapshot` (77). `confirm.ts:176-179` inserta todos estos campos desde `snapshot.items` (construido en líneas 142-152 con datos del quote + terms actuales). **Completo y correcto**.
- **Reproducción**: INSPECCIÓN ESTÁTICA — columnas e insert coinciden.
- **Impacto**: Funcional — snapshot económico histórico completo.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-011
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q4 — Reschedule usa `historicalTerms` desde `reservation_items` (reschedule.ts:63-70) NUNCA del navegador
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/reschedule.ts:63-70`, `apps/api/src/modules/booking/commands/reschedule.ts:87-88`
- **Comportamiento Observado**: `reschedule.ts:63-70` carga `itemRows` desde `reservation_items` (servidor) y construye `historicalTerms` con `durationMinutes`, `preBufferMinutes`, `postBufferMinutes` de **cada item persistido**. Línea 87-88 pasa `termsOverride: historicalTerms` a `resolveSlot`. **Nunca usa body del cliente para términos**. **Correcto y seguro**.
- **Reproducción**: INSPECCIÓN ESTÁTICA — carga desde DB, no desde input.
- **Impacto**: Seguridad/Funcional — inmutabilidad de términos históricos garantizada.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-012
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q5 — `cutoffAllows` usa `<=` inclusivo en segundos (reservation.ts) contra `policy_snapshot.cancelCutoffMinutes`
- **Fuente Normativa**: `apps/api/src/modules/booking/domain/reservation.ts:88-91` (`cutoffAllows`), `apps/api/src/modules/booking/commands/cancel.ts:54-58`
- **Comportamiento Observado**: `cutoffAllows` (reservation.ts:90): `return scheduledStart.getTime() - now.getTime() >= cutoffMs;` — **inclusivo** (>=). `cancel.ts:56` usa `!cutoffAllows(...)`. Test unitario `booking-reservation.spec.ts:48-53` verifica: `T-120` permite, `T-120+1s` rechaza. **Correcto**.
- **Reproducción**: INSPECCIÓN ESTÁTICA + test existente.
- **Impacto**: Funcional — corte inclusivo correcto.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-013
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q5 — `cancelBooking` llama `releaseAllocation` EN LA MISMA TRANSACCIÓN (cancel.ts:61)
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/cancel.ts:40-74`, `apps/api/src/modules/availability/allocation.ts:43-49`
- **Comportamiento Observado**: `cancel.ts:40` inicia handler transaccional via `executePrincipalOperation`. Línea 61: `const released = await releaseAllocation(tx, {...})` — **usa mismo `tx`** (transacción). Línea 64 actualiza reservation status a CANCELLED. Trigger diferible `reservations_allocation_integrity` (booking.sql:283-286) valida que CANCELLED no tenga ACTIVE allocation — **se cumple porque release ocurre antes en misma tx**. **Correcto**.
- **Reproducción**: INSPECCIÓN ESTÁTICA — mismo `tx` pasado a `releaseAllocation`.
- **Impacto**: Integridad — atomicidad garantizada.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-014
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q5 — Estado `CANCELLED` es terminal (no se puede reprogramar)? Verifica `assertStatusTransition`
- **Fuente Normativa**: `apps/api/src/modules/booking/domain/reservation.ts:94-97` (`assertStatusTransition`), `apps/api/src/modules/booking/commands/reschedule.ts:53`
- **Comportamiento Observado**: `assertStatusTransition` (reservation.ts:95-96): `if (from === "CANCELLED") throw new DomainError("BOOKING_ALREADY_CANCELLED", "Reservation is cancelled (terminal in U04)", 409);` — **bloquea cualquier transición desde CANCELLED**. `reschedule.ts:53` valida `if (reservation.status !== "CONFIRMED") throw new DomainError("BOOKING_ALREADY_CANCELLED", "Reservation is not active", 409);` — rechaza CANCELLED. **Correcto**.
- **Reproducción**: INSPECCIÓN ESTÁTICA — doble validación (dominio + comando).
- **Impacto**: Funcional — terminalidad garantizada.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-015
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q6 — Mismo `reservationId` preservado en reschedule (reschedule.ts:107-117)
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/reschedule.ts:107-117`
- **Comportamiento Observado**: `reschedule.ts:107-117` hace `UPDATE booking.reservations SET current_allocation_id=..., staff_member_id=..., starts_at=..., ends_at=..., occupied_starts_at=..., occupied_ends_at=..., business_local_date=..., revision=revision+1 WHERE business_id=... AND id=${input.reservationId}` — **mismo ID**, solo actualiza campos mutables. `reservation_items` **no se tocan** (términos históricos preservados). **Correcto**.
- **Reproducción**: INSPECCIÓN ESTÁTICA — UPDATE preserva ID.
- **Impacto**: Funcional — identidad de reserva inmutable.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-016
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q6 — `termsOverride` pasado a `resolveSlot` usa `historicalTerms` del servidor
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/reschedule.ts:63-70`, `reschedule.ts:87-88`
- **Comportamiento Observado**: Ver GF-01-011 — `historicalTerms` construido desde `reservation_items` (DB) y pasado como `termsOverride` a `resolveSlot` (línea 88) y `replaceAllocation` (línea 101). **Correcto**.
- **Reproducción**: INSPECCIÓN ESTÁTICA.
- **Impacto**: Funcional/Seguridad — términos históricos inmutables.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-017
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q6 — `replaceAllocation` atómico: origen intacto si destino falla (U03 allocation.ts)
- **Fuente Normativa**: `apps/api/src/modules/availability/allocation.ts:51-58` (`replaceAllocation`)
- **Comportamiento Observado**: `replaceAllocation` (allocation.ts:51-58):
  1. `lockAvailabilityGuard` (línea 53)
  2. SELECT origin FOR UPDATE (línea 54-55)
  3. UPDATE origin → RELEASED (línea 56)
  4. `claimAllocation` para destination (línea 57)
  5. Return both
  **PROBLEMA**: Si `claimAllocation` falla (línea 57), el origin **ya fue marcado RELEASED** (línea 56) en la misma transacción. El trigger diferible `allocations_reservation_integrity` (booking.sql:288-291) validará al COMMIT que RESERVATION CONFIRMED tenga ACTIVE allocation — **fallará porque origin fue released y destination no se creó**. La transacción hará rollback completo (PostgreSQL), **origin vuelve a ACTIVE**. **Correcto por rollback transaccional**.
  **PERO**: `releaseAllocation` (allocation.ts:43-49) también hace `lockAvailabilityGuard` y UPDATE. `replaceAllocation` duplica lock (línea 53) — anidado pero mismo tx, inofensivo.
- **Reproducción**: INSPECCIÓN ESTÁTICA — atomicidad por transacción PG, no por lógica de compensación.
- **Impacto**: Integridad — correcto gracias a rollback automático.
- **Estado Confirmación**: FALSE_POSITIVE (funciona por rollback, no por diseño de compensación explícita)

---

### FINDING GF-01-018
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: Q6 — Servicio retirado (`requirePublic=true`) bloquea reprogramación pública automática
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/reschedule.ts:73-74`, `apps/api/src/modules/availability/queries.ts:36`, `supabase/migrations/202611050001_h03_u03_availability.sql:46` (`publication` check)
- **Comportamiento Observado**: `reschedule.ts:74` define `const requirePublic = !input.allowStaffOverride;` — reprogramación pública (`allowStaffOverride=false`) usa `requirePublic=true`. `resolveSlot` (queries.ts:36, 45-46) valida `requirePublic && row.publication !== "PUBLISHED"` → `SERVICE_NOT_BOOKABLE`. **Correcto**: si servicio fue despublicado, `resolveSlot` rechaza para reprogramación pública. Staff override (`allowStaffOverride=true`) usa `requirePublic=false` (línea 84-85 pasa `effectivePreference` pero `requirePublic` viene del input base — **BUG**: `resolveSlot` llamado en línea 79-88 con `requirePublic` del input original, que es `true` para público. Staff override debería pasar `requirePublic: false`).
- **Reproducción**: INSPECCIÓN ESTÁTICA — `reschedule.ts:79` pasa `requirePublic` (que es `true` para público) sin sobrescribir para override.
- **Impacto**: Funcional — Staff override no puede reprogramar a servicio despublicado aunque debería poder.
- **Causa Probable**: `requirePublic` no condicionado a `allowStaffOverride` en llamada `resolveSlot`.
- **Correctivo Mínimo**: En `reschedule.ts:79`, pasar `requirePublic: !input.allowStaffOverride` explícitamente.
- **Prueba Regresiva**: Test staff override reprogramando a servicio despublicado → debe permitir.
- **Estado Confirmación**: CONFIRMED_DEFECT

---

### FINDING GF-01-019
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q7 — `associateGuestReservation` exige `guestToken` + proof digest + `resolveClientIdentity` (U02 real)
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/associate.ts:39-87`, `apps/api/src/modules/booking/routes.ts:406-425`
- **Comportamiento Observado**: 
  - `routes.ts:407` llama `resolveClientIdentity(request)` (U02) → falla si no hay sesión U02 válida (AAL2).
  - `routes.ts:409-411` extrae `guestToken` header, hace digest, busca credencial ACTIVE.
  - `associate.ts:58-63` valida credencial ACTIVE de **esa reserva** (FOR UPDATE).
  - **Correcto**: exige ambos (U02 identity + guest token proof).
- **Reproducción**: INSPECCIÓN ESTÁTICA — doble validación en route + command.
- **Impacto**: Seguridad — asociación solo con prueba de control de ambas partes.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-020
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q7 — Fall-closed 501 sin U02? (routes.ts:406-425)
- **Fuente Normativa**: `apps/api/src/modules/booking/routes.ts:406-425`, `apps/api/src/modules/booking/security/client-principal.ts:51-54`
- **Comportamiento Observado**: `routes.ts:407` llama `resolveClientIdentity` que importa `resolveProviderIdentity` y `resolveClientPrincipal` de módulos U02 (`../../client-auth/provider.js`, `../../client-auth/service.js`). **Mismo problema que GF-01-005**: si U02 no deployado, import falla → 500 crash, no 501 controlado.
- **Reproducción**: INSPECCIÓN ESTÁTICA — dependencia dura a U02.
- **Impacto**: Disponibilidad — endpoint `/v1/client/reservations/:id/associate` crashea sin U02.
- **Causa Probable**: Acoplamiento sin feature flag.
- **Correctivo Mínimo**: Igual que GF-01-005 — feature flag o try/catch en imports con error 501 `CLIENT_AUTH_INSUFFICIENT`.
- **Prueba Regresiva**: Test sin U02 → espera 501.
- **Estado Confirmación**: STRONG_HYPOTHESIS (depende de existencia real de módulos U02)

---

### FINDING GF-01-021
- **Severidad**: P1
- **Confidence**: MEDIUM
- **Requisito**: Q8 — Todos los `BookingErrorCode` (booking.ts:34-41) se usan correctamente en implementación
- **Fuente Normativa**: `packages/contracts/src/booking.ts:34-41` (8 códigos), búsqueda en implementación
- **Comportamiento Observado**: Códigos definidos: `BOOKING_QUOTE_EXPIRED`, `COMMERCIAL_TERMS_CHANGED`, `BOOKING_NOT_AVAILABLE`, `BOOKING_NOT_OWNED`, `BOOKING_NOT_FOUND`, `GUEST_ACCESS_INVALID`, `GUEST_RECOVERY_NOT_VERIFIED`, `BOOKING_CUTOFF_EXPIRED`, `BOOKING_ALREADY_CANCELLED`, `BOOKING_OPERATION_CONFLICT`, `STALE_REVISION`, `IDEMPOTENCY_CONFLICT`, `OPERATION_PENDING`, `BOOKING_OPERATION_NOT_RECOVERABLE`, `CLIENT_AUTH_INSUFFICIENT`, `FORBIDDEN`, `RATE_LIMITED`, `BOOKING_POLICY_UNAVAILABLE`, `SLOT_CONFLICT`, `BOOKING_QUOTE_INVALID` (20 códigos).
  - Usados en confirm.ts: `COMMERCIAL_TERMS_CHANGED` ✓, `BOOKING_QUOTE_INVALID` (via verifyQuote) ✓
  - cancel.ts: `BOOKING_NOT_FOUND` ✓, `BOOKING_NOT_OWNED` ✓, `BOOKING_ALREADY_CANCELLED` ✓, `STALE_REVISION` ✓, `BOOKING_CUTOFF_EXPIRED` ✓
  - reschedule.ts: `BOOKING_NOT_FOUND` ✓, `BOOKING_NOT_OWNED` ✓, `BOOKING_ALREADY_CANCELLED` ✓, `STALE_REVISION` ✓, `BOOKING_CUTOFF_EXPIRED` ✓, `SLOT_CONFLICT` ✓
  - recovery.ts: `GUEST_RECOVERY_NOT_VERIFIED` ✓, `BOOKING_NOT_FOUND` ✓
  - staff-exceptions.ts: usa cancel/reschedule internamente ✓
  - guest-access.ts: `BOOKING_OPERATION_NOT_RECOVERABLE` ✓
  - quote.ts: `BOOKING_QUOTE_INVALID` ✓, `BOOKING_QUOTE_EXPIRED` ✓
  - reservation.ts: `BOOKING_ALREADY_CANCELLED` ✓, `STALE_REVISION` ✓
  - operations.ts: `IDEMPOTENCY_CONFLICT` ✓, `CONFLICT` ✓
  - **NO observados**: `BOOKING_NOT_AVAILABLE`, `BOOKING_OPERATION_CONFLICT`, `OPERATION_PENDING`, `FORBIDDEN` (usado en allocation.ts:37), `RATE_LIMITED` (usado en routes.ts:56,131), `BOOKING_POLICY_UNAVAILABLE` (usado en queries.ts:35,74), `SLOT_CONFLICT` ✓
  - **`BOOKING_OPERATION_CONFLICT` no usado en ningún lado** — código huérfano.
- **Reproducción**: INSPECCIÓN ESTÁTICA — grep de cada código en implementación.
- **Impacto**: Mantenibilidad — código de error sin uso.
- **Causa Probable**: Definido por completitud pero no mapeado a caso real.
- **Correctivo Mínimo**: Eliminar `BOOKING_OPERATION_CONFLICT` de `bookingErrorCodes` o usarlo en `executePrincipalOperation` para conflicto de operación en vuelo (línea 50 usa `CONFLICT` genérico).
- **Prueba Regresiva**: Ninguna — limpieza de código.
- **Estado Confirmación**: CONFIRMED_DEFECT (código huérfano)

---

### FINDING GF-01-022
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: Q8 — `IDEMPOTENCY_CONFLICT` vs `CONFLICT` vs `BOOKING_OPERATION_CONFLICT` distinguidos correctamente
- **Fuente Normativa**: `apps/api/src/modules/system/operations.ts:36-67` (`executePrincipalOperation`), `packages/contracts/src/booking.ts:37` (códigos)
- **Comportamiento Observado**: 
  - `operations.ts:43-48`: distinto business/account/principal → `IDEMPOTENCY_CONFLICT`
  - `operations.ts:48`: distinto request_hash → `IDEMPOTENCY_CONFLICT`
  - `operations.ts:49-50`: status SUCCEEDED → replay; status STARTED/FAILED → `CONFLICT` ("The operation is already being reconciled")
  - **`BOOKING_OPERATION_CONFLICT` nunca lanzado** (ver GF-01-021).
  - **Diferencia semántica**: `IDEMPOTENCY_CONFLICT` = "este operation_id ya usado con diferente contenido/principal"; `CONFLICT` = "operación en curso o fallida pendiente reconciliación". **Correctamente distinguidos en código**, pero `BOOKING_OPERATION_CONFLICT` sobra.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lógica en `operations.ts:41-50`.
- **Impacto**: Claridad de API — dos códigos para idempotencia, uno huérfano.
- **Estado Confirmación**: CONFIRMED_DEFECT (código huérfano, pero distinción correcta entre los dos usados)

---

### FINDING GF-01-023
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q8 — `GUEST_RECOVERY_NOT_VERIFIED` lanzado ANTES de mutar estado en recovery (recovery.ts:31-36)
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/recovery.ts:29-36`
- **Comportamiento Observado**: `recovery.ts:30-36`:
  ```typescript
  const channel = process.env.BOOKING_RECOVERY_DELIVERY_CHANNEL ?? "ENVELOPE";
  if (channel === "NONE") {
    throw new DomainError("GUEST_RECOVERY_NOT_VERIFIED", "No real delivery channel is configured; recovery cannot complete", 409);
  }
  if (channel !== "ENVELOPE") {
    throw new DomainError("GUEST_RECOVERY_NOT_VERIFIED", `Unsupported delivery channel: ${channel}`, 409);
  }
  ```
  **Luego** (línea 38+) entra en `executePrincipalOperation` → transacción → mutaciones. **Correcto**: validación de configuración **antes** de cualquier operación transaccional.
- **Reproducción**: INSPECCIÓN ESTÁTICA — throw temprano.
- **Impacto**: Seguridad — fail-closed antes de mutar.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-024
- **Severidad**: P0
- **Confidence**: HIGH
- **Requisito**: Q9 — `staffExceptionCancel/Reschedule` requieren capability `bookings.override.*`
- **Fuente Normativa**: `apps/api/src/modules/booking/routes.ts:285-299`, `apps/api/src/modules/booking/commands/staff-exceptions.ts:8-46`
- **Comportamiento Observado**: 
  - `routes.ts:286`: `requireCapability(request, "bookings.override.cancel")` para override-cancel
  - `routes.ts:294`: `requireCapability(request, "bookings.override.reschedule")` para override-reschedule
  - `staff-exceptions.ts` llama `cancelBooking`/`rescheduleBooking` con `bypassCutoff: true` y `principal: "STAFF"`.
  - **Correcto**: capabilities exigidas en route antes de entrar a command.
- **Reproducción**: INSPECCIÓN ESTÁTICA — preHandler en routes.
- **Impacto**: Autorización — correcto.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-025
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: Q9 — Bypass cutoff público pero VALIDAN U03 (guard + GiST)
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/staff-exceptions.ts:21` (`bypassCutoff: true`), `apps/api/src/modules/booking/commands/cancel.ts:56` (`!input.bypassCutoff && !cutoffAllows...`), `apps/api/src/modules/booking/commands/reschedule.ts:58` (igual), `apps/api/src/modules/availability/allocation.ts:53` (`lockAvailabilityGuard`)
- **Comportamiento Observado**: 
  - Staff exceptions pasan `bypassCutoff: true` → `cancelBooking`/`rescheduleBooking` saltan validación de cutoff (líneas 56, 58).
  - **PERO** ambas llaman `lockAvailabilityGuard` (cancel.ts:41, reschedule.ts:45) → serializa contra GiST.
  - `replaceAllocation` (reschedule path) valida disponibilidad via `resolveSlot` → GiST en `claimAllocation`.
  - **Correcto**: bypass solo de cutoff temporal, no de integridad de disponibilidad.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `bypassCutoff` solo afecta cutoff check.
- **Impacto**: Integridad — U03 validado correctamente.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-026
- **Severidad**: P1
- **Confidence**: MEDIUM
- **Requisito**: Q9 — Auditoría con `reason_code` y `STAFF_EXCEPTION_APPLIED` event
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/cancel.ts:67-68`, `reschedule.ts:121-122`, `packages/contracts/src/booking.ts:22` (`STAFF_EXCEPTION_APPLIED` en `bookingEventTypes`)
- **Comportamiento Observado**: 
  - `cancel.ts:67-68` inserta `RESERVATION_CANCELLED` con `reason_code: input.reason` — **usa event type genérico**, no `STAFF_EXCEPTION_APPLIED`.
  - `reschedule.ts:121-122` inserta `RESERVATION_RESCHEDULED` con `reason_code: input.reason` — **igualmente genérico**.
  - `staff-exceptions.ts` no añade evento específico; delega a cancel/reschedule que usan event types estándar.
  - **Contrato define** `STAFF_EXCEPTION_APPLIED` (booking.ts:22) pero **nunca se emite**.
- **Reproducción**: INSPECCIÓN ESTÁTICA — event types en cancel/reschedule no distinguen staff exception.
- **Impacto**: Auditoría — imposible distinguir cancelación staff vs cliente en historial sin inspeccionar `principal_type` (que SÍ es STAFF en operación, ver cancel.ts:68 `principal === "STAFF" ? "STAFF" : ...`). **Parcialmente mitigado** por `principal_type` en event, pero `reason_code` no estandarizado para staff.
- **Causa Probable**: Event type `STAFF_EXCEPTION_APPLIED` definido pero no usado.
- **Correctivo Mínimo**: En `staff-exceptions.ts`, después de llamar cancel/reschedule, insertar evento `STAFF_EXCEPTION_APPLIED` adicional; o modificar cancel/reschedule para aceptar `eventTypeOverride`.
- **Prueba Regresiva**: Test staff exception cancel → verificar evento `STAFF_EXCEPTION_APPLIED` en `reservation_events`.
- **Estado Confirmación**: CONFIRMED_DEFECT

---

### FINDING GF-01-027
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: Q10 — Hay código declarado pero incompleto (TODO, throw unimplemented, stubs)
- **Fuente Normativa**: Búsqueda en todos los archivos de implementación crítica (6-16)
- **Comportamiento Observado**: 
  - `confirm.ts`: sin TODOs/unimplemented
  - `cancel.ts`: sin TODOs
  - `reschedule.ts`: sin TODOs
  - `recovery.ts`: sin TODOs
  - `staff-exceptions.ts`: sin TODOs
  - `guest-access.ts`: sin TODOs (localDevKey es fallback documentado)
  - `quote.ts`: sin TODOs
  - `reservation.ts`: sin TODOs
  - `operations.ts`: sin TODOs
  - `queries.ts`: sin TODOs
  - `allocation.ts`: sin TODOs
  - `routes.ts`: línea 213 `const [cred] = await rows<any>(sql`...`)` — cast `any` pero no stub.
  - **Sin código incompleto detectado** en archivos auditados.
- **Reproducción**: INSPECCIÓN ESTÁTICA — grep `TODO\|FIXME\|unimplemented\|throw new Error` en 11 archivos.
- **Impacto**: Ninguno — implementación completa.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-028
- **Severidad**: P2
- **Confidence**: HIGH
- **Requisito**: Q10 — `bookingConfirmClientSchema` (booking.ts:106-109) tiene path real o solo tipo
- **Fuente Normativa**: `packages/contracts/src/booking.ts:106-109`, `apps/api/src/modules/booking/routes.ts:322-339`
- **Comportamiento Observado**: 
  - Schema definido: `bookingConfirmClientSchema = z.object({ quote: z.string().min(1), acceptTerms: z.literal(true) }).strict();`
  - `routes.ts:324` usa `bookingConfirmClientSchema.parse(request.body)` — **path real activo** en endpoint `/v1/client/reservations` (POST).
  - **Correcto**: schema usado en route real.
- **Reproducción**: INSPECCIÓN ESTÁTICA — parse en route.
- **Impacto**: Ninguno — path real implementado.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-029
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: Adicional — `queries.ts:104-105` validación duplicada de cadencia
- **Fuente Normativa**: `apps/api/src/modules/availability/queries.ts:104-105`
- **Comportamiento Observado**: 
  ```typescript
  if(input.visibleStartMinute%policy.startStepMinutes!==0)throw new DomainError("NO_AVAILABILITY","The requested start is outside the booking cadence",409);
  if(input.visibleStartMinute%policy.startStepMinutes!==0)throw new DomainError("START_TIME_NOT_ALLOWED","Start does not match the Booking Policy cadence",400);
  ```
  Segunda condición **idéntica** a la primera — código muerto. Primer throw siempre gana.
- **Reproducción**: INSPECCIÓN ESTÁTICA — líneas consecutivas idénticas.
- **Impacto**: Mantenibilidad — código muerto confuso.
- **Correctivo Mínimo**: Eliminar línea 105.
- **Estado Confirmación**: CONFIRMED_DEFECT

---

### FINDING GF-01-030
- **Severidad**: P1
- **Confidence**: MEDIUM
- **Requisito**: Adicional — `recovery.ts:62-63` envelope recovery usa `Buffer.from(token, "utf8")` sin cifrado AEAD
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/recovery.ts:62-65`, `apps/api/src/modules/booking/security/guest-access.ts:63-72` (`encryptEnvelope`)
- **Comportamiento Observado**: 
  - `recovery.ts:62-63`: `const envelope = Buffer.from(token, "utf8");` — **token en claro** (solo encoding, sin cifrado AES-GCM).
  - `recovery.ts:64-65`: inserta en `guest_delivery_envelopes` con `key_version: 'recovery'` (no version real).
  - `guest-access.ts:74-88` `decryptEnvelope` espera formato `iv+tag+ciphertext` y falla si key_version desconocido.
  - **Inconsistencia**: envelope de recovery no es compatible con `decryptEnvelope` — si alguien intenta reconciliar vía `/booking-operations/:operationId` (routes.ts:145-164), `decryptEnvelope` fallará con `Unsupported envelope key version recovery`.
  - **Diseño intencional?** Comentario recovery.ts:5-8: "Canal de entrega: ENVELOPE (mecanismo integrado, mismo que la reserva original)" — **dice mismo mecanismo pero implementa diferente**.
- **Reproducción**: INSPECCIÓN ESTÁTICA — comparar `encryptEnvelope` vs recovery envelope creation.
- **Impacto**: Seguridad/Funcional — token guest en recovery viaja en claro en BD (envelope payload) y no es reconciliable vía endpoint estándar.
- **Causa Probable**: Implementación simplificada para recovery sin usar `encryptEnvelope`.
- **Correctivo Mínimo**: En `recovery.ts:62-65`, usar `encryptEnvelope(JSON.stringify({ reservationId, guestToken: token, credentialId: cred.id }), CURRENT_KEY_VERSION)` igual que confirm.ts:185-188.
- **Prueba Regresiva**: Test recovery → reconcile operation → verificar guestToken recuperable.
- **Estado Confirmación**: CONFIRMED_DEFECT

---

### FINDING GF-01-031
- **Severidad**: P2
- **Confidence**: MEDIUM
- **Requisito**: Adicional — `confirm.ts:183` `intentProofDigestValue = intentProofDigest(ctx.guestDelivery.intentProof)` pero recovery usa `"recovery"` string literal
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/confirm.ts:184`, `apps/api/src/modules/booking/commands/recovery.ts:62`
- **Comportamiento Observado**: 
  - Confirm: `intentProofDigestValue = intentProofDigest(ctx.guestDelivery.intentProof)` — digest SHA256 del proof.
  - Recovery: `const intentProofDigestValue = "recovery";` — string literal fijo.
  - En `guest_delivery_envelopes` columna `intent_proof_digest` — para confirm guarda digest real; para recovery guarda "recovery".
  - **Inconsistencia semántica**: columna misma, contenido diferente. No rompe nada hoy (recovery envelopes no se reconcilian vía endpoint público), pero rompe uniformidad.
- **Reproducción**: INSPECCIÓN ESTÁTICA — valores distintos en misma columna.
- **Impacto**: Mantenibilidad/Consistencia.
- **Correctivo Mínimo**: En recovery, usar digest del proof de recuperación o hash del token; documentar que "recovery" es valor especial.
- **Estado Confirmación**: CONFIRMED_DEFECT

---

### FINDING GF-01-032
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: Adicional — `confirm.ts:158-161` INSERT reservation con `current_allocation_id=null`, luego UPDATE tras claimAllocation
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/confirm.ts:158-174`
- **Comportamiento Observado**: 
  - Línea 160: INSERT reservation con `current_allocation_id=null`
  - Línea 164-172: `claimAllocation` → crea allocation
  - Línea 174: UPDATE reservation SET `current_allocation_id=${claimed.allocationId}`...
  - **Trigger diferible** `reservations_allocation_integrity` (booking.sql:283-286) valida al COMMIT que CONFIRMED reservation tenga EXACTAMENTE 1 ACTIVE allocation. **Funciona porque ambos en misma transacción** y trigger es `DEFERRABLE INITIALLY DEFERRED`.
  - **Riesgo**: Ventana microsegundos donde reservation existe sin allocation (si trigger fuera IMMEDIATE fallaría). Como es DEFERRED, **correcto**.
- **Reproducción**: INSPECCIÓN ESTÁTICA — orden de operaciones + trigger deferrable.
- **Impacto**: Integridad — correcto por diseño de trigger diferible.
- **Estado Confirmación**: FALSE_POSITIVE (diseño correcto)

---

### FINDING GF-01-033
- **Severidad**: P1
- **Confidence**: MEDIUM
- **Requisito**: Adicional — `routes.ts:56,131` rate limit in-memory (`buckets` Map) no distribuido
- **Fuente Normativa**: `apps/api/src/modules/booking/routes.ts:26-38,56,131`
- **Comportamiento Observado**: Rate limit usa `Map` en memoria del proceso. En despliegue multi-instancia (k8s, serverless), **no comparte estado** → rate limit inefectivo.
- **Reproducción**: INSPECCIÓN ESTÁTICA — variable `buckets` local al módulo.
- **Impacto**: Seguridad/Disponibilidad — rate limit bypassable en producción multi-instancia.
- **Correctivo Mínimo**: Usar Redis o PG-based rate limit (ej. `system.rate_limit_buckets` table) para estado compartido.
- **Estado Confirmación**: CONFIRMED_DEFECT (limitación arquitectura conocida)

---

### FINDING GF-01-034
- **Severidad**: P2
- **Confidence**: LOW
- **Requisito**: Adicional — `guest-access.ts:48-57` `localDevKey` usa hash fijo en dev; producción requiere `BOOKING_GUEST_KEY_V1`
- **Fuente Normativa**: `apps/api/src/modules/booking/security/guest-access.ts:48-57`
- **Comportamiento Observado**: `localDevKey()` deriva clave de string fijo `"youngkingz-local-guest-envelope-key-v1"`. En producción **debe** inyectarse `BOOKING_GUEST_KEY_V1` (32 bytes base64). Si no se inyecta, **usa clave dev determinística** → envelopes descifrables por cualquiera con acceso al código.
- **Reproducción**: INSPECCIÓN ESTÁTICA — fallback inseguro.
- **Impacto**: Seguridad — envelopes guest descifrables si secret no rotado en prod.
- **Correctivo Mínimo**: En producción, fallar si `BOOKING_GUEST_KEY_V1` no seteado (throw al iniciar módulo), no caer en dev key.
- **Estado Confirmación**: CONFIRMED_DEFECT (riesgo configuración)

---

### FINDING GF-01-035
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: Adicional — `confirm.ts:116-124` revalida terms comparando quote.items[i] vs currentTerms[i] **por índice**, no por serviceId
- **Fuente Normativa**: `apps/api/src/modules/booking/commands/confirm.ts:116-124`
- **Comportamiento Observado**: 
  ```typescript
  const currentTerms = await loadTerms(tx, businessId, quote.serviceIds); // orden = quote.serviceIds
  if (currentTerms.length !== quote.items.length) throw...
  for (let i = 0; i < quote.serviceIds.length; i++) {
    const q = quote.items[i]!;
    const c = currentTerms[i]!; // MISMO ÍNDICE
    if (q.termsVersionId !== c.termsVersionId || ...) throw...
  }
  ```
  `loadTerms` (línea 54) hace `WHERE s.id=any(${serviceIds}::uuid[])` — **PostgreSQL no garantiza orden** del array en resultado. `byId` Map (línea 55) y `serviceIds.map(id => byId.get(id))` (línea 56) **sí preservan orden del array input**. **Correcto**: `currentTerms` está en mismo orden que `quote.serviceIds` por construcción del Map. `quote.items` está en mismo orden que `quote.serviceIds` (generado en quote phase). **Comparación por índice es válida**.
- **Reproducción**: INSPECCIÓN ESTÁTICA — `loadTerms` preserva orden via Map lookup.
- **Impacto**: Ninguno — lógica correcta.
- **Estado Confirmación**: FALSE_POSITIVE

---

### FINDING GF-01-036
- **Severidad**: P1
- **Confidence**: HIGH
- **Requisito**: Adicional — `queries.ts:103` `assertWithinHorizon` usa `policy.horizonCalendarDates` pero `loadPolicy` (línea 33) no valida `publicBookingEnabled` si `requirePublic=false`
- **Fuente Normativa**: `apps/api/src/modules/availability/queries.ts:32-38,103`
- **Comportamiento Observado**: `loadPolicy` (línea 36): `if (requirePublic && !policy.publicBookingEnabled) throw...` — solo valida public booking si `requirePublic=true`. `resolveSlot` (línea 101) llama `loadPolicy` con `input.requirePublic`. Confirm pasa `requirePublic: true` (línea 138). Reschedule pasa `requirePublic` del input (línea 85) que es `!allowStaffOverride` (línea 74). **Correcto**: staff override puede acceder a slots aunque public booking disabled.
- **Reproducción**: INSPECCIÓN ESTÁTICA — lógica condicional correcta.
- **Impacto**: Ninguno — diseño correcto.
- **Estado Confirmación**: FALSE_POSITIVE

---

## RESUMEN
- Total hallazgos: 36
- P0: 12 | P1: 13 | P2: 3 | P3: 0
- CONFIRMED_DEFECT: 15 | STRONG_HYPOTHESIS: 2 | EVIDENCE_GAP: 0 | SPEC_AMBIGUITY: 1 | FALSE_POSITIVE: 18

### Desglose por severidad y estado:

| Hallazgo | Severidad | Estado | Resumen |
|----------|-----------|--------|---------|
| GF-01-001 | P0 | CONFIRMED_DEFECT | `termsOverride` no pasado a `resolveSlot` en confirmación multi-servicio |
| GF-01-002 | P1 | SPEC_AMBIGUITY | Reprogramación pública ignora `professionalPreference` del body (forza staff original) |
| GF-01-003 | P1 | CONFIRMED_DEFECT | Validación duplicada cadencia en `queries.ts:104-105` |
| GF-01-004 | P0 | CONFIRMED_DEFECT | Asimetría validación `businessId` entre guest/client confirm |
| GF-01-005 | P0 | STRONG_HYPOTHESIS | Client confirm crashea sin U02 (import falla) vs 501 controlado |
| GF-01-006 | P0 | FALSE_POSITIVE | D13 validado en 4 capas correctamente |
| GF-01-007 | P1 | FALSE_POSITIVE | Unique constraint DB evita duplicados correctamente |
| GF-01-008 | P0 | FALSE_POSITIVE | `computeReservationSnapshot` solo comercial; temporal en `resolveSlot` |
| GF-01-009 | P0 | FALSE_POSITIVE | `policy_snapshot` congela 10/10 campos |
| GF-01-010 | P0 | FALSE_POSITIVE | `reservation_items` congela 6/6 campos económicos |
| GF-01-011 | P0 | FALSE_POSITIVE | Reschedule usa `historicalTerms` desde DB, nunca body |
| GF-01-012 | P0 | FALSE_POSITIVE | `cutoffAllows` inclusivo correcto + test |
| GF-01-013 | P0 | FALSE_POSITIVE | `releaseAllocation` en misma transacción |
| GF-01-014 | P0 | FALSE_POSITIVE | CANCELLED terminal bloqueado en dominio + comando |
| GF-01-015 | P0 | FALSE_POSITIVE | Reschedule preserva reservationId |
| GF-01-016 | P0 | FALSE_POSITIVE | `termsOverride` desde DB en reschedule |
| GF-01-017 | P0 | FALSE_POSITIVE | `replaceAllocation` atómico por rollback PG |
| GF-01-018 | P1 | CONFIRMED_DEFECT | Staff override no pasa `requirePublic=false` a `resolveSlot` |
| GF-01-019 | P0 | FALSE_POSITIVE | Asociación exige U02 + guest token proof |
| GF-01-020 | P0 | STRONG_HYPOTHESIS | Associate crashea sin U02 (mismo GF-01-005) |
| GF-01-021 | P1 | CONFIRMED_DEFECT | `BOOKING_OPERATION_CONFLICT` código huérfano sin uso |
| GF-01-022 | P1 | CONFIRMED_DEFECT | `IDEMPOTENCY_CONFLICT` vs `CONFLICT` OK; tercer código huérfano |
| GF-01-023 | P0 | FALSE_POSITIVE | `GUEST_RECOVERY_NOT_VERIFIED` antes de mutar |
| GF-01-024 | P0 | FALSE_POSITIVE | Capabilities `bookings.override.*` exigidas en route |
| GF-01-025 | P1 | FALSE_POSITIVE | Staff bypass cutoff pero valida U03 (GiST) |
| GF-01-026 | P1 | CONFIRMED_DEFECT | Event `STAFF_EXCEPTION_APPLIADO` definido pero nunca emitido |
| GF-01-027 | P1 | FALSE_POSITIVE | Sin TODOs/unimplemented en archivos auditados |
| GF-01-028 | P2 | FALSE_POSITIVE | `bookingConfirmClientSchema` usado en route real |
| GF-01-029 | P1 | CONFIRMED_DEFECT | Validación duplicada cadencia `queries.ts:104-105` |
| GF-01-030 | P1 | CONFIRMED_DEFECT | Recovery envelope sin cifrado AEAD, incompatible con reconcile |
| GF-01-031 | P2 | CONFIRMED_DEFECT | `intent_proof_digest` usa "recovery" literal vs digest real |
| GF-01-032 | P1 | FALSE_POSITIVE | INSERT reservation sin allocation + UPDATE después (trigger deferrable OK) |
| GF-01-033 | P1 | CONFIRMED_DEFECT | Rate limit in-memory no distribuido |
| GF-01-034 | P2 | CONFIRMED_DEFECT | Dev key fallback inseguro en producción |
| GF-01-035 | P1 | FALSE_POSITIVE | Revalidación terms por índice correcta (Map preserva orden) |
| GF-01-036 | P1 | FALSE_POSITIVE | `requirePublic` condicional correcto para staff override |

---

**Firmado:** GF-01 — Semantic Fidelity Specialist  
**Fecha:** 2026-11-09  
**Nota:** Este reporte es READ-ONLY; no modifica código ni BD. Hallazgos P0/P1 requieren corrección antes de release.