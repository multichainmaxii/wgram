import { BRAND } from "./config";

// Link-preview cards use the site's night palette (globals.css): Satori can't read CSS
// variables. Satori's text-stroke parser splits on spaces, so no rgba() in strokes.
export const OG = {
  ink: "#17212B",
  line: "#2A3542",
  text: "#E9EDF1",
  muted: "#8596A8",
  accent: "#5EB0F3",
  up: "#56C271",
  glow: "radial-gradient(circle at 88% 8%, rgba(94, 176, 243, 0.22), rgba(94, 176, 243, 0) 55%)",
  pill: { border: "2px solid rgba(94, 176, 243, 0.35)", backgroundColor: "rgba(94, 176, 243, 0.1)" },
};

// The wGRAM logo (launchpad/brand/wgram-logo.svg) drawn with boxes, which Satori renders reliably.
export function OgLogo({ size }: { size: number }) {
  const stroke = `${Math.max(1, size * 0.02)}px #ffffff`;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundImage: "linear-gradient(135deg, #3FB7F2, #1A7FD0)",
      }}
    >
      <div
        style={{
          width: size * 0.84,
          height: size * 0.84,
          borderRadius: size * 0.42,
          border: `${Math.max(2, Math.round(size * 0.024))}px dashed #ffffffe6`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#ffffff",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", marginTop: -size * 0.04 }}>
          <span style={{ fontSize: size * 0.3, WebkitTextStroke: stroke }}>w</span>
          <span style={{ fontSize: size * 0.42, WebkitTextStroke: stroke }}>G</span>
        </div>
      </div>
    </div>
  );
}

// The site's own mark (public/logo.svg), inlined so the card renderer needs no fetch.
const BRAND_LOGO = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><linearGradient id="og-rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5EE0FF"/><stop offset="1" stop-color="#1668D2"/></linearGradient></defs><rect width="512" height="512" rx="120" fill="#17212B"/><circle cx="256" cy="256" r="150" fill="none" stroke="#2A3542" stroke-width="44"/><path d="M256 106 A150 150 0 1 1 106 256" fill="none" stroke="url(#og-rg)" stroke-width="44" stroke-linecap="round"/><g transform="translate(256 262) scale(0.5) translate(-256 -285)"><polygon points="176,150 336,150 416,210 256,420 96,210" fill="#2A9EF4" stroke="#2A9EF4" stroke-width="6" stroke-linejoin="round"/></g></svg>').toString("base64")}`;

export function OgBrandMark({ size }: { size: number }) {
  // eslint-disable-next-line @next/next/no-img-element -- Satori renders plain img
  return <img src={BRAND_LOGO} width={size} height={size} alt="" />;
}

// "ongram.fun" with the ".fun" softened, as in the site header.
export function OgWordmark({ fontSize }: { fontSize: number }) {
  const dot = BRAND.name.indexOf(".");
  const stroke = `${fontSize / 36}px`;
  return (
    <div style={{ display: "flex", fontSize, letterSpacing: -1 }}>
      <span style={{ color: OG.text, WebkitTextStroke: `${stroke} ${OG.text}` }}>{dot < 0 ? BRAND.name : BRAND.name.slice(0, dot)}</span>
      {dot >= 0 && <span style={{ color: OG.muted, WebkitTextStroke: `${stroke} ${OG.muted}` }}>{BRAND.name.slice(dot)}</span>}
    </div>
  );
}
