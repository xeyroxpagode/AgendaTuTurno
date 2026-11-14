# Adversarial results

ST-01–ST-20 were mapped to the frozen dependency, temporal, assignment and modification scenarios: missing policy, disabled publication/category, missing profile, repeated/ordered services, split intervals, buffers, horizon, lead time, DST, capacity zero, unequal load, deterministic tie, concurrent claim, overlapping/touching ranges, failed/successful replace, schedule closure, eligibility removal, urgent suspension and applied absence. All are covered by pure/integration/bridge tests.

AV-01–AV-20 status: AV-01/02/05/06/07/08/09/11/12/13/14/16/17/18/19/20 are directly or compositionally verified; AV-03/04/10/15 are protected by the shared guard/exclusion and exercised through their component concurrency tests. No SQL internals leak. PENDING/APPROVED absence is not ingested; only the explicit APPLIED fact can enter effective unavailability.

