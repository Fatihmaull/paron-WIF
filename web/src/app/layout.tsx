import type { Metadata, Viewport } from "next";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { ProtocolProvider } from "@/lib/protocol";

export const metadata: Metadata = {
  title: { default: "Paron WIF · Flat-World Compute Exchange", template: "%s · Paron WIF" },
  description:
    "Standardized GPU compute units (1 CU = 1 H100-equivalent hour) traded on a central limit order book, secured by $WIF-boosted margin, a burn-to-vote SLA jury and a 4-engine $WIF burn flywheel.",
};

export const viewport: Viewport = { themeColor: "#000000", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ProtocolProvider>
          <AppShell>{children}</AppShell>
        </ProtocolProvider>
      </body>
    </html>
  );
}
