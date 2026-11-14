# Test matrix

| Tier | Unique tests | Result |
|---|---:|---|
| Vitest unit | 64 | PASS |
| Vitest integration | 136 | PASS |
| Playwright E2E | 54 | PASS |

The corrected root `pnpm test` excludes Playwright files and runs unit/integration serially: 16 files, 200 tests, all passed. `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed. The database reset/migration/seed passed.

