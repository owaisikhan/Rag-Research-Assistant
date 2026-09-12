-- Visitor uploads.
--
-- THE PROBLEM THIS SOLVES FIRST IS PRIVACY, NOT PLUMBING.
--
-- The anon key is public by design -- it ships to every browser. So "filter by
-- session in the application" is not isolation: anyone can take that key and
-- query /rest/v1/documents directly for every row, including other visitors'
-- uploaded files. A contract, a medical letter, a draft nobody meant to share.
--
-- So RLS is tightened to expose ONLY the public demo corpus (session_id is
-- null) to direct table reads, and everything session-scoped goes through
-- SECURITY DEFINER functions that take the session id and enforce the filter
-- themselves. The session id lives in an httpOnly cookie: unguessable, and not
-- readable by scripts on the page.

alter table documents
  add column session_id uuid,
  add column expires_at timestamptz;

-- Null session_id is the curated demo corpus; non-null is one visitor's
-- private upload. Partial index because the demo corpus is read on every
-- query and uploads are comparatively rare.
create index documents_session_idx on documents (session_id) where session_id is not null;
create index documents_expiry_idx  on documents (expires_at) where expires_at is not null;

-- ------------------------------------------------------------------- RLS

drop policy if exists "documents are publicly readable" on documents;
drop policy if exists "chunks are publicly readable"    on chunks;

create policy "the demo corpus is publicly readable"
  on documents for select to anon, authenticated
  using (session_id is null);

create policy "demo corpus chunks are publicly readable"
  on chunks for select to anon, authenticated
  using (exists (
    select 1 from documents d
    where d.id = chunks.document_id and d.session_id is null
  ));

-- --------------------------------------------------------------- limits

-- Deliberately small. Every chunk is an embedding request against a metered
-- quota, and the demo exists to show the idea, not to host a library.
create or replace function upload_limits ()
returns table (max_documents_per_session integer, max_pages integer, lifetime_hours integer)
language sql immutable as $$ select 3, 60, 24 $$;

-- ------------------------------------------------------------- lifecycle

-- Opportunistic purge. Keeps expired uploads from accumulating without
-- needing a scheduled job on a free-tier project.
create or replace function purge_expired_uploads ()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  removed integer;
begin
  delete from documents
   where session_id is not null
     and expires_at is not null
     and expires_at < now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

/**
 * Reserve a document row for an upload.
 *
 * Returns the new document id, or raises if the session is at its limit. The
 * content_hash is written as a `pending:` sentinel, exactly as the ingestion
 * script does -- a failure partway through chunk insertion must leave a row
 * that can never be mistaken for complete.
 */
create or replace function begin_upload (
  p_session         uuid,
  p_title           text,
  p_file_name       text,
  p_page_count      integer,
  p_content_hash    text,
  p_embedding_model text
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  limits    record;
  used      integer;
  new_id    uuid;
begin
  if p_session is null then
    raise exception 'An upload must belong to a session';
  end if;

  perform purge_expired_uploads();

  select * into limits from upload_limits();

  if p_page_count > limits.max_pages then
    raise exception 'That document is % pages; the limit is %', p_page_count, limits.max_pages;
  end if;

  select count(*) into used
    from documents
   where session_id = p_session;

  if used >= limits.max_documents_per_session then
    raise exception 'You have reached the limit of % uploaded documents', limits.max_documents_per_session;
  end if;

  insert into documents (
    source_id, title, file_name, page_count, kind,
    content_hash, embedding_model, session_id, expires_at
  ) values (
    'upload:' || p_session::text || ':' || p_content_hash,
    p_title, p_file_name, p_page_count, 'document',
    'pending:' || p_content_hash, p_embedding_model, p_session,
    now() + (limits.lifetime_hours || ' hours')::interval
  )
  returning id into new_id;

  return new_id;
end;
$$;

/**
 * Add chunks to an upload.
 *
 * Refuses any document that is not session-scoped, so this can never be used
 * to inject passages into the curated demo corpus -- which would otherwise be
 * a way to put words in the assistant's mouth for every other visitor.
 */
-- NOTE the search_path. This function casts to vector(1536), and pgvector is
-- installed in the `extensions` schema, so pinning to `public` alone makes the
-- type unresolvable and every upload fails with "type vector does not exist".
-- Same trap recorded in 003 for match_chunks.
create or replace function add_upload_chunks (
  p_session  uuid,
  p_document uuid,
  p_chunks   jsonb
)
returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare
  inserted integer;
begin
  if not exists (
    select 1 from documents
     where id = p_document and session_id = p_session and session_id is not null
  ) then
    raise exception 'Unknown document for this session';
  end if;

  insert into chunks (
    document_id, chunk_index, content, token_count,
    section, page_start, page_end, embedding
  )
  select
    p_document,
    (value->>'chunk_index')::integer,
    value->>'content',
    (value->>'token_count')::integer,
    value->>'section',
    (value->>'page_start')::integer,
    (value->>'page_end')::integer,
    (value->>'embedding')::vector(1536)
  from jsonb_array_elements(p_chunks);

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

/** Commit the real hash once the chunks are stored and counted. */
create or replace function finish_upload (
  p_session      uuid,
  p_document     uuid,
  p_content_hash text
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  stored integer;
begin
  select count(*) into stored from chunks where document_id = p_document;

  if stored = 0 then
    raise exception 'No passages were stored for that document';
  end if;

  update documents
     set content_hash = p_content_hash
   where id = p_document and session_id = p_session;

  return stored;
end;
$$;

/** What this session has uploaded, for the UI. */
create or replace function session_documents (p_session uuid)
returns table (
  id          uuid,
  title       text,
  file_name   text,
  page_count  integer,
  chunk_count integer,
  expires_at  timestamptz
)
language sql stable security definer set search_path = public
as $$
  select
    d.id, d.title, d.file_name, d.page_count,
    (select count(*)::integer from chunks c where c.document_id = d.id),
    d.expires_at
  from documents d
  where d.session_id = p_session
    and d.content_hash not like 'pending:%'
  order by d.ingested_at desc;
$$;

/** Let a visitor remove their own uploads. */
create or replace function delete_session_document (p_session uuid, p_document uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  removed integer;
begin
  delete from documents
   where id = p_document and session_id = p_session and session_id is not null;
  get diagnostics removed = row_count;
  return removed > 0;
end;
$$;

-- ---------------------------------------------------------- retrieval

-- Now SECURITY DEFINER, because RLS deliberately hides session-scoped rows
-- from direct reads. The function is the only path to them, and it always
-- constrains to the demo corpus plus the caller's OWN session.
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
    where d.session_id is null
       or (p_session is not null and d.session_id = p_session)
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
    where query_text is not null
      and query_text <> ''
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

-- The previous six-argument signature must go, or a call that omits
-- p_session matches both and Postgres refuses to choose.
drop function if exists public.match_chunks (vector, text, integer, integer, integer, integer);

-- corpus_stats must not count uploads as part of the public library.
create or replace function corpus_stats ()
returns table (document_count integer, chunk_count integer, page_count integer, kinds jsonb)
language sql stable set search_path = public, extensions
as $$
  select
    (select count(*)::integer from documents where session_id is null),
    (select count(*)::integer from chunks c
       join documents d on d.id = c.document_id where d.session_id is null),
    (select coalesce(sum(page_count), 0)::integer from documents where session_id is null),
    (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb)
       from (select kind, count(*)::integer as n from documents
              where session_id is null group by kind) k);
$$;

-- ---------------------------------------------------------------- grants

revoke all on function begin_upload(uuid, text, text, integer, text, text) from public;
revoke all on function add_upload_chunks(uuid, uuid, jsonb) from public;
revoke all on function finish_upload(uuid, uuid, text) from public;
revoke all on function session_documents(uuid) from public;
revoke all on function delete_session_document(uuid, uuid) from public;
revoke all on function purge_expired_uploads() from public;

grant execute on function begin_upload(uuid, text, text, integer, text, text) to anon, authenticated;
grant execute on function add_upload_chunks(uuid, uuid, jsonb) to anon, authenticated;
grant execute on function finish_upload(uuid, uuid, text) to anon, authenticated;
grant execute on function session_documents(uuid) to anon, authenticated;
grant execute on function delete_session_document(uuid, uuid) to anon, authenticated;
grant execute on function upload_limits() to anon, authenticated;
