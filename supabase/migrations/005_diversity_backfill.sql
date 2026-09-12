-- Make the per-document cap a PREFERENCE, not a hard filter.
--
-- Measured against the real corpus: asking for 8 passages about zero trust
-- returned 3. Only one document in the library covers the subject, so the cap
-- discarded five relevant passages and replaced them with nothing. The cap
-- exists to stop one document crowding out OTHERS -- when there are no others,
-- it is pure loss, and the answer gets less to work with precisely when the
-- corpus has one clear best source.
--
-- Within-cap passages now rank first (by score) and any remaining slots are
-- backfilled from over-cap passages (also by score). A comparative question
-- still gets breadth; a narrow question gets its depth back.
--
-- Only the final ORDER BY changes; the rest is identical to 004.

create or replace function match_chunks (
  query_embedding vector(1536),
  query_text      text,
  match_count     integer default 12,
  pool_size       integer default 40,
  rrf_k           integer default 60,
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
  order by
    -- Diverse results first, then backfill rather than return fewer.
    (case when rank_within_document <= per_document then 0 else 1 end),
    score desc
  limit match_count;
$$;
