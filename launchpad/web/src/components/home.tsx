"use client";

import Link from "next/link";
import { useGramUsd } from "@/lib/price";
import type { Coin } from "@/lib/types";
import { usePolling } from "@/lib/usePolling";
import { CoinCard } from "./CoinCard";
import { fetchCoins } from "./CoinList";
import { coinGradient } from "./coin-ui";

function useTopCoins() {
  const { data } = usePolling(fetchCoins, 15000);
  return (data ?? []).slice().sort((a, b) => b.mcapWgram - a.mcapWgram);
}

function Art({ coin, className = "" }: { coin?: Coin; className?: string }) {
  if (coin?.image) {
    // eslint-disable-next-line @next/next/no-img-element -- creator-hosted images can't be listed in next.config
    return <img src={coin.image} alt={coin.name} className={`size-full object-cover ${className}`} />;
  }
  return <div className={`size-full ${className}`} style={{ background: coin ? coinGradient(coin.symbol) : "linear-gradient(135deg,#5EE0FF,#1668D2)" }} />;
}

// The top two coins floating over the hero art.
export function HeroCoins() {
  const top = useTopCoins().slice(0, 2);
  return (
    <>
      {top.map((coin, i) => (
        <Link
          key={coin.pool}
          href={`/coin/${coin.mint}`}
          className={`drift absolute hidden md:block ${i === 0 ? "top-[14%] right-[30%] w-44 [--r:-4deg]" : "right-[7%] bottom-[22%] w-36 [--r:5deg] [animation-delay:-3s]"}`}
        >
          <div className="cut-sm relative aspect-[4/5] overflow-hidden bg-panel-2 shadow-2xl">
            <Art coin={coin} />
            <span className="hud absolute bottom-2 left-2.5 text-[10px] text-white drop-shadow">${coin.symbol}</span>
          </div>
        </Link>
      ))}
    </>
  );
}

export function CoinCount() {
  const top = useTopCoins();
  return <>{String(top.length).padStart(2, "0")}</>;
}

export function FeaturedCoin() {
  const [coin] = useTopCoins();
  const gramUsd = useGramUsd();
  if (!coin) return <div className="cut aspect-[4/5] w-full bg-panel-2" />;
  return <CoinCard coin={coin} gramUsd={gramUsd} />;
}

// The live coins fanned out like a hand of cards.
export function CoinFan() {
  const coins = useTopCoins().slice(0, 7);
  const n = coins.length;
  if (n === 0) return <p className="hud text-center text-muted">No coins yet. Be the first.</p>;
  return (
    <div className="relative mx-auto h-[360px] max-w-4xl sm:h-[420px]">
      {coins.map((coin, i) => {
        const offset = i - (n - 1) / 2;
        return (
          <Link
            key={coin.pool}
            href={`/coin/${coin.mint}`}
            className="group absolute top-6 left-1/2 w-40 transition-transform duration-300 hover:z-10 sm:w-52"
            style={{ transform: `translateX(calc(-50% + ${offset * 92}px)) translateY(${Math.abs(offset) * 14}px) rotate(${offset * 5}deg)`, zIndex: n - Math.abs(Math.round(offset)) }}
          >
            <div className="cut-sm relative aspect-[4/5] bg-panel-2 shadow-2xl transition-transform duration-300 group-hover:-translate-y-6">
              <div className="absolute inset-0 overflow-hidden">
                <Art coin={coin} />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 pt-10">
                  <div className="display truncate text-lg text-white">{coin.name}</div>
                </div>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
