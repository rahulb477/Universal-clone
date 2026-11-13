import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Universal Clone — authorised website archiver",
  description: "Archive websites you own or are authorised to copy: public and signed-in pages, assets and an offline-ready ZIP.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: "dark" }}>
      <body className="bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
