"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

// Local test network only: tops up the connected wallet with test SOL and wGRAM.
export function DevFaucet() {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function claim() {
    if (!publicKey) return setVisible(true);
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/dev/faucet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: publicKey.toBase58() }),
    });
    const body = await res.json();
    setStatus(res.ok ? `Sent ${body.sol} test SOL and ${body.wgram.toLocaleString()} test wGRAM.` : body.error);
    setBusy(false);
  }

  return (
    <div className="rounded-2xl border border-accent/40 bg-accent/10 p-5">
      <h2 className="font-semibold">Test network faucet</h2>
      <p className="mt-1 text-sm text-muted">You&apos;re on the local test network. Grab test SOL and wGRAM to try launching and trading.</p>
      <button onClick={claim} disabled={busy} className="mt-3 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-ink hover:bg-accent-strong disabled:opacity-50">
        {!publicKey ? "Connect wallet" : busy ? "Sending…" : "Get test SOL + wGRAM"}
      </button>
      {status && <p className="mt-2 text-sm">{status}</p>}
    </div>
  );
}
