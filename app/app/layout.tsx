import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SEO Cockpit",
  description: "Internal SEO dashboard for Search Console and Core Web Vitals data.",
};

// Sets the `.dark` class from the OS colour-scheme before first paint, so
// Bklit's dark chart CSS variables (which live under `.dark`, not a media
// query) apply immediately instead of flashing light. No user-facing toggle
// yet — this only wires the app to follow the OS, same as before — but a
// later toggle just needs to set the same class + persist a preference.
//
// Rendered as a plain inline `<script>` in `<head>` (not `next/script`):
// the browser executes an inline `<head>` script synchronously during HTML
// parsing, before first paint, which is what "render-blocking" requires
// here. `next/script`'s `beforeInteractive` strategy does not guarantee
// that — see node_modules/next/dist/docs/.../preventing-flash-before-hydration.md
// ("Themes"), which uses exactly this pattern.
const THEME_INIT_SCRIPT = `
  try {
    var isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", isDark);
  } catch (e) {}
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
