import { DevFaucet } from "@/components/DevFaucet";
import { NETWORK, WGRAM_MINT } from "@/lib/config";

export default function GetWgramPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Get wGRAM</h1>
        <p className="mt-2 text-muted">
          wGRAM is GRAM, Telegram&apos;s coin, brought to Solana. Each wGRAM is backed 1:1 by GRAM locked on the way over
          and can be redeemed back to GRAM on TON.
        </p>
      </div>

      {NETWORK === "localnet" && <DevFaucet />}

      <section className="rounded-2xl border border-line bg-panel p-5">
        <h2 className="font-semibold">Bring GRAM from TON</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted">
          <li>Deposit GRAM from your TON wallet through HOT Bridge to a NEAR account.</li>
          <li>Wrap it into wGRAM on NEAR (one transaction, 1:1).</li>
          <li>Send it to your Solana wallet through NEAR&apos;s Omni Bridge.</li>
        </ol>
        <p className="mt-3 text-sm text-muted">A one-click bridge from your TON wallet is coming.</p>
      </section>

      <section className="rounded-2xl border border-line bg-panel p-5">
        <h2 className="font-semibold">Or swap on Solana</h2>
        <p className="mt-2 text-sm text-muted">Once the wGRAM/SOL pool is live you&apos;ll be able to swap SOL for wGRAM directly.</p>
        {WGRAM_MINT && (
          <p className="mt-3 break-all font-mono text-xs text-muted">
            wGRAM mint: {WGRAM_MINT}
          </p>
        )}
      </section>
    </div>
  );
}
