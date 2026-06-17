import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { CosmosMotionConfig } from "@/components/ui/motion-config";
import { WebVitalsReporter } from "@/components/telemetry/web-vitals";
import { ChunkReloadGuard } from "@/components/telemetry/chunk-reload-guard";
import { getBrand } from "@/lib/brand";
import { SKIN_CSS } from "@/lib/theme/skins";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

const brand = getBrand();

export const metadata: Metadata = {
  title: brand.title,
  description: brand.description,
  appleWebApp: {
    capable: true,
    title: brand.name,
    statusBarStyle: "black-translucent",
  },
};

// `viewportFit: "cover"` activates safe-area-inset-* CSS env vars (iOS notch
// and home-indicator) so the mobile bottom nav and dialog bottom-sheets can
// respect them. `app/manifest.ts` supplies the manifest link automatically.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: brand.themeColor,
};

/**
 * Inline script that runs synchronously before any paint, reads the `theme`
 * cookie, and applies the matching `dark`/`light` class to <html>. This
 * keeps RootLayout a pure synchronous server component (no `cookies()`
 * call), which is required by Next.js 16 Cache Components — cookie reads
 * outside <Suspense> are not permitted.
 *
 * The default class comes from the product profile's htmlThemeClass (cosmos:
 * `dark`; a skinned product like Pontis: its own base, e.g. `pontis` = atelier
 * light). The script removes dark/light and re-applies per the cookie, so the
 * light/dark toggle works for every product with no FOUC.
 */
const themeInitScript = `
(function() {
  try {
    var m = document.cookie.match(/(^| )theme=([^;]+)/);
    var theme = m ? decodeURIComponent(m[2]) : null;
    document.documentElement.classList.remove('dark', 'light');
    if (theme === 'light') {
      document.documentElement.classList.add('light');
    } else if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    }
    // No class for 'system' or unset — CSS @media (prefers-color-scheme) handles it.
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetBrainsMono.variable} ${brand.htmlThemeClass} h-full`}
      suppressHydrationWarning
    >
      <head>
        {/* Product skin (e.g. Pontis atelier): SSR-inject the token override +
            drafting backdrop + type in the initial HTML (no FOUC), scoped to
            :root.<product>. The skin ships BOTH light and dark palettes, so the
            theme bootstrap below still runs and the light/dark toggle works. */}
        {brand.skin && (
          <style dangerouslySetInnerHTML={{ __html: SKIN_CSS[brand.skin] }} />
        )}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-[var(--bg)] text-[var(--text)] antialiased">
        <WebVitalsReporter />
        <ChunkReloadGuard />
        <CosmosMotionConfig>{children}</CosmosMotionConfig>
      </body>
    </html>
  );
}
