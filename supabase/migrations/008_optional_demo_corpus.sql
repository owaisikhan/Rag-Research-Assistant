-- Make the curated demo corpus optional at query time.
--
-- Applied to the database before this file existed; written down afterwards so
-- a fresh project built from these migrations matches production. If you are
-- rebuilding from scratch, this is a no-op beyond the new argument.
--
-- The corpus is switched off with INCLUDE_DEMO_CORPUS=false rather than
-- deleted, because deleting it throws away several hundred embeddings that
-- cost real quota to regenerate. Off is reversible; deleted is not.

create or replace function match_chunks (
  query_embedding vector(1536),
  query_text      text,
  match_count     integer default 12,
  pool_size       integer default 40,
  rrf_k           integer default 60,
  per_document    integer default 3,
  p_session       uuid    default null,
  include_demo    boolean default true
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
  is_upload    boolean,
  score        double precision
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with visible as (
    select c.id, c.embedding, c.fts, c.document_id
    from chunks c
    join documents d on d.id = c.document_id
    -- A half-indexed upload must never be searchable: its chunks exist but
    -- the document is incomplete, and a partial passage outranking a whole
    -- one is the kind of wrong that looks right.
    where d.content_hash not like 'pending:%'
      and (
        (include_demo and d.session_id is null)
        or (p_session is not null and d.session_id = p_session)
      )
  ),
  semantic as (
    select v.id, row_number() over (order by v.embedding <=> query_embedding) as rank
    from visible v
    where v.embedding is not null
    order by v.embedding <=> query_embedding
    limit pool_size
  ),
  keyword as (
    select
      v.id,
      row_number() over (
        order by ts_rank_cd(v.fts, websearch_to_tsquery('english', query_text)) desc
      ) as rank
    from visible v
    where query_text is not null and query_text <> ''
      and v.fts @@ websearch_to_tsquery('english', query_text)
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
      c.id as chunk_id, c.document_id, c.content, c.section,
      c.page_start, c.page_end,
      d.title, d.authors, d.source_url, d.kind,
      (d.session_id is not null) as is_upload,
      f.score,
      row_number() over (partition by c.document_id order by f.score desc) as rank_within_document
    from fused f
    join chunks    c on c.id = f.id
    join documents d on d.id = c.document_id
  )
  select
    chunk_id, document_id, content, section, page_start, page_end,
    title, authors, source_url, kind, is_upload, score
  from ranked
  order by
    (case when rank_within_document <= per_document then 0 else 1 end),
    score desc
  limit match_count;
$$;

-- The seven-argument signature must go, or a call omitting include_demo
-- matches both and Postgres refuses to choose.
drop function if exists public.match_chunks (vector, text, integer, integer, integer, integer, uuid);
