import { DevFaucet } from "@/components/DevFaucet";
import { NETWORK, SOURCE_URL, WGRAM_MINT, WGRAM_SOL_POOL } from "@/lib/config";

const ext = { target: "_blank", rel: "noopener noreferrer" } as const;
const pill = "rounded-full px-5 py-2 text-sm font-semibold transition-colors";

export default function GetWgramPage() {
  return (
    <div className="mx-auto max-w-[760px] px-4 py-10 md:px-6">
      <div className="hud text-muted">{"// get wgram"}</div>
      <h1 className="display mt-3 text-6xl sm:text-7xl">Get wGRAM.</h1>
      <p className="mt-3 text-muted">GRAM, Telegram&apos;s coin, on Solana.</p>
      <p className="mt-5">
        Each <b>wGRAM</b> is backed 1:1 by GRAM held by an <b>open-source contract</b> on NEAR, and can be redeemed back to GRAM.
        Every coin on this launchpad trades against it.
      </p>

      {NETWORK === "localnet" && (
        <div className="mt-6">
          <DevFaucet />
        </div>
      )}

      <section className="mt-8 border-t border-line py-6">
        <h2 className="text-[15px] font-semibold text-accent">Swap SOL for wGRAM</h2>
        <p className="mt-1">
          The quickest way. The <b>wGRAM/SOL pool</b> on Meteora is kept at the GRAM price by a market maker, so a swap costs about
          what GRAM costs.
        </p>
        {NETWORK === "mainnet" && WGRAM_MINT && (
          <div className="mt-4 flex flex-wrap gap-3">
            <a href={`https://jup.ag/swap/SOL-${WGRAM_MINT}`} {...ext} className={`${pill} bg-accent text-ink hover:bg-accent-strong`}>
              Swap on Jupiter
            </a>
            {WGRAM_SOL_POOL && (
              <a href={`https://app.meteora.ag/dlmm/${WGRAM_SOL_POOL}`} {...ext} className={`${pill} bg-panel-2 text-accent hover:text-accent-strong`}>
                Pool on Meteora
              </a>
            )}
          </div>
        )}
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-muted marker:text-muted/50">
          <li>In a Telegram trading bot you can skip this: buy any coin here with SOL and the bot routes through wGRAM.</li>
        </ul>
      </section>

      <section className="border-t border-line py-6">
        <h2 className="text-[15px] font-semibold text-accent">Bring GRAM from TON</h2>
        <p className="mt-1">Already hold GRAM? It takes three steps:</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Deposit GRAM from your TON wallet through HOT Bridge to a NEAR account.</li>
          <li>Wrap it into wGRAM on NEAR (one transaction, 1:1).</li>
          <li>Send it to your Solana wallet through NEAR&apos;s Omni Bridge.</li>
        </ol>
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-muted marker:text-muted/50">
          <li>A one-click bridge from your TON wallet is coming.</li>
          <li>
            <a href={SOURCE_URL} {...ext} className="text-accent hover:underline">
              The wrapper contract and bridge scripts are open source
            </a>
          </li>
        </ul>
      </section>

      {WGRAM_MINT && (
        <section className="border-t border-line py-6">
          <h2 className="text-[15px] font-semibold">wGRAM token address</h2>
          <p className="mt-1 break-all font-mono text-sm text-muted">{WGRAM_MINT}</p>
        </section>
      )}
    </div>
  );
}
