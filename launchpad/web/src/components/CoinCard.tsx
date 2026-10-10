import Link from "next/link";
import { age, usd } from "@/lib/format";
import type { Coin } from "@/lib/types";
import { coinGradient } from "./coin-ui";

// A coin as a card: its picture full-bleed, with its name and market cap over it.
export function CoinCard({ coin: c, gramUsd, className = "" }: { coin: Coin; gramUsd: number; className?: string }) {
  const pct = Math.round(c.progress * 100);
  return (
    <Link href={`/coin/${c.mint}`} className={`group block ${className}`}>
      <div className="cut relative aspect-[4/5] bg-panel-2">
        <div className="absolute inset-0 overflow-hidden">
          {c.image ? (
            // eslint-disable-next-line @next/next/no-img-element -- creator-hosted images can't be listed in next.config
            <img src={c.image} alt={c.name} className="size-full object-cover transition-transform duration-500 group-hover:scale-105" />
          ) : (
            <div className="grid size-full place-items-center" style={{ background: coinGradient(c.symbol) }}>
              <span className="display text-6xl text-white/90">{c.symbol.slice(0, 3)}</span>
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-4 pt-16">
            <div className="display truncate text-2xl text-white">{c.name}</div>
            <div className="hud mt-1 flex justify-between text-white/80">
              <span>${c.symbol}</span>
              <span>{usd(c.mcapWgram, gramUsd)} MC</span>
            </div>
          </div>
          {c.status !== "trading" && <span className="hud absolute top-3 right-3 rounded-full bg-up px-2 py-0.5 text-[10px] text-ink">{c.status}</span>}
        </div>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-panel-2">
        <div className={`h-full ${c.status === "trading" ? "bg-accent" : "bg-up"}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <div className="hud mt-1.5 flex justify-between text-muted">
        <span>{age(c.createdAt)}</span>
        <span>{c.status === "graduated" ? "graduated" : `${pct}% to graduation`}</span>
      </div>
    </Link>
  );
}
