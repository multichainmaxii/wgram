import Link from "next/link";
import { CoinGrid } from "@/components/CoinGrid";
import { BRAND } from "@/lib/config";

export default function Home() {
  return (
    <>
      <section className="mb-10 flex flex-col items-start gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{BRAND.tagline}</h1>
          <p className="mt-2 max-w-xl text-muted">
            Telegram&apos;s coin, now on Solana. Every coin here trades against wGRAM on a bonding curve and graduates
            into a Meteora pool with its liquidity locked forever.
          </p>
        </div>
        <Link href="/launch" className="rounded-full bg-accent px-5 py-2.5 font-semibold text-ink hover:bg-accent-strong">
          Launch a coin
        </Link>
      </section>
      <CoinGrid />
    </>
  );
}
