/**
 * Messages that are not questions about the documents.
 *
 * "hello" went through the full pipeline: rewrite the query, embed it, run
 * hybrid retrieval, send a dozen passages of price-comparison rows to the
 * model, and stream back an answer explaining that the documents do not
 * contain greetings. That costs an embedding request, a generation request and
 * one of the visitor's twelve hourly slots, to answer a word that was never
 * about the documents.
 *
 * MATCHING IS DELIBERATELY EXACT, on the whole normalised message, against a
 * closed list. A fuzzy "does this look like a question" heuristic would be
 * worse than nothing here: "rent?" and "total?" are real questions, short and
 * content-free, and sending one of those down this path would answer a genuine
 * question with a canned line. Anything not on the list goes down the normal
 * path, so the failure mode is a greeting that gets searched -- which is
 * exactly today's behaviour, and harmless.
 */
const PHRASES = new Set([
  "hi", "hello", "hey", "yo", "hiya",
  "hi there", "hello there", "hey there",
  "good morning", "good afternoon", "good evening", "good day",
  "how are you", "how are you doing", "how r u", "hows it going", "how is it going",
  "hello how are you", "hi how are you", "hey how are you",
  "whats up", "sup",
  "thanks", "thank you", "thanks a lot", "thank you very much", "thx", "ty",
  "ok", "okay", "k", "ok fine", "okay fine", "fine", "alright", "all right",
  "cool", "nice", "great", "good", "perfect", "awesome", "lovely",
  "yes", "yeah", "yep", "no", "nope",
  "bye", "goodbye", "see you", "see ya", "good night",
  "test", "testing",
]);

/**
 * Is this the whole message, and is it small talk?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isSmallTalk(text) {
  const normalised = String(text)
    .toLowerCase()
    // Punctuation and emoji go, so "Hello!" and "hello 👋" match "hello".
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalised === "") return false;

  return PHRASES.has(normalised);
}

/**
 * What to say instead.
 *
 * Says what the thing does rather than performing friendliness back, because
 * the useful information at this moment is "ask me about your documents".
 */
export function smallTalkReply(documentCount = 0) {
  if (documentCount === 0) {
    return "Hello. Upload a PDF and I will answer questions about it — using only what is actually in the document.";
  }

  return documentCount === 1
    ? "Hello. Ask me anything about your document and I will answer from what is in it."
    : "Hello. Ask me anything about your documents and I will answer from what is in them.";
}
