-- Knowledge base: documents, their chunks, and hybrid retrieval.
--
-- Two design decisions worth stating, because they are expensive to reverse:
--
-- 1. Citation metadata lives on the chunk, not the document. An answer cites a
--    passage on a page, not a file. page_start/page_end/section are therefore
--    NOT NULL-able conveniences -- they are the product.
--
-- 2. Retrieval is hybrid. Vector search alone loses exact terms (a CVE id, an
--    error string, a surname); full-text search alone loses paraphrase. Both
--    are run and fused with Reciprocal Rank Fusion in match_chunks().

create extension if not exists vector;

-- ---------------------------------------------------------------- documents

create table documents (
  id             uuid primary key default gen_random_uuid(),

  -- Stable identity from the source, so re-ingesting the same file updates
  -- rather than duplicates. arXiv id, or a hash of the origin URL.
  source_id      text not null unique,

  title          text not null,
  authors        text[]      not null default '{}',
  published_on   date,
  source_url     text,
  file_name      text        not null,
  page_count     integer,

  -- What kind of document this is, so the UI can group a mixed corpus.
  kind           text        not null default 'document'
                 check (kind in ('paper','report','manual','filing','standard','document')),

  -- Licence is tracked because this corpus is public and redistributed.
  licence        text,

  -- Hash of the extracted text. Re-ingestion compares this and skips unchanged
  -- files, which is what makes "add more PDFs later" cheap instead of a rebuild.
  content_hash   text        not null,

  -- Which embedding model produced this document's vectors. Mixing models in
  -- one index silently destroys retrieval, so ingestion refuses on mismatch.
  embedding_model text       not null,

  ingested_at    timestamptz not null default now()
);

create index documents_kind_idx on documents (kind);

-- ------------------------------------------------------------------- chunks

create table chunks (
  id            bigint generated always as identity primary key,
  document_id   uuid    not null references documents (id) on delete cascade,

  chunk_index   integer not null,
  content       text    not null,
  token_count   integer not null,

  -- Citation payload. section is the nearest enclosing heading, so a source
  -- can be shown as "Methodology, p. 7" rather than a naked page number.
  section       text,
  page_start    integer not null,
  page_end      integer not null,

  embedding     vector(1536),

  -- Generated, so it can never drift from content.
  fts           tsvector generated always as (to_tsvector('english', content)) stored,

  unique (document_id, chunk_index),
  check (page_end >= page_start)
);

-- HNSW beats IVFFlat here: this corpus is rebuilt rarely and queried often,
-- and HNSW needs no training step or list-count tuning as the corpus grows.
create index chunks_embedding_idx on chunks
  using hnsw (embedding vector_cosine_ops);

create index chunks_fts_idx      on chunks using gin (fts);
create index chunks_document_idx on chunks (document_id);

-- -------------------------------------------------------- hybrid retrieval

-- Runs vector and full-text search independently, then fuses them with
-- Reciprocal Rank Fusion: score = sum over both lists of 1 / (k + rank).
--
-- RRF is used rather than a weighted score blend because cosine distance and
-- ts_rank are not on comparable scales -- any fixed weighting between them is
-- a magic number that stops being right when the corpus changes. Ranks are
-- always comparable.
create or replace function match_chunks (
  query_embedding vector(1536),
  query_text      text,
  match_count     integer default 12,
  -- Pool size per strategy before fusion. Larger = better recall, slower.
  pool_size       integer default 40,
  -- RRF damping. 60 is the value from the original RRF paper.
  rrf_k           integer default 60
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
  )
  select
    c.id,
    c.document_id,
    c.content,
    c.section,
    c.page_start,
    c.page_end,
    d.title,
    d.authors,
    d.source_url,
    d.kind,
    f.score
  from fused f
  join chunks    c on c.id = f.id
  join documents d on d.id = c.document_id
  order by f.score desc
  limit match_count;
$$;

-- ------------------------------------------------------------ corpus stats

-- Aggregated in the database rather than the browser, so every screen that
-- shows "N documents, M passages" reads the same number from one place.
create or replace function corpus_stats ()
returns table (
  document_count integer,
  chunk_count    integer,
  page_count     integer,
  kinds          jsonb
)
language sql
stable
as $$
  select
    (select count(*)::integer from documents),
    (select count(*)::integer from chunks),
    (select coalesce(sum(page_count), 0)::integer from documents),
    (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb)
       from (select kind, count(*)::integer as n from documents group by kind) k);
$$;

-- ---------------------------------------------------------------------- RLS
--
-- The corpus is public and read-only to the world. Every write goes through
-- the ingestion script using the service-role key, which bypasses RLS. There
-- is deliberately no anon write path -- visitors cannot upload.

alter table documents enable row level security;
alter table chunks    enable row level security;

create policy "documents are publicly readable"
  on documents for select to anon, authenticated using (true);

create policy "chunks are publicly readable"
  on chunks for select to anon, authenticated using (true);
