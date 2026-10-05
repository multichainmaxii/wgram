# GramFun website

The launchpad's site (working name GramFun): browse coins, launch one, and trade on its
Meteora bonding curve in wGRAM. Next.js 16, React 19, Tailwind 4 and the Solana wallet
adapter.

## Run locally

Start the local chain and seed it from `launchpad/` first (see the
[repo README](../../README.md#run-it-locally)). Seeding writes `.env.local` here, then:

```bash
pnpm install
pnpm dev
```

On the local chain the site uses a burner wallet and a wGRAM faucet, so no browser wallet
is needed.

## How it reads the chain

| Where | What |
|---|---|
| `src/lib/chain.ts` | Pool reads, quotes and transactions (Meteora DBC SDK), shared by browser and server |
| `src/app/api/coins/` | Cached coin list and per-coin trade history, read by the server so browsers don't each scan the chain |
| `src/app/api/price/` | GRAM/USD price from CoinGecko, with a fallback value |
| `src/app/api/upload/`, `api/metadata/`, `api/images/` | Coin images and token metadata: Vercel Blob in production, `.data/` locally |
| `src/app/api/dev/faucet/` | Local chain only: mints stand-in wGRAM |

Environment variables and the Vercel deploy are in [DEPLOY.md](../DEPLOY.md).
