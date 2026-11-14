# H03.U03 — CURRENT crosswalk

| Concept | CURRENT source | Target authority | Class | Duplication avoided | Verification |
|---|---|---|---|---|---|
| Business and timezone | `business.businesses` | Same | EQUIVALENT | No new tenant or location model | Migration/API tests |
| Service lifecycle/publication | `catalog.services` | Same | EQUIVALENT | No availability catalog | Query/unit tests |
| Duration and buffers | `catalog.service_terms_versions` | Same current immutable terms | EQUIVALENT | No copied duration/price | Multiservice tests |
| Operational professional | `team.staff_members` | Same | EQUIVALENT | No dependency on optional profile | Eligibility test |
| Weekly schedule | `team.staff_weekly_schedules` + intervals | Same | EQUIVALENT | No second weekly schedule | Availability integration |
| Eligibility | `team.staff_service_sets` + assignments | Same | EQUIVALENT | No implicit permission | Eligibility integration |
| Idempotency | `system.operation_attempts` | Reused command envelope | ADAPTABLE | No parallel operation ledger | Retry/conflict tests |
| Audit | `system.audit_events` | Reused audit writer | ADAPTABLE | No parallel audit log | Mutation tests |
| Business hours | None | `business.business_hours_*` | NEW | Separate Business authority | Migration/config tests |
| Booking policy | None | Version + current state | NEW | No implicit SaaS defaults | Policy tests |
| Date exceptions | None | Business and Staff aggregates | NEW | Weekly schedules remain unchanged | Exception tests |
| Effective unavailability | None | Applied facts only | NEW | No AbsenceRequest lifecycle | Availability tests |
| Availability guard | None | Per-Business transaction row | NEW | Shared serialization point | Concurrency tests |
| Resource allocation | None | `availability.resource_allocations` | NEW | No Reservation domain | Exclusion/claim tests |
| Impact conflicts | None | `availability.commitment_conflicts` | NEW | No silent cancellation | Bridge tests |
| H03.U02 client identity | Uncommitted outside worktree | Future convergence | INCOMPATIBLE/ABSENT | U03 does not claim U02 regression | Explicit residual risk |

No product file was modified before this crosswalk was completed.
