# Cited — a document-grounded research assistant

Ask a library of PDFs a question in plain English. Get an answer built only
from passages retrieved out of those documents, with every claim numbered and
linked back to the page it came from.

Point it at research papers, contracts, policy manuals, standards or reports —
it is not tuned to one subject.

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

**Citation metadata lives on the chunk, not the document.** An answer cites a
passage on a page, not a file. `page_start`, `page_end` and `section` are
carried from PDF extraction all the way to the chip you click in the UI.

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
| Embeddings | OpenAI `text-embedding-3-small` | Swappable — see `app/_lib/rag/embed.js` |
| Answers | Claude Opus 5 | Follows negative instructions ("use only these passages") reliably |
| Follow-up rewriting | Claude Haiku 4.5 | A mechanical transformation; no reason to pay Opus rates |
| Deploy | Vercel | Pin the region to your Supabase region |

---

## Setup

**Prerequisites:** Node 20+, a Supabase project, an OpenAI key (embeddings),
an Anthropic key (answers).

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

`corpus:fetch --limit 20` is a good first run: it proves the pipeline end to
end in a couple of minutes before you commit to the full set.

**3. Run it.**

```bash
npm run dev                    # http://localhost:3000
```

---

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
  _components/chat/        the conversation, citations and source panel
  _lib/
    rag/embed.js           embedding provider (swappable)
    rag/retrieve.js        hybrid search
    rag/prompt.js          context assembly + grounding instructions
    rag/answer.js          streaming answer + follow-up rewriting
    rag/limits.js          rate limiting and request validation
    data-service.js        every read query
    siteConfig.js          identity as data
  api/chat/route.js        streaming NDJSON endpoint
scripts/
  fetch-corpus.mjs         build the demo library
  ingest.mjs               the ingestion pipeline
  sources.json             which public documents the demo pulls
supabase/migrations/       numbered, applied in order
tests/
```
