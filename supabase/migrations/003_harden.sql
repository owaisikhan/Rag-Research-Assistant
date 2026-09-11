-- Hardening, from the findings of Supabase's database linter.
--
-- A separate migration rather than an edit to 001/002: those have been applied,
-- and an applied migration is never edited -- a fresh clone and a live database
-- must reach the same state by running the same files in the same order.

-- ---------------------------------------------------------- search_path
--
-- Finding: `function_search_path_mutable` on match_chunks and corpus_stats.
--
-- A function without a fixed search_path resolves unqualified names against
-- whatever the CALLER's search_path happens to be. Anyone able to create an
-- object in a schema earlier in that path can shadow a table or operator the
-- function relies on.
--
-- NOTE the `extensions` in the path. pgvector is installed there (Supabase
-- convention), so pinning these functions to `public` alone would leave the
-- `<=>` cosine-distance operator unresolvable and break retrieval entirely.
-- This is the trap in the obvious fix.

alter function match_chunks (vector, text, integer, integer, integer)
  set search_path = public, extensions;

alter function corpus_stats ()
  set search_path = public, extensions;

-- ------------------------------------------------- caller-supplied ceiling
--
-- Finding: `anon_security_definer_function_executable` on check_rate_limit.
--
-- Anonymous execution is INTENTIONAL -- a visitor with no account has to be
-- able to spend against their own quota. What was not intentional is that
-- `max_per_hour` arrived from the caller. The app always passes the configured
-- value, but the anon key is public by design, so the RPC is reachable
-- directly at /rest/v1/rpc/check_rate_limit with any value at all.
--
-- Clamped in the function, where a caller cannot reach it.

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
  -- Never trust a limit that arrived over the wire.
  effective    integer     := least(greatest(coalesce(max_per_hour, 12), 1), 60);
  used         integer;
  oldest       timestamptz;
begin
  delete from rate_limit_hits where occurred_at < now() - interval '2 hours';

  select count(*), min(occurred_at)
    into used, oldest
    from rate_limit_hits
   where caller_hash = caller
     and occurred_at >= window_start;

  if used >= effective then
    return query select false, 0, oldest + interval '1 hour';
    return;
  end if;

  insert into rate_limit_hits (caller_hash) values (caller);

  return query select
    true,
    (effective - used - 1),
    coalesce(oldest, now()) + interval '1 hour';
end;
$$;

revoke all on function check_rate_limit(text, integer) from public;
grant execute on function check_rate_limit(text, integer) to anon, authenticated;

-- ------------------------------------------------------------ not a finding
--
-- The linter also reports `rls_enabled_no_policy` on rate_limit_hits (INFO).
-- That is deliberate and must stay: RLS enabled with no policy denies every
-- direct read and write, which is exactly the intent. The table is reachable
-- only through check_rate_limit(), so a visitor can spend their own quota
-- without being able to read, edit or delete the record of it.
