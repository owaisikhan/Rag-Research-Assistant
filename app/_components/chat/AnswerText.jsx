"use client";

/**
 * Render an answer: light markdown, with [1] [2] markers as live citations.
 *
 * The whole product promise is "you can check this", so a citation has to be a
 * control rather than decoration -- clicking one reveals the passage the claim
 * came from. A marker pointing at a source that was not retrieved renders as
 * plain text instead of a dead button; the model is told never to do that, but
 * an answer must not break if it does.
 *
 * Markdown is parsed into React elements rather than injected as HTML. Model
 * output is untrusted text: dangerouslySetInnerHTML here would be an XSS hole
 * wherever a document contains something that looks like markup. It also keeps
 * the supported subset deliberately small -- headings, lists, bold, code --
 * which is everything a cited answer actually uses.
 */

const CITATION = /(\[\d+\])/g;
const INLINE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`)/g;

/** Bold, inline code, and citations, in that order of nesting. */
function renderInline(text, { byNumber, onCite, activeNumber, keyPrefix }) {
  return text.split(INLINE).map((segment, segmentIndex) => {
    const key = `${keyPrefix}-${segmentIndex}`;

    if (segment.startsWith("**") && segment.endsWith("**")) {
      return (
        <strong key={key} className="font-semibold">
          {renderCitations(segment.slice(2, -2), { byNumber, onCite, activeNumber, keyPrefix: key })}
        </strong>
      );
    }

    // Italic: *text* or _text_. Checked after bold, since ** also starts *.
    const isItalic =
      (segment.startsWith("*") && segment.endsWith("*") && segment.length > 2) ||
      (segment.startsWith("_") && segment.endsWith("_") && segment.length > 2);

    if (isItalic) {
      return (
        <em key={key} className="italic">
          {renderCitations(segment.slice(1, -1), { byNumber, onCite, activeNumber, keyPrefix: key })}
        </em>
      );
    }

    if (segment.startsWith("`") && segment.endsWith("`")) {
      return (
        <code
          key={key}
          className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[0.85em]"
        >
          {segment.slice(1, -1)}
        </code>
      );
    }

    return (
      <span key={key}>
        {renderCitations(segment, { byNumber, onCite, activeNumber, keyPrefix: key })}
      </span>
    );
  });
}

function renderCitations(text, { byNumber, onCite, activeNumber, keyPrefix }) {
  return text.split(CITATION).map((part, partIndex) => {
    const key = `${keyPrefix}-c${partIndex}`;
    const match = part.match(/^\[(\d+)\]$/);
    if (!match) return <span key={key}>{part}</span>;

    const number = Number(match[1]);
    const source = byNumber.get(number);
    if (!source) return <span key={key}>{part}</span>;

    const isActive = activeNumber === number;

    return (
      <button
        key={key}
        type="button"
        onClick={() => onCite(number)}
        aria-label={`Source ${number}: ${source.title}`}
        title={source.title}
        /* inline, not inline-flex: a flex box with a min-width is a large
           breakable unit, so the marker wraps onto its own line and leaves a
           gap before the following punctuation. */
        className={`ml-0.5 inline rounded px-1 py-px align-super text-[0.6rem] font-semibold leading-none transition-colors ${
          isActive
            ? "bg-primary text-white"
            : "bg-primary-soft text-primary hover:bg-primary hover:text-white"
        }`}
      >
        {number}
      </button>
    );
  });
}

/**
 * Group lines into blocks. Deliberately line-based rather than a real parser:
 * the supported subset is small and closed, and a parser would be more code
 * defending against markdown this never receives.
 */
/**
 * Strip TeX math delimiters, keeping what is between them.
 *
 * The prompt asks for plain prose, but a model reading a mathematics paper
 * will sometimes mirror its notation anyway. Rendering "$\\sqrt{d_k}$"
 * verbatim looks like the page is broken, and a reader cannot tell whether the
 * document or the app is at fault. Unwrapping at least leaves something
 * readable. Full math rendering is a larger job than this demo needs.
 */
function stripMathDelimiters(text) {
  return text
    .replace(/\$\$([^$]+)\$\$/g, "$1")
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/\\(?:text|mathrm|mathbf)\{([^}]*)\}/g, "$1")
    .replace(/\\sqrt\{([^}]*)\}/g, "the square root of $1")
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "$1/$2");
}

function toBlocks(text) {
  const blocks = [];
  let list = null;

  const closeList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const rawLine of stripMathDelimiters(text).split("\n")) {
    const line = rawLine.trim();

    if (line === "") {
      closeList();
      continue;
    }

    // A horizontal rule carries no meaning inside a short answer and renders
    // as three literal dashes if ignored. Dropped rather than drawn.
    if (/^([-*_])\1{2,}$/.test(line.replace(/\s/g, ""))) {
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (list?.type !== "bullets") {
        closeList();
        list = { type: "bullets", items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }

    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (list?.type !== "numbers") {
        closeList();
        list = { type: "numbers", items: [] };
      }
      list.items.push(numbered[1]);
      continue;
    }

    // A plain line continues the previous paragraph rather than starting a
    // new one: the model wraps prose, and one <p> per wrapped line would
    // render the answer as a column of fragments.
    closeList();
    const previous = blocks[blocks.length - 1];
    if (previous?.type === "paragraph") previous.text += ` ${line}`;
    else blocks.push({ type: "paragraph", text: line });
  }

  closeList();
  return blocks;
}

export default function AnswerText({ text, sources, onCite, activeNumber }) {
  const byNumber = new Map(sources.map((source) => [source.number, source]));
  const context = { byNumber, onCite, activeNumber };

  return (
    <div className="answer-prose">
      {toBlocks(text).map((block, index) => {
        const inline = (value, prefix) =>
          renderInline(value, { ...context, keyPrefix: `${index}-${prefix}` });

        if (block.type === "heading") {
          // Every level renders at one visual weight. An answer is a few
          // hundred words; a heading hierarchy inside it is noise, and the
          // model's choice of ## versus ### is arbitrary anyway.
          return (
            <p key={index} className="mt-4 mb-1 font-semibold text-ink">
              {inline(block.text, "h")}
            </p>
          );
        }

        if (block.type === "bullets" || block.type === "numbers") {
          const List = block.type === "bullets" ? "ul" : "ol";
          return (
            <List key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item, `l${itemIndex}`)}</li>
              ))}
            </List>
          );
        }

        return <p key={index}>{inline(block.text, "p")}</p>;
      })}
    </div>
  );
}
