// Page-tagged text -> retrievable chunks.
//
// This file decides answer quality more than the model choice does. A chunk
// that splits a claim from its condition produces a confident wrong answer;
// a chunk carrying the wrong page number produces a citation that does not
// check out, which is worse than no citation at all.

// ~500 tokens is the sweet spot for this corpus: large enough to hold a
// complete argument, small enough that a dozen fit in context with room for
// the conversation. Overlap stops a claim being cut in half at a boundary.
const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 80;
const MIN_TOKENS = 50;

// Approximate rather than exact. A real tokenizer is a heavy dependency and a
// 10% error here costs nothing -- the budget is a guideline, not a limit that
// anything breaks against.
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Headings this corpus actually contains: "3.5 Positional Encoding",
// "IV. RESULTS", "Abstract", "Appendix B".
const NUMBERED_HEADING = /^(\d+(\.\d+)*\.?)\s+([A-Z][^.!?]{2,80})$/;
const ROMAN_HEADING = /^([IVXLC]+\.)\s+([A-Z][^.!?]{2,80})$/;
const NAMED_HEADING =
  /^(abstract|introduction|background|related work|methodology|methods|approach|experiments?|results|discussion|evaluation|conclusions?|future work|acknowledge?ments?|references|bibliography|appendix(\s+[A-Z])?)\s*$/i;

function detectHeading(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;

  const numbered = trimmed.match(NUMBERED_HEADING);
  if (numbered) return trimmed;

  const roman = trimmed.match(ROMAN_HEADING);
  if (roman) return trimmed;

  if (NAMED_HEADING.test(trimmed)) return trimmed;

  return null;
}

/**
 * Everything after the reference list is a bibliography: thousands of tokens
 * of author names and titles that match keyword queries beautifully and
 * answer nothing. Dropping it is one of the cheapest quality wins available.
 *
 * Only trusted in the last 40% of the document, because papers also cite
 * "see References" mid-body.
 */
function findReferencesCutoff(blocks) {
  // The heading itself is consumed into block.section by toBlocks(), so the
  // cutoff is the first block that BELONGS to the references section, not a
  // block whose text reads "References".
  //
  // Scanned from the start, not from a position near the end: a bibliography
  // is hundreds of short lines and therefore often MORE blocks than the body
  // it follows, so any "look in the last 40%" window lands inside the
  // references and leaves half of them in. The section label occurs once, so
  // scanning from the start is unambiguous.
  const firstReference = blocks.findIndex((block) =>
    /^(references|bibliography)\s*$/i.test(block.section ?? "")
  );

  // Guard against a document whose body is genuinely titled "References":
  // refuse to discard nearly everything.
  const MIN_BODY_FRACTION = 0.25;
  if (firstReference > blocks.length * MIN_BODY_FRACTION) return firstReference;

  return blocks.length;
}

/**
 * Flatten pages into paragraph blocks, each tagged with its page and the
 * nearest heading above it.
 */
function toBlocks(pages) {
  const blocks = [];
  let section = null;

  pages.forEach((pageText, index) => {
    const pageNumber = index + 1;

    for (const rawParagraph of pageText.split(/\n{2,}|\n(?=\d+(?:\.\d+)*\s+[A-Z])/)) {
      for (const line of rawParagraph.split("\n")) {
        const heading = detectHeading(line);
        if (heading) {
          section = heading;
          continue;
        }
        const text = line.trim();
        if (text.length > 0) blocks.push({ text, page: pageNumber, section });
      }
    }
  });

  return blocks;
}

/**
 * Pack blocks into overlapping, page-tagged chunks.
 *
 * @param {string[]} pages
 * @returns {Array<{content: string, section: string|null, pageStart: number, pageEnd: number, tokenCount: number, chunkIndex: number}>}
 */
export function chunkPages(pages) {
  const allBlocks = toBlocks(pages);
  const blocks = allBlocks.slice(0, findReferencesCutoff(allBlocks));

  const chunks = [];
  let current = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;

    const content = current.map((b) => b.text).join(" ");
    const tokenCount = estimateTokens(content);

    // Drop fragments -- a stray caption or a page of whitespace.
    if (tokenCount >= MIN_TOKENS) {
      chunks.push({
        content,
        // The section a chunk belongs to is the one it starts in.
        section: current[0].section,
        pageStart: current[0].page,
        pageEnd: current[current.length - 1].page,
        tokenCount,
        chunkIndex: chunks.length,
      });
    }

    // Carry the tail into the next chunk so a claim split across the boundary
    // survives in at least one of them.
    const overlap = [];
    let overlapTokens = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      const tokens = estimateTokens(current[i].text);
      if (overlapTokens + tokens > OVERLAP_TOKENS) break;
      overlap.unshift(current[i]);
      overlapTokens += tokens;
    }

    current = overlap;
    currentTokens = overlapTokens;
  };

  for (const block of blocks) {
    const tokens = estimateTokens(block.text);

    // A section change is a natural boundary -- respect it rather than
    // gluing the end of Methods onto the start of Results.
    const sectionChanged =
      current.length > 0 && current[current.length - 1].section !== block.section;

    if (currentTokens + tokens > TARGET_TOKENS || (sectionChanged && currentTokens > MIN_TOKENS)) {
      flush();
    }

    current.push(block);
    currentTokens += tokens;
  }

  flush();
  // The final flush leaves the overlap tail unwritten; emit it if substantial.
  if (estimateTokens(current.map((b) => b.text).join(" ")) >= MIN_TOKENS) {
    const content = current.map((b) => b.text).join(" ");
    chunks.push({
      content,
      section: current[0].section,
      pageStart: current[0].page,
      pageEnd: current[current.length - 1].page,
      tokenCount: estimateTokens(content),
      chunkIndex: chunks.length,
    });
  }

  return chunks;
}
