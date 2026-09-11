/**
 * Colour is never the only carrier of meaning here -- each tone also gets a
 * word, so it reads correctly in greyscale and to a colourblind user.
 */
const TONES = {
  danger: {
    label: "Error",
    className: "border-danger/40 bg-danger-soft text-ink",
  },
  info: {
    label: "Note",
    className: "border-border bg-surface-sunken text-ink-muted",
  },
};

export default function Callout({ tone = "info", children }) {
  const { label, className } = TONES[tone] ?? TONES.info;

  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${className}`} role={tone === "danger" ? "alert" : undefined}>
      <span className="font-medium">{label}: </span>
      {children}
    </div>
  );
}
