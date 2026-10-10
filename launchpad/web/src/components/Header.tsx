"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BRAND, NETWORK } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { useAppWallet } from "@/lib/wallet";

const NAV = [
  { href: "/explore", label: "Explore" },
  { href: "/launch", label: "Launch" },
  { href: "/profile", label: "Profile" },
];

export function Logo({ size = 30 }: { size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element -- a tiny static SVG gains nothing from next/image
  return <img src="/logo.svg" alt="" width={size} height={size} className="shrink-0 rounded-[24%]" />;
}

// "ongram.fun" with the ".fun" softened, the way the domain reads.
export function Wordmark() {
  const dot = BRAND.name.indexOf(".");
  if (dot < 0) return <>{BRAND.name}</>;
  return (
    <>
      {BRAND.name.slice(0, dot)}
      <span className="text-muted">{BRAND.name.slice(dot)}</span>
    </>
  );
}

const chamfer = { clipPath: "polygon(9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%, 0 9px)" };

function WalletButton() {
  const { ready, publicKey, account, login } = useAppWallet();
  if (!publicKey) {
    return (
      <button onClick={login} disabled={!ready} style={chamfer} className="hud h-9 shrink-0 bg-text px-4 text-ink transition-opacity hover:opacity-85 disabled:opacity-50">
        Sign in
      </button>
    );
  }
  return (
    <Link href="/profile" style={chamfer} className="hud flex h-9 max-w-[9.5rem] shrink-0 items-center gap-2 truncate bg-panel-2 px-3 text-text hover:bg-line sm:max-w-none sm:px-4">
      <span className="h-1.5 w-1.5 rounded-full bg-up" />
      {account ?? shortAddress(publicKey.toBase58())}
    </Link>
  );
}

export function Header() {
  const path = usePathname();
  const links = NAV.map((n) => {
    const active = path === n.href || path.startsWith(`${n.href}/`);
    return (
      <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} className={`hud flex items-center gap-1.5 py-1 transition-colors ${active ? "text-text" : "text-muted hover:text-text"}`}>
        <span className={`h-1 w-1 rounded-full ${active ? "bg-accent" : "bg-transparent"}`} />
        {n.label}
      </Link>
    );
  });

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-header backdrop-blur-[25px]">
      <div className="flex h-14 items-center gap-3 px-4 sm:gap-6 md:px-6">
        <Link href="/" className="flex items-center gap-2 text-[17px] font-bold tracking-tight" style={{ fontStretch: "112%" }}>
          <Logo size={28} />
          <span>
            <Wordmark />
          </span>
        </Link>
        {NETWORK !== "mainnet" && <span className="hud hidden rounded-full border border-accent/40 px-2 py-0.5 text-[10px] text-accent sm:inline">{NETWORK}</span>}
        <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-8 md:flex">{links}</nav>
        <div className="ml-auto flex items-center gap-2">
          <WalletButton />
        </div>
      </div>
      <nav className="flex justify-center gap-8 border-t border-line py-2 md:hidden">{links}</nav>
    </header>
  );
}
