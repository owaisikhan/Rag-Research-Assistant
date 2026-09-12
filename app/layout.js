import "@/app/_styles/globals.css";
import { siteConfig } from "@/app/_lib/siteConfig";
import ThemeScript from "@/app/_components/shell/ThemeScript";

export const metadata = {
  title: `${siteConfig.name} — ${siteConfig.tagline}`,
  description: siteConfig.description,
};

export const viewport = {
  themeColor: "#231f1c",
};

export default function RootLayout({ children }) {
  // suppressHydrationWarning because ThemeScript sets data-theme on <html>
  // before React hydrates. Without it every light-theme visitor sees a
  // hydration warning about an attribute the server could not have known.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
