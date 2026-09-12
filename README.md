# Folio

Upload a PDF and ask questions about it. Every answer is built only from
passages retrieved out of your own document — if the document does not cover
the question, it says so rather than filling the gap from general knowledge.

Uploads are private to whoever made them, enforced in the database rather than
the application, and deleted after 24 hours.

---

## Why it is built this way

Most of the interesting decisions here are about **trust**, not plumbing. A
RAG app that sounds fluent while quietly inventing things is worse than no app,
because a confident wrong answer costs more than a missing one.

**Retrieval is hybrid, not vector-only.** Vector search alone loses exact
terms — a CVE identifier, an error string, a surname. Full-text search alone
loses paraphrase. `match_chunks()` runs both and fuses the ranks with
Reciprocal Rank Fusion. RRF rather than a weighted blend of the two scores,
because cosine distance and `ts_rank` are not on comparable scales, so any
fixed weighting between them is a magic number that stops being right as soon
as the corpus changes. Ranks are always comparable.

**Citation metadata lives on the chunk, not the document.** A passage belongs
to a page, not to a file. `page_start`, `page_end` and `section` are carried
from PDF extraction all the way through retrieval.

Page-level citations — numbered markers in the answer, a sources panel, click a
marker to see the passage it came from — are built and working, but currently
**switched off** (`NEXT_PUBLIC_SHOW_CITATIONS=false`). One env var brings them
back. The grounding rules are unaffected either way: the model answers only
from retrieved passages in both modes.

**"The sources do not say" is a correct answer.** The system prompt makes
refusing an explicitly correct outcome rather than a failure, which is the
only thing that reliably stops a model filling gaps from general knowledge.

**Follow-ups are rewritten before retrieval.** "What about the second one?"
embeds to nothing useful. A cheap model rewrites it into a standalone query
first. Skipping this is the most common way multi-turn RAG breaks: retrieval
silently returns noise while the answer still reads fluently.

**Ingestion is incremental by content hash.** Adding fifty PDFs to an existing
library re-embeds fifty PDFs, not the whole corpus.

**The corpus records which embedding model wrote it.** Mixing embedding models
in one index produces retrieval that looks like it works and returns noise —
a failure with no error message. Ingestion refuses up front.

---

## Architecture

```
PDFs ──► extract (page-tagged) ──► clean ──► section-aware chunk
                                                    │
                                            embed (batched)
                                                    │
                                       Supabase Postgres + pgvector
                                                    │
   question ──► rewrite follow-up ──► hybrid search (vector + FTS, RRF)
                                                    │
                                        top 12 passages as context
                                                    │
                                   Claude, grounded + citation-constrained
                                                    │
                                    streamed answer + clickable sources
```

**Ingestion runs on your machine, never on Vercel.** Embedding hundreds of
PDFs takes minutes to hours and needs a real filesystem; serverless functions
have neither. The deployed app only reads what ingestion writes.

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js App Router | Server Components query at request time; the chat endpoint streams |
| Database | Supabase Postgres + pgvector | One database for rows and vectors; RLS is the access control |
| Index | HNSW + GIN | HNSW needs no training step or list tuning as the corpus grows |
| Embeddings | Gemini `gemini-embedding-001` at 1536 dims | Free tier; asks for the dimensionality that matches the column, so no migration. Swappable — see `app/_lib/rag/embed.js` |
| Answers | Claude Opus 5 | Follows negative instructions ("use only these passages") reliably |
| Follow-up rewriting | Claude Haiku 4.5 | A mechanical transformation; no reason to pay Opus rates |
| Deploy | Vercel | Pin the region to your Supabase region |

---

## Setup

**Prerequisites:** Node 20+, a Supabase project, a Gemini key (embeddings —
free tier is enough), an Anthropic key (answers).

```bash
git clone https://github.com/owaisikhan/Rag-Research-Assistant.git
cd Rag-Research-Assistant
npm install
cp .env.example .env.local     # then fill it in
```

**1. Create the schema.** In the Supabase SQL editor, run the migrations in
order:

```
supabase/migrations/001_knowledge_base.sql
supabase/migrations/002_rate_limit.sql
```

**2. Build the library.**

```bash
npm run corpus:fetch           # downloads PDFs + a metadata manifest
npm run corpus:ingest          # extract → chunk → embed → store
```

`corpus:fetch -- --limit 20` is a good first run: it proves the pipeline end to
end before you commit to the full set.

**Ingestion is paced, and that is deliberate.** Gemini's free tier allows 100
embed requests per minute, and each *text* counts as a request rather than each
HTTP call — so batching saves round trips and nothing else. `embed.js` holds a
sliding window against that limit rather than racing into it and backing off,
because a rejected batch has already spent its quota. Budget roughly a minute
per 100 chunks: about two documents a minute, so a 300-document library is a
few hours. Leave it running; it is resumable.

**Interrupting it is safe.** A document's row is written with a sentinel
`pending:` hash and only gets its real hash once its chunks are stored and
counted. Anything interrupted mid-flight is retried on the next run rather than
being mistaken for complete work and skipped.

**3. Run it.**

```bash
npm run dev                    # http://localhost:3000
```

---

## Uploading a PDF from the browser

A visitor can drop a PDF onto the page and immediately ask questions about it.
It runs the same extract -> clean -> chunk -> embed pipeline as the ingestion
script, against the same code, so an uploaded document produces citations
identical in shape to the curated corpus: title, section, page.

**Uploads are private to the visitor who made them, and that is enforced in
the database rather than the application.** This distinction is the whole
design:

The anon key is public by design -- it ships to every browser. So "filter by
session in the app" is not isolation: anyone can take that key and query
`/rest/v1/documents` directly for every row, including other people's uploaded
files. A contract, a medical letter, a draft nobody meant to share.

So RLS exposes only the demo corpus (`session_id is null`) to direct table
reads, and everything session-scoped goes through `SECURITY DEFINER` functions
that take the session id and apply the filter themselves. The session id lives
in an httpOnly cookie: unguessable, and unreadable by scripts on the page. The
deployed app never holds the service-role key, so it has no credential capable
of reaching another visitor's documents or of writing to the demo corpus.

Verified rather than assumed -- a planted "other visitor's upload" is
invisible to a direct table read, to a read with no session, and to a read
with a *different* session, while remaining visible to its own.

| Limit | Value | Why |
|---|---|---|
| File size | 10 MB | |
| Pages | 100 (ceiling) | The real gate is time, not pages -- see below |
| Documents per visitor | 3 | |
| Lifetime | 24 hours | Purged opportunistically; no scheduled job needed |
| Interrupted uploads | 10 minutes | Retryable rather than occupying an allowance slot all day |

**On timeouts.** Vercel terminates a function that exceeds its duration; it does
not restart or retry it, and anything already written stays written.

How long that is depends on a project setting, and the two answers differ by
5x: **300s** with fluid compute (the default for projects created after April
2025) and **60s** for a legacy project without it. Vercel's docs carry both
tables, which is a good way to size an upload limit confidently against the
wrong one.

So the page cap is only a coarse ceiling. The real gate is `UPLOAD_TIME_BUDGET_S`
(default 60, raise to 300 once you have confirmed fluid compute), checked at
runtime against the work the document actually requires. Extraction and
chunking are local and free, so by then the exact chunk count is known --
and pages are a poor proxy for it, ranging from 1.5 to 4.25 chunks per page
across this corpus. A 30-page document can cost less than a 21-page one.

A document that will not fit is refused immediately, with a sentence saying
what would, instead of dying at the platform timeout halfway through and
leaving a half-indexed document behind. So an
upload writes its document row with a `pending:` sentinel hash FIRST, and
commits the real hash only once every chunk is stored and counted. A timeout
therefore leaves a row that can never be mistaken for a complete document --
hidden from the visitor's list, excluded from retrieval, and purged after ten
minutes so the next attempt starts clean.

The free tier's real constraint on large uploads is the per-minute embedding
limit rather than the daily one: 100 requests/minute means a 100-page document
takes about two minutes of wall time. Enabling billing removes that pacing, at
roughly four cents per 100-page document.

Change them in one place: the `upload_limits()` function in
`supabase/migrations/006_uploads.sql`.

## Summarising a document

Each uploaded document has a **Summarise** button. It produces a summary of
the whole document, not an answer assembled from whichever passages happened
to match a question.

**Summarising is not a retrieval query, and building it as one is the trap.**
Asking the index for the chunks most similar to "summarise this document"
returns whatever uses summary-flavoured language -- an abstract, a conclusion,
a sentence beginning "in summary" -- and silently skips the middle of the
document. The result reads fluently and covers half the content, which is the
worst failure available: confident and incomplete.

So `document_outline()` never touches the embedding. It cuts the document into
equal buckets with `ntile()` and takes the first chunk of each, giving an even
spread in reading order regardless of length. Measured on a 190-chunk paper, 16
passages span chunk 0 to 179 and pages 1 to 76.

The model is told how much it is seeing (`16 passages ... out of 190`), because
a model told nothing writes as though it read the document end to end.

Two consequences worth knowing:

- **It costs no embedding quota.** There is no query to embed, so a summary is
  pure Postgres plus one generation call — the cheapest thing the app does.
- **Access is enforced in the function, not the route.** The caller passes a
  document id, so without that check a visitor could summarise someone else's
  upload by guessing a uuid. Same proof as uploads: a planted document is
  invisible with no session and to a *different* session, visible only to its
  owner, and a half-indexed one is invisible even to its owner.

## The interface

Warm neutrals, a single brass accent, no gradients.

With nothing uploaded the drop zone is the whole page, centred in the viewport:
there is exactly one thing to do, so it is the only thing on screen. Once a
document exists the layout becomes two columns — documents on the left, the
conversation on the right — so the thing being asked about sits beside the
asking rather than scrolled away above it.

The palette is ink on paper: a warm near-black ground rather than a blue-black,
warm off-white type rather than pure white, and one accent that reads like a
bookmark ribbon. This is a deliberate move away from violet-to-magenta, which
has become the house style of every AI demo and now signals "template" before a
visitor has read a word. Warm neutrals with a single metallic accent read as
editorial, which is what a tool for reading documents should look like.

Theme is a `data-theme` attribute on `<html>`, applied by a blocking script in
`<head>` before first paint — otherwise a light-theme visitor watches the page
render dark and then flip. It defaults to dark; light is a complete theme, not
an afterthought.

**`@theme` cannot be nested.** Tailwind v4 hoists its declarations out of
whatever wraps them, so a dark block inside `@media` is emitted unconditionally
and wins. The light palette is a plain `:root[data-theme="light"]` rule for
that reason.

### What was removed, and why

An earlier pass copied a reference chatbot template: a gradient nav rail, a
gradient top bar with search, notifications and an avatar, a glowing orb behind
the empty state, and a composer toolbar of four icons wired to "coming soon".

All of it is gone. The rail navigated nothing — this is one screen. The search,
bell and avatar were chrome for features that do not exist. The orb was the
single clearest tell that a page came out of a template. And a row of icons for
features that do not exist is the visual equivalent of a stock photo: it fills
the space and tells the viewer nothing true. In a demo the first thing anyone
does is click them, and four dead ends in a row costs more trust than an empty
toolbar ever would.

What is left is what works:

| Control | Does |
|---|---|
| Choose / drop a PDF | Uploads and indexes it |
| Attach PDF (in the composer) | The same, without leaving the question |
| Ask | Streams a grounded answer |
| Summarise | Summarises that whole document |
| Copy (on hover) | Copies an answer |
| Export chat | Downloads the conversation as Markdown |
| Clear chat | Empties it |
| Fullscreen | Real fullscreen |
| Theme | Light / dark |
| Remove | Deletes that document |

### Showing where an answer came from

Under every answer is a **Based on** list: the documents it drew on, with the
pages, collapsed by default and expandable to the passages themselves.

It is grouped BY DOCUMENT, not listed per passage. Twelve passages out of one
lease is not twelve sources — it is one document and a set of pages — and the
page ranges are merged into one readable run (`pp. 3–5, 9` rather than
`pp. 3–4, p. 5, p. 9`). Adjacent ranges merge as well as overlapping ones, so
pages 3–4 and 5 read as one reference to one stretch of text.

Documents used by the newest answer are also marked in the left-hand list, with
an accent stripe **and the words "used in this answer"** — which of several
uploads an answer came from is not something a reader should have to infer from
a hue.

`NEXT_PUBLIC_SHOW_CITATIONS` now controls only the inline `[1]` markers inside
the prose. The Based-on list and the document marking are always on: the markers
are a presentation choice, but which document a claim came from and on what page
is the product promise.

Share-by-link is the one thing deliberately not built: it means storing a
conversation server-side under a public id, which is a privacy decision about
documents the visitor was promised were private.

Desktop is tuned; mobile currently degrades rather than being designed. It does
not overflow at 390px, but it has not had a layout pass.

## Rate limiting

Twelve questions per hour per caller, counted in Postgres rather than in
memory: every Vercel function instance would keep its own counter, so the real
limit would become (limit x instances) and a burst would walk straight past it.
Callers are identified by a salted hash of their IP, never the IP.

**A failed request does not cost a slot.** The spend is atomic — it has to be,
or two simultaneous requests both read "11 used" and both proceed — but a
request that dies *after* the spend, for reasons the visitor had no part in
(the daily model quota is gone, retrieval failed), is refunded. This was found
the hard way: with the model's daily quota exhausted, twelve failed questions
spent the whole hour and produced nothing, and the app then blamed the visitor
for asking too much. A partial answer is not refunded — the visitor got
something and the call was billed.

### Turning it off for testing

```
DEMO_QUESTIONS_PER_HOUR=0
```

Local testing only. This app calls a metered API on behalf of anyone who can
reach it, so a public deployment with no limiter is an unbounded bill waiting
for one bored visitor. The server logs a warning on every boot while it is off,
and the default if the variable is unset is 12 — so forgetting to set it back
locally is harmless, and forgetting to remove it from a deployment is the thing
to watch.

## Adding your own documents

Drop PDFs into `corpus/` and run `npm run corpus:ingest`. Anything already
ingested and unchanged is skipped — only the new files cost embedding calls.

To give them proper titles, authors and links rather than filenames, add them
to `corpus/manifest.json`:

```json
[
  {
    "fileName": "annual-report-2025.pdf",
    "sourceId": "acme:annual-2025",
    "title": "Acme Corporation Annual Report 2025",
    "authors": ["Acme Corporation"],
    "publishedOn": "2025-03-31",
    "sourceUrl": "https://example.com/annual-2025.pdf",
    "kind": "filing",
    "licence": "© Acme Corporation"
  }
]
```

To change which public documents the demo library pulls, edit
`scripts/sources.json` — arXiv categories and direct PDF URLs.

**Re-ingesting after a change:** editing chunking or switching embedding model
requires `npm run corpus:ingest -- --force`. Switching embedding model also
needs a migration changing `vector(1536)` to the new dimension, because the
column width is fixed at the database.

---

## Deploying

1. Push to GitHub, import the repo in Vercel.
2. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RATE_LIMIT_SALT`.
   **Do not set `SUPABASE_SERVICE_ROLE_KEY`** — the deployed app never writes.
3. **Pin the Vercel function region to your Supabase region.** Functions in
   one continent and Postgres in another costs a round trip on every query.

Before making the URL public, check `siteConfig.demo` in
`app/_lib/siteConfig.js`: questions per hour, maximum question length, and how
many conversation turns are kept. The rate limiter counts in Postgres rather
than in memory, because each serverless instance would otherwise keep its own
counter and the real limit would be (limit × instances).

---

## Tests

```bash
npm test
```

Covers chunking: page ranges, section labelling, bibliography exclusion, the
token budget, and the degenerate inputs (empty pages, a document that is
entirely references, a page extracted as one unbroken paragraph).

Chunking is what is tested because it is deterministic, needs no network, and
decides answer quality — a chunk carrying the wrong page number produces a
citation that does not check out, which is worse than no citation at all.

---

## Layout

```
app/
  _components/ui/          generic, knows nothing about the domain
  _components/ui/Icon.jsx  the icon set, as inline SVG (no icon package)
  _components/ui/Toaster.jsx  transient feedback
  _components/shell/       theme toggle + the pre-paint theme script
  _components/chat/        the conversation, composer, uploads, sources
  _lib/
    rag/embed.js           embedding provider (swappable)
    rag/retrieve.js        hybrid search
    rag/prompt.js          context assembly + grounding instructions
    rag/answer.js          streaming answer + summary + follow-up rewriting
    rag/summarize.js       even-coverage passage sampling for summaries
    rag/limits.js          rate limiting and request validation
    data-service.js        every read query
    siteConfig.js          identity as data
  api/chat/route.js        streaming NDJSON endpoint
  api/summarize/route.js   whole-document summary, same wire format
  api/upload/route.js      PDF upload and indexing
  api/documents/route.js   list and delete this visitor's uploads
scripts/
  fetch-corpus.mjs         build the demo library
  ingest.mjs               the ingestion pipeline
  sources.json             which public documents the demo pulls
supabase/migrations/       numbered, applied in order
tests/
```
