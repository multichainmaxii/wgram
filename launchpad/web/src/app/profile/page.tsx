"use client";

import Link from "next/link";
import { useState } from "react";
import { Avatar, StatusBadge } from "@/components/coin-ui";
import { CreatorEarnings } from "@/components/CreatorEarnings";
import { fetchCoins } from "@/components/CoinList";
import { connection, fromBaseUnits, getCoin, tokenBalance, wgramMint } from "@/lib/chain";
import { NETWORK, WGRAM_DECIMALS } from "@/lib/config";
import { usd, wgram } from "@/lib/format";
import { useGramUsd } from "@/lib/price";
import { usePolling } from "@/lib/usePolling";
import { useAppWallet } from "@/lib/wallet";

// The coins this wallet launched, read fresh from the chain so claim amounts are exact.
async function myCoins(owner: string) {
  const mine = (await fetchCoins()).filter((c) => c.creator === owner).sort((a, b) => b.createdAt - a.createdAt);
  const fresh = await Promise.all(mine.map((c) => getCoin(c.mint)));
  return { owner, coins: fresh.filter((x) => x !== null) };
}

export default function ProfilePage() {
  const { publicKey, account, embedded, login, logout } = useAppWallet();
  const owner = publicKey?.toBase58() ?? "";
  const { data, error, refresh } = usePolling(() => (owner ? myCoins(owner) : Promise.resolve(null)), 15000, [owner]);
  const balances = usePolling(
    async () =>
      publicKey
        ? { owner, sol: (await connection().getBalance(publicKey)) / 1e9, wgram: fromBaseUnits(await tokenBalance(publicKey, wgramMint()), WGRAM_DECIMALS) }
        : null,
    20000,
    [owner],
  );
  const gramUsd = useGramUsd();
  const [copied, setCopied] = useState(false);
  const coins = data?.owner === owner ? data.coins : null; // never show another wallet's list
  const bal = balances.data?.owner === owner ? balances.data : null;
  const total = (coins ?? []).reduce((sum, { coin }) => sum + coin.creatorFeeWgram, 0);

  return (
    <div className="px-4 py-10 md:px-6">
      <div className="hud text-muted">{"// profile"}</div>
      <h1 className="display mt-3 text-[13vw] sm:text-7xl">Profile</h1>

      {!publicKey ? (
        <div className="mt-10 max-w-xl border-t border-line pt-6">
          <p>Sign in with Telegram, email or a Solana wallet to see your wallet, the coins you launched and what they&apos;ve earned you.</p>
          <button onClick={login} className="hud mt-5 h-10 bg-text px-5 text-ink hover:opacity-85">
            Sign in
          </button>
        </div>
      ) : (
        <>
          <section className="mt-10 grid gap-px overflow-hidden border border-line bg-line sm:grid-cols-3">
            <div className="bg-ink p-5">
              <div className="hud text-muted">Signed in as</div>
              <div className="mt-2 truncate font-semibold">{account ?? "Solana wallet"}</div>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(owner);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="hud mt-2 block max-w-full truncate text-left text-muted hover:text-accent"
                title="Copy address"
              >
                {copied ? "Copied" : `${owner.slice(0, 6)}…${owner.slice(-6)} ⧉`}
              </button>
            </div>
            <div className="bg-ink p-5">
              <div className="hud text-muted">Balance</div>
              <div className="mt-2 font-semibold tabular-nums">{bal ? `${bal.sol.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL` : "…"}</div>
              <div className="hud mt-2 text-muted">{bal ? wgram(bal.wgram) : ""}</div>
            </div>
            <div className="flex flex-col items-start justify-between gap-3 bg-ink p-5">
              <div className="hud text-muted">{embedded ? "Wallet made for you at sign-in" : "Your own wallet"}</div>
              <button onClick={() => void logout()} className="hud h-9 border border-line px-4 hover:bg-panel-2">
                Sign out
              </button>
            </div>
          </section>
          {embedded && (
            <p className="hud mt-3 text-muted">
              Send SOL to the address above to trade. {NETWORK === "mainnet" ? "Your key can be exported from the sign-in window." : ""}
            </p>
          )}

          <section className="mt-14">
            <div className="flex items-end justify-between gap-4 border-b border-line pb-3">
              <h2 className="display text-3xl sm:text-4xl">Your coins</h2>
              {coins && coins.length > 0 && (
                <div className="text-right">
                  <div className="hud text-muted">Unclaimed</div>
                  <div className="font-semibold tabular-nums">
                    {wgram(total)} <span className="text-muted">≈ {usd(total, gramUsd)}</span>
                  </div>
                </div>
              )}
            </div>
            {!coins ? (
              <p className="py-6 text-muted">{error ? `Couldn't load your coins: ${error}` : "Loading your coins…"}</p>
            ) : coins.length === 0 ? (
              <p className="py-6">
                You haven&apos;t launched a coin from this wallet yet.{" "}
                <Link href="/launch" className="text-accent hover:underline">
                  Launch one
                </Link>{" "}
                and about 0.4% of every trade on its curve is yours.
              </p>
            ) : (
              <ul>
                {coins.map(({ coin, pool }) => (
                  <li key={coin.pool} className="grid gap-4 border-b border-line py-5 sm:grid-cols-[1fr_minmax(280px,380px)] sm:items-center">
                    <div className="flex items-center gap-3">
                      <Avatar coin={coin} size={48} />
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <Link href={`/coin/${coin.mint}`} className="truncate font-semibold hover:text-accent">
                            {coin.name}
                          </Link>
                          <span className="hud shrink-0 text-muted">${coin.symbol}</span>
                          <StatusBadge status={coin.status} />
                        </div>
                        <div className="hud text-muted">
                          {usd(coin.mcapWgram, gramUsd)} MC · {coin.status === "graduated" ? "graduated" : `${Math.round(coin.progress * 100)}% to graduation`}
                        </div>
                      </div>
                    </div>
                    <CreatorEarnings coin={coin} pool={pool} onClaimed={() => void refresh()} compact />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
