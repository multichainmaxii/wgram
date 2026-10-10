"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { SwapQuote2Result } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { buildTrade, confirmSignature, connection, fromBaseUnits, parseUnits, quoteTrade, tokenBalance, wgramMint, type Coin, type Side } from "@/lib/chain";
import { TOKEN_DECIMALS, WGRAM_DECIMALS } from "@/lib/config";
import { tokens, wgram } from "@/lib/format";
import { useAppWallet } from "@/lib/wallet";

type PoolAccount = Parameters<typeof quoteTrade>[0];

const SLIPPAGES = [50, 100, 300];

export function TradePanel({ coin, pool, onTraded }: { coin: Coin; pool: PoolAccount; onTraded: () => void }) {
  const { publicKey, login, sendTransaction } = useAppWallet();
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  // Each quote is tagged with the inputs it was computed for, so a stale one is ignored.
  const [quoteState, setQuoteState] = useState<{ key: string; quote?: SwapQuote2Result; error?: string } | null>(null);
  // Tagged with the wallet they belong to, so switching wallets never shows stale balances.
  const [balanceState, setBalanceState] = useState<{ owner: string; mint: string; wgram: bigint; token: bigint } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const balances = publicKey && balanceState?.owner === publicKey.toBase58() && balanceState.mint === coin.mint ? balanceState : null;
  const inDecimals = side === "buy" ? WGRAM_DECIMALS : TOKEN_DECIMALS;
  const outDecimals = side === "buy" ? TOKEN_DECIMALS : WGRAM_DECIMALS;
  const amountIn = parseUnits(amount, inDecimals);
  const balanceIn = balances ? (side === "buy" ? balances.wgram : balances.token) : null;
  const insufficient = amountIn !== null && balanceIn !== null && BigInt(amountIn.toString()) > balanceIn;
  const quoteKey = `${side}|${amount}|${slippageBps}|${pool.account.poolState.sqrtPrice.toString()}`;
  const quote = amountIn && quoteState?.key === quoteKey ? (quoteState.quote ?? null) : null;
  const quoteError = amountIn && quoteState?.key === quoteKey ? (quoteState.error ?? null) : null;

  async function loadBalances() {
    if (!publicKey) return;
    const [w, t] = await Promise.all([tokenBalance(publicKey, wgramMint()), tokenBalance(publicKey, new PublicKey(coin.mint))]);
    setBalanceState({ owner: publicKey.toBase58(), mint: coin.mint, wgram: w, token: t });
  }

  useEffect(() => {
    if (!publicKey) return;
    let cancelled = false;
    Promise.all([tokenBalance(publicKey, wgramMint()), tokenBalance(publicKey, new PublicKey(coin.mint))]).then(([w, t]) => {
      if (!cancelled) setBalanceState({ owner: publicKey.toBase58(), mint: coin.mint, wgram: w, token: t });
    });
    return () => {
      cancelled = true;
    };
  }, [publicKey, coin.mint]);

  // Re-quote as the input or the pool changes (quoteKey covers both).
  useEffect(() => {
    if (!amountIn) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const q = await quoteTrade(pool, side, amountIn, slippageBps);
        if (!cancelled) setQuoteState({ key: quoteKey, quote: q });
      } catch (e) {
        if (!cancelled) setQuoteState({ key: quoteKey, error: (e as Error).message.split("\n")[0] });
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey]);

  async function submit() {
    if (!publicKey) return login();
    if (!amountIn || !quote) return;
    setBusy(true);
    setStatus(null);
    try {
      const tx = await buildTrade(publicKey, pool, side, amountIn, quote.minimumAmountOut ?? new BN(0));
      const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash();
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;
      const signature = await sendTransaction(tx);
      await confirmSignature(connection(), signature, lastValidBlockHeight);
      const got = fromBaseUnits(quote.outputAmount, outDecimals);
      setStatus({ ok: true, text: side === "buy" ? `Bought ~${tokens(got)} $${coin.symbol}` : `Sold for ~${wgram(got)}` });
      setAmount("");
      await loadBalances();
      onTraded();
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message.split("\n")[0] });
    } finally {
      setBusy(false);
    }
  }

  // The curve is full and the coin is moving to Meteora (the market-maker bot migrates it
  // within about a minute); the curve takes no trades in between.
  if (coin.status === "graduating") {
    return (
      <div className="border border-line bg-panel p-5">
        <h2 className="hud text-muted">Graduating</h2>
        <p className="mt-2 text-sm">
          ${coin.symbol} filled its curve and is moving into its Meteora pool, with the liquidity locked forever. Trading opens there in about a minute.
        </p>
      </div>
    );
  }

  if (coin.status === "graduated") {
    return (
      <div className="border border-line bg-panel p-5">
        <h2 className="font-semibold">Graduated</h2>
        <p className="mt-1 text-sm text-muted">
          ${coin.symbol} completed its curve and now trades in a Meteora pool against wGRAM, with its liquidity locked forever.
        </p>
        {coin.dammPool && (
          <a
            href={`https://app.meteora.ag/dammv2/${coin.dammPool}`}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex rounded-full bg-accent px-4 py-2 text-sm font-semibold text-ink hover:bg-accent-strong"
          >
            Trade on Meteora
          </a>
        )}
      </div>
    );
  }

  const quickBuys = ["25", "100", "500", "1000"];
  const leftover = quote && side === "buy" && quote.amountLeft && !quote.amountLeft.isZero() ? fromBaseUnits(quote.amountLeft, WGRAM_DECIMALS) : 0;

  return (
    <div className="border border-line bg-panel p-5">
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-full bg-panel-2 p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            onClick={() => {
              setSide(s);
              setAmount("");
              setStatus(null);
            }}
            className={`rounded-full py-2 text-sm font-semibold capitalize ${
              side === s ? (s === "buy" ? "bg-up text-ink" : "bg-down text-ink") : "text-muted hover:text-text"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <label className="mb-1 flex justify-between text-xs text-muted" htmlFor="trade-amount">
        <span>{side === "buy" ? "You pay (wGRAM)" : `You sell ($${coin.symbol})`}</span>
        {balanceIn !== null && (
          <button
            type="button"
            className="hover:text-text"
            onClick={() => setAmount(String(fromBaseUnits(balanceIn, inDecimals)))}
          >
            Balance: {side === "buy" ? wgram(fromBaseUnits(balanceIn, inDecimals)) : tokens(fromBaseUnits(balanceIn, inDecimals))}
          </button>
        )}
      </label>
      <input
        id="trade-amount"
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(",", "."))}
        placeholder="0.0"
        className="h-12 w-full rounded-xl border border-line bg-ink px-4 text-lg focus:border-accent focus:outline-none"
      />
      <div className="mt-2 flex gap-2">
        {side === "buy"
          ? quickBuys.map((v) => (
              <button key={v} onClick={() => setAmount(v)} className="flex-1 rounded-lg bg-panel-2 py-1.5 text-xs text-muted hover:text-text">
                {v}
              </button>
            ))
          : [25, 50, 100].map((pct) => (
              <button
                key={pct}
                disabled={!balances}
                onClick={() => balances && setAmount(String(fromBaseUnits((balances.token * BigInt(pct)) / 100n, TOKEN_DECIMALS)))}
                className="flex-1 rounded-lg bg-panel-2 py-1.5 text-xs text-muted hover:text-text disabled:opacity-40"
              >
                {pct}%
              </button>
            ))}
      </div>

      <div className="mt-4 space-y-1.5 text-sm">
        <Row label="You receive" value={quote ? `≈ ${side === "buy" ? `${tokens(fromBaseUnits(quote.outputAmount, outDecimals))} $${coin.symbol}` : wgram(fromBaseUnits(quote.outputAmount, outDecimals))}` : "—"} />
        <Row label={`Minimum (${slippageBps / 100}% slippage)`} value={quote?.minimumAmountOut ? (side === "buy" ? tokens(fromBaseUnits(quote.minimumAmountOut, outDecimals)) : wgram(fromBaseUnits(quote.minimumAmountOut, outDecimals))) : "—"} />
        <Row label="Trading fee" value={quote ? wgram(fromBaseUnits(quote.tradingFee.add(quote.protocolFee), WGRAM_DECIMALS)) : "—"} />
        {leftover > 0 && <p className="text-xs text-up">This buy completes the curve. Only part is used; {wgram(leftover)} is refunded.</p>}
        {quoteError && <p className="text-xs text-down">{quoteError}</p>}
      </div>

      <div className="mt-3 flex items-center gap-1 text-xs text-muted">
        Slippage
        {SLIPPAGES.map((bps) => (
          <button key={bps} onClick={() => setSlippageBps(bps)} className={`rounded-md px-2 py-0.5 ${slippageBps === bps ? "bg-panel-2 text-text" : "hover:text-text"}`}>
            {bps / 100}%
          </button>
        ))}
      </div>

      <button
        onClick={submit}
        disabled={busy || (!!publicKey && (!quote || insufficient))}
        className={`mt-4 h-12 w-full rounded-full font-semibold text-ink disabled:opacity-50 ${side === "buy" ? "bg-up" : "bg-down"}`}
      >
        {!publicKey ? "Connect wallet" : busy ? "Confirm in your wallet…" : insufficient ? "Not enough balance" : `${side === "buy" ? "Buy" : "Sell"} $${coin.symbol}`}
      </button>
      {publicKey && side === "buy" && balances?.wgram === 0n && (
        <p className="mt-3 text-center text-xs text-muted">
          You need wGRAM to buy. <Link href="/get-wgram" className="text-accent hover:underline">Get wGRAM</Link>
        </p>
      )}
      {status && <p className={`mt-3 text-center text-sm ${status.ok ? "text-up" : "text-down"}`}>{status.text}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
