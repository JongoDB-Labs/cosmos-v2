import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
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

// Metadata + viewport read getBrand() at REQUEST time so a one-image deployment
// gets the runtime product's <title>/theme-color (e.g. PRODUCT=pontis → "Pontis",
// not the build-baked cosmos default). Under Cache Components, generateMetadata
// reading runtime data needs a dynamic marker in the tree — the RootBrandProvider
// (`await connection()` inside <Suspense>, in the body below) is that marker, so
// the static shell still prerenders while these stream per-request.
// (The <html> skin-class below still uses the build default; the no-FOUC script /
// login skin effect correct it at runtime — a first-paint-only nuance.)
export async function generateMetadata(): Promise<Metadata> {
  await connection(); // halt prerender → getBrand() reads the runtime PRODUCT env
  const b = getBrand();
  return {
    title: b.title,
    description: b.description,
    appleWebApp: {
      capable: true,
      title: b.name,
      statusBarStyle: "black-translucent",
    },
  };
}

// `viewportFit: "cover"` activates safe-area-inset-* CSS env vars (iOS notch
// and home-indicator) so the mobile bottom nav and dialog bottom-sheets can
// respect them. `app/manifest.ts` supplies the manifest link automatically.
// Viewport stays STATIC (build-baked themeColor): `connection()` here forces a
// fully-dynamic viewport, which Next disallows for prerendered routes (build
// error). themeColor is a deferred one-image minor (cosmos accent on a pontis
// deploy); the title — the visible white-label surface — is fixed via the
// runtime generateMetadata above.
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
          {/* fallback=null (NOT {children}): connection() defers with no I/O so
              the branded subtree resolves same-tick; rendering {children} in both
              the fallback and the resolved subtree double-mounts + remounts the
              page (recoverable hydration #419) — the lesson the dashboard layout
              already documents. */}
          <Suspense fallback={null}>
            <RootBrandProvider>{children}</RootBrandProvider>
          </Suspense>
        </CosmosMotionConfig>
      </body>
    </html>
  );
}
