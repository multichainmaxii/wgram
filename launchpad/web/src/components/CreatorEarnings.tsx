"use client";

import { useEffect, useState } from "react";
import type { Transaction } from "@solana/web3.js";
import {
  buildCreatorFeeClaim,
  buildCreatorSurplusClaim,
  confirmSignature,
  connection,
  fromBaseUnits,
  mayHaveSurplus,
  simulatedWgramGain,
  type Coin,
  type PoolAccount,
} from "@/lib/chain";
import { NETWORK, WGRAM_DECIMALS, WGRAM_MINT } from "@/lib/config";
import { usd, wgram } from "@/lib/format";
import { useGramUsd } from "@/lib/price";
import { useAppWallet } from "@/lib/wallet";

// What the connected wallet has earned as this coin's creator, with buttons to claim it.
// Render it only for the creator: the program rejects claims from anyone else.
export function CreatorEarnings({ coin, pool, onClaimed, compact = false }: { coin: Coin; pool: PoolAccount; onClaimed: () => void; compact?: boolean }) {
  const { publicKey, sendTransaction } = useAppWallet();
  const gramUsd = useGramUsd();
  const [busy, setBusy] = useState<"fees" | "surplus" | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  // The graduation surplus, read from a simulation; tagged with the pool it was read for.
  const [surplus, setSurplus] = useState<{ pool: string; amount: bigint } | null>(null);

  const fees = BigInt(pool.account.poolState.creatorQuoteFee.toString());
  const surplusDue = mayHaveSurplus(pool);
  const surplusAmount = surplus?.pool === pool.publicKey.toBase58() ? surplus.amount : 0n;

  useEffect(() => {
    if (!publicKey || !surplusDue) return;
    let cancelled = false;
    buildCreatorSurplusClaim(publicKey, pool)
      .then((tx) => simulatedWgramGain(tx, publicKey))
      .then((amount) => !cancelled && setSurplus({ pool: pool.publicKey.toBase58(), amount }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [publicKey, pool, surplusDue]);

  async function claim(kind: "fees" | "surplus", build: () => Promise<Transaction>, amount: bigint) {
    if (!publicKey) return;
    setBusy(kind);
    setStatus(null);
    try {
      const tx = await build();
      const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash();
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;
      const signature = await sendTransaction(tx);
      await confirmSignature(connection(), signature, lastValidBlockHeight);
      setStatus({ ok: true, text: `Claimed ${wgram(fromBaseUnits(amount, WGRAM_DECIMALS))} to your wallet.` });
      if (kind === "surplus") setSurplus({ pool: pool.publicKey.toBase58(), amount: 0n });
      onClaimed();
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message.split("\n")[0] });
    } finally {
      setBusy(null);
    }
  }

  if (!publicKey) return null;
  const feesWgram = fromBaseUnits(fees, WGRAM_DECIMALS);
  const surplusWgram = fromBaseUnits(surplusAmount, WGRAM_DECIMALS);
  const button = "rounded-full bg-accent px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-accent-strong disabled:opacity-50";

  return (
    <div className={compact ? "" : "border border-line bg-panel p-5"}>
      {!compact && (
        <>
          <h2 className="hud text-muted">Your earnings</h2>
          <p className="mt-1 text-sm text-muted">You launched ${coin.symbol}, so about 0.4% of every trade on its curve is yours.</p>
        </>
      )}

      <div className={`flex items-center justify-between gap-3 ${compact ? "" : "mt-4"}`}>
        <div>
          <div className="text-lg font-semibold tabular-nums">{wgram(feesWgram)}</div>
          <div className="text-xs text-muted">{fees > 0n ? `≈ ${usd(feesWgram, gramUsd)} unclaimed trading fees` : "No unclaimed trading fees right now"}</div>
        </div>
        <button disabled={fees === 0n || busy !== null} onClick={() => claim("fees", () => buildCreatorFeeClaim(publicKey, pool), fees)} className={button}>
          {busy === "fees" ? "Confirm in wallet…" : "Claim"}
        </button>
      </div>

      {surplusAmount > 0n && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
          <div>
            <div className="font-semibold tabular-nums">{wgram(surplusWgram)}</div>
            <div className="text-xs text-muted">Your share of the graduation surplus, claimable once</div>
          </div>
          <button disabled={busy !== null} onClick={() => claim("surplus", () => buildCreatorSurplusClaim(publicKey, pool), surplusAmount)} className={button}>
            {busy === "surplus" ? "Confirm in wallet…" : "Claim"}
          </button>
        </div>
      )}

      {coin.status === "graduated" && coin.dammPool && (
        <p className="mt-3 text-xs text-muted">
          Half of the graduated pool&apos;s locked liquidity is yours and keeps earning its trading fees.{" "}
          <a href={`https://app.meteora.ag/dammv2/${coin.dammPool}`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            Claim those on Meteora
          </a>
          .
        </p>
      )}

      {status && <p className={`mt-3 text-sm ${status.ok ? "text-up" : "text-down"}`}>{status.text}</p>}
      {status?.ok && NETWORK === "mainnet" && WGRAM_MINT && (
        <p className="mt-1 text-xs text-muted">
          wGRAM is GRAM on Solana.{" "}
          <a href={`https://jup.ag/swap/${WGRAM_MINT}-SOL`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            Swap it to SOL on Jupiter
          </a>{" "}
          or keep it.
        </p>
      )}
    </div>
  );
}
