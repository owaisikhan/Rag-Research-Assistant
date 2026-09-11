export default function Spinner({ label = "Working" }) {
  return (
    <span className="inline-flex items-center gap-2 text-ink-muted">
      <span
        aria-hidden="true"
        className="size-3.5 animate-spin rounded-full border-2 border-border-strong border-t-primary"
      />
      <span className="text-xs">{label}</span>
    </span>
  );
}
