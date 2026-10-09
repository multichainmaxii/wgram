// Reads launchpad state straight from Meteora's bonding-curve program and builds
// transactions for wallets to sign. Works in the browser and on the server.

import { Connection, PublicKey, type Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import {
  ActivationType,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  SwapMode,
  TokenDecimal,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
  deriveMintMetadata,
  getCurrentPoint,
  getPriceFromSqrtPrice,
  type PoolConfig,
  type SwapQuote2Result,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CONFIG_ADDRESS, TOTAL_SUPPLY, WGRAM_DECIMALS, WGRAM_MINT, rpcEndpoint } from "./config";
import type { Coin } from "./types";

export type { Coin } from "./types";

let conn: Connection | null = null;
let client: DynamicBondingCurveClient | null = null;
export const connection = () => (conn ??= new Connection(rpcEndpoint(), "confirmed"));
export const dbc = () => (client ??= new DynamicBondingCurveClient(connection(), "confirmed"));

// Polls for confirmation instead of web3.js's confirmTransaction, which waits on a
// websocket that the /api/rpc relay can't provide.
export async function confirmSignature(conn: Connection, signature: string, lastValidBlockHeight: number) {
  for (;;) {
    const {
      value: [status],
    } = await conn.getSignatureStatuses([signature]);
    if (status?.err) throw new Error("Transaction failed on-chain");
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error("Transaction expired before it confirmed; try again");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export const wgramMint = () => new PublicKey(WGRAM_MINT);
export const configAddress = () => new PublicKey(CONFIG_ADDRESS);

export type PoolAccount = { publicKey: PublicKey; account: VirtualPool };
export type TokenMeta = { name: string; symbol: string; uri: string };
export type Offchain = { image?: string; description?: string };

let configCache: PoolConfig | null = null;
export async function launchpadConfig(): Promise<PoolConfig> {
  if (!configCache) {
    configCache = await dbc().state.getPoolConfig(configAddress());
    if (!configCache) throw new Error(`launchpad config ${CONFIG_ADDRESS} not found on ${rpcEndpoint()}`);
  }
  return configCache;
}

export const thresholdWgram = (config: PoolConfig) => Number(config.migrationQuoteThreshold.toString()) / 10 ** WGRAM_DECIMALS;
export const metadataAddress = (mint: PublicKey) => deriveMintMetadata(mint);

// Metaplex metadata: key(1) + update authority(32) + mint(32), then borsh strings
// name, symbol and uri, each zero-padded.
export function parseMetaplex(data: Uint8Array): TokenMeta {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 65;
  const readString = () => {
    const len = view.getUint32(offset, true);
    offset += 4;
    const text = new TextDecoder().decode(data.subarray(offset, offset + len));
    offset += len;
    return text.replace(/\0/g, "").trim();
  };
  return { name: readString(), symbol: readString(), uri: readString() };
}

const offchainCache = new Map<string, Offchain>();

// Metadata JSON hosted by this site is fetched by path in the browser (so local URIs
// keep working whatever port the dev server runs on) and against `origin` on the server.
export async function fetchOffchain(uri: string, origin?: string): Promise<Offchain> {
  if (!uri) return {};
  const cached = offchainCache.get(uri);
  if (cached) return cached;
  let url: string;
  try {
    const parsed = new URL(uri);
    const ownPath = parsed.pathname.startsWith("/api/metadata/");
    const base = typeof window === "undefined" ? (origin ?? process.env.NEXT_PUBLIC_SITE_URL) : undefined;
    url = ownPath ? (base ? new URL(parsed.pathname, base).toString() : parsed.pathname) : uri;
  } catch {
    return {};
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const json = res.ok ? ((await res.json()) as Offchain) : {};
    const value = { image: json.image || undefined, description: json.description || undefined };
    offchainCache.set(uri, value);
    return value;
  } catch {
    return {};
  }
}

// Pure: turns a pool account plus its metadata into the Coin shown everywhere.
export function coinFromPool(pool: PoolAccount, meta: TokenMeta | null, offchain: Offchain, threshold: number): Coin {
  const s = pool.account.poolState;
  const price = Number(getPriceFromSqrtPrice(s.sqrtPrice, TokenDecimal.SIX, WGRAM_DECIMALS).toString());
  const raised = Number(s.quoteReserve.toString()) / 10 ** WGRAM_DECIMALS;
  const migrated = Number(s.isMigrated) === 1;
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100];
  return {
    pool: pool.publicKey.toBase58(),
    mint: s.baseMint.toBase58(),
    creator: s.creator.toBase58(),
    name: meta?.name ?? "Unknown",
    symbol: meta?.symbol ?? "???",
    image: offchain.image,
    description: offchain.description,
    priceWgram: price,
    mcapWgram: price * TOTAL_SUPPLY,
    raisedWgram: raised,
    thresholdWgram: threshold,
    progress: migrated ? 1 : Math.min(1, raised / threshold),
    status: migrated ? "graduated" : raised >= threshold ? "graduating" : "trading",
    createdAt: Number(s.activationPoint.toString()),
    dammPool: migrated ? deriveDammV2PoolAddress(dammConfig, s.baseMint, wgramMint()).toBase58() : undefined,
  };
}

async function toCoins(pools: PoolAccount[], origin?: string): Promise<Coin[]> {
  if (pools.length === 0) return [];
  const threshold = thresholdWgram(await launchpadConfig());
  const metaInfos = await connection().getMultipleAccountsInfo(pools.map((p) => metadataAddress(p.account.poolState.baseMint)));
  return Promise.all(
    pools.map(async (pool, i) => {
      const meta = metaInfos[i] ? parseMetaplex(metaInfos[i]!.data) : null;
      return coinFromPool(pool, meta, await fetchOffchain(meta?.uri ?? "", origin), threshold);
    }),
  );
}

// One account read: the pool address is derived from (wGRAM, mint, our config).
// Server code uses getCoinServer() in lib/server/coins.ts, which vets creator-supplied
// metadata URLs before fetching them.
export async function getCoin(mint: string, origin?: string): Promise<{ coin: Coin; pool: PoolAccount } | null> {
  let address: PublicKey;
  try {
    address = deriveDbcPoolAddress(wgramMint(), new PublicKey(mint), configAddress());
  } catch {
    return null;
  }
  const account = (await dbc().state.getPool(address)) as VirtualPool | null;
  if (!account) return null;
  const pool = { publicKey: address, account };
  const [coin] = await toCoins([pool], origin);
  return { coin, pool };
}

export async function tokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  try {
    const res = await connection().getTokenAccountBalance(getAssociatedTokenAddressSync(mint, owner, true));
    return BigInt(res.value.amount);
  } catch {
    return 0n;
  }
}

export type Side = "buy" | "sell";

// Buys use PartialFill: a buy bigger than what's left on the curve fills up to the
// graduation point and refunds the rest, instead of being rejected.
export async function quoteTrade(pool: PoolAccount, side: Side, amountIn: BN, slippageBps: number): Promise<SwapQuote2Result> {
  const config = await launchpadConfig();
  const currentPoint = await getCurrentPoint(connection(), ActivationType.Timestamp);
  const base = {
    virtualPool: pool.account,
    config,
    swapBaseForQuote: side === "sell",
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
    slippageBps,
    amountIn,
  };
  return side === "buy"
    ? dbc().pool.swapQuote2({ ...base, swapMode: SwapMode.PartialFill })
    : dbc().pool.swapQuote2({ ...base, swapMode: SwapMode.ExactIn });
}

export async function buildTrade(owner: PublicKey, pool: PoolAccount, side: Side, amountIn: BN, minimumAmountOut: BN): Promise<Transaction> {
  return dbc().pool.swap2({
    owner,
    pool: pool.publicKey,
    swapBaseForQuote: side === "sell",
    referralTokenAccount: null,
    swapMode: side === "buy" ? SwapMode.PartialFill : SwapMode.ExactIn,
    amountIn,
    minimumAmountOut,
  });
}

export async function buildLaunch(params: { creator: PublicKey; baseMint: PublicKey; name: string; symbol: string; uri: string }): Promise<Transaction> {
  return dbc().creator.createPool({
    baseMint: params.baseMint,
    config: configAddress(),
    name: params.name,
    symbol: params.symbol,
    uri: params.uri,
    payer: params.creator,
    poolCreator: params.creator,
  });
}

// Parses a typed amount like "12.5" into base units without floating point.
// Returns null for anything that isn't a positive number with at most `decimals` places.
export function parseUnits(input: string, decimals: number): BN | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  const units = new BN((whole || "0") + frac.padEnd(decimals, "0"));
  return units.isZero() ? null : units;
}

export const fromBaseUnits = (amount: BN | bigint, decimals: number) => Number(amount.toString()) / 10 ** decimals;
