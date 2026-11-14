# ANY barber report

ANY first filters eligibility and actual availability. It then compares confirmed reservation minutes divided by effective daily capacity using integer cross multiplication. Capacity zero is ineligible. Equal fractions use a stable SHA-256 tie-break over Business/date/start/Staff, so retries do not oscillate.

Tests cover unequal capacities, equal proportional load, occupied candidates, deterministic ties, and final resolution inside Claim rather than trusting Quote.

