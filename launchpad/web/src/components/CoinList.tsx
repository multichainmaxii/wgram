"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { isConfigured } from "@/lib/config";
import { useGramUsd } from "@/lib/price";
import type { Coin, CoinsResponse } from "@/lib/types";
import { usePolling } from "@/lib/usePolling";
import { CoinCard } from "./CoinCard";

// The server scans the chain once for every visitor (and caches it); browsers only poll.
export async function fetchCoins(): Promise<Coin[]> {
  const res = await fetch("/api/coins", { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as (CoinsResponse & { error?: string }) | null;
  if (!res.ok || !Array.isArray(body?.coins)) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body.coins;
}

const SORTS = {
  top: { label: "Top", fn: (a: Coin, b: Coin) => b.mcapWgram - a.mcapWgram },
  new: { label: "New", fn: (a: Coin, b: Coin) => b.createdAt - a.createdAt },
  close: {
    label: "Graduating",
    fn: (a: Coin, b: Coin) => (b.status === "trading" ? b.progress : -1) - (a.status === "trading" ? a.progress : -1),
  },
} as const;
type Sort = keyof typeof SORTS;

export function CoinList({ limit }: { limit?: number }) {
  const { data, error } = usePolling(fetchCoins, 5000);
  const gramUsd = useGramUsd();
  const [sort, setSort] = useState<Sort>("top");
  const [query, setQuery] = useState("");

  const coins = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (data ?? [])
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q) || c.mint === query.trim())
      .sort(SORTS[sort].fn);
    return limit ? list.slice(0, limit) : list;
  }, [data, sort, query, limit]);

  if (!isConfigured) {
    return <p className="text-muted">Launchpad isn&apos;t configured. Run <code>pnpm seed</code> in launchpad/.</p>;
  }

  return (
    <section>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-line py-3">
        <div className="flex gap-6" role="tablist" aria-label="Sort coins">
          {(Object.keys(SORTS) as Sort[]).map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={sort === key}
              onClick={() => setSort(key)}
              className={`hud flex items-center gap-1.5 transition-colors ${sort === key ? "text-text" : "text-muted hover:text-text"}`}
            >
              <span className={`h-1 w-1 rounded-full ${sort === key ? "bg-accent" : "bg-transparent"}`} />
              {SORTS[key].label}
            </button>
          ))}
        </div>
        <span className="hud text-muted">
          {String(data?.length ?? 0).padStart(2, "0")} coins // live
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, ticker or address"
          aria-label="Search coins"
          className="hud ml-auto h-9 w-full border border-line bg-transparent px-3 text-text normal-case placeholder:text-muted focus:border-accent focus:outline-none sm:w-72"
        />
      </div>

      {error && !data && <p className="py-6 text-sm text-down">Couldn&apos;t load coins: {error}</p>}
      {!data && !error && <p className="hud py-6 text-muted">Loading coins…</p>}
      {data && coins.length === 0 && (
        <p className="py-6 text-sm text-muted">
          {query ? "No coin matches that." : "No coins yet."}{" "}
          <Link href="/launch" className="text-accent hover:underline">
            Launch the first one
          </Link>
        </p>
      )}

      <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 xl:grid-cols-4">
        {coins.map((c) => (
          <li key={c.pool}>
            <CoinCard coin={c} gramUsd={gramUsd} />
          </li>
        ))}
      </ul>
    </section>
  );
}
