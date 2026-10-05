"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { isConfigured } from "@/lib/config";
import { age, usd, wgram } from "@/lib/format";
import { useGramUsd } from "@/lib/price";
import type { Coin, CoinsResponse } from "@/lib/types";
import { usePolling } from "@/lib/usePolling";
import { Avatar, PairedWithGram, Progress, StatusBadge } from "./coin-ui";

// The server scans the chain once for every visitor (and caches it); browsers only poll.
async function fetchCoins(): Promise<Coin[]> {
  const res = await fetch("/api/coins", { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as (CoinsResponse & { error?: string }) | null;
  if (!res.ok || !Array.isArray(body?.coins)) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body.coins;
}

const SORTS = {
  mcap: { label: "Market cap", fn: (a: Coin, b: Coin) => b.mcapWgram - a.mcapWgram },
  new: { label: "Newest", fn: (a: Coin, b: Coin) => b.createdAt - a.createdAt },
  close: {
    label: "About to graduate",
    fn: (a: Coin, b: Coin) => (b.status === "trading" ? b.progress : -1) - (a.status === "trading" ? a.progress : -1),
  },
} as const;

export function CoinGrid() {
  const { data, error } = usePolling(fetchCoins, 5000);
  const gramUsd = useGramUsd();
  const [sort, setSort] = useState<keyof typeof SORTS>("mcap");
  const [query, setQuery] = useState("");

  const coins = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? [])
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q) || c.mint === query.trim())
      .sort(SORTS[sort].fn);
  }, [data, sort, query]);

  if (!isConfigured) {
    return <p className="rounded-xl border border-line bg-panel p-6 text-muted">Launchpad isn&apos;t configured. Run <code>pnpm seed</code> in launchpad/.</p>;
  }

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {Object.entries(SORTS).map(([key, s]) => (
          <button
            key={key}
            onClick={() => setSort(key as keyof typeof SORTS)}
            className={`rounded-full px-3 py-1.5 text-sm ${sort === key ? "bg-text text-ink" : "bg-panel text-muted hover:text-text"}`}
          >
            {s.label}
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, ticker or address"
          aria-label="Search coins"
          className="ml-auto h-9 w-full rounded-full border border-line bg-panel px-4 text-sm placeholder:text-muted focus:border-accent focus:outline-none sm:w-72"
        />
      </div>

      {error && !data && <p className="text-sm text-down">Couldn&apos;t load coins: {error}</p>}
      {!data && !error && <p className="text-sm text-muted">Loading coins…</p>}
      {data && coins.length === 0 && <p className="text-sm text-muted">No coins yet. Be the first to launch one.</p>}

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {coins.map((c) => (
          <li key={c.pool}>
            <Link
              href={`/coin/${c.mint}`}
              className="flex h-full flex-col gap-3 rounded-2xl border border-line bg-panel p-4 transition-colors hover:border-accent/50 hover:bg-panel-2"
            >
              <div className="flex items-start gap-3">
                <Avatar coin={c} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">${c.symbol}</span>
                    <StatusBadge status={c.status} />
                  </div>
                  <div className="truncate text-sm text-muted">{c.name}</div>
                </div>
                <span className="text-xs text-muted">{age(c.createdAt)}</span>
              </div>
              <div className="flex items-end justify-between">
                <div>
                  <div className="text-lg font-semibold">{usd(c.mcapWgram, gramUsd)}</div>
                  <div className="text-xs text-muted">market cap · {wgram(c.mcapWgram)}</div>
                </div>
                <PairedWithGram />
              </div>
              <div className="space-y-1">
                <Progress coin={c} />
                <div className="text-[11px] text-muted">
                  {c.status === "graduated" ? "Trading on Meteora" : `${Math.round(c.progress * 100)}% to graduation`}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
