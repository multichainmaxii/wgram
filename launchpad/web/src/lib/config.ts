// Site-wide settings. NEXT_PUBLIC_* values are inlined at build time, so each must be
// read with its literal name. Local values are written by `pnpm seed` in launchpad/.

export const BRAND = {
  name: "GramFun", // working name
  tagline: "Launch coins paired with GRAM",
};

export type Network = "localnet" | "devnet" | "mainnet";
export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "localnet") as Network;
export const RPC_URL = process.env.NEXT_PUBLIC_RPC ?? "http://127.0.0.1:11899";
// Our Meteora bonding-curve config; every coin launched here uses it.
export const CONFIG_ADDRESS = process.env.NEXT_PUBLIC_CONFIG ?? "";
export const WGRAM_MINT = process.env.NEXT_PUBLIC_WGRAM_MINT ?? "";
// Fallback GRAM price for USD estimates until a live price source is wired in.
export const GRAM_USD = Number(process.env.NEXT_PUBLIC_GRAM_USD ?? "1.5");

// Must match launchpad/scripts/curve.ts.
export const TOTAL_SUPPLY = 1_000_000_000;
export const TOKEN_DECIMALS = 6;
export const WGRAM_DECIMALS = 9;

export const isConfigured = Boolean(CONFIG_ADDRESS && WGRAM_MINT);
