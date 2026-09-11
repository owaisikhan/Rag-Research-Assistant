# Working in this repo

A retrieval-augmented assistant over a library of PDFs. Answers are built only
from retrieved passages, and every claim carries a citation to a page.

**Who reads it:** anyone evaluating the tool — a prospective client on a
public demo, or a user querying their own documents. Not an internal tool, so
it can lean on hover and animation, but the answer body is read as prose and
needs to stay legible.

## Ground rules

**Every read goes in `app/_lib/data-service.js`.** A query written inline in a
page is one nobody finds when the schema changes.

**Citation metadata is the product.** `page_start`, `page_end` and `section`
travel from extraction to the UI. Anything that merges, reorders or resamples
chunks must preserve them. A citation that does not check out is worse than no
citation.

**Never let the model answer from outside the retrieved passages.** The
grounding rules live in `app/_lib/rag/prompt.js`. If you loosen them, the
product stops being the product.

**The corpus must never mix embedding models.** `documents.embedding_model`
records which model wrote each row; ingestion refuses on mismatch. Changing
`EMBEDDING_MODEL` requires `--force` re-ingestion AND a migration for the new
`vector(n)` dimension.

**Ingestion runs locally, not on Vercel.** Serverless has no persistent disk
and a 60s ceiling.

**Identity is data.** Business name, tagline, demo limits — all in
`app/_lib/siteConfig.js`. A new client is a clone, this file, and new colour
tokens.

## Verifying a change

- `npm test` — chunking. Fast, no network.
- `npm run build` — catches import and server/client boundary mistakes.
- **Look at the screen.** A DOM check can pass while the layout is wrong. The
  two bugs caught this way so far: a permanently-dark theme (Tailwind v4
  hoists `@theme` out of `@media`, so a nested dark block is emitted
  unconditionally), and citation markers wrapping onto their own line
  (`inline-flex` with a min-width is a large breakable box). Screenshot at a
  small laptop and ~400px, in both colour schemes.
- For a disposable render harness, add `app/devcheck/page.js` importing the
  real components with fixture data — **and delete it before committing**.

## Conventions

- Colour tokens are named by role (`--color-ink`, `--color-surface`), never by
  hue, so a rebrand is a token swap.
- Colour is never the only carrier of meaning — pair it with a word or icon.
- `_components/ui/` must not know what the business is.
- Import with `@/`, never `../../..`.
- Aggregate in Postgres (`corpus_stats()`), not in the browser.

## Things already tried

- **Positional heuristics for finding the bibliography.** "Search the last
  40% of blocks" lands *inside* the references, because reference entries are
  short lines and generate more blocks than the body they follow. Match the
  section label from the start instead.
- **A words-per-token constant when hard-splitting long text.** Overshoots
  badly on long tokens. Measure with `estimateTokens` instead.
