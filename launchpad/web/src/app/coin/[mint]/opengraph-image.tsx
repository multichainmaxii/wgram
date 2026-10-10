import { ImageResponse } from "next/og";
import BrandImage from "@/app/opengraph-image";
import { BRAND } from "@/lib/config";
import { OG, OgBrandMark, OgLogo, OgWordmark } from "@/lib/og";
import { usd, wgram } from "@/lib/format";
import { getCoinServer } from "@/lib/server/coins";
import { getGramUsd } from "@/lib/server/price";
import type { Coin } from "@/lib/types";

export const alt = `A coin on ${BRAND.name}: market cap and bonding curve progress`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const { ink: INK, line: LINE, text: TEXT, muted: MUTED, accent: ACCENT, up: UP } = OG;
// Satori's text-stroke parser splits on spaces, so no rgba() here.
const WHITE_90 = "#ffffffe6";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// A short CDN cache lets a burst of link previews share one RPC read; the fallback card
// gets a shorter one so the real card returns soon after the RPC recovers.
const cacheFor = (seconds: number) =>
  process.env.NODE_ENV === "development" ? "no-store" : `public, max-age=${seconds}, s-maxage=${seconds}`;

async function loadCoin(mint: string): Promise<Coin | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
  return Promise.race([getCoinServer(mint), timeout]).catch(() => null);
}

// Satori decodes PNG, JPEG and GIF; WebP/AVIF (and SVGs without a viewBox) fail the render.
function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return null;
}

// Reads at most MAX_IMAGE_BYTES, so a hostile URL can't make the server buffer a huge body.
async function readImage(res: Response): Promise<string | null> {
  if (!res.body || Number(res.headers.get("content-length")) > MAX_IMAGE_BYTES) {
    await res.body?.cancel();
    return null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    total += r.value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(r.value);
  }
  const bytes = Buffer.concat(chunks);
  const type = imageType(bytes);
  return type ? `data:${type};base64,${bytes.toString("base64")}` : null;
}

// The image URL comes from the coin creator, so it is fetched here rather than by Satori:
// https only, with a time and size cap and a format check.
async function loadImage(uri: string | undefined): Promise<string | null> {
  if (!uri) return null;
  try {
    let url = new URL(uri);
    // Images this site hosts are read from our own origin, as fetchOffchain does for metadata.
    const site = process.env.NEXT_PUBLIC_SITE_URL;
    const own = site && url.pathname.startsWith("/api/images/") ? new URL(url.pathname, site) : null;
    if (own) url = own;
    const signal = AbortSignal.timeout(2500);
    // Redirects are followed by hand so every hop is held to the same rule.
    for (let hop = 0; hop < 4; hop++) {
      if (url.protocol !== "https:" && url.origin !== own?.origin) return null;
      const res = await fetch(url, { redirect: "manual", signal });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location) {
        await res.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      if (res.ok) return await readImage(res);
      await res.body?.cancel();
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

// Same gradient as the Avatar in components/coin-ui.tsx.
function hue(seed: string) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Avatar({ coin, image }: { coin: Coin; image: string | null }) {
  const box = { width: 208, height: 208, borderRadius: 44 };
  if (image) {
    return <img src={image} alt={coin.name} width={box.width} height={box.height} style={{ ...box, objectFit: "cover" }} />;
  }
  const h = hue(coin.symbol);
  return (
    <div
      style={{
        ...box,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundImage: `linear-gradient(135deg, hsl(${h}, 70%, 50%), hsl(${(h + 60) % 360}, 70%, 38%))`,
        color: WHITE_90,
        fontSize: 68,
        WebkitTextStroke: `2px ${WHITE_90}`,
      }}
    >
      {Array.from(coin.symbol).slice(0, 2).join("")}
    </div>
  );
}

function CoinCard({ coin, image, gramUsd }: { coin: Coin; image: string | null; gramUsd: number }) {
  const pct = Math.round(coin.progress * 100);
  const done = coin.status !== "trading";
  const nameSize = coin.name.length > 22 ? 52 : coin.name.length > 14 ? 64 : 80;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 64,
        backgroundColor: INK,
        backgroundImage: OG.glow,
        color: TEXT,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <OgBrandMark size={60} />
          <OgWordmark fontSize={40} />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 24px 8px 10px",
            borderRadius: 999,
            ...OG.pill,
            color: ACCENT,
            fontSize: 28,
          }}
        >
          <OgLogo size={32} />
          paired with wGRAM
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 48 }}>
        <Avatar coin={coin} image={image} />
        <div style={{ display: "flex", flexDirection: "column", width: 808 }}>
          <div
            style={{
              fontSize: nameSize,
              lineHeight: 1.1,
              letterSpacing: -2,
              WebkitTextStroke: `2px ${TEXT}`,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {coin.name}
          </div>
          <div style={{ fontSize: 40, color: ACCENT, marginTop: 6 }}>{`$${coin.symbol}`}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginTop: 28 }}>
            <div style={{ fontSize: 60, letterSpacing: -1, WebkitTextStroke: `1.5px ${TEXT}` }}>
              {usd(coin.mcapWgram, gramUsd)}
            </div>
            <div style={{ fontSize: 30, color: MUTED }}>{`market cap · ${wgram(coin.mcapWgram)}`}</div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 30 }}>
          <div style={{ color: MUTED }}>Bonding curve</div>
          <div style={{ color: done ? UP : TEXT }}>
            {coin.status === "graduated" ? "Graduated" : coin.status === "graduating" ? "Graduating" : `${pct}%`}
          </div>
        </div>
        <div style={{ display: "flex", height: 20, borderRadius: 10, backgroundColor: LINE }}>
          <div style={{ width: `${Math.max(2, pct)}%`, height: 20, borderRadius: 10, backgroundColor: done ? UP : ACCENT }} />
        </div>
      </div>
    </div>
  );
}

// Rendered before responding: ImageResponse otherwise renders while streaming, where a
// bad image or glyph would cut the response off instead of falling back.
async function renderCard(coin: Coin, image: string | null, gramUsd: number): Promise<Response | null> {
  try {
    const card = new ImageResponse(<CoinCard coin={coin} image={image} gramUsd={gramUsd} />, {
      ...size,
      headers: { "cache-control": cacheFor(300) },
    });
    return new Response(await card.arrayBuffer(), { headers: card.headers });
  } catch {
    return null;
  }
}

export default async function Image({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  const [coin, { gramUsd }] = await Promise.all([loadCoin(mint), getGramUsd()]);
  if (coin) {
    const image = await loadImage(coin.image);
    // An image can pass the format check and still fail to decode: retry with initials.
    const card = (await renderCard(coin, image, gramUsd)) ?? (image ? await renderCard(coin, null, gramUsd) : null);
    if (card) return card;
  }
  // Unknown mint, slow RPC or a failed render: the generic brand card, cached briefly.
  const generic = BrandImage();
  generic.headers.set("cache-control", cacheFor(60));
  return generic;
}
