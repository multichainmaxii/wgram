"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BRAND, NETWORK } from "@/lib/config";

// Rendered client-side only: the button's label depends on wallet state.
const WalletMultiButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), {
  ssr: false,
});

const NAV = [
  { href: "/", label: "Coins" },
  { href: "/launch", label: "Launch" },
  { href: "/get-wgram", label: "Get wGRAM" },
];

export function Header() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ink/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-accent text-sm font-bold text-ink">G</span>
          <span className="text-lg">{BRAND.name}</span>
        </Link>
        {NETWORK !== "mainnet" && (
          <span className="rounded-full border border-accent/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent">
            {NETWORK}
          </span>
        )}
        <nav className="hidden items-center gap-1 sm:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
                path === n.href ? "bg-panel-2 text-text" : "text-muted hover:text-text"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto">
          <WalletMultiButton />
        </div>
      </div>
      <nav className="flex gap-1 border-t border-line px-4 py-2 sm:hidden">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={`rounded-full px-3 py-1 text-sm ${path === n.href ? "bg-panel-2" : "text-muted"}`}>
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
