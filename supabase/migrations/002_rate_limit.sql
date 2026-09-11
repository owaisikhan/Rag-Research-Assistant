-- Rate limiting for the public demo.
--
-- In-memory counters do not work here: every Vercel function instance would
-- keep its own, so the real limit becomes (limit x instances) and a burst
-- walks straight past it. The counter has to live where the instances agree,
-- which is the database.
--
-- Callers are identified by a SALTED HASH of their IP, never the IP itself.
-- The demo has no reason to be able to reconstruct a visitor's address, and
-- storing one would make this a personal-data processor for no benefit.

create table rate_limit_hits (
  id          bigint generated always as identity primary key,
  caller_hash text        not null,
  occurred_at timestamptz not null default now()
);

create index rate_limit_hits_lookup_idx
  on rate_limit_hits (caller_hash, occurred_at desc);

-- SECURITY DEFINER so anonymous visitors can spend against their own quota
-- without being able to read, edit or delete the table that records it.
create or replace function check_rate_limit (
  caller        text,
  max_per_hour  integer default 12
)
returns table (allowed boolean, remaining integer, resets_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  window_start timestamptz := now() - interval '1 hour';
  used         integer;
  oldest       timestamptz;
begin
  -- Opportunistic cleanup. Cheap, and it keeps the table from growing without
  -- needing a scheduled job on a free-tier project.
  delete from rate_limit_hits where occurred_at < now() - interval '2 hours';

  select count(*), min(occurred_at)
    into used, oldest
    from rate_limit_hits
   where caller_hash = caller
     and occurred_at >= window_start;

  if used >= max_per_hour then
    return query select false, 0, oldest + interval '1 hour';
    return;
  end if;

  insert into rate_limit_hits (caller_hash) values (caller);

  return query select
    true,
    (max_per_hour - used - 1),
    coalesce(oldest, now()) + interval '1 hour';
end;
$$;

alter table rate_limit_hits enable row level security;
-- No policies: the table is reachable only through check_rate_limit().

revoke all on function check_rate_limit(text, integer) from public;
grant execute on function check_rate_limit(text, integer) to anon, authenticated;
