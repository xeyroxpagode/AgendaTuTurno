# Implementation map

| Gate | Implementation |
|---|---|
| G00–G02 | Baseline/crosswalk; migration `202611050001_h03_u03_availability.sql`; contracts and Drizzle schema |
| G03–G06 | Temporal engine, effective schedules, eligibility without ProfessionalProfile, exact multiservice |
| G07–G09 | ResourceAllocation Quote/Claim/Release/Replace, GiST exclusion, deterministic ANY |
| G10–G12 | Impact preview/conflicts, H02 schedule/service/lifecycle bridges, Fastify routes, Availability workspace |
| G13–G16 | Unit/integration/E2E, adversarial and historical regression, reports 01–17 |

Primary code is under `apps/api/src/modules/availability`, `apps/web/src/features/availability`, `packages/contracts/src/availability.ts`, and `packages/database/src/availability.ts`.

