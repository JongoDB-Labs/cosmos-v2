import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import { CosmosMotionConfig } from "@/components/ui/motion-config";
import { WebVitalsReporter } from "@/components/telemetry/web-vitals";
import { ChunkReloadGuard } from "@/components/telemetry/chunk-reload-guard";
import { getBrand } from "@/lib/brand";
import { allSkinsCss, getSkinPreset } from "@/lib/theme/skins";
import { RootBrandProvider } from "@/components/providers/root-brand-provider";
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
const defaultSkin = getSkinPreset(brand.defaultSkinId).id;
const skinCss = allSkinsCss();

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
 * Inline script that runs synchronously before any paint to prevent FOUC.
 * It reads the `theme` and `skin` cookies and applies `light`/`dark` and
 * `skin-<id>` classes to <html>. The SSR-rendered class on <html> uses the
 * active product's `defaultSkinId` (e.g. `skin-universe` for cosmos,
 * `skin-atelier` for Pontis); the script corrects it at runtime if the
 * user's cookie differs. RootLayout stays a pure synchronous server component
 * (no `cookies()` call) — required by Next.js 16 Cache Components.
 */
const themeInitScript = `
(function(){try{
  var d=document.documentElement, c=document.cookie;
  var t=(c.match(/(^| )theme=([^;]+)/)||[])[2];
  var s=(c.match(/(^| )skin=([^;]+)/)||[])[2];
  d.classList.remove('dark','light');
  if(t==='light')d.classList.add('light');else if(t==='dark')d.classList.add('dark');
  if(s){d.className=d.className.replace(/\\bskin-[\\w-]+\\b/g,'').trim();d.classList.add('skin-'+decodeURIComponent(s));}
}catch(e){}})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetBrainsMono.variable} skin-${defaultSkin} h-full`}
      suppressHydrationWarning
    >
      <head>
        <style dangerouslySetInnerHTML={{ __html: skinCss }} />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-[var(--bg)] text-[var(--text)] antialiased">
        <WebVitalsReporter />
        <ChunkReloadGuard />
        <CosmosMotionConfig>
          <Suspense fallback={children}>
            <RootBrandProvider>{children}</RootBrandProvider>
          </Suspense>
        </CosmosMotionConfig>
      </body>
    </html>
  );
}
