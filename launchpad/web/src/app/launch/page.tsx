"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Keypair } from "@solana/web3.js";
import { Avatar, PairedWithGram } from "@/components/coin-ui";
import { buildLaunch, confirmSignature, connection } from "@/lib/chain";
import { useAppWallet } from "@/lib/wallet";
import { isConfigured } from "@/lib/config";
import { ImagePicker, useImagePicker } from "./ImagePicker";

export default function LaunchPage() {
  const router = useRouter();
  const { publicKey, login, sendTransaction } = useAppWallet();
  const [form, setForm] = useState({ name: "", symbol: "", description: "" });
  const picker = useImagePicker();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: key === "symbol" ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") : e.target.value }));

  async function launch(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey) return login();
    if (picker.uploading) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, image: picker.url }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't save the coin's details");

      const baseMint = Keypair.generate();
      const tx = await buildLaunch({ creator: publicKey, baseMint: baseMint.publicKey, name: form.name.trim(), symbol: form.symbol, uri: body.uri });
      const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash();
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;
      const signature = await sendTransaction(tx, [baseMint]);
      await confirmSignature(connection(), signature, lastValidBlockHeight);
      router.push(`/coin/${baseMint.publicKey.toBase58()}`);
    } catch (err) {
      setError((err as Error).message.split("\n")[0]);
      setBusy(false);
    }
  }

  const preview = { name: form.name || "Your coin", symbol: form.symbol || "TICKER", image: picker.preview };

  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 py-10 md:px-6 lg:grid-cols-[1fr_320px]">
      <form onSubmit={launch} className="space-y-4">
        <div className="hud text-muted">{"// launch"}</div>
        <h1 className="display text-6xl sm:text-7xl">Launch.</h1>
        <p className="text-muted">It trades against wGRAM from the first second. No presale, no team allocation.</p>
        <Field label="Name" hint="Up to 32 characters">
          <input required maxLength={32} value={form.name} onChange={set("name")} placeholder="Pavel" className={input} />
        </Field>
        <Field label="Ticker" hint="Up to 10 letters or numbers">
          <input required maxLength={10} value={form.symbol} onChange={set("symbol")} placeholder="PAVEL" className={input} />
        </Field>
        <Field label="Description" hint="Optional">
          <textarea maxLength={500} rows={3} value={form.description} onChange={set("description")} placeholder="What's the story?" className={`${input} h-auto py-3`} />
        </Field>
        {/* A div, not a label: the picker holds several buttons of its own. */}
        <Field as="div" label="Image" hint="Optional, square works best">
          <ImagePicker picker={picker} disabled={busy} inputClassName={input} />
        </Field>
        {!isConfigured && <p className="text-sm text-down">The launchpad isn&apos;t configured on this network yet.</p>}
        {error && <p className="text-sm text-down">{error}</p>}
        <button
          disabled={busy || !isConfigured || picker.uploading}
          className="h-12 w-full rounded-full bg-accent font-semibold text-ink hover:bg-accent-strong disabled:opacity-50"
        >
          {busy ? "Confirm in your wallet…" : picker.uploading ? "Uploading image…" : !publicKey ? "Connect wallet to launch" : "Launch coin"}
        </button>
      </form>

      <aside className="space-y-4">
        <div className="border border-line bg-panel p-4">
          <div className="hud mb-3 text-muted">Preview</div>
          <div className="flex items-center gap-3">
            <Avatar coin={preview} />
            <div>
              <div className="font-semibold">${preview.symbol}</div>
              <div className="text-sm text-muted">{preview.name}</div>
            </div>
          </div>
          <div className="mt-3">
            <PairedWithGram />
          </div>
        </div>
        <div className="space-y-2 border border-line bg-panel p-4 text-sm">
          <Info label="Launch cost" value="~0.035 SOL" />
          <Info label="Supply" value="1,000,000,000" />
          <Info label="Starts at" value="~$4.5k market cap" />
          <Info label="Graduates at" value="~$40k market cap" />
          <Info label="Trading fee" value="1.5%, about 0.4% of volume goes to you" />
          <p className="pt-1 text-xs text-muted">
            Your share of the fees builds up in wGRAM; claim it any time from{" "}
            <Link href="/my-coins" className="text-accent hover:underline">
              My coins
            </Link>
            . On graduation the curve&apos;s wGRAM and remaining supply move into a Meteora pool with the liquidity locked
            forever, half of it yours.
          </p>
        </div>
      </aside>
    </div>
  );
}

const input = "h-11 w-full border border-line bg-panel px-4 text-sm placeholder:text-muted/70 focus:border-accent focus:outline-none";

function Field({ label, hint, children, as: Tag = "label" }: { label: string; hint: string; children: React.ReactNode; as?: "label" | "div" }) {
  return (
    <Tag className="block">
      <span className="mb-1 flex justify-between text-sm">
        <span className="hud">{label}</span>
        <span className="text-xs text-muted">{hint}</span>
      </span>
      {children}
    </Tag>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
