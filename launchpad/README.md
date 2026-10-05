# wGRAM launchpad

Coins launched here trade on Meteora bonding curves priced in **wGRAM** (Wrapped GRAM,
bridged from TON; see `../contracts`). Once a curve raises enough wGRAM it graduates into a
Meteora DAMM v2 pool (coin/wGRAM) with its liquidity locked forever.

## Smoke test

Runs on a local validator loaded with Meteora's **live mainnet programs**, so it tests what
production runs. wGRAM is replaced by a stand-in with identical properties (classic SPL
token, 9 decimals), since that's what Omni Bridge mints on Solana.

```bash
pnpm install
pnpm validator   # terminal 1: RPC on 127.0.0.1:11899 (can run beside a validator on 8899)
pnpm smoke       # terminal 2
```

Knobs: `CREATORS`, `TRADERS`, `TRADES`, `RPC` environment variables.

What it checks: several creators launch coins, random traders buy and sell across all
curves (every trade must settle exactly), one coin graduates and migrates into a DAMM v2
pool, and the platform and a creator claim trading fees in wGRAM.

## Current parameters (in `scripts/curve.ts`)

| | |
|---|---|
| Launch market cap | 3,000 wGRAM (~$4.5k) |
| Graduation market cap | 26,500 wGRAM (~$40k, StonkFun's level) |
| wGRAM raised to graduate | ~6,672 (~$10k) |
| Trading fee | 1.5%: Meteora 0.3%, creator ~0.4%, platform ~0.4%, ecosystem buyback ~0.4% |
| Launch fee | 0.01 SOL (total launch cost ~0.0345 SOL with rent) |
| Supply | 1B, 6 decimals, no mint authority after launch |
| Graduated pool | DAMM v2, 1% fee tier, LP locked 50/50 platform/creator |

## Things the real app must handle

- **The graduating buy must use `swap2` with `SwapMode.PartialFill`.** A plain exact-in
  buy larger than what's left on the curve is rejected (`InsufficientLiquidity`); partial
  fill buys up to the graduation point and refunds the rest.
- **Graduation is automatic on mainnet.** Meteora's migrator moves completed curves into
  DAMM v2, and Meteora pre-funds the rent (its pool authorities held 68.6 and 175 SOL when
  checked). The local test funds them itself.
- **Traders need wGRAM to buy**, so a liquid wGRAM/SOL pool and a buy-with-SOL flow are
  needed for anyone who doesn't bridge from TON.
- **Must be a website, not a Telegram Mini App.** Telegram's blockchain guidelines forbid
  Mini Apps from promoting versions of TON tokens on other chains.

## Going live

[DEPLOY.md](DEPLOY.md) is the runbook: the devnet rehearsal, creating the config, the
website's environment variables, the Vercel deploy and claiming fees.

```bash
pnpm create-config --rpc <url> --wgram <mint> --platform-keypair <path>    # creates our Meteora config
pnpm claim-fees --rpc <url> --config <address> --platform-keypair <path> --buyback <address>   # claims fees, half to buyback
```

Both are dry runs (simulation only) unless you add `--send`.
