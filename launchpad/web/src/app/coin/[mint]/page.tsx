import type { Metadata } from "next";
import { CoinView } from "@/components/CoinView";
import { BRAND } from "@/lib/config";
import { usd } from "@/lib/format";
import { getCoinServer } from "@/lib/server/coins";
import { getGramUsd } from "@/lib/server/price";
import type { Coin } from "@/lib/types";

// Link previews (X, Telegram) block on this before they get the page head, so a slow
// RPC gets 3s before the page falls back to generic metadata.
async function loadCoin(mint: string): Promise<Coin | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
  return Promise.race([getCoinServer(mint), timeout]).catch(() => null);
}

export async function generateMetadata({ params }: PageProps<"/coin/[mint]">): Promise<Metadata> {
  const { mint } = await params;
  const [coin, { gramUsd }] = await Promise.all([loadCoin(mint), getGramUsd()]);
  // The card image comes from ./opengraph-image.tsx, which falls back the same way.
  const openGraph = { type: "website", siteName: BRAND.name } as const;
  const twitter = { card: "summary_large_image" } as const;
  // Unknown mint or slow RPC: the site's default title and description.
  if (!coin) return { openGraph, twitter };

  const title = `${coin.name} ($${coin.symbol}) · ${BRAND.name}`;
  const stage =
    coin.status === "graduated"
      ? "Graduated and trading on Meteora."
      : coin.status === "graduating"
        ? "Graduating to Meteora."
        : `${Math.round(coin.progress * 100)}% of the way to graduation.`;
  const description = `${coin.name} ($${coin.symbol}) has a ${usd(coin.mcapWgram, gramUsd)} market cap on ${BRAND.name}, paired with wGRAM. ${stage}`;
  return {
    title,
    description,
    openGraph: { ...openGraph, title, description },
    twitter: { ...twitter, title, description },
  };
}

export default async function CoinPage({ params }: PageProps<"/coin/[mint]">) {
  const { mint } = await params;
  return <CoinView mint={mint} />;
}
