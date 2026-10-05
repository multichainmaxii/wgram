import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Header } from "@/components/Header";
import { Providers } from "@/components/Providers";
import { BRAND } from "@/lib/config";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  // Base for og:image and twitter:image URLs. Without it, production builds off Vercel
  // would point link previews at localhost.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: `${BRAND.name}: ${BRAND.tagline}`,
  description: "Launch and trade coins paired with GRAM, Telegram's coin, on Solana.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
          <footer className="border-t border-line px-4 py-6 text-center text-xs text-muted">
            Coins launched here are created by users and are highly speculative. wGRAM is GRAM bridged
            from TON and is not issued by Telegram or the TON Foundation. Nothing here is financial advice.
          </footer>
        </Providers>
      </body>
    </html>
  );
}
