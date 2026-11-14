# Temporal engine report

`temporal.ts` implements normalized half-open local intervals, intersection/subtraction, exact inclusion, local calendar horizon, service composition and IANA timezone conversion. Internal buffers between consecutive services are preserved once: 30+5+5 followed by 20+5+5 yields 70 occupied minutes and 60 visible minutes.

Unit coverage proves 24:00 handling, date-30/date-31 horizon boundary, ambiguous and nonexistent DST rejection, deterministic comparison, and integer load comparison without floating-point ratios.

