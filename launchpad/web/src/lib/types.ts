// Shapes shared by the browser, the API routes and the server-side data layer.

export type CoinStatus = "trading" | "graduating" | "graduated";

export type Coin = {
  pool: string;
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  image?: string;
  description?: string;
  priceWgram: number; // wGRAM per token
  mcapWgram: number;
  raisedWgram: number;
  thresholdWgram: number;
  progress: number; // 0..1 toward graduation
  status: CoinStatus;
  createdAt: number; // unix seconds
  dammPool?: string; // DAMM v2 pool once graduated
};

export type Trade = {
  signature: string;
  side: "buy" | "sell";
  wgram: number; // wGRAM paid (buy) or received (sell)
  tokens: number; // coin tokens received (buy) or sold (sell)
  priceWgram: number; // wgram / tokens
  trader: string; // first signer
  time: number; // unix seconds (block time)
};

// GET /api/coins
export type CoinsResponse = { coins: Coin[]; updatedAt: number };
// GET /api/coins/[mint]
export type CoinResponse = { coin: Coin | null };
// GET /api/coins/[mint]/trades
export type TradesResponse = { trades: Trade[] };
// GET /api/price
export type PriceResponse = { gramUsd: number; source: "coingecko" | "fallback"; updatedAt: number };
