-- WP-08 · M4b — Campos temporales LOCALES persistidos de la sesión.
-- La entrada local (+ timezone) es la que permite detectar DST y reconstruir
-- la reprogramación. Derivar el minuto local desde un timestamptz es incorrecto.
alter table courses.course_sessions
  add column if not exists local_start_minute integer,
  add column if not exists duration_minutes integer;

alter table courses.course_sessions
  add constraint course_sessions_local_minute_check
  check (local_start_minute is null or (local_start_minute between 0 and 1439));

alter table courses.course_sessions
  add constraint course_sessions_duration_check
  check (duration_minutes is null or (duration_minutes between 15 and 480));
