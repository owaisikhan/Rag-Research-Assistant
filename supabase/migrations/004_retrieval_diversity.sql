-- Cap how many passages one document may contribute to a single answer.
--
-- Observed against the real corpus: a comparative question ("what risks do
-- these papers identify, and how do they differ?") returned five of eight
-- passages from one paper. The answer built from that is lopsided by
-- construction -- it cannot compare sources it was never shown, and it will
-- still sound confident, because nothing in the context hints that other
-- documents had anything to say.
--
-- This is the cheap half of what MMR does: rank within each document, keep the
-- best few, then take the global top N. It costs one window function and no
-- extra round trip, and it only ever changes results that were dominated.

-- Adding a parameter does NOT replace a function: the signature differs, so
-- `create or replace` leaves the old arity behind as an overload. A call
-- supplying only the first three arguments then matches both, and Postgres
-- refuses with "could not choose the best candidate function". Drop it first.
drop function if exists public.match_chunks (vector, text, integer, integer, integer);

create or replace function match_chunks (
  query_embedding vector(1536),
  query_text      text,
  match_count     integer default 12,
  pool_size       integer default 40,
  rrf_k           integer default 60,
  -- 3 leaves room for a document to make a point across two or three passages
  -- without letting one crowd out every other source.
  per_document    integer default 3
)
returns table (
  chunk_id     bigint,
  document_id  uuid,
  content      text,
  section      text,
  page_start   integer,
  page_end     integer,
  title        text,
  authors      text[],
  source_url   text,
  kind         text,
  score        double precision
)
language sql
stable
set search_path = public, extensions
as $$
  with semantic as (
    select
      c.id,
      row_number() over (order by c.embedding <=> query_embedding) as rank
    from chunks c
    where c.embedding is not null
    order by c.embedding <=> query_embedding
    limit pool_size
  ),
  keyword as (
    select
      c.id,
      row_number() over (
        order by ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) desc
      ) as rank
    from chunks c
    where query_text is not null
      and query_text <> ''
      and c.fts @@ websearch_to_tsquery('english', query_text)
    limit pool_size
  ),
  fused as (
    select
      coalesce(s.id, k.id) as id,
      coalesce(1.0 / (rrf_k + s.rank), 0.0)
        + coalesce(1.0 / (rrf_k + k.rank), 0.0) as score
    from semantic s
    full outer join keyword k on k.id = s.id
  ),
  ranked as (
    select
      c.id           as chunk_id,
      c.document_id,
      c.content,
      c.section,
      c.page_start,
      c.page_end,
      d.title,
      d.authors,
      d.source_url,
      d.kind,
      f.score,
      row_number() over (
        partition by c.document_id order by f.score desc
      ) as rank_within_document
    from fused f
    join chunks    c on c.id = f.id
    join documents d on d.id = c.document_id
  )
  select
    chunk_id, document_id, content, section, page_start, page_end,
    title, authors, source_url, kind, score
  from ranked
  where rank_within_document <= per_document
  order by score desc
  limit match_count;
$$;
