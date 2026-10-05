import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { RegisterSW } from "@/components/RegisterSW";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-jakarta", display: "swap",
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
    <html lang="en" className={jakarta.variable}>
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
