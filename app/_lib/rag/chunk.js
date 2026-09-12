// Page-tagged text -> retrievable chunks.
//
// This file decides answer quality more than the model choice does. A chunk
// that splits a claim from its condition produces a confident wrong answer;
// a chunk carrying the wrong page number produces a citation that does not
// check out, which is worse than no citation at all.

// ~700 tokens, measured against this corpus rather than picked.
//
// Every chunk is one embedding request against a metered quota, so chunk size
// is the main lever on ingestion cost -- and the cost is paid against citation
// precision, because a larger passage spans more pages and a citation that
// reads "pp. 12-15" is far less checkable than one that reads "p. 13".
//
// Re-chunking the ten-document corpus at several sizes:
//
//   target  chunks  vs 500  single-page cites  spanning 3+ pages
//     500      846       -               57%                  2%
//     700      645    -24%               47%                  3%
//     900      541    -36%               40%                  6%
//    1200      466    -45%               37%                 14%
//
// 700 takes a quarter off the bill while passages spanning three or more
// pages barely move. 1200 halves the bill and wrecks the product's whole
// promise -- one citation in seven stops being checkable at a glance.
//
// NOTE: chunk size is per-document and applied at ingestion. Documents already
// in the corpus keep the size they were ingested at, and mixing sizes in one
// index is harmless -- unlike mixing embedding MODELS, which silently destroys
// retrieval. So this takes effect on new documents without re-ingesting
// anything.
export const TARGET_TOKENS = 700;
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
 * Drop the title block: title, authors, affiliations, emails, the arXiv stamp.
 *
 * It is retrieved constantly and answers nothing. Worse, it is retrieved for
 * the WRONG reason -- it contains the paper's title, so keyword search scores
 * it highly for any query about the paper's own subject, pushing out a passage
 * that actually makes a claim. Same argument as the bibliography.
 *
 * Only applied when the document has real headings. A document with no
 * detected sections might be a report or a letter whose opening IS the
 * content, and dropping its first page would be worse than the noise.
 */
function findFrontMatterEnd(blocks) {
  const hasSections = blocks.some((block) => block.section !== null);
  if (!hasSections) return 0;

  // Everything before the first block that carries a section, provided it is
  // confined to the first page. A section-less run deeper into the document is
  // body text the heading detector simply missed.
  let end = 0;
  while (end < blocks.length && blocks[end].section === null && blocks[end].page === 1) {
    end++;
  }
  return end;
}

/**
 * Break a block that is already larger than the whole chunk budget.
 *
 * Extraction does not guarantee line breaks: a page can come back as one
 * unbroken run of text, and such a block would otherwise pass through whole,
 * producing a chunk several times the budget. That chunk then dominates the
 * context it appears in and cites a whole page instead of a passage.
 *
 * Split on sentence ends first, since those are real semantic boundaries.
 * A single "sentence" still over budget (a table flattened into one line, a
 * long formula) falls back to a hard word-count split -- imperfect, but
 * bounded, which is what matters.
 */
function splitOversized(text) {
  if (estimateTokens(text) <= TARGET_TOKENS) return [text];

  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];

  const pieces = [];
  let current = "";

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed !== "") pieces.push(trimmed);
    current = "";
  };

  for (const sentence of sentences) {
    if (estimateTokens(sentence) > TARGET_TOKENS) {
      pushCurrent();
      // Accumulate words by MEASURED size rather than a words-per-token
      // guess: a fixed word count overshoots badly on long tokens (chemical
      // names, hashes, identifiers) and wastes the budget on short ones.
      let piece = "";
      for (const word of sentence.split(/\s+/)) {
        const candidate = piece === "" ? word : `${piece} ${word}`;
        if (estimateTokens(candidate) > TARGET_TOKENS && piece !== "") {
          pieces.push(piece);
          piece = word;
        } else {
          piece = candidate;
        }
      }
      if (piece !== "") pieces.push(piece);
      continue;
    }

    if (estimateTokens(current + sentence) > TARGET_TOKENS) pushCurrent();
    current += sentence;
  }

  pushCurrent();
  return pieces;
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
        if (text.length === 0) continue;

        for (const piece of splitOversized(text)) {
          blocks.push({ text: piece, page: pageNumber, section });
        }
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
  const blocks = allBlocks.slice(
    findFrontMatterEnd(allBlocks),
    findReferencesCutoff(allBlocks)
  );

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
