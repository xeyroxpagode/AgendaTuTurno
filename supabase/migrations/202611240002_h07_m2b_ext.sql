-- WP-05 / M2b — H07-EXT sobre la Agenda canónica.
--
-- (1) Integridad diferida Allocation -> CourseSession. Se crea AQUÍ, antes de
--     que exista `courses.course_sessions`, usando to_regclass para no fallar
--     en instalación limpia. La invariante queda instalada desde M2b.
-- (2) Integridad diferida CourseSession -> Allocation (la usa M4 al crear la
--     tabla). Misma guard por Business, mismo EXCLUDE GiST, mismos `[inicio,fin)`.
-- (3) Matriz de ausencia ÚNICA: `team.staff_effective_unavailability` ya es la
--     tabla canónica; la función expuesta aquí es la única regla de impacto
--     para RESERVATION y COURSE_SESSION (la app la reutiliza en ambos paths).

create schema if not exists courses;

create or replace function availability.assert_course_allocation_integrity()
returns trigger language plpgsql as $$
begin
  if new.source_type = 'COURSE_SESSION' and new.status = 'ACTIVE' then
    if to_regclass('courses.course_sessions') is not null then
      if not exists (
        select 1 from courses.course_sessions s
        where s.id = new.source_id
          and s.business_id = new.business_id
          and s.instructor_staff_member_id = new.staff_member_id
          and s.status in ('CONFIRMED', 'RESCHEDULED')
      ) then
        raise exception 'COURSE_SESSION allocation has no confirmed session'
          using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists course_allocation_integrity on availability.resource_allocations;
create constraint trigger course_allocation_integrity
  after insert or update on availability.resource_allocations
  deferrable initially deferred
  for each row execute function availability.assert_course_allocation_integrity();

-- Integridad inversa: una sesión CONFIRMED/RESCHEDULED debe tener exactamente
-- una ocupación ACTiva de su mismo profesional e intervalo. La adjunta M4 al
-- crear `courses.course_sessions`; definirla aquí respeta el orden M2 -> M2b
-- -> M3/M4 sin perder la invariante.
create or replace function courses.assert_session_allocation_integrity()
returns trigger language plpgsql as $$
begin
  if new.status in ('CONFIRMED', 'RESCHEDULED') then
    if not exists (
      select 1 from availability.resource_allocations a
      where a.business_id = new.business_id
        and a.source_type = 'COURSE_SESSION'
        and a.source_id = new.id
        and a.staff_member_id = new.instructor_staff_member_id
        and a.status = 'ACTIVE'
        and a.occupied_start_at = new.occupied_start_at
        and a.occupied_end_at = new.occupied_end_at
    ) then
      raise exception 'CONFIRMED session without active allocation'
        using errcode = '23514';
    end if;
  elsif new.status in ('SCHEDULED', 'CANCELLED', 'COMPLETED') then
    if exists (
      select 1 from availability.resource_allocations a
      where a.business_id = new.business_id
        and a.source_type = 'COURSE_SESSION'
        and a.source_id = new.id
        and a.status = 'ACTIVE'
    ) then
      raise exception 'Non-active session retains an active allocation'
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- Unica matriz de impacto de ausencias. Devuelve TODO intervalo effectivo
-- (APPLIED_ABSENCE u OPERATIONAL_BLOCK) que solape la sesión propuesta.
create or replace function availability.course_session_absence_conflicts(
  p_business_id uuid,
  p_staff_member_id uuid,
  p_local_date date,
  p_start_minute integer,
  p_end_minute integer
) returns table (id uuid, reason_code text, local_date date)
language sql stable as $$
  select u.id, u.source_type::text, u.local_date
  from team.staff_effective_unavailability u
  where u.business_id = p_business_id
    and u.staff_member_id = p_staff_member_id
    and u.released_at is null
    and u.local_date = p_local_date
    and u.start_minute < p_end_minute
    and p_start_minute < u.end_minute;
$$;

revoke all on function availability.assert_course_allocation_integrity() from public, anon, authenticated;
grant execute on function availability.assert_course_allocation_integrity() to service_role;
revoke all on function availability.course_session_absence_conflicts(uuid, uuid, date, integer, integer) from public, anon, authenticated;
grant execute on function availability.course_session_absence_conflicts(uuid, uuid, date, integer, integer) to service_role;
revoke all on function courses.assert_session_allocation_integrity() from public, anon, authenticated;
grant execute on function courses.assert_session_allocation_integrity() to service_role;
