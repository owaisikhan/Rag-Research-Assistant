# Deploying

## Region

Functions run in `syd1` (Sydney), set in `vercel.json`.

This is not a preference. The Supabase project is in `ap-southeast-2`, which is
Sydney, and Vercel's default for every new project is `iad1` (Washington DC).
Left at the default, every database query in the request path crosses the
Pacific and back. Co-locating the function with the database beats any query
tuning you could do afterwards, and it is one line.

If you move the database, change this line to match. The region codes are
Vercel's own, and they map onto AWS regions directly:

| Vercel | AWS | Location |
|---|---|---|
| `syd1` | `ap-southeast-2` | Sydney |
| `sin1` | `ap-southeast-1` | Singapore |
| `iad1` | `us-east-1` | Washington DC |
| `fra1` | `eu-central-1` | Frankfurt |
| `lhr1` | `eu-west-2` | London |

Deploying to a region your plan does not allow fails the deployment **before**
the build step. Hobby allows a single region, Pro five, Enterprise all — so on
Hobby, `regions` must contain exactly one entry.

Setting it here rather than in the dashboard means it is reviewable, travels
with the repo, and cannot be silently lost if the project is ever recreated.
The dashboard equivalent is Settings → Functions → Function Regions.

## Environment variables

Set these in Vercel (Settings → Environment Variables), for all three
environments:

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public by design |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public by design; RLS is what constrains it |
| `GEMINI_API_KEY` | Embeddings and, if `ANSWER_MODEL` is a Gemini model, answers |
| `ANTHROPIC_API_KEY` | Only if `ANSWER_MODEL` is a Claude model |
| `EMBEDDING_MODEL` | Must match what the corpus was embedded with |
| `ANSWER_MODEL` | |
| `RATE_LIMIT_SALT` | Any random string |
| `UPLOAD_TIME_BUDGET_S` | 60, or 300 once fluid compute is confirmed |

**Never set `SUPABASE_SERVICE_ROLE_KEY` on Vercel.** The deployed app never
writes: ingestion runs from a developer machine, and uploads go through
`SECURITY DEFINER` functions that enforce their own limits. That key bypasses
RLS entirely, so putting it in a public web app hands every visitor's request
path a credential that can read and delete every other visitor's documents.

Environment variables are read at build time, so adding one requires a
redeploy before it takes effect.

## After deploying

`npm run doctor` locally points at the same database, so it still verifies the
schema, the RPCs and both model APIs. What it cannot check is the deployment's
own environment — for that, load the site and confirm the header shows a
document count rather than the "not configured" notice.
