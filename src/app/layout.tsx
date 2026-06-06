import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { CosmosMotionConfig } from "@/components/ui/motion-config";
import { WebVitalsReporter } from "@/components/telemetry/web-vitals";
import { ChunkReloadGuard } from "@/components/telemetry/chunk-reload-guard";
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

export const metadata: Metadata = {
  title: "COSMOS — Enterprise Project Management",
  description:
    "Multi-tenant project management platform with boards, OKRs, CRM, and more.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "COSMOS",
    statusBarStyle: "black-translucent",
  },
};

// `viewportFit: "cover"` activates safe-area-inset-* CSS env vars (iOS notch
// and home-indicator) so the mobile bottom nav and dialog bottom-sheets can
// respect them.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0B0E1A",
};

/**
 * Inline script that runs synchronously before any paint, reads the `theme`
 * cookie, and applies the matching `dark`/`light` class to <html>. This
 * keeps RootLayout a pure synchronous server component (no `cookies()`
 * call), which is required by Next.js 16 Cache Components — cookie reads
 * outside <Suspense> are not permitted.
 *
 * The default class is `dark` (set below on <html>); the script flips it to
 * `light` only if the cookie says so, so there's no FOUC.
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
      className={`${inter.variable} ${jetBrainsMono.variable} dark h-full`}
      suppressHydrationWarning
    >
      <head>
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
