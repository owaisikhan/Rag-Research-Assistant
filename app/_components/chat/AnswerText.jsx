"use client";

/**
 * Render an answer, turning [1] [2] markers into interactive citations.
 *
 * The whole product promise is "you can check this", so a citation has to be
 * a control, not decoration: clicking one reveals the exact passage the claim
 * came from. A marker pointing at a source that was not retrieved is rendered
 * as plain text rather than a dead control -- the model is instructed never
 * to do that, but an answer must not break if it does.
 */

const CITATION = /(\[\d+\])/g;

export default function AnswerText({ text, sources, onCite, activeNumber }) {
  const byNumber = new Map(sources.map((source) => [source.number, source]));

  // Blank lines separate paragraphs; the model writes plain prose.
  const paragraphs = text.split(/\n{2,}/);

  return (
    <div className="answer-prose">
      {paragraphs.map((paragraph, paragraphIndex) => (
        <p key={paragraphIndex}>
          {paragraph.split(CITATION).map((part, partIndex) => {
            const match = part.match(/^\[(\d+)\]$/);
            if (!match) return <span key={partIndex}>{part}</span>;

            const number = Number(match[1]);
            const source = byNumber.get(number);

            if (!source) return <span key={partIndex}>{part}</span>;

            const isActive = activeNumber === number;

            return (
              <button
                key={partIndex}
                type="button"
                onClick={() => onCite(number)}
                aria-label={`Source ${number}: ${source.title}`}
                title={source.title}
                /* inline, not inline-flex: a flex box with a min-width is a
                   large breakable unit, so the marker wraps onto its own line
                   and leaves a gap before the following punctuation. */
                className={`ml-0.5 inline rounded px-1 py-px align-super text-[0.6rem] font-semibold leading-none transition-colors ${
                  isActive
                    ? "bg-primary text-white"
                    : "bg-primary-soft text-primary hover:bg-primary hover:text-white"
                }`}
              >
                {number}
              </button>
            );
          })}
        </p>
      ))}
    </div>
  );
}
