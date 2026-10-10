// Site-wide settings. NEXT_PUBLIC_* values are inlined at build time, so each must be
// read with its literal name. Local values are written by `pnpm seed` in launchpad/.

export const BRAND = {
  name: "ongram.fun",
  tagline: "Launch coins paired with GRAM",
};
export const SOURCE_URL = "https://github.com/multichainmaxii/wgram";
// Privy app (dashboard.privy.io) for sign-in on mainnet and devnet. Public, not a secret.
// Full-bleed artwork for the home hero (a path under public/, e.g. "/art/hero.jpg").
// Empty: the hero draws the logo's progress ring instead.
export const HERO_ART = process.env.NEXT_PUBLIC_HERO_ART ?? "";
// Community links for the footer; each shows only when set.
export const SOCIAL_X = process.env.NEXT_PUBLIC_X_URL ?? "";
export const SOCIAL_TELEGRAM = process.env.NEXT_PUBLIC_TELEGRAM_URL ?? "";
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

export type Network = "localnet" | "devnet" | "mainnet";
export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "localnet") as Network;
export const RPC_URL = process.env.NEXT_PUBLIC_RPC ?? "http://127.0.0.1:11899";
// NEXT_PUBLIC_RPC may be a path on this site (the /api/rpc relay on mainnet), but web3.js
// needs a full URL. During server rendering no browser calls happen, so any origin works.
export function rpcEndpoint(): string {
  if (!RPC_URL.startsWith("/")) return RPC_URL;
  return typeof window === "undefined" ? `http://localhost${RPC_URL}` : `${window.location.origin}${RPC_URL}`;
}
// Our Meteora bonding-curve config; every coin launched here uses it.
export const CONFIG_ADDRESS = process.env.NEXT_PUBLIC_CONFIG ?? "";
export const WGRAM_MINT = process.env.NEXT_PUBLIC_WGRAM_MINT ?? "";
// The wGRAM/SOL pool that lets bots and terminals buy coins here with SOL.
export const WGRAM_SOL_POOL = process.env.NEXT_PUBLIC_WGRAM_SOL_POOL ?? (NETWORK === "mainnet" ? "7DoV9YSeSDiLF6gh97tAToRSpgtWt4VpZZzZ15pq9XRd" : "");
// Fallback GRAM price for USD estimates until a live price source is wired in.
export const GRAM_USD = Number(process.env.NEXT_PUBLIC_GRAM_USD ?? "1.5");

// Must match launchpad/scripts/curve.ts.
export const TOTAL_SUPPLY = 1_000_000_000;
export const TOKEN_DECIMALS = 6;
export const WGRAM_DECIMALS = 9;

export const isConfigured = Boolean(CONFIG_ADDRESS && WGRAM_MINT);
