# ongram.fun website

The launchpad's site, live at https://ongram.fun: browse coins, launch one, and trade on its
Meteora bonding curve in wGRAM. Next.js 16, React 19, Tailwind 4 and the Solana wallet
adapter.

The look is editorial and console-like (in the spirit of kprverse.com): extra-wide display
type (Archivo), monospace labels (IBM Plex Mono), coin cards with cut corners, and Telegram's
night palette (the site is dark only). The logo is a progress ring around a diamond (`public/logo.svg`;
earlier concepts are in `../brand/`). No Telegram or TON marks are used, and the footer says
the site is independent. Pages: home, Explore, Launch, Profile (your wallet, your coins and
their creator earnings) and Get wGRAM (linked from the footer).

Sign-in goes through Privy (Telegram, email or any Solana wallet, with a wallet made for
people who have none) when `NEXT_PUBLIC_PRIVY_APP_ID` is set; otherwise, and always on the
local chain, the Solana wallet adapter is used. Components only use `useAppWallet()` from
`src/lib/wallet.tsx`.

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
