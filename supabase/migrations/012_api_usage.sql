-- What this app has spent against the model provider.
--
-- WHY THIS EXISTS. Gemini has no "how much is left" endpoint. The only signal
-- the free tier gives is a 429 once the allowance is already gone, which is
-- how this project kept discovering the daily cap: a feature would stop
-- working mid-test and the cause was invisible until someone read a server
-- log. A ledger the app writes itself is the only way to see the spend before
-- it becomes a wall.
--
-- It is a LEDGER, not a quota check. The provider's count is authoritative and
-- this one will drift from it -- a request that fails after the provider
-- counted it, a key used from somewhere else, a reset boundary on Google's
-- clock rather than ours. It is for seeing the shape of consumption, not for
-- gating on.

create table api_usage (
  id          bigint generated always as identity primary key,
  provider    text        not null,
  -- 'embedding' and 'generation' are metered SEPARATELY by Gemini, with
  -- different daily allowances, so they are never summed into one number.
  kind        text        not null check (kind in ('embedding', 'generation')),
  -- Requests as the provider counts them. For embeddings each TEXT counts as
  -- one request even when a hundred are sent in a single HTTP call, which is
  -- the detail that makes a 100-page upload cost 200+ against the daily 1000.
  units       integer     not null check (units >= 0),
  tokens_in   integer     not null default 0,
  tokens_out  integer     not null default 0,
  occurred_at timestamptz not null default now()
);

create index api_usage_recent_idx on api_usage (occurred_at desc);

alter table api_usage enable row level security;
-- No policies: reachable only through the functions below.

/**
 * Record one call's cost. Never throws in the caller's path -- see usage.js.
 */
create or replace function record_api_usage (
  p_provider   text,
  p_kind       text,
  p_units      integer,
  p_tokens_in  integer default 0,
  p_tokens_out integer default 0
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- Opportunistic pruning. Thirty days is more history than a demo needs and
  -- keeps the table from growing without a scheduled job.
  delete from api_usage where occurred_at < now() - interval '30 days';

  insert into api_usage (provider, kind, units, tokens_in, tokens_out)
  values (p_provider, p_kind, greatest(p_units, 0), greatest(p_tokens_in, 0), greatest(p_tokens_out, 0));
end;
$$;

/**
 * Today's spend, and the last hour's, per kind.
 *
 * "Today" is UTC. Google's daily quotas reset on Pacific time, so this will
 * disagree with the provider's own reckoning for part of each day -- stated
 * here rather than left as a puzzle for whoever notices the numbers drifting.
 */
create or replace function api_usage_summary ()
returns table (
  kind          text,
  units_today   integer,
  units_hour    integer,
  tokens_today  bigint,
  calls_today   integer
)
language sql stable security definer set search_path = public
as $$
  select
    k.kind,
    coalesce(sum(u.units) filter (where u.occurred_at >= date_trunc('day', now())), 0)::integer,
    coalesce(sum(u.units) filter (where u.occurred_at >= now() - interval '1 hour'), 0)::integer,
    coalesce(sum(u.tokens_in + u.tokens_out) filter (where u.occurred_at >= date_trunc('day', now())), 0)::bigint,
    coalesce(count(u.id) filter (where u.occurred_at >= date_trunc('day', now())), 0)::integer
  from (values ('embedding'), ('generation')) as k(kind)
  left join api_usage u on u.kind = k.kind
  group by k.kind
  order by k.kind;
$$;

revoke all   on function record_api_usage(text, text, integer, integer, integer) from public;
revoke all   on function api_usage_summary() from public;
grant execute on function record_api_usage(text, text, integer, integer, integer) to anon, authenticated;
grant execute on function api_usage_summary() to anon, authenticated;
