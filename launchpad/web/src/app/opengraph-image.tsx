import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/config";

export const alt = `${BRAND.name}: ${BRAND.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Site colors from globals.css: Satori can't read CSS variables.
const INK = "#0a0f1a";
const TEXT = "#e6edf7";
const MUTED = "#8a99b3";
const ACCENT = "#2aabee";

// Also the generic card for coin links whose coin can't be loaded.
export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          backgroundColor: INK,
          backgroundImage: "radial-gradient(circle at 88% 8%, rgba(42, 171, 238, 0.3), rgba(42, 171, 238, 0) 55%)",
          color: TEXT,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <div
            style={{
              width: 76,
              height: 76,
              borderRadius: 38,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: ACCENT,
              color: INK,
              fontSize: 44,
              WebkitTextStroke: `2px ${INK}`,
            }}
          >
            {BRAND.name.charAt(0)}
          </div>
          <div style={{ fontSize: 52, letterSpacing: -1, WebkitTextStroke: `1.5px ${TEXT}` }}>{BRAND.name}</div>
        </div>
        <div style={{ maxWidth: 1000, fontSize: 100, lineHeight: 1.05, letterSpacing: -3, WebkitTextStroke: `2.5px ${TEXT}` }}>
          {BRAND.tagline}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 32 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "12px 26px",
              borderRadius: 999,
              border: "2px solid rgba(42, 171, 238, 0.35)",
              backgroundColor: "rgba(42, 171, 238, 0.1)",
              color: ACCENT,
            }}
          >
            <div style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: ACCENT }} />
            paired with wGRAM
          </div>
          <div style={{ color: MUTED }}>on Solana</div>
        </div>
      </div>
    ),
    size,
  );
}
