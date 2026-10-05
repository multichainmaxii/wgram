// Coins as the server reads them: every coin under our config for /api/coins (one
// program scan serves every visitor, instead of each browser scanning the chain), and
// single coins for coin pages' link previews.

import "server-only";
import { PublicKey } from "@solana/web3.js";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  coinFromPool,
  configAddress,
  metadataAddress,
  parseMetaplex,
  thresholdWgram,
  wgramMint,
  type Offchain,
  type PoolAccount,
  type TokenMeta,
} from "@/lib/chain";
import { CONFIG_ADDRESS, NETWORK } from "@/lib/config";
import type { Coin } from "@/lib/types";
import { cached, peek } from "./cache";
import { serverRpc } from "./rpc";

const OFFCHAIN_TIMEOUT_MS = 3_000;
const OFFCHAIN_TTL_MS = 10 * 60_000;
const OFFCHAIN_MAX_BYTES = 64 * 1024;
// A listing waits at most this long for off-chain JSON. Slower fetches keep running and
// land in the cache for the next refresh, so one slow host can't stall the whole list.
const OFFCHAIN_WAIT_MS = 1_500;

// A config can't change once it's created.
const graduationThreshold = () =>
  cached(`config:${CONFIG_ADDRESS}`, 60 * 60_000, async () => {
    const config = await serverRpc().dbc.state.getPoolConfig(configAddress());
    if (!config) throw new Error(`launchpad config ${CONFIG_ADDRESS} not found`);
    return thresholdWgram(config);
  });

// Token metadata is immutable under our config (TokenAuthorityOption.Immutable), so each
// mint's name, symbol and uri only need reading once.
const tokenMetaCache = new Map<string, TokenMeta>();

async function tokenMetas(mints: PublicKey[]): Promise<(TokenMeta | null)[]> {
  const missing = mints.filter((mint) => !tokenMetaCache.has(mint.toBase58()));
  const batches: PublicKey[][] = [];
  for (let i = 0; i < missing.length; i += 100) batches.push(missing.slice(i, i + 100));
  await Promise.all(
    batches.map(async (batch) => {
      const infos = await serverRpc().connection.getMultipleAccountsInfo(batch.map(metadataAddress));
      infos.forEach((info, j) => {
        if (info) tokenMetaCache.set(batch[j].toBase58(), parseMetaplex(info.data));
      });
    }),
  );
  return mints.map((mint) => tokenMetaCache.get(mint.toBase58()) ?? null);
}

// Anyone launching a coin picks its URI, so off the local test chain the server only
// fetches https hosts that aren't IP literals or internal names.
function isPublicUrl(url: URL): boolean {
  if (NETWORK === "localnet") return url.protocol === "https:" || url.protocol === "http:";
  return url.protocol === "https:" && !/^(localhost|[\d.]+|\[.*\])$|\.(localhost|local|internal)$/.test(url.hostname);
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    size += value.byteLength;
    if (size > OFFCHAIN_MAX_BYTES) {
      void reader.cancel();
      throw new Error("metadata JSON too large");
    }
    chunks.push(value);
  }
}

// Keeps only the fields the site shows, type-checked, since the JSON is user-supplied.
function parseOffchain(json: unknown): Offchain {
  const { image, description } = (json ?? {}) as Record<string, unknown>;
  return {
    image: typeof image === "string" && image.length <= 2048 && /^(https?:\/\/|\/(?!\/))/.test(image) ? image : undefined,
    description: typeof description === "string" && description ? description.slice(0, 1000) : undefined,
  };
}

async function loadOffchain(uri: string, origin: string): Promise<Offchain> {
  const self = new URL(origin).origin;
  let url = new URL(uri);
  // JSON hosted by this site is read from the origin serving the request, so local URIs
  // keep working whatever port the dev server runs on.
  if (url.pathname.startsWith("/api/metadata/")) url = new URL(url.pathname, self);
  const signal = AbortSignal.timeout(OFFCHAIN_TIMEOUT_MS);
  // Redirects are followed by hand so every hop gets the same host check.
  for (let hop = 0; hop <= 3; hop++) {
    if (url.origin !== self && !isPublicUrl(url)) throw new Error(`not fetching ${url.origin}`);
    const res = await fetch(url, { signal, redirect: "manual", cache: "no-store" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) {
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.origin}`);
      return parseOffchain(JSON.parse(await readCapped(res)));
    }
    void res.body?.cancel();
    url = new URL(location, url);
  }
  throw new Error(`too many redirects for ${uri}`);
}

// Off-chain JSON per URI, cached 10 minutes. Past the wait budget a coin gets its last
// known JSON (or none) while the fetch finishes in the background.
async function offchainFor(uris: string[], origin: string): Promise<Offchain[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, OFFCHAIN_WAIT_MS);
  });
  try {
    return await Promise.all(
      uris.map((uri): Offchain | Promise<Offchain> => {
        if (!uri) return {};
        const key = `offchain:${uri}`;
        const load = cached(key, OFFCHAIN_TTL_MS, () => loadOffchain(uri, origin)).catch((): Offchain => ({}));
        return Promise.race([load, deadline.then(() => peek<Offchain>(key) ?? {})]);
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function listCoinsServer(origin: string): Promise<Coin[]> {
  const config = configAddress();
  const [threshold, pools] = await Promise.all([
    graduationThreshold(),
    serverRpc().dbc.state.getPoolsByConfig(config) as Promise<PoolAccount[]>,
  ]);
  const metas = await tokenMetas(pools.map((pool) => pool.account.poolState.baseMint));
  const offchain = await offchainFor(metas.map((meta) => meta?.uri ?? ""), origin);
  return pools.map((pool, i) => coinFromPool(pool, metas[i], offchain[i], threshold));
}

// One coin for server-rendered metadata and link-preview cards, read the same way as the
// list. Cached briefly so a burst of link previews shares one read. Pages have no request
// origin to read this site's own metadata from, so they use the configured site URL.
export async function getCoinServer(
  mint: string,
  origin = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
): Promise<Coin | null> {
  let address: PublicKey;
  try {
    address = deriveDbcPoolAddress(wgramMint(), new PublicKey(mint), configAddress());
  } catch {
    return null;
  }
  return cached(`coin:${address.toBase58()}`, 4_000, async () => {
    const [threshold, account] = await Promise.all([graduationThreshold(), serverRpc().dbc.state.getPool(address)]);
    if (!account) return null;
    const [meta] = await tokenMetas([account.poolState.baseMint]);
    const [offchain] = await offchainFor([meta?.uri ?? ""], origin);
    return coinFromPool({ publicKey: address, account }, meta, offchain, threshold);
  });
}
