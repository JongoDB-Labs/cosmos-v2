import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import localFont from "next/font/local";
import { CosmosMotionConfig } from "@/components/ui/motion-config";
import { WebVitalsReporter } from "@/components/telemetry/web-vitals";
import { ChunkReloadGuard } from "@/components/telemetry/chunk-reload-guard";
import { getBrand } from "@/lib/brand";
import { allSkinsCss, getSkinPreset } from "@/lib/theme/skins";
import { RootBrandProvider } from "@/components/providers/root-brand-provider";
import "./globals.css";

// SELF-HOSTED, not next/font/google (changed 2026-08-10).
//
// next/font/google downloads every face AT BUILD TIME, which put Google in the
// critical path of shipping. On 2026-08-10 fonts.gstatic.com started returning
// 404 for IBM Plex Sans v23 files — same version, rotated hashes — and three
// separate CI runs died with "Module not found: can't resolve
// @vercel/turbopack-next/internal/font/google/font", blocking a merge each time.
// Verified externally: the exact URL CI requested 404s from a laptop too, while
// the css2 API still serves the family. Nothing was wrong with our code.
//
// Two things that buys, beyond not being flaky:
//   - builds are REPRODUCIBLE — the same commit cannot build today and fail
//     tomorrow because a CDN rotated a filename
//   - builds work AIR-GAPPED, which the sideload path in ADR 0004 depends on;
//     previously `docker build` needed egress to Google or it failed outright
//
// The files are latin-only subsets pulled from Google's own CDN: 288 KB for all
// eleven. All seven families are OFL-1.1 or Apache-2.0, so redistribution here
// is permitted. To refresh one, re-fetch the latin @font-face from
// fonts.googleapis.com/css2 and replace the file — the API shape below does not
// change.
const inter = localFont({
  src: "./fonts/inter-variable.woff2",
  variable: "--font-sans",
  weight: "100 900",
  display: "swap",
});

const jetBrainsMono = localFont({
  src: "./fonts/jetbrains-mono-variable.woff2",
  variable: "--font-mono",
  weight: "100 800",
  display: "swap",
});

const archivoNarrow = localFont({
  src: [
    { path: "./fonts/archivo-narrow-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/archivo-narrow-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/archivo-narrow-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-field",
  display: "swap",
});

const sourceSerif = localFont({
  src: "./fonts/source-serif-4-variable.woff2",
  variable: "--font-ledger",
  weight: "200 900",
  display: "swap",
});

const ibmPlexSans = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-clinical",
  display: "swap",
});

const spaceGrotesk = localFont({
  src: "./fonts/space-grotesk-variable.woff2",
  variable: "--font-studio",
  weight: "300 700",
  display: "swap",
});

// Atelier was the one sector skin with no face of its own, so it fell through to
// Inter and leaned on stylistic sets to approximate a drafting-office grotesque.
// A geometric humanist with a large x-height carries that look directly.
const plusJakartaSans = localFont({
  src: "./fonts/plus-jakarta-sans-variable.woff2",
  variable: "--font-atelier",
  weight: "200 800",
  display: "swap",
});

const brand = getBrand();
const defaultSkin = getSkinPreset(brand.defaultSkinId).id;
const skinCss = allSkinsCss();

// Metadata + viewport read getBrand() at REQUEST time so a one-image deployment
// gets the runtime product's <title>/theme-color (e.g. PRODUCT=<brand> → that brand's name,
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
// error). themeColor is a deferred one-image minor (cosmos accent on an alternate-brand
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
 * `skin-atelier` for the atelier brand); the script corrects it at runtime if the
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
      className={`${inter.variable} ${jetBrainsMono.variable} ${archivoNarrow.variable} ${sourceSerif.variable} ${ibmPlexSans.variable} ${spaceGrotesk.variable} ${plusJakartaSans.variable} skin-${defaultSkin} h-full`}
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
