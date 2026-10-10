# wGRAM

GRAM on Solana, and a launchpad for coins paired with it.

- **wGRAM** is an SPL token on Solana backed 1:1 by GRAM, Telegram's TON coin. GRAM
  leaves TON through HOT Bridge, is wrapped on NEAR by the contract in
  [`contracts/`](contracts), and crosses to Solana through NEAR's Omni Bridge.
- **ongram.fun** is the launchpad in [`launchpad/`](launchpad). Anyone can
  launch a coin priced in wGRAM on a Meteora bonding curve. When the curve fills, the coin
  graduates into a Meteora DAMM v2 pool with its liquidity locked.

> **Status: not live.** Nothing is deployed on mainnet yet, and the contract has not been
> audited. The wrapper's NEAR side has run end to end on testnet, and the launchpad is
> tested on a local validator running Meteora's mainnet programs.

## How GRAM gets to Solana

```
GRAM on TON
  │  HOT Bridge
  ▼
HOT GRAM on NEAR     v2_1.omni.hot.tg, token 1117_   (NEP-245)
  │  gram-wrapper: deposit → mint 1:1, unwrap → burn and send back
  ▼
wGRAM on NEAR        wgram.near                       (NEP-141)
  │  Omni Bridge
  ▼
wGRAM on Solana      SPL mint created by Omni Bridge
```

Omni Bridge only carries NEP-141 tokens, and GRAM reaches NEAR as HOT's NEP-245 token, so
the wrapper is the one new piece. The rest of the route already runs in production.

The wrapper has no owner, admin, mint or upgrade method. Once it's deployed, its account
keys are deleted, so nobody (including us) can change it or mint wGRAM without GRAM
behind it. The mainnet build is reproducible: anyone can rebuild the wasm from this repo
and compare it with the code on chain.

## Layout

| Path | What it is |
|---|---|
| [`contracts/`](contracts) | The NEAR wrapper contract, its tests, threat model ([SECURITY.md](contracts/SECURITY.md)) and runbook |
| [`launchpad/`](launchpad) | Meteora curve settings, operator scripts and a local smoke test |
| [`launchpad/web/`](launchpad/web) | The website (Next.js) |

## Run it locally

Contracts (Rust and [cargo-near](https://github.com/near/cargo-near)):

```bash
cd contracts
cargo test -p gram-wrapper
```

Launchpad (Node 20+, pnpm 10 and the Solana CLI):

```bash
cd launchpad
pnpm install
pnpm validator   # terminal 1: local validator with Meteora's mainnet programs
pnpm seed        # terminal 2: stand-in wGRAM and demo coins, writes web/.env.local
cd web
pnpm install
pnpm dev         # http://localhost:3000
```

## Security

[contracts/SECURITY.md](contracts/SECURITY.md) has the threat model, the invariants and
the tests that cover them, and the pre-mainnet checklist. Please report vulnerabilities
privately through this repository's Security tab, not in a public issue.

## Disclaimer

wGRAM is an independent project. It is not issued or endorsed by Telegram, the TON
Foundation, HOT, NEAR or Meteora.
