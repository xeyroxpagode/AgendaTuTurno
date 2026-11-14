# API and authorization report

Fastify exposes configuration, exceptions, public search, self search, impact preview and conflict reads. Claim/Release/Replace remain internal typed functions. Owner has management/read/impact; Reception has read/impact but no management; Barber has only self read.

API integration proves Owner and Reception reads, Barber management-read denial, Reception mutation denial, Barber self authority, Barber impact denial, and public missing-policy fail-closed behavior without SQL leakage. Direct anonymous table reads fail with PostgreSQL `42501`.

