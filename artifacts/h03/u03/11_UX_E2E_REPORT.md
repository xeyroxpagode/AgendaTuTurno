# UX and E2E report

Chromium exercised an authenticated Owner through `/availability`, changed Booking Policy and observed a new immutable version, queried real public availability, and verified the query created zero allocations. Anonymous access redirects to login. A 390×844 run verified the workspace and tablist with no document overflow.

The UI includes Hours, Policy/history, Business closures, Staff exceptions, real Search and Impact tabs, plus loading, retry, dirty, stale/conflict, success and read-only states. A load-generation guard prevents late initial responses from overwriting an active draft.

Full historical Playwright result: 54/54 passed in 2.3 minutes.

