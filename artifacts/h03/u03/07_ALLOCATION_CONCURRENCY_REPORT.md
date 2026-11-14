# Allocation and concurrency report

Quote is read-only. Claim locks the per-Business guard, revalidates eligibility/time/policy, resolves ANY, inserts one ACTIVE allocation plus service requirements, and is idempotent through `system.operation_attempts`. Release preserves the row as RELEASED. Replace protects the origin and swaps only after the destination succeeds.

PostgreSQL tests demonstrate: two simultaneous claims produce one success; distinct Staff can occupy the same instant; overlapping ACTIVE rows fail with `23P01`; touching half-open ranges succeed; failed Replace preserves origin; successful Replace releases it atomically. SQL exclusion errors are mapped to `SLOT_CONFLICT`.

