/**
 * Set the theme before first paint.
 *
 * A Server Component cannot know what the visitor chose last time -- that
 * lives in localStorage -- so without this the page renders dark, hydrates,
 * and then flips to light in front of them. Running synchronously in <head>
 * costs a few hundred bytes and removes the flash entirely.
 *
 * It also means the server never renders a theme-dependent attribute, so
 * there is nothing for React to find mismatched.
 */
// Dark unless the visitor has explicitly chosen light. Deliberately NOT
// following prefers-color-scheme: the design is built dark-first -- the
// gradients, the glow and the orb are what it is -- and someone opening the
// link on a light-mode laptop should still see the product as designed. The
// toggle is one click away in the top bar.
const SCRIPT = `
(function () {
  try {
    if (localStorage.getItem("folio-theme") === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    }
  } catch (e) {}
})();
`;

export default function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
