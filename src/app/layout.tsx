import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { RegisterSW } from "@/components/RegisterSW";

// Self-hosted Plus Jakarta Sans (variable 400 to 700, SIL Open Font License). No build-time network fetch.
const jakarta = localFont({
  src: "./fonts/PlusJakartaSans-latin.woff2",
  weight: "400 700",
  variable: "--font-jakarta",
  display: "swap",
  declarations: [{ prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" }],
});
const jakartaExt = localFont({
  src: "./fonts/PlusJakartaSans-latin-ext.woff2",
  weight: "400 700",
  variable: "--font-jakarta-ext",
  display: "swap",
  declarations: [{ prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF" }],
});

export const metadata: Metadata = {
  title: "DLV | Mitrex shipping portal",
  description: "Book loads and follow live status.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "DLV", statusBarStyle: "black-translucent" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = { themeColor: "#020814", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${jakartaExt.variable}`}>
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
