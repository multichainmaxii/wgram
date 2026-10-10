"use client";

import Link from "next/link";
import { getCoin } from "@/lib/chain";
import { age, shortAddress, usd, wgram } from "@/lib/format";
import { useGramUsd } from "@/lib/price";
import type { Trade, TradesResponse } from "@/lib/types";
import { usePolling } from "@/lib/usePolling";
import { useAppWallet } from "@/lib/wallet";
import { Avatar, PairedWithGram, Progress, StatusBadge } from "./coin-ui";
import { CreatorEarnings } from "./CreatorEarnings";
import { PriceChart } from "./PriceChart";
import { TradePanel } from "./TradePanel";
import { TradesTable } from "./TradesTable";

// Not cached by the browser so every poll sees the latest; the route sets a short
// shared-cache lifetime instead.
async function fetchTrades(mint: string): Promise<Trade[]> {
  const res = await fetch(`/api/coins/${encodeURIComponent(mint)}/trades`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Trades request failed (${res.status})`);
  return ((await res.json()) as TradesResponse).trades;
}

export function CoinView({ mint }: { mint: string }) {
  const { data, error, loaded, refresh } = usePolling(() => getCoin(mint), 4000, [mint]);
  const trades = usePolling(() => fetchTrades(mint), 5000, [mint]);
  const gramUsd = useGramUsd();
  const { publicKey } = useAppWallet();

  if (!loaded) return <p className="hud px-4 py-8 text-muted md:px-6">Loading…</p>;
  if (error && !data) return <p className="text-down">Couldn&apos;t load this coin: {error}</p>;
  if (!data) {
    return (
      <p className="text-muted">
        No coin with this address was launched here. <Link href="/explore" className="text-accent hover:underline">Back to Explore</Link>
      </p>
    );
  }

  const { coin, pool } = data;
  const toGo = Math.max(0, coin.thresholdWgram - coin.raisedWgram);

  return (
    <div className="grid gap-6 px-4 py-8 md:px-6 lg:grid-cols-[1fr_380px]">
      {/* min-w-0: on narrow phones the column keeps the screen's width instead of growing to fit the trades table */}
      <div className="min-w-0 space-y-6">
        <div className="flex items-start gap-4">
          <Avatar coin={coin} size={72} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="display text-4xl sm:text-5xl">{coin.name}</h1>
              <span className="hud text-muted">${coin.symbol}</span>
              <StatusBadge status={coin.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              <PairedWithGram />
              <span>by {shortAddress(coin.creator)}</span>
              <span>{age(coin.createdAt)}</span>
              <button className="hover:text-text" onClick={() => navigator.clipboard.writeText(coin.mint)} title="Copy token address">
                CA {shortAddress(coin.mint)} ⧉
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Market cap" value={usd(coin.mcapWgram, gramUsd)} sub={wgram(coin.mcapWgram)} />
          <Stat label="Price" value={`${coin.priceWgram.toPrecision(3)} wGRAM`} sub={usd(coin.priceWgram, gramUsd)} />
          <Stat label="Raised on curve" value={wgram(coin.raisedWgram)} sub={`of ${wgram(coin.thresholdWgram)}`} />
        </div>

        <PriceChart trades={trades.data} error={trades.error} />

        <div className="border border-line bg-panel p-5">
          <div className="mb-2 flex justify-between text-sm">
            <span className="hud text-muted">Bonding curve</span>
            <span className="text-muted">{Math.round(coin.progress * 100)}%</span>
          </div>
          <Progress coin={coin} />
          <p className="mt-3 text-sm text-muted">
            {coin.status === "graduated"
              ? "Graduated: the curve's wGRAM and remaining supply moved into a Meteora pool with liquidity locked forever."
              : coin.status === "graduating"
                ? "The curve is complete. It moves into a Meteora pool automatically, usually within a minute."
                : `${wgram(toGo)} more to graduation. When the curve fills, liquidity moves into a Meteora pool and is locked forever.`}
          </p>
        </div>

        {coin.description && (
          <div className="border border-line bg-panel p-5">
            <h2 className="hud mb-2 text-muted">About</h2>
            <p className="whitespace-pre-line text-sm text-muted">{coin.description}</p>
          </div>
        )}

        <TradesTable trades={trades.data} symbol={coin.symbol} error={trades.error} />
      </div>

      <div className="space-y-6 lg:sticky lg:top-24 lg:self-start">
        {publicKey?.toBase58() === coin.creator && <CreatorEarnings coin={coin} pool={pool} onClaimed={() => void refresh()} />}
        <TradePanel
          coin={coin}
          pool={pool}
          onTraded={() => {
            void refresh();
            void trades.refresh();
          }}
        />
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-line bg-panel p-4">
      <div className="hud text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}
