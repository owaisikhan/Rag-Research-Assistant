// Identity as data. A new client gets a clone, this file edited, new colour
// tokens in globals.css, and a fresh Supabase project -- no grep required.

export const siteConfig = {
  name: "Folio",
  tagline: "Upload a PDF and ask questions about it.",
  description:
    "Upload a PDF and ask questions about it. Every answer is built only from " +
    "passages retrieved out of your own document — never from outside it.",

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

  // What the app IS, as configuration rather than as scattered conditionals.
  //
  // Both default to the fuller behaviour and are switched off by env var, so
  // nothing is deleted and either can come back in one line. The citation
  // machinery in particular is the most distinctive part of this codebase --
  // turning it off is a product decision, not a reason to throw the code away.
  mode: {
    // Server-only: retrieval and the page header read this, both of which run
    // on the server, so it needs no NEXT_PUBLIC_ prefix.
    //
    // false = the assistant answers only from what this visitor uploaded. The
    // curated library stays in the database, simply not searched.
    includeDemoCorpus: process.env.INCLUDE_DEMO_CORPUS !== "false",

    // NEXT_PUBLIC_ because ChatPanel is a client component and reads it.
    //
    // Without the prefix the value is stripped from the browser bundle, so the
    // server renders one thing and the client renders another -- the sources
    // panel reappears after hydration and React throws error #418. The failure
    // is confusing precisely because the server half is correct.
    //
    // false = no [1] markers in answers, no citation chips, no sources panel.
    showCitations: process.env.NEXT_PUBLIC_SHOW_CITATIONS !== "false",
  },

  // Hard ceilings for the public demo. See app/_lib/rag/limits.js.
  demo: {
    // Questions per hour, per caller. 0 DISABLES the limiter entirely.
    //
    // Disabling is for testing only: this app calls a metered API on behalf of
    // anyone who can reach it, so a public deployment with no limiter is an
    // unbounded bill waiting for one bored visitor. Set
    // DEMO_QUESTIONS_PER_HOUR=0 locally; never on the deployment.
    questionsPerHour: Number(process.env.DEMO_QUESTIONS_PER_HOUR ?? 12),
    maxQuestionLength: 500,
    maxTurnsKept: 6,
  },
};

export default siteConfig;
