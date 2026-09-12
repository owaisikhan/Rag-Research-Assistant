-- Give back a rate-limit slot that bought nothing.
--
-- check_rate_limit spends atomically, which it must: two simultaneous requests
-- would otherwise both read "11 used" and both proceed. The cost of that is
-- that a request dying AFTER the spend -- the daily model quota is gone,
-- retrieval failed -- still costs the visitor one of their twelve. Twelve
-- failures in a row and the hour is spent with nothing to show for it.
--
-- Deletes the caller's most recent hit only, so a refund can never take back
-- more than the request that called it spent.

create or replace function refund_rate_limit (caller text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  victim bigint;
begin
  select id into victim
    from rate_limit_hits
   where caller_hash = caller
   order by occurred_at desc
   limit 1;

  if victim is null then
    return false;
  end if;

  delete from rate_limit_hits where id = victim;
  return true;
end;
$$;

revoke all   on function refund_rate_limit(text) from public;
grant execute on function refund_rate_limit(text) to anon, authenticated;
