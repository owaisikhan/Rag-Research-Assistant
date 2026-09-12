import Icon from "../ui/Icon";

/**
 * The navigation rail.
 *
 * DECORATION, not navigation. This product is one screen; the rail exists
 * because the reference design has one and because a pitch reads better when
 * the shell looks like a product. So the items are rendered as plain spans
 * rather than buttons: no pointer cursor, no focus ring, nothing that invites
 * a click it cannot answer. A dead button is worse than no button; a mark that
 * was never clickable is just furniture.
 *
 * Server Component -- there is no state and no handler here any more.
 */
const ITEMS = [
  { id: "overview", icon: "grid" },
  { id: "magic", icon: "sparkle" },
  { id: "assistant", icon: "bot", active: true },
  { id: "insights", icon: "pulse" },
  { id: "billing", icon: "card" },
  { id: "settings", icon: "sliders" },
];

export default function Sidebar() {
  return (
    <div className="pointer-events-none hidden lg:block">
      {/* The mark sits outside the rail, top-left of the viewport, as in the
          reference. It is the one thing in this column that carries meaning,
          so it keeps its label while the rest is hidden from assistive tech. */}
      <span className="brand-gradient fixed left-7 top-7 z-10 flex h-11 w-11 items-center justify-center rounded-2xl text-white shadow-lg">
        <Icon name="gem" className="h-5 w-5" />
        <span className="sr-only">Folio</span>
      </span>

      {/* aria-hidden: there is one page, and announcing six unlabelled marks
          would be noise. */}
      <div aria-hidden="true">
      <div className="brand-gradient rail fixed left-0 top-1/2 z-10 flex w-[5.5rem] -translate-y-1/2 flex-col items-center gap-2 rounded-r-[2rem] py-7">
        {/* The inverted corners, where the page background curves into the
            rail. Two squares of rail colour with a rounded cut-out of page
            colour laid over each -- there is no border-radius that curves
            outward, so this is the way it is done. */}
        <span className="rail-notch rail-notch-top" />
        <span className="rail-notch rail-notch-bottom" />

        {ITEMS.map((item) => (
          <span
            key={item.id}
            className={`flex h-12 w-12 items-center justify-center rounded-2xl ${
              item.active ? "bg-white/25 text-white" : "text-white/70"
            }`}
          >
            <Icon name={item.icon} className="h-5.5 w-5.5" strokeWidth={1.6} />
          </span>
        ))}
      </div>

        {/* Detached from the rail, as in the reference. */}
        <span className="brand-gradient fixed bottom-7 left-7 flex h-12 w-12 items-center justify-center rounded-full text-white shadow-xl">
          <Icon name="sparkle" className="h-5 w-5" />
        </span>
      </div>
    </div>
  );
}
