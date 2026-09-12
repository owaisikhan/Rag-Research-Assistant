-- A half-indexed document must not be searchable.
--
-- Vercel TERMINATES a function that exceeds its duration -- it does not restart
-- or retry it -- so whatever was already written stays written. For an upload
-- that means the document row and some of its chunks survive, while
-- finish_upload never runs and the real content_hash is never committed.
--
-- session_documents already hid such a document from the visitor's own list.
-- match_chunks did not, so the passages that DID land stayed retrievable: the
-- visitor is told the upload failed, and then gets answers cited to a document
-- they were told does not exist, built on whatever fraction of it happened to
-- be indexed. Silently partial context is worse than none, because nothing
-- about the answer looks wrong.
--
-- Measured before the fix, not assumed: a single planted half-indexed passage
-- came back as the NUMBER ONE result for its own subject, at double the score
-- of anything else.
--
-- The `pending:` sentinel already marks these. Retrieval just has to respect
-- it -- one line in the `visible` CTE.

create or replace function match_chunks (
  query_embedding vector(1536),
  query_text      text,
  match_count     integer default 12,
  pool_size       integer default 40,
  rrf_k           integer default 60,
  per_document    integer default 3,
  p_session       uuid    default null
)
returns table (
  chunk_id bigint, document_id uuid, content text, section text,
  page_start integer, page_end integer, title text, authors text[],
  source_url text, kind text, is_upload boolean, score double precision
)
language sql stable security definer set search_path = public, extensions
as $$
  with visible as (
    select c.id, c.embedding, c.fts, c.document_id
    from chunks c
    join documents d on d.id = c.document_id
    where d.content_hash not like 'pending:%'
      and (
        d.session_id is null
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

-- An interrupted upload should be retryable rather than counting against the
-- visitor's three-document allowance forever, and should not sit around for a
-- full day. Ten minutes is far longer than any successful upload takes.
create or replace function purge_expired_uploads ()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  removed integer;
begin
  delete from documents
   where session_id is not null
     and (
       (expires_at is not null and expires_at < now())
       or (content_hash like 'pending:%' and ingested_at < now() - interval '10 minutes')
     );
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- Raised from 60 now that the duration ceiling is understood correctly.
-- Vercel allows 300s on Hobby with fluid compute, and a 100-page document is
-- ~210 chunks -- about 126 seconds at the free tier's 100 embeddings/minute.
create or replace function upload_limits ()
returns table (max_documents_per_session integer, max_pages integer, lifetime_hours integer)
language sql immutable as $$ select 3, 100, 24 $$;
