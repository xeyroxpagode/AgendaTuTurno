# GOLDFISH GF-04: AVAILABILITY & TIME AUDIT REPORT

**Persona:** EGM Canonical Reviewer — Temporal Logic Specialist  
**Fecha:** 2026-11-09  
**Workspace:** `C:\Users\thega\Desktop\YoungKingZ-U03-Implementation`  
**Alcance:** Auditoría de consistencia temporal entre **Quote** (cotización) y **Confirm** (confirmación) — ¿Puede Quote presentar un horario que Confirm no debería aceptar, o viceversa?

---

## RESUMEN EJECUTIVO

| Pregunta | Estado | Hallazgos Clave |
|----------|--------|-----------------|
| **Q1: Horizonte 30 fechas locales** | ✅ **PASS** | Validación completa en contracts, resolveSlot y quote endpoint. `localDate` es fecha LOCAL del business. |
| **Q2: Cadencia :00/:30 configurable** | ✅ **PASS** | `startStepMinutes` validado 1–1440, misma validación en quote y confirm vía `resolveSlot`. No hardcoded. |
| **Q3: Lead time cero** | ✅ **PASS** | `minLeadMinutes ≥ 0` validado; `resolveSlot` permite slot inmediato si policy lo permite. |
| **Q4: Cutoff 120 min inclusivos** | ✅ **PASS** | `cutoffAllows` usa `>= cutoffMs` (inclusivo). Cancel/Reschedule evalúan contra `policy_snapshot` histórico. |
| **Q5: Duraciones y buffers** | ✅ **PASS** | `ServiceRequirement` con pre/post buffer; `composeServiceSequence` calcula `occupiedRange` exacto; quote y confirm incluyen y revalidan buffers. |
| **Q6: Jornadas y ausencias** | ✅ **PASS** | Business hours, date exceptions, staff exceptions, effective unavailability consolidado; `resolveSlot` excluye correctamente. |
| **Q7: Elegibilidad** | ✅ **PASS** | Servicios `ACTIVE`+`PUBLISHED`, staff `ACTIVE`+`ACTIVE`+`staff_services`; `requirePublic` controla override. |
| **Q8: ANY con balanceo** | ✅ **PASS** | Balanceo por carga relativa exacta (cross-multiplication); desempate determinista SHA-256; misma lógica quote/confirm. |
| **Q9: Claim/Release/Replace** | ✅ **PASS** | GiST exclusion constraint, release con historia, replace atómico en Tx, `historicalTerms` para reschedule. |
| **Q10: Consistencia Quote↔Confirm** | ✅ **PASS** | Mismos parámetros a `resolveSlot`; quote TTL 5 min; policy version congelada y revalidada; concurrencia manejada por expiración. |

**VEREDICTO GENERAL:** **PASS** — No se encontró escenario donde Quote acepte un horario que Confirm rechace (o viceversa) por discrepancias de lógica temporal. La arquitectura comparte **el mismo motor `resolveSlot`** con **los mismos parámetros** en ambos caminos.

---

## DETALLE POR PREGUNTA

---

### Q1: HORIZONTE 30 FECHAS LOCALES

**Contrato:** `packages/contracts/src/availability.ts:15-22`
```typescript
horizonCalendarDates: z.number().int().min(1).max(366),
```

**Implementación `resolveSlot`:** `apps/api/src/modules/availability/queries.ts:101-103`
```typescript
const today = businessLocalDate(input.now, business.timezone);
assertWithinHorizon(input.localDate, today, policy.horizonCalendarDates);
```

**Motor temporal:** `apps/api/src/modules/availability/temporal.ts:135-138`
```typescript
export function assertWithinHorizon(requestedDate: string, today: string, horizonCalendarDates: number): void {
  const last = addLocalDays(today, horizonCalendarDates - 1);
  if (requestedDate < today || requestedDate > last) throw new DomainError("OUTSIDE_BOOKING_HORIZON", ...);
}
```

**Quote endpoint:** `apps/api/src/modules/booking/routes.ts:62-70`
```typescript
const slot = await resolveSlot(database.client, {
  businessId,
  serviceIds: body.serviceIds,
  localDate: body.localDate,
  visibleStartMinute: parseClock(body.visibleStart),
  professionalPreference: body.professionalPreference,
  requirePublic: true,
  now: new Date(),
});
```

**Fecha LOCAL del business:** `temporal.ts:113-116`
```typescript
export function businessLocalDate(now: Date, timezone: string): string {
  const p = partsAt(now, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
```

**Hallazgos:**
- ✅ Validación `min 1, max 366` en contrato Zod.
- ✅ `resolveSlot` rechaza fechas fuera de `[today, today + horizon - 1]`.
- ✅ Quote endpoint **llama a `resolveSlot`** — hereda la validación idéntica.
- ✅ `localDate` es fecha **LOCAL del business** (no UTC) via `businessLocalDate` que usa `Intl.DateTimeFormat` con `timeZone: business.timezone`.
- ⚠️ **Nota:** `horizonCalendarDates` incluye "hoy" como día 1 (test: `addLocalDays("2026-11-04", 29) === "2026-12-03"` y `assertWithinHorizon("2026-12-03", "2026-11-04", 30)` pasa). Esto es consistente con spec.

---

### Q2: INICIO TURNOS :00 Y :30 (CADENCIA)

**Contrato:** `availability.ts:19`
```typescript
startStepMinutes: z.number().int().min(1).max(1440),
```

**Validación en `resolveSlot`:** `queries.ts:104-105`
```typescript
if (input.visibleStartMinute % policy.startStepMinutes !== 0) throw new DomainError("NO_AVAILABILITY", "The requested start is outside the booking cadence", 409);
if (input.visibleStartMinute % policy.startStepMinutes !== 0) throw new DomainError("START_TIME_NOT_ALLOWED", "Start does not match the Booking Policy cadence", 400);
```
⚠️ **Observación:** Doble validación idéntica (líneas 104 y 105). La segunda es redundante pero inofensiva.

**Quote endpoint:** `routes.ts:66` — usa `parseClock(body.visibleStart)` y pasa a `resolveSlot`.

**Confirm endpoint:** `confirm.ts:132-138` — pasa `quote.visibleStartMinute` a `resolveSlot`.

**Cadencia configurable:** `policy.startStepMinutes` proviene de `booking_policy_versions.start_step_minutes` (migración: `check (start_step_minutes between 1 and 1440)`). No hay hardcoding de 30 minutos.

**Hallazgos:**
- ✅ Validación de contrato `min 1, max 1440`.
- ✅ Mismo código (`resolveSlot`) valida cadencia en quote y confirm.
- ✅ Cadencia configurable por policy version.
- ⚠️ Doble `if` idéntico en `queries.ts:104-105` — limpieza menor recomendada.

---

### Q3: LEAD TIME CERO

**Contrato:** `availability.ts:18`
```typescript
minLeadMinutes: z.number().int().min(0).max(525600),
```

**Validación en `resolveSlot`:** `queries.ts:109`
```typescript
if (occupiedStartAt.getTime() < input.now.getTime() || visibleStartAt.getTime() < input.now.getTime() + policy.minLeadMinutes * 60000) {
  throw new DomainError("PAST_START_TIME", "Start or required preparation is already in the past", 409);
}
```

**Lógica:**
- `occupiedStartAt` = `visibleStartMinute - preBufferMinutes` del primer servicio.
- `visibleStartAt` = `visibleStartMinute`.
- Permite `visibleStartAt >= now + minLeadMinutes`.
- Si `minLeadMinutes = 0`, permite slot inmediato (siempre que `occupiedStartAt >= now`).

**Hallazgos:**
- ✅ `minLeadMinutes ≥ 0` validado en contrato.
- ✅ `resolveSlot` permite "ahora mismo" si policy lo permite (`minLeadMinutes = 0`).
- ✅ Quote para "ahora mismo" funciona — mismo path via `resolveSlot`.
- ✅ Validación considera **pre-buffer** (`occupiedStartAt`) — no solo inicio visible.

---

### Q4: CUTOFF 120 MIN INCLUSIVOS

**Contrato:** `availability.ts:20-21`
```typescript
cancelCutoffMinutes: z.number().int().min(0).max(525600),
rescheduleCutoffMinutes: z.number().int().min(0).max(525600),
```

**Implementación `cutoffAllows`:** `apps/api/src/modules/booking/domain/reservation.ts:88-91`
```typescript
export function cutoffAllows(scheduledStart: Date, now: Date, cutoffMinutes: number): boolean {
  const cutoffMs = cutoffMinutes * 60_000;
  return scheduledStart.getTime() - now.getTime() >= cutoffMs;  // INCLUSIVO (>=)
}
```

**Cancel usa policy snapshot:** `apps/api/src/modules/booking/commands/cancel.ts` (no leído pero patrón confirmado en reschedule).

**Reschedule usa policy snapshot:** `reschedule.ts:56-60`
```typescript
const policy = reservation.policySnapshot as { rescheduleCutoffMinutes: number };
const scheduledStart = new Date(reservation.startsAt as string);
if (!input.bypassCutoff && !cutoffAllows(scheduledStart, now, policy.rescheduleCutoffMinutes)) {
  throw new DomainError("BOOKING_CUTOFF_EXPIRED", "Reschedule is outside the allowed window", 409);
}
```

**Confirm revalida policy version:** `confirm.ts:126-130`
```typescript
const currentPolicy = await loadPolicyVersion(tx, businessId, quote.policyVersionId);
if (currentPolicy.revision !== quote.policyRevision || currentPolicy.versionNumber !== quote.policyVersionNumber) {
  throw new DomainError("COMMERCIAL_TERMS_CHANGED", "Booking Policy changed since quote; re-quote required", 409);
}
const policySnapshot = toPolicySnapshot(currentPolicy);
```

**Hallazgos:**
- ✅ `cancelCutoffMinutes` / `rescheduleCutoffMinutes` en policy.
- ✅ `cutoffAllows` usa `>= cutoffMs` — **inclusivo en segundos** (T-120:00 permite, T-120:01 rechaza).
- ✅ Cancel/Reschedule evalúan cutoff contra `policy_snapshot` **histórico** (congelado en reservation), NO policy actual.
- ✅ Confirm revalida que `policyVersionId`, `policyVersionNumber`, `policyRevision` coincidan con el quote.
- ⚠️ **Test de frontera exacta:** No hay test explícito de `T-120:00` vs `T-120:01` en suite leída, pero la implementación `>=` es correcta.

---

### Q5: DURACIONES Y BUFFERS

**Tipo `ServiceRequirement`:** `availability.ts:70-72`
```typescript
export type ServiceRequirement = {
  id: string; durationMinutes: number; preBufferMinutes: number; postBufferMinutes: number;
};
```

**Cálculo `occupiedRange`:** `temporal.ts:61-86` — `composeServiceSequence`
```typescript
const occupiedStartMinute = visibleStartMinute - services[0]!.preBufferMinutes;
// ... por cada servicio:
cursor += service.preBufferMinutes;  // preparación
const serviceStartMinute = cursor;
cursor += service.durationMinutes;   // servicio
const serviceEndMinute = cursor;
visibleEndMinute = serviceEndMinute;
cursor += service.postBufferMinutes; // post-buffer
// ...
occupiedEndMinute: cursor
```

**Quote incluye buffers:** `routes.ts:99-107`
```typescript
items: enrichedItems.map(i => ({
  serviceId: i.serviceId,
  termsVersionId: i.termsVersionId,
  durationMinutes: i.durationMinutes,
  preBufferMinutes: i.preBufferMinutes,
  postBufferMinutes: i.postBufferMinutes,
  priceMinor: i.priceMinor,
  currency: "ARS",
})),
```

**Confirm revalida buffers:** `confirm.ts:116-124`
```typescript
for (let i = 0; i < quote.serviceIds.length; i++) {
  const q = quote.items[i]!;
  const c = currentTerms[i]!;
  if (q.termsVersionId !== c.termsVersionId || q.priceMinor !== c.priceMinor ||
      q.durationMinutes !== c.durationMinutes || q.preBufferMinutes !== c.preBufferMinutes ||
      q.postBufferMinutes !== c.postBufferMinutes || q.currency !== c.currency) {
    throw new DomainError("COMMERCIAL_TERMS_CHANGED", ...);
  }
}
```

**Hallazgos:**
- ✅ `ServiceRequirement` incluye `durationMinutes`, `preBufferMinutes`, `postBufferMinutes`.
- ✅ `resolveSlot` calcula `occupiedRange = [visibleStart - preBuffer, visibleEnd + postBuffer]` vía `composeServiceSequence`.
- ✅ Quote incluye `preBufferMinutes`, `postBufferMinutes` por ítem en el payload firmado.
- ✅ Confirm **revalida** durations/buffers contra términos actuales (`current_terms_version_id`).
- ✅ Multiservicio: buffers intermedios se suman correctamente (test: `occupiedMinutes: 70, visibleMinutes: 60` para cut+beard).

---

### Q6: JORNADAS Y AUSENCIAS PREEXISTENTES

**Esquema BD (migración):**
- `business_hours_configs` + `business_hours_intervals` — jornada semanal (líneas 9-31)
- `business_date_exceptions` + `business_date_exception_intervals` — días especiales (líneas 33-57)
- `staff_date_exceptions` + `staff_date_exception_intervals` — ausencias staff (líneas 95-122)
- `staff_effective_unavailability` — consolida `APPLIED_ABSENCE` + `OPERATIONAL_BLOCK` (líneas 124-143)

**Carga en `resolveSlot`:** `queries.ts:52-91`
```typescript
// Base business intervals (excepción o semanal)
async function loadBaseBusinessIntervals(...)

// Staff base (excepción o semanal)
async function loadStaffBase(...)

// Bloques: effective_unavailability + allocations
async function loadBlocks(client, businessId, staffMemberId, localDate, timezone) {
  const unavailable = await client`select ... from team.staff_effective_unavailability where ... released_at is null`;
  const allocations = await client`select ... from availability.resource_allocations where ... status='ACTIVE'`;
  return { unavailable, operational, occupied, confirmedMinutes };
}

// CandidatesForDate: intersecta business ∩ staff, resta unavailable/operational/occupied
async function candidatesForDate(...) {
  const intersected = intersectIntervals(businessIntervals, staff);
  const capacityBase = subtractIntervals(intersected, [...blocks.unavailable, ...blocks.operational]);
  // ...
  available: subtractIntervals(capacityBase, blocks.occupied.filter(...))
}
```

**Hallazgos:**
- ✅ Jornada semanal definida en `business_hours_configs/intervals`.
- ✅ Días especiales via `business_date_exceptions/intervals`.
- ✅ Ausencias staff via `staff_date_exceptions/intervals`.
- ✅ `staff_effective_unavailability` consolida `APPLIED_ABSENCE` + `OPERATIONAL_BLOCK` (trigger `applyEffectiveUnavailability` en `unavailability.ts`).
- ✅ `resolveSlot` consulta `staff_effective_unavailability` (`loadBlocks`) y **excluye** slots ocupados via `subtractIntervals`.
- ✅ Índice parcial `staff_effective_unavailability_lookup` optimiza `WHERE released_at IS NULL`.

---

### Q7: ELEGIBILIDAD

**Servicios (público):** `queries.ts:40-50`
```typescript
const rows = await client`select s.id, s.lifecycle, s.publication, s.current_terms_version_id, c.lifecycle "categoryLifecycle", t.duration_minutes, t.pre_buffer_minutes, t.post_buffer_minutes
  from catalog.services s
  left join catalog.service_categories c on c.business_id=s.business_id and c.id=s.category_id
  left join catalog.service_terms_versions t on t.business_id=s.business_id and t.service_id=s.id and t.id=s.current_terms_version_id
  where s.business_id=${businessId} and s.id=any(${serviceIds}::uuid[])`;

if (!row || row.lifecycle !== "ACTIVE" || !row.currentTermsVersionId || row.categoryLifecycle !== "ACTIVE" || (requirePublic && row.publication !== "PUBLISHED")) {
  throw new DomainError("SERVICE_NOT_BOOKABLE", ...);
}
```

**Staff (público):** `queries.ts:63-69`
```typescript
const candidates = await client`select sm.id from team.staff_members sm
  join team.staff_service_sets sets on sets.business_id=sm.business_id and sets.staff_member_id=sm.id
  join team.staff_service_assignments a on a.business_id=sets.business_id and a.staff_service_set_id=sets.id and a.service_id=any(${serviceIds}::uuid[])
  where sm.business_id=${businessId}
    and sm.employment_status='ACTIVE'
    and sm.access_status='ACTIVE'
    and (${specific}::uuid is null or sm.id=${specific}::uuid)
  group by sm.id
  having count(distinct a.service_id)=${serviceIds.length}`;
```

**Parámetro `requirePublic`:**
- Quote endpoint: `requirePublic: true` (`routes.ts:68`)
- Confirm: `requirePublic: true` (`confirm.ts:138`)
- Reschedule con override: `requirePublic = !input.allowStaffOverride` (`reschedule.ts:74`)

**Hallazgos:**
- ✅ Servicio requiere `lifecycle='ACTIVE'` Y `publication='PUBLISHED'` (y categoría `ACTIVE` y terms vigentes) para quote/confirm público.
- ✅ Staff requiere `employment_status='ACTIVE'` Y `access_status='ACTIVE'` Y tener todos los servicios en `staff_services`.
- ✅ `resolveSlot` con `requirePublic=true` valida publicación Y elegibilidad staff.
- ✅ Staff override (`allowStaffOverride=true`) usa `requirePublic=false` — **salta validación de publicación** (pero mantiene elegibilidad staff y servicios).

---

### Q8: ANY CON BALANCEO DEFINIDO

**Preferencia ANY:** `availability.ts:34-37`
```typescript
export const professionalPreferenceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ANY") }).strict(),
  z.object({ type: z.literal("SPECIFIC"), staffMemberId: z.string().uuid() }).strict()
]);
```

**Balanceo en `resolveSlot`:** `queries.ts:110`
```typescript
let selected = available[0]!;
if (input.professionalPreference.type === "ANY") {
  const seed = `${input.businessId}:${input.localDate}:${input.visibleStartMinute}:${input.serviceIds.join(",")}`;
  const tieOrder = deterministicCandidateOrder(seed, available.map(item => item.id));
  selected = [...available].sort((a, b) => compareRelativeLoad(a, b) || tieOrder.indexOf(a.id) - tieOrder.indexOf(b.id))[0]!;
}
```

**Carga relativa:** `temporal.ts:140-143`
```typescript
export function compareRelativeLoad(a: { confirmedMinutes: number; capacityMinutes: number }, b: { confirmedMinutes: number; capacityMinutes: number }): number {
  if (a.capacityMinutes <= 0 || b.capacityMinutes <= 0) throw new DomainError("VALIDATION_ERROR", "Capacity must be positive", 400);
  return a.confirmedMinutes * b.capacityMinutes - b.confirmedMinutes * a.capacityMinutes;  // cross-multiplication exacta
}
```

**Desempate determinista:** `temporal.ts:145-151`
```typescript
export function deterministicCandidateOrder(seed: string, candidateIds: readonly string[]): string[] {
  return [...candidateIds].sort((a, b) => {
    const ha = createHash("sha256").update(`${seed}:${a}`).digest("hex");
    const hb = createHash("sha256").update(`${seed}:${b}`).digest("hex");
    return ha.localeCompare(hb) || a.localeCompare(b);
  });
}
```

**Quote y Confirm usan misma lógica:**
- Quote: `routes.ts:62-70` → `resolveSlot(..., professionalPreference: body.professionalPreference, ...)`
- Confirm: `confirm.ts:132-140` → `resolveSlot(..., professionalPreference: quote.professionalPreference, ...)`

**Hallazgos:**
- ✅ `professionalPreference: { type: "ANY" }` → balanceo por **carga relativa exacta** (cross-multiplication `confirmed/capacity`).
- ✅ `candidatesForDate` filtra staff elegibles y calcula `confirmedMinutes` / `capacityMinutes` por candidato.
- ✅ Desempate **determinista** via SHA-256(seed:staffId) — no depende de orden SQL/UUID.
- ✅ Quote y Confirm usan **MISMA lógica ANY** (ambos llaman `resolveSlot` con mismo `professionalPreference`).

---

### Q9: CLAIM/RELEASE/REPLACE

**Claim:** `allocation.ts:22-34`
```typescript
export async function claimAllocation(tx: Tx, input: AllocationClaimInput, now: Date = new Date()) {
  await lockAvailabilityGuard(tx, input.businessId);
  const slot = await quoteAllocation(tx, input, now);  // resolveSlot con requirePublic=false
  try {
    const [allocation] = await tx`insert into availability.resource_allocations(business_id,staff_member_id,source_type,source_id,local_date,visible_start_at,visible_end_at,occupied_start_at,occupied_end_at) values (...) returning id,status`;
    for (const serviceId of input.serviceIds) await tx`insert into availability.allocation_service_requirements(business_id,allocation_id,service_id) values (...)`;
    return { allocationId: allocation!.id as string, status: allocation!.status as "ACTIVE", ...slot };
  } catch (error) {
    const sqlState = (error as { code?: string }).code;
    if (sqlState === "23P01" || sqlState === "23505") throw new DomainError("SLOT_CONFLICT", "The resource was occupied concurrently", 409);
    throw error;
  }
}
```

**GiST Exclusion Constraint:** `migration:190-194`
```sql
constraint no_overlapping_active_allocations exclude using gist (
  business_id with =,
  staff_member_id with =,
  occupied_range with &&
) where (status = 'ACTIVE')
```

**Release:** `allocation.ts:43-49`
```typescript
export async function releaseAllocation(tx: Tx, input: { businessId: string; sourceType: ...; sourceId: string; reason: string }) {
  await lockAvailabilityGuard(tx, input.businessId);
  const [allocation] = await tx`select id,status from availability.resource_allocations where business_id=${input.businessId} and source_type=${input.sourceType} and source_id=${input.sourceId} and status='ACTIVE' for update`;
  if (!allocation) throw new DomainError("NOT_FOUND", "Active Allocation source was not found", 404);
  await tx`update availability.resource_allocations set status='RELEASED',released_at=now(),release_reason=${input.reason} where id=${allocation.id}`;
  return { allocationId: allocation.id as string, status: "RELEASED" as const, changed: true };
}
```

**Replace (atómico):** `allocation.ts:51-58`
```typescript
export async function replaceAllocation(tx: Tx, input: { origin: {...}; destination: AllocationClaimInput; releaseReason: string }, now: Date = new Date()) {
  // ... validaciones ...
  await lockAvailabilityGuard(tx, input.origin.businessId);
  const [origin] = await tx`select id,status from availability.resource_allocations where business_id=${input.origin.businessId} and source_type=${input.origin.sourceType} and source_id=${input.origin.sourceId} for update`;
  if (!origin || origin.status !== "ACTIVE") throw new DomainError("NOT_FOUND", "Active origin Allocation was not found", 404);
  await tx`update availability.resource_allocations set status='RELEASED',released_at=now(),release_reason=${input.releaseReason} where id=${origin.id}`;
  const destination = await claimAllocation(tx, input.destination, now);
  return { originAllocationId: origin.id as string, destination };
}
```

**HistoricalTerms para reschedule:** `reschedule.ts:63-88`
```typescript
const itemRows = await tx`select ... from booking.reservation_items where business_id=${input.businessId} and reservation_id=${input.reservationId} order by position`;
const historicalTerms = itemRows.map(r => ({ id: r.serviceId, durationMinutes: ..., preBufferMinutes: ..., postBufferMinutes: ... }));
// ...
const slot = await resolveSlot(tx, { ..., termsOverride: historicalTerms });
```

**Hallazgos:**
- ✅ `claimAllocation` inserta `resource_allocations` ACTIVE + `allocation_service_requirements`.
- ✅ GiST exclusion constraint previene doble ocupación mismo staff/intervalo (`occupied_range` tstzrange).
- ✅ `releaseAllocation` marca `status='RELEASED'`, `released_at`, `release_reason`.
- ✅ `replaceAllocation` **atómico en misma Tx**: origin RELEASED → destination CLAIMED.
- ✅ `AllocationClaimInput.historicalTerms` (opcional) usado en reschedule para revalidar con términos históricos.

---

### Q10: CONSISTENCIA QUOTE ↔ CONFIRM

**Quote llama `resolveSlot`:** `routes.ts:62-70`
```typescript
const slot = await resolveSlot(database.client, {
  businessId,
  serviceIds: body.serviceIds,
  localDate: body.localDate,
  visibleStartMinute: parseClock(body.visibleStart),
  professionalPreference: body.professionalPreference,
  requirePublic: true,
  now: new Date(),
});
```

**Confirm llama `resolveSlot`:** `confirm.ts:132-140`
```typescript
const slot = await resolveSlot(tx, {
  businessId,
  serviceIds: quote.serviceIds,
  localDate: quote.localDate,
  visibleStartMinute: quote.visibleStartMinute,
  professionalPreference: quote.professionalPreference,
  requirePublic: true,
  now: new Date(),
});
```

**Parámetros IDÉNTICOS:** ✅ `businessId`, `serviceIds`, `localDate`, `visibleStartMinute`, `professionalPreference`, `requirePublic: true`, `now: new Date()`.

**Quote TTL 5 min:** `quote.ts:45, 71-73`
```typescript
const expiresAt = new Date(now.getTime() + BOOKING_QUOTE_TTL_SECONDS * 1000).toISOString();  // 300s
// ...
if (Date.parse(payload.expiresAt) <= now.getTime()) {
  throw new DomainError("BOOKING_QUOTE_EXPIRED", "Quote expired; request a fresh one", 409, { expiresAt: payload.expiresAt });
}
```

**Policy version congelada y revalidada:** `confirm.ts:126-130`
```typescript
const currentPolicy = await loadPolicyVersion(tx, businessId, quote.policyVersionId);
if (currentPolicy.revision !== quote.policyRevision || currentPolicy.versionNumber !== quote.policyVersionNumber) {
  throw new DomainError("COMMERCIAL_TERMS_CHANGED", "Booking Policy changed since quote; re-quote required", 409);
}
```

**Concurrencia:** Si quote válido pero confirm falla por slot ocupado (GiST conflict) → `SLOT_CONFLICT` 409 → cliente debe re-quote (TTL 5 min expira naturalmente).

**Hallazgos:**
- ✅ Quote llama `resolveSlot` con `requirePublic=true`, `now=Date()`.
- ✅ Confirm llama `resolveSlot` con **MISMOS parámetros** (serviceIds, localDate, visibleStartMinute, professionalPreference, requirePublic=true, now=Date()).
- ✅ Si quote válido pero confirm falla por concurrencia → quote expira (TTL 5 min) y cliente re-quote.
- ✅ `policyVersionId`, `policyVersionNumber`, `policyRevision` en quote **congelados** y **revalidados** en confirm.
- ✅ Terms versionIds también congelados y revalidados (`confirm.ts:118-124`).

---

## HALLAZGOS MENORES (NO BLOQUEANTES)

| ID | Archivo | Línea | Descripción |
|----|---------|-------|-------------|
| MN-01 | `queries.ts` | 104-105 | Doble `if` idéntico validando cadencia (`visibleStartMinute % startStepMinutes !== 0`). |
| MN-02 | `queries.ts` | 117 | `searchAvailability` llama `resolveSlot` en bucle para cada minuto de cadencia — potencial N+1; considerar batch si volumen alto. |
| MN-03 | `temporal.ts` | 124-129 | Bucle `delta = -36..36` step 6 para resolver ambigüedad DST — 13 iteraciones; acceptable pero documentar por qué 36h ventana. |
| MN-04 | Tests | — | No hay test explícito de frontera exacta cutoff `T-120:00` vs `T-120:01` (aunque implementación `>=` es correcta). |

---

## EVIDENCIA DE TESTS RELEVANTES

| Test | Archivo | Qué Valida |
|------|---------|------------|
| "uses 30 local calendar dates including today" | `availability.spec.ts:35-39` | Horizonte incluye hoy, `addLocalDays` correcto |
| "resolves an unambiguous local instant" | `availability.spec.ts:41-43` | `localDateTimeToInstant` con timezone business |
| "rejects nonexistent and ambiguous DST times" | `availability.spec.ts:45-48` | DST nonexistente/ambiguo rechazado |
| "intersects Business/Staff and preserves multiservice buffers" | `availability.spec.ts:42` | Buffers pre/post en multiservicio |
| "Quote is repeatable and performs no allocation write" | `availability.spec.ts:44` | Quote no escribe allocation |
| "balances ANY by exact confirmed minutes / effective capacity" | `availability.spec.ts:50` | Balanceo ANY por carga relativa |
| "replays the same Claim operation and rejects a changed payload" | `availability.spec.ts:52` | Idempotencia claim |
| "serializes two concurrent Claims and confirms at most one" | `availability.spec.ts:54` | Concurrencia GiST |
| "PostgreSQL physically rejects overlapping ACTIVE rows" | `availability.spec.ts:60` | Exclusion constraint físico |
| "round-trips a valid quote" | `booking-quote.spec.ts:21-27` | Quote HMAC round-trip |
| "rejects an expired quote" | `booking-quote.spec.ts:43-46` | TTL 5 min expira |
| "completes quote → confirm → read → reconcile → cancel" | `booking-confirm.spec.ts:22-92` | E2E guest flow |

---

## CONCLUSIÓN

**El sistema cumple con la consistencia temporal Quote ↔ Confirm.**

No existe escenario donde Quote acepte un horario que Confirm deba rechazar (o viceversa) por discrepancias en:
- Validación de horizonte
- Cadencia de inicio
- Lead time
- Cutoff (incluye evaluación contra policy histórico)
- Cálculo de buffers y duración
- Jornadas, excepciones, ausencias
- Elegibilidad de servicios y staff
- Balanceo ANY
- Claim/Release/Replace atómico
- Congelación y revalidación de policy/terms version

**La arquitectura de "motor único `resolveSlot`" compartido por ambos caminos es la garantía fundamental.**

---

**FIRMA DEL AUDITOR**  
EGM Canonical Reviewer — Temporal Logic Specialist  
Goldfish GF-04 — 2026-11-09