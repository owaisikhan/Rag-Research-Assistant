-- Index a long document across several requests instead of one.
--
-- THE PROBLEM. Embedding is paced by the provider (about 95 texts a minute on
-- the free tier), and a single serverless request has a fixed duration. Those
-- two numbers multiply out to roughly 313 passages per upload, so a document
-- larger than that was refused outright -- with a sentence explaining what
-- would fit, which is honest but not useful when the answer is "your document".
--
-- THE FIX. Nothing about the pacing changes; the work is split across requests
-- rather than crammed into one. Extraction and chunking are local and free, so
-- ALL passages are stored on the first request with no embedding. Each
-- subsequent pass embeds as many as its budget allows. The document keeps its
-- `pending:` hash throughout, which already excludes it from retrieval, so a
-- half-indexed document is never searchable -- the property that makes this
-- safe was built for timeouts and works unchanged here.
--
-- WHAT THIS DOES NOT FIX. The provider's DAILY allowance. Splitting the work
-- does not reduce it: a 450-page document is about 985 passages however many
-- requests deliver them, against a free-tier ceiling of 1,000 a day.

/**
 * Store passages without embeddings.
 *
 * Same ownership check as add_upload_chunks: refuses any document that is not
 * session-scoped, so this cannot be used to inject passages into the curated
 * corpus.
 */
create or replace function add_upload_chunks_unembedded (
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
    document_id, chunk_index, content, token_count, section, page_start, page_end
  )
  select
    p_document,
    (value->>'chunk_index')::integer,
    value->>'content',
    (value->>'token_count')::integer,
    value->>'section',
    (value->>'page_start')::integer,
    (value->>'page_end')::integer
  from jsonb_array_elements(p_chunks);

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

/** The next passages still needing an embedding, in reading order. */
create or replace function next_unembedded_chunks (
  p_session  uuid,
  p_document uuid,
  p_limit    integer default 300
)
returns table (id bigint, content text)
language sql stable security definer set search_path = public
as $$
  select c.id, c.content
  from chunks c
  join documents d on d.id = c.document_id
  where d.id = p_document
    and d.session_id = p_session
    and d.session_id is not null
    and c.embedding is null
  order by c.chunk_index
  limit p_limit;
$$;

/** Fill in embeddings for passages of this session's own document. */
create or replace function set_chunk_embeddings (
  p_session  uuid,
  p_document uuid,
  p_rows     jsonb
)
returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare
  updated integer;
begin
  if not exists (
    select 1 from documents
     where id = p_document and session_id = p_session and session_id is not null
  ) then
    raise exception 'Unknown document for this session';
  end if;

  update chunks c
     set embedding = (r.value->>'embedding')::vector(1536)
    from jsonb_array_elements(p_rows) r
   where c.id = (r.value->>'id')::bigint
     and c.document_id = p_document;

  get diagnostics updated = row_count;
  return updated;
end;
$$;

/** How far along an upload is, for the progress the visitor watches. */
create or replace function upload_progress (p_session uuid, p_document uuid)
returns table (total integer, embedded integer, title text, is_complete boolean)
language sql stable security definer set search_path = public
as $$
  select
    count(c.id)::integer,
    count(c.embedding)::integer,
    max(d.title),
    bool_and(d.content_hash not like 'pending:%')
  from documents d
  left join chunks c on c.document_id = d.id
  where d.id = p_document
    and d.session_id = p_session
    and d.session_id is not null;
$$;

revoke all   on function add_upload_chunks_unembedded(uuid, uuid, jsonb) from public;
revoke all   on function next_unembedded_chunks(uuid, uuid, integer) from public;
revoke all   on function set_chunk_embeddings(uuid, uuid, jsonb) from public;
revoke all   on function upload_progress(uuid, uuid) from public;

grant execute on function add_upload_chunks_unembedded(uuid, uuid, jsonb) to anon, authenticated;
grant execute on function next_unembedded_chunks(uuid, uuid, integer) to anon, authenticated;
grant execute on function set_chunk_embeddings(uuid, uuid, jsonb) to anon, authenticated;
grant execute on function upload_progress(uuid, uuid) to anon, authenticated;
