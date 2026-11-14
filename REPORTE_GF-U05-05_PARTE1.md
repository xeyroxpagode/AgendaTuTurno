# REPORTE DE AUDITORÍA GF-U05-05 — Persistencia & Integridad U05 "Agenda Staff"

## Metadata
- Reviewer ID: GF-U05-05
- Session ID: gf-u05-05-20261111-persistence-integrity
- Modelo usado: nvidia/nemotron-3.5-super-vl-120b-a12b
- Workspace: C:\Users\thega\Desktop\YoungKingZ-U03-Implementation
- HEAD: 35aab9e, rama: feature/h03-u03-implementation
- Modo: READ-ONLY estricto (sin SQL mutante, sin modificaciones)
- Estado: Investigación estática únicamente

## Alcance investigado (archivos leídos íntegramente)
1. packages/database/src/booking.ts (reservations, reservation_items, reservation_events, guest_credentials, guest_delivery_envelopes, guest_recovery_cases)
2. packages/database/src/availability.ts (resource_allocations, allocation_service_requirements, commitment_conflicts, staff_effective_unavailability, business_guards + tablas negocio/team)
3. packages/database/src/schema.ts (businesses, persons, user_accounts, staff_members, role_assignments, capability_grants, access_sessions, operation_attempts, audit_events)
4. packages/database/src/catalog.ts, schedules.ts, staff-services.ts, clients.ts, client-auth.ts
5. supabase/migrations/202611050002_h03_u04_booking.sql
6. supabase/migrations/202611050001_h03_u03_availability.sql
7. supabase/migrations/202611030001_h03_u02_client_identity.sql

---

## Diagrama de tablas relevantes (texto) con relaciones FK

### Esquemas y tablas involucradas en U05

```
business.businesses          (id PK)  [tenant root]
business.booking_policy_versions (id PK, business_id -> businesses)
business.booking_policy_states   (business_id PK, current_version_id)

iam.persons                  (id PK)
iam.user_accounts            (id PK, person_id -> persons)
iam.role_assignments         (id PK, business_id, staff_member_id)
iam.capability_grants        (id PK, business_id, staff_member_id, role_assignment_id)
iam.access_sessions          (id PK, account_id, business_id, staff_member_id, active_role_assignment_id)
system.operation_attempts    (operation_id PK, business_id, actor_account_id)
system.audit_events          (id PK, business_id, actor_account_id, operation_id, resource_type, resource_id)

team.staff_members           (id PK, business_id -> businesses, person_id -> persons)
team.staff_weekly_schedules  (id PK, business_id, staff_member_id -> staff_members)
team.staff_schedule_intervals (id PK, business_id, weekly_schedule_id -> staff_weekly_schedules)

catalog.service_categories   (id PK, business_id)
catalog.services             (id PK, business_id, category_id -> service_categories)
catalog.service_terms_versions (id PK, business_id, service_id -> services)
business.booking_policy_versions

booking.reservations         (id PK, business_id, staff_member_id -> staff_members,
                              business_id, policy_version_id -> booking_policy_versions,
                              business_id, client_profile_id -> clients.client_profiles,
                              business_id, current_allocation_id -> resource_allocations,
                              business_id -> businesses, created_operation_id -> operation_attempts)
booking.reservation_items    (id PK, business_id, reservation_id -> reservations,
                              business_id, service_id -> catalog.services,
                              business_id, terms_version_id -> service_terms_versions)
booking.reservation_events   (id PK, business_id, reservation_id -> reservations,
                              business_id, operation_id -> operation_attempts)
booking.guest_credentials    (id PK, business_id, reservation_id -> reservations)
booking.guest_delivery_envelopes (id PK, business_id, operation_id -> operation_attempts,
                                business_id, reservation_id -> reservations)
booking.guest_recovery_cases (id PK, business_id, reservation_id -> reservations,
                              business_id, requested_by_staff_id -> staff_members,
                              business_id, verified_by_staff_id -> staff_members)

availability.resource_allocations       (id PK, business_id -> businesses,
                                          business_id, staff_member_id -> staff_members)
availability.allocation_service_requirements (id PK, business_id, allocation_id -> resource_allocations,
                                              business_id, service_id -> catalog.services)
availability.commitment_conflicts       (id PK, business_id, allocation_id -> resource_allocations,
                                          business_id, source_operation_id -> operation_attempts)
availability.business_guards            (business_id PK -> businesses)
team.staff_effective_unavailability     (id PK, business_id, staff_member_id -> staff_members)

business.business_hours_configs         (id PK, business_id -> businesses)
business.business_hours_intervals       (id PK, business_id, config_id -> business_hours_configs)
business.business_date_exceptions       (id PK, business_id -> businesses)
business.business_date_exception_intervals (id PK, business_id, exception_id -> business_date_exceptions)
team.staff_date_exceptions              (id PK, business_id, staff_member_id -> staff_members)
team.staff_date_exception_intervals     (id PK, business_id, exception_id -> staff_date_exceptions)

clients.client_profiles   (id PK, business_id -> businesses)
clients.client_contacts   (id PK, business_id, client_profile_id -> client_profiles)
clients.client_notes      (id PK, business_id, client_profile_id -> client_profiles)
clients.client_account_links (id PK, business_id, client_profile_id -> client_profiles, account_id -> iam.user_accounts)
```

### Relaciones FK clave para U05 (resumen)
- `booking.reservations.staff_member_id` → `team.staff_members(business_id, id)` (tenant-safe composite)
- `booking.reservations.current_allocation_id` → `availability.resource_allocations(business_id, id)` (tenant-safe composite)
- `booking.reservations.created_operation_id` → `system.operation_attempts(operation_id)`
- `booking.reservation_events.reservation_id` → `booking.reservations(business_id, id)`
- `booking.reservation_events.operation_id` → `system.operation_attempts(operation_id)`
- `availability.resource_allocations.source_id` → lógicamente `booking.reservations.id` cuando `source_type='RESERVATION'` (no hay FK declarada; se valida por trigger diferible)
- `availability.commitment_conflicts.allocation_id` → `availability.resource_allocations(business_id, id)`
- `system.audit_events.operation_id` → `system.operation_attempts(operation_id)` (no FK declarada, asociación lógica)

---

## (Parte 1 de 4 — se continúa en siguientes entregas)
