import type { Coin } from "@/lib/chain";

// Deterministic gradient for coins without an image.
function hue(seed: string) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// The same gradient as a big background, for cards of coins without an image.
export function coinGradient(symbol: string) {
  const h = hue(symbol);
  return `linear-gradient(135deg, hsl(${h} 70% 50%), hsl(${(h + 60) % 360} 70% 32%))`;
}

export function Avatar({ coin, size = 48 }: { coin: Pick<Coin, "symbol" | "image" | "name">; size?: number }) {
  if (coin.image) {
    // eslint-disable-next-line @next/next/no-img-element -- user-supplied hosts can't be listed in next.config
    return <img src={coin.image} alt={coin.name} width={size} height={size} className="shrink-0 rounded-[10px] object-cover" style={{ width: size, height: size }} />;
  }
  const h = hue(coin.symbol);
  return (
    <div
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[10px] font-bold text-white/90"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.32,
        background: `linear-gradient(135deg, hsl(${h} 70% 50%), hsl(${(h + 60) % 360} 70% 38%))`,
      }}
    >
      {coin.symbol.slice(0, 2)}
    </div>
  );
}

export function Progress({ coin }: { coin: Pick<Coin, "progress" | "status"> }) {
  const pct = Math.round(coin.progress * 100);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div
        className={`h-full rounded-full ${coin.status === "trading" ? "bg-accent" : "bg-up"}`}
        style={{ width: `${Math.max(2, pct)}%` }}
      />
    </div>
  );
}

export function StatusBadge({ status }: { status: Coin["status"] }) {
  if (status === "trading") return null;
  return (
    <span className="shrink-0 rounded-full bg-up/15 px-2 py-0.5 text-[11px] font-semibold text-up">
      {status === "graduated" ? "Graduated" : "Graduating"}
    </span>
  );
}

export function PairedWithGram() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 py-0.5 pr-2.5 pl-1 text-xs font-medium text-accent">
      {/* eslint-disable-next-line @next/next/no-img-element -- a tiny static SVG */}
      <img src="/wgram.svg" alt="" width={16} height={16} />
      paired with wGRAM
    </span>
  );
}
