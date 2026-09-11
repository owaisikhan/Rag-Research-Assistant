// Identity as data. A new client gets a clone, this file edited, new colour
// tokens in globals.css, and a fresh Supabase project -- no grep required.

export const siteConfig = {
  name: "Cited",
  tagline: "Ask your documents. Get answers with receipts.",
  description:
    "A retrieval-augmented research assistant. Every answer is built only " +
    "from passages retrieved out of the source documents, and every claim " +
    "links back to the page it came from.",

  // Shown on the demo page so visitors understand what they are querying.
  corpus: {
    label: "Demo library",
    blurb:
      "A deliberately mixed set of public documents -- research papers, " +
      "government reports, technical standards and company filings -- to " +
      "show the assistant is not tuned to one subject.",
  },

  author: {
    name: "Owais Khan",
    // Fill these in before deploying; they are what turns a demo into a lead.
    email: "",
    site: "",
    github: "",
    linkedin: "",
  },

  // Hard ceilings for the public demo. See app/_lib/rag/limits.js.
  demo: {
    questionsPerHour: 12,
    maxQuestionLength: 500,
    maxTurnsKept: 6,
  },
};

export default siteConfig;
