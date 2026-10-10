import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import Link from "next/link";
import { Header } from "@/components/Header";
import { BOOT_SCRIPT, BootScreen, LeftRail } from "@/components/HudFrame";
import { Providers } from "@/components/Providers";
import { BRAND, NETWORK, SOURCE_URL, SOCIAL_TELEGRAM, SOCIAL_X, WGRAM_MINT, WGRAM_SOL_POOL } from "@/lib/config";
import "./globals.css";

// Archivo's width axis gives the extra-wide display type; Plex Mono the console labels.
const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
  // Base for og:image and twitter:image URLs. Without it, production builds off Vercel
  // would point link previews at localhost.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: `${BRAND.name}: ${BRAND.tagline}`,
  description: "Launch and trade coins paired with GRAM, Telegram's coin, on Solana.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The boot script may set data-booted before React hydrates.
    <html lang="en" className={`${archivo.variable} ${plexMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <BootScreen />
        <LeftRail />
        <Providers>
          <div className="flex min-h-full flex-1 flex-col md:pl-11">
            <Header />
            <main className="w-full flex-1">{children}</main>
            <Footer />
          </div>
        </Providers>
      </body>
    </html>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  const cls = "hud block py-0.5 text-text hover:text-accent";
  return href.startsWith("/") ? (
    <Link href={href} className={cls}>
      {children}
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {children}
    </a>
  );
}

function Footer() {
  const explorer = NETWORK === "mainnet" ? "" : NETWORK === "devnet" ? "?cluster=devnet" : null;
  return (
    <footer className="mt-24 border-t border-line">
      <div className="grid gap-10 px-4 py-12 sm:grid-cols-3 md:px-6">
        <div>
          <div className="hud text-muted">Discover more</div>
          <div className="mt-3">
            <FooterLink href="/explore">Explore</FooterLink>
            <FooterLink href="/launch">Launch a coin</FooterLink>
            <FooterLink href="/profile">Profile</FooterLink>
            <FooterLink href="/get-wgram">Get wGRAM</FooterLink>
          </div>
        </div>
        <div>
          <div className="hud text-muted">Join the conversation</div>
          <div className="mt-3">
            {SOCIAL_X && <FooterLink href={SOCIAL_X}>X / Twitter</FooterLink>}
            {SOCIAL_TELEGRAM && <FooterLink href={SOCIAL_TELEGRAM}>Telegram</FooterLink>}
            <FooterLink href={SOURCE_URL}>Source code</FooterLink>
          </div>
        </div>
        <div>
          <div className="hud text-muted">More details</div>
          <div className="mt-3">
            {WGRAM_MINT && explorer !== null && <FooterLink href={`https://solscan.io/token/${WGRAM_MINT}${explorer}`}>wGRAM token</FooterLink>}
            {WGRAM_SOL_POOL && <FooterLink href={`https://app.meteora.ag/dlmm/${WGRAM_SOL_POOL}`}>wGRAM/SOL pool</FooterLink>}
          </div>
        </div>
      </div>
      <div aria-hidden className="display overflow-hidden px-4 text-[18vw] leading-[0.8] text-panel-2 select-none md:px-6">ongram</div>
      <p className="hud border-t border-line px-4 py-5 text-[10px] leading-relaxed text-muted md:px-6">
        Coins launched here are created by users and are highly speculative. wGRAM is GRAM bridged from TON and is not issued by
        Telegram or the TON Foundation; this site is independent and not affiliated with them. Nothing here is financial advice.
        © {new Date().getFullYear()} {BRAND.name}
      </p>
    </footer>
  );
}
