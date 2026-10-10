# Going live

How to take the launchpad from the local chain to devnet, then mainnet. Rehearse the whole
thing on devnet first. Steps marked **(owner)** need your money, keys or accounts; the
[owner checklist](#7-owner-checklist) at the end collects them.

Both operator scripts only simulate unless you pass `--send`, and never print secret keys.

Order of go-live:

1. wGRAM exists on Solana mainnet ([contracts runbook](../contracts/README.md#runbook), steps 2–6).
2. The devnet rehearsal passes end to end (section 2).
3. Create the mainnet config (section 3).
4. Deploy the site with the mainnet values (sections 4 and 5).
5. A first small real launch, then the wGRAM/SOL pool and Jupiter verification.
6. Claim fees on a schedule (section 6).

## 1. Prerequisites

- **The wGRAM mint.** Mainnet: the mint printed by step 5 of the contracts runbook
  (`bridge-cli mainnet deploy-token`). Devnet: the mint from the testnet dry run
  (`./scripts/testnet-dry-run.sh bridge` in `contracts/`, saved as `MINT=` in
  `contracts/scripts/.dryrun-state`). It must be a classic SPL Token mint with 9 decimals,
  which is what Omni Bridge creates; `create-config` refuses anything else.
- **An RPC that supports `getProgramAccounts`**, such as Helius or Triton on mainnet. The
  site's server and `claim-fees` list coins by scanning Meteora's program, which the public
  `api.mainnet-beta.solana.com` endpoint blocks or rate-limits. Get two keys: a secret one
  for the server and one for browsers, restricted to your domain.
- **A Vercel project with a Blob store** (section 5) for coin images and metadata.
- **(owner) A platform keypair per network**, kept outside the repo:
  `solana-keygen new --outfile ~/.config/gramfun/mainnet-platform.json`. It pays for the
  config and becomes its fee claimer **permanently**: Meteora configs can't be changed, so
  losing this file loses all future platform fees, and anyone with a copy can claim them.
  The website never needs it.
- Node 20+, pnpm 10, the Solana CLI, and `pnpm install` in `launchpad/` (scripts) and
  `launchpad/web/` (site).

## 2. Devnet rehearsal

Meteora's bonding curve program, DAMM v2 and the 1% DAMM v2 graduation config live at the
same addresses on devnet and mainnet, so devnet runs the same code paths.

1. Pick the devnet wGRAM mint: the Omni-bridged one from the testnet dry run if you have it.
   Otherwise a stand-in is fine for the launchpad side: **(owner)**
   `spl-token create-token --decimals 9 --url devnet`, then `spl-token mint` test wGRAM to
   whoever is testing.
2. Create and fund a devnet platform keypair:

   ```bash
   solana-keygen new --outfile ~/.config/gramfun/devnet-platform.json
   solana airdrop 1 $(solana-keygen pubkey ~/.config/gramfun/devnet-platform.json) --url devnet
   ```

3. Create the devnet config (section 3) with a devnet RPC (`https://api.devnet.solana.com`
   works at devnet scale; a Helius devnet key is better).
4. Deploy a devnet preview with the devnet values (sections 4 and 5).
5. With a wallet switched to devnet: launch a coin with an image, buy and sell, check the
   coin page's trades and chart, and paste a coin link into Telegram or X to see its preview
   image. Graduation needs about 6,672 wGRAM raised on one curve; try it if you have a
   stand-in mint, but it isn't required.
6. Claim the fees (section 6) and check that wGRAM and SOL reach the platform wallet.

## 3. Create the config

One config per network, and every coin launched on the site uses it. Its curve and fees
come from `scripts/curve.ts` and can't be changed once it exists: a new curve means a new
config.

```bash
cd launchpad
RPC='https://mainnet.helius-rpc.com/?api-key=<server key>'
WGRAM=<wGRAM mint>
KEY=~/.config/gramfun/mainnet-platform.json

pnpm create-config --rpc "$RPC" --wgram $WGRAM --platform-keypair $KEY          # dry run
pnpm create-config --rpc "$RPC" --wgram $WGRAM --platform-keypair $KEY --send   # create it
```

- The dry run checks the mint (classic SPL Token, 9 decimals) and prints its authorities,
  shows the platform wallet's balance against the rent it needs (about 0.0082 SOL),
  summarizes the curve and prints the simulated result. Nothing is sent and nothing is
  written to disk.
- `--send` saves a new config keypair next to the platform keypair
  (`mainnet-platform-config.json`), sends the transaction, checks on chain that the quote mint
  is wGRAM and the fee claimer is the platform, and prints the website env lines:

  ```
  NEXT_PUBLIC_CONFIG=<config address>
  NEXT_PUBLIC_WGRAM_MINT=<wGRAM mint>
  ```

- Re-running is safe. If the saved config already exists on that network, the script prints
  its env lines again instead of creating another one (also after a send that timed out).
  To create a second config on purpose, move the saved `*-config.json` aside first.
- Check it on an explorer: `https://solscan.io/account/<config>` (add `?cluster=devnet`).

## 4. Website environment variables

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_NETWORK` | `mainnet` or `devnet` | Off mainnet the header shows a network badge. `localnet` is for the local chain only (burner wallet, wGRAM faucet). |
| `NEXT_PUBLIC_RPC` | Browser RPC URL | Wallets read balances and send trades through it. Visible to everyone: use the domain-restricted key. |
| `RPC_URL_SERVER` | Server RPC URL | Server-only. Used by the site's server for the cached coin list, trade history and coin link previews. Must support `getProgramAccounts`. Secret: never give it a `NEXT_PUBLIC_` name. Falls back to `NEXT_PUBLIC_RPC` if unset, which mainnet traffic will outgrow (and a domain-restricted browser key may refuse server requests). |
| `NEXT_PUBLIC_CONFIG` | From `create-config` | Our Meteora config on this network. |
| `NEXT_PUBLIC_WGRAM_MINT` | From `create-config` | The wGRAM mint on this network. |
| `NEXT_PUBLIC_GRAM_USD` | e.g. `1.5` | Fallback GRAM price in USD, used until the live price loads or if it is unavailable. |
| `COINGECKO_DEMO_API_KEY` | Optional | Server-only. Free CoinGecko demo key for the live GRAM price, sent as the `x-cg-demo-api-key` header. Without it, price requests share CoinGecko's keyless per-IP limit with everything else on Vercel's IPs. Never give it a `NEXT_PUBLIC_` name. |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy app id | Optional. Turns on Privy sign-in (Telegram, email, Solana wallets, embedded wallets). The app must allow the site's domain. Not a secret. |
| `NEXT_PUBLIC_HERO_ART` | e.g. `/art/hero.jpg` | Optional. Full-bleed home hero image under `public/`; without it the hero draws the logo's ring. |
| `NEXT_PUBLIC_X_URL`, `NEXT_PUBLIC_TELEGRAM_URL` | Community links | Optional. Shown in the footer when set. |
| `NEXT_PUBLIC_SITE_URL` | e.g. `https://ongram.fun` | The site's public https origin, with no trailing slash. It is the base of the `og:image` URLs in coin link previews, and the server reads the site's own `/api/metadata` and `/api/images` paths from it. |
| `BLOB_READ_WRITE_TOKEN` | Set by Vercel | Added when you connect the Blob store. Stores coin images and metadata; required in production, where the site refuses uploads without it. Not needed locally, where uploads go to `launchpad/web/.data/`. |
| `DEV_ADMIN_KEYPAIR` | Local only | Mint authority of the local stand-in wGRAM, for the localnet faucet. **Never set it on Vercel or anywhere but your machine.** |

`NEXT_PUBLIC_*` values are compiled in at build time, so redeploy after changing them.

## 5. Deploy to Vercel

1. **(owner)** In Vercel, add a new project and import this Git repository.
2. Set **Root Directory** to `launchpad/web`. The framework preset is Next.js; keep the
   default install and build commands (pnpm is detected from `launchpad/web/pnpm-lock.yaml`,
   the build is `next build`).
3. Under Storage, create a Blob store with public access and connect it to the project.
   Vercel adds `BLOB_READ_WRITE_TOKEN` to the project's environments. Coin images and
   metadata are served straight from it, and their URLs go on chain, so keep the store.
4. Under Firewall, add a rate-limit rule for `POST /api/upload` and `POST /api/metadata`
   (for example 10 requests a minute per IP). Neither route limits itself, and images
   uploaded for coins that never launch stay in the Blob store.
5. Under Environment Variables, give **Production** the mainnet values and **Preview** the
   devnet ones. Scoping Preview to a `devnet` branch with a stable domain (for example
   `devnet.<your domain>`) keeps its `NEXT_PUBLIC_SITE_URL` valid.
6. Deploy. **(owner)** Add your domain and point its DNS at Vercel, set
   `NEXT_PUBLIC_SITE_URL` to it, and redeploy.
7. Check the live site: the home page lists coins, `/api/coins` and `/api/price` return
   JSON, launching uploads the image, coin pages show trades and the chart, and a shared coin
   link shows its preview image.

It has to stay a website: Telegram's blockchain guidelines forbid Mini Apps that promote
versions of TON tokens on other chains.

## 6. Claim fees

Per coin on its bonding curve, the platform earns:

- **~0.8% of trading volume in wGRAM**: the 1.5% fee, less Meteora's 20% cut, of which the
  coin's creator gets 33%. `claim-fees` passes half of what it claims (~0.4% of volume) on
  to the ecosystem buyback wallet (`--buyback`), so the platform keeps ~0.4%.
- **0.009 SOL per launch**: the 0.01 SOL launch fee, less Meteora's 10%.

Fees wait in each coin's pool until claimed, so claim whenever suits (weekly is plenty):

```bash
cd launchpad
pnpm claim-fees --rpc "$RPC" --config <config> --platform-keypair $KEY --buyback <buyback address>          # list and simulate
pnpm claim-fees --rpc "$RPC" --config <config> --platform-keypair $KEY --buyback <buyback address> --send   # claim
pnpm claim-fees … --buyback-share 100 --send   # all of it to the buyback (market-maker) wallet as liquidity
```

- It checks that the keypair is the config's fee claimer, lists every coin with unclaimed
  platform fees and the totals, then claims with one transaction per coin (trading fees and
  the launch-fee share together) and prints the platform's wGRAM and SOL before and after.
- Cost: about 0.000005 SOL per coin, plus about 0.002 SOL once to open the platform's wGRAM
  account. Meteora's SDK also opens a token account for each coin in case there are fees in
  it; the script closes it again in the same transaction, so no rent stays locked.
- Failures (for example a transaction that didn't land) are listed and the script exits
  non-zero. Re-run it: it only picks up what is still unclaimed.

### Graduations

Meteora's own keepers only migrate finished curves whose quote token is on their list (SOL,
USDC, JUP and a few others) or is Jupiter-verified with an Organic Score above 50. wGRAM is
neither yet, so the market-maker bot (`BOT=mm`) migrates every finished curve under
`LAUNCHPAD_CONFIG` (default: the mainnet config) into its DAMM v2 pool on each cycle
(`scripts/migrate.ts`, about 0.002 SOL each, paid by the buyback wallet). To check or run it by hand:

```bash
pnpm migrate-graduated --rpc "$RPC" --config <config> --payer-keypair <path>          # list
pnpm migrate-graduated --rpc "$RPC" --config <config> --payer-keypair <path> --send   # migrate
```

### Keeping the market maker supplied

- **NEAR for bridging.** Every bridge trip pays NEAR gas and Omni's relayer fee from
  `NEAR_ACCOUNT`, about 0.06 NEAR per trip. The bot logs `LOW NEAR` below 1.5 NEAR; bridging
  stops when it runs out. Keep tens of NEAR there when volume is high.
- **Pool size.** Bridge trips take a few minutes, so the pool plus the bot's reserve must
  absorb the flow in between. In `scripts/stress-mm.ts` runs at a $1M/day pace with 5-minute
  trips: $3.5k let a third of buys fail, $10k about 14%, $25k filled everything at 0.6% cost;
  a one-way $25k burst in 30 minutes needed $25k to fill (7% cost) and about $50k to stay
  calm. Send SOL to the buyback wallet to grow it; the bot converts and spreads it.
- Coins keep the config they launched with, so if you ever switch configs, keep claiming
  from the old one too.
- After graduation a coin trades in a Meteora DAMM v2 pool. The platform's half of the
  locked liquidity is a position NFT in the platform wallet; the trading fees it earns are
  claimed through DAMM v2 (`claimPositionFee` in `@meteora-ag/cp-amm-sdk`), not by this
  script.

## 7. Owner checklist

Everything here needs your funds, keys or accounts; nothing else in this runbook does.

**Keys** (back up offline; never commit them or put them on Vercel)

- [ ] Platform keypairs for devnet and mainnet (`solana-keygen new`). Keep two offline copies
      of the mainnet one: it is the permanent fee claimer.
- [ ] The Solana keypair `bridge-cli` uses for `deploy-token` (`SOLANA_KEYPAIR`, contracts
      runbook step 5).
- [ ] The keys for `wgram.near`, until they are deleted when the contract is locked
      (contracts runbook step 4).

**Funds** (approximate)

- [ ] SOL: about 0.05 SOL in the mainnet platform wallet (config rent, wGRAM account, claim
      fees), about 0.02 SOL for `deploy-token`, and SOL for the wGRAM/SOL pool.
- [ ] NEAR: about 5 NEAR on `wgram.near` for storage, plus a few NEAR for gas and storage
      deposits (contracts runbook).
- [ ] GRAM: 0.1 GRAM for the interop test, some for the first bridge transfer, and more for
      the wGRAM/SOL pool.
- [ ] Devnet SOL from `solana airdrop` or faucet.solana.com (free).

**Accounts**

- [ ] RPC provider (Helius or Triton): a server key and a domain-restricted browser key.
- [ ] Vercel: the project, its Blob store and the upload rate limit. A domain, with DNS
      pointed at Vercel.

**Signing**

- [ ] Contracts runbook steps 2–6: deploy and initialize the wrapper, prove it with real
      GRAM, lock it, create wGRAM on Solana, first bridge transfer.
- [ ] `pnpm create-config … --send` on mainnet, then put the printed values in Vercel.
- [ ] A first small launch and trade on the production site.
- [ ] Seed a wGRAM/SOL pool so traders who don't bridge from TON can get wGRAM.
- [ ] Apply for Jupiter verification of wGRAM at verified.jup.ag.
- [ ] `pnpm claim-fees … --send` on a schedule.
