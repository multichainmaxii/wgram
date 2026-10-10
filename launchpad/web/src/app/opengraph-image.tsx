import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/config";
import { OG, OgBrandMark, OgLogo, OgWordmark } from "@/lib/og";

export const alt = `${BRAND.name}: ${BRAND.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

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
          backgroundColor: OG.ink,
          backgroundImage: OG.glow,
          color: OG.text,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <OgBrandMark size={76} />
          <OgWordmark fontSize={52} />
        </div>
        <div style={{ maxWidth: 1000, fontSize: 100, lineHeight: 1.05, letterSpacing: -3, WebkitTextStroke: `2.5px ${OG.text}` }}>
          {BRAND.tagline}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 32 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "10px 26px 10px 12px",
              borderRadius: 999,
              ...OG.pill,
              color: OG.accent,
            }}
          >
            <OgLogo size={36} />
            paired with wGRAM
          </div>
          <div style={{ color: OG.muted }}>on Solana</div>
        </div>
      </div>
    ),
    size,
  );
}
