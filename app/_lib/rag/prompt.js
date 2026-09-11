// Context assembly and the grounding instructions.
//
// This file is the anti-hallucination mechanism. There is no setting on the
// model that makes it stick to the sources; what does it is (a) giving each
// passage a visible number the answer must cite, and (b) making "the sources
// do not say" an explicitly correct answer rather than a failure.

/**
 * Render retrieved passages as numbered sources.
 *
 * Numbered rather than titled because the model must be able to cite a
 * specific passage cheaply mid-sentence, and because two chunks from the same
 * paper need to be distinguishable in a citation.
 *
 * @param {import("./retrieve.js").Source[]} sources
 */
export function renderContext(sources) {
  return sources
    .map((source, index) => {
      const pages =
        source.pageStart === source.pageEnd
          ? `p. ${source.pageStart}`
          : `pp. ${source.pageStart}-${source.pageEnd}`;

      const where = source.section ? `${source.section}, ${pages}` : pages;
      const who = source.authors.length > 0 ? ` -- ${source.authors.slice(0, 3).join(", ")}${source.authors.length > 3 ? " et al." : ""}` : "";

      return [
        `[${index + 1}] ${source.title}${who}`,
        `    (${where})`,
        "",
        source.content,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

export const SYSTEM_PROMPT = `You answer questions about a library of documents, using only passages retrieved from those documents.

## The rule that matters

Every factual claim in your answer must come from the numbered sources given to you in the user message. You may not use anything you know from outside them, even if you are confident it is correct and even if the sources are clearly incomplete.

If the sources do not answer the question, say so plainly and say what they DO cover that is nearby. That is a correct and useful answer, not a failure. Never fill a gap with general knowledge, and never present a plausible inference as something the sources state.

## Citations

Cite with bracketed numbers matching the sources: [1], [3]. Put the citation immediately after the claim it supports, not bundled at the end of a paragraph.

- Every sentence containing a fact from the sources gets a citation.
- A sentence drawing on two sources cites both: [2][5].
- If you are summarizing or connecting ideas rather than stating a sourced fact, no citation is needed -- but the underlying facts must still be cited where they appear.
- Never cite a source number that was not given to you.

## How to write

Answer the question that was asked, directly, in the first sentence where possible. Then support it.

Use plain prose. Reach for a short list only when the content is genuinely a list. Keep it proportionate -- a factual question deserves a short answer, not an essay assembled from every passage you were handed.

Where sources disagree, say so and cite both sides rather than silently picking one.

Where a source is making a claim rather than reporting a result -- a proposal, a limitation the authors acknowledge, future work -- characterize it that way. "X and colleagues propose" is different from "X is the case".

Do not describe your own process. No "based on the provided sources" or "the retrieved passages indicate" -- just answer, and let the citations show where it came from.`;

/**
 * Build the user-turn content: the sources, then the question.
 *
 * Sources come first so that the question is the last thing read, which
 * measurably improves how well the answer stays on the question asked.
 */
export function buildUserTurn(question, sources) {
  if (sources.length === 0) {
    return `No passages were retrieved from the library for this question.

Tell the user plainly that you could not find anything relevant in the library, and suggest they rephrase or ask about something else. Do not attempt an answer from general knowledge.

Question: ${question}`;
  }

  return `Sources retrieved from the library:

${renderContext(sources)}

---

Question: ${question}`;
}

/**
 * Rewrite a follow-up into a standalone search query.
 *
 * Retrieval sees one string, with no memory. "What about the second one?"
 * embeds to nothing useful, so a follow-up in a conversation silently
 * retrieves garbage while the answer still sounds fluent -- the single most
 * common way multi-turn RAG breaks.
 */
export const QUERY_REWRITE_SYSTEM = `Rewrite the user's latest message into a standalone search query for a document search engine.

Resolve pronouns and references against the conversation. Keep the specific nouns, names, numbers and technical terms -- those carry the search. Drop conversational framing.

If the latest message is already standalone, return it unchanged.

Return only the query text. No preamble, no quotes, no explanation.`;
