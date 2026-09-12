-- Passages for summarising one whole document.
--
-- WHY THIS IS NOT match_chunks.
--
-- Similarity search answers "which passages look like this question". A
-- summary has no question: asking the index for the chunks most similar to
-- "summarise this document" returns whichever passages happen to use
-- summary-flavoured language -- an abstract, a conclusion, a sentence starting
-- "in summary" -- and silently omits the middle of the document entirely. The
-- result reads fluently and misses half the content, which is the worst
-- failure mode available: confident and incomplete.
--
-- What a summary needs instead is COVERAGE. So this samples evenly across the
-- document in reading order and never consults the embedding at all, which
-- also means summarising costs no embedding quota.

/**
 * An even spread of passages across one document, in reading order.
 *
 * ntile(p_limit) cuts the document into that many equal buckets and the first
 * chunk of each is taken, so the passages are spread over the whole thing
 * regardless of its length. A document with fewer chunks than p_limit simply
 * returns all of them, in order.
 *
 * Access is the same rule as retrieval and is enforced HERE, not in the
 * application: the demo corpus, or this session's own uploads, and never a
 * half-indexed one. The caller passes a document id, so without this check a
 * visitor could summarise someone else's upload by guessing a uuid.
 */
create or replace function document_outline (
  p_session  uuid,
  p_document uuid,
  p_limit    integer default 16
)
returns table (
  chunk_index integer,
  content     text,
  section     text,
  page_start  integer,
  page_end    integer,
  title       text,
  authors     text[],
  page_count  integer,
  chunk_total integer
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with allowed as (
    select d.id, d.title, d.authors, d.page_count
    from documents d
    where d.id = p_document
      and d.content_hash not like 'pending:%'
      and (d.session_id is null or (p_session is not null and d.session_id = p_session))
  ),
  ordered as (
    select
      c.chunk_index, c.content, c.section, c.page_start, c.page_end,
      a.title, a.authors, a.page_count,
      count(*) over ()                                    as chunk_total,
      ntile(greatest(p_limit, 1)) over (order by c.chunk_index) as bucket,
      row_number()                over (order by c.chunk_index) as rn
    from chunks c
    join allowed a on a.id = c.document_id
  ),
  sampled as (
    select distinct on (bucket) *
    from ordered
    order by bucket, rn
  )
  select
    chunk_index, content, section, page_start, page_end,
    title, authors, page_count, chunk_total
  from sampled
  order by rn;
$$;

revoke all   on function document_outline(uuid, uuid, integer) from public;
grant execute on function document_outline(uuid, uuid, integer) to anon, authenticated;
