import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "JointStores", description: "Store money — Fortville pilot" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false, themeColor: "#0f1117" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
