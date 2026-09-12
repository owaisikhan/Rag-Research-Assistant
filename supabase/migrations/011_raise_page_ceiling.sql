-- Raise the page ceiling so it stops being the binding constraint.
--
-- max_pages was 60, chosen when UPLOAD_TIME_BUDGET_S defaulted to 60 seconds.
-- It is a COARSE ceiling, not the real gate: the real gate is the measured
-- check in the upload route, which runs first and knows the document's exact
-- chunk count rather than guessing from its page count. Across this corpus a
-- page costs between 0.96 and 4.25 chunks, so pages were always a poor proxy.
--
-- With a 300-second budget the measured check allows roughly 313 passages,
-- which is about 143 pages at the corpus average of 2.19 chunks per page --
-- and considerably more for a sparse document. A 60-page ceiling would reject
-- those before the measurement ever ran.
--
-- 500 is chosen to sit above anything the time check will pass, so that a
-- refusal always comes from the measurement and carries the sentence saying
-- what WOULD fit, rather than from a flat number that explains nothing.

create or replace function upload_limits ()
returns table (max_documents_per_session integer, max_pages integer, lifetime_hours integer)
language sql immutable as $$ select 3, 500, 24 $$;
