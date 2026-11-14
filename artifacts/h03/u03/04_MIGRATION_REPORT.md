# Migration report

`pnpm db:reset` rebuilt local PostgreSQL and applied all migrations through `202611050001_h03_u03_availability.sql`; the local QA seed completed. The migration creates Business Hours, immutable Booking Policy versions/current state, Business/Staff exceptions, effective unavailability, per-Business guards, allocations, service requirements, and commitment conflicts.

Integrity includes composite tenant FKs, checks, unique source identity, `tstzrange`, and a partial GiST exclusion over ACTIVE allocations. `anon`/`authenticated` receive no direct table grants; `service_role` owns application access. The guard FK uses cascade only when its owning Business is deleted, preserving historical test/tenant cleanup.

