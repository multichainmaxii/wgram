# GRAM on Solana

Brings real GRAM (Telegram's TON coin) to Solana as **wGRAM**, an SPL token backed
1:1 by GRAM, so our launchpad can pair coins against it.

```
GRAM on TON
  │  HOT Bridge (deposit)
  ▼
HOT GRAM on NEAR        v2_1.omni.hot.tg, token "1117_"  (NEP-245 multi-token)
  │  gram-wrapper (this repo): mt_transfer_call → mint 1:1
  ▼
wGRAM on NEAR           our wrapper account               (NEP-141)
  │  Omni Bridge: omni.bridge.near → Solana program dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe
  ▼
wGRAM on Solana         SPL mint created by Omni's deploy_token
```

The wrapper is the one missing piece. Omni Bridge (the route ZEC and NEAR took to
Solana) only carries NEP-141 tokens, and GRAM only exists on NEAR as HOT's NEP-245
token. Everything else in the path already runs in production.

## What the wrapper guarantees

- **1:1 backing.** Wrapped supply is only minted when HOT GRAM arrives from
  `v2_1.omni.hot.tg` with token id `1117_`. Anything else sent to it is refunded.
- **Always redeemable.** `unwrap` burns wrapped GRAM and sends HOT GRAM back. If
  that transfer fails, the burn is reverted.
- **No admin.** There is no owner, mint, pause or upgrade method. After deployment
  the account's access keys are deleted, so nobody (including us) can change it.
- Force-unregistering storage is disabled, and an account can't unregister while one
  of its transfers or unwraps is still settling, so a refund or a failed unwrap always
  lands. Neither path can burn supply and strand backing (see SECURITY.md, L1).

**Trust model for holders.** Holders rely on HOT Bridge (holds the TON-side GRAM;
its contract is admin-upgradable and pausable), this wrapper (immutable), and Omni
Bridge (NEAR MPC plus Wormhole). ZEC and NEAR on Solana use the same Omni leg.

## Layout

| Path | What it is |
|---|---|
| `gram-wrapper/` | The contract. Unit tests in `src/lib.rs`, property tests in `tests/properties.rs`, sandbox tests in `tests/sandbox.rs` |
| `mock-mt/` | Test-only NEP-245 token standing in for HOT Bridge |
| `mock-ft-receiver/` | Test-only NEP-141 receiver that keeps part of each `ft_transfer_call` |
| `SECURITY.md` | Threat model, invariants mapped to tests, pre-mainnet checklist |

## Build and test

Requires Rust and [`cargo-near`](https://github.com/near/cargo-near) 0.22.

```bash
cargo test -p gram-wrapper --lib               # unit tests
cargo test -p gram-wrapper --test properties  # property tests, 1,280 cases
cargo test -p gram-wrapper --test sandbox     # end-to-end on a local NEAR sandbox
cargo near build non-reproducible-wasm --manifest-path gram-wrapper/Cargo.toml
```

For mainnet, build with
`cargo near build reproducible-wasm --manifest-path gram-wrapper/Cargo.toml` from a clean
commit that is pushed to this repo (needs Docker). It runs in the cargo-near image pinned
in `gram-wrapper/Cargo.toml`, so anyone can rebuild the same wasm from that commit and
compare its hash with the code on chain.

## Decisions (permanent)

1. **Token name and symbol.** Decided: `Wrapped GRAM` / `wGRAM`, 9 decimals (matches
   HOT GRAM). Omni copies these into the Solana mint and they can never change. The
   "wrapped" name keeps it honest (not issued by Telegram/TON) and lets it coexist
   with any future official GRAM on Solana.
2. **NEAR account for the wrapper.** Decided: `wgram.near`. Create it fresh and use it for
   nothing else, because its keys get deleted when the contract is locked (step 4).

Known risk, accepted: Chainlink's TON repo has an unreleased wrapper also called wGRAM. If
an official wGRAM reaches Solana, two tokens will share the ticker and Jupiter will verify
only one of them.

## Runbook

All signing happens in your wallets. Commands use
[near-cli-rs](https://github.com/near/near-cli-rs) (`near`) and Omni's
[bridge-cli](https://github.com/Near-One/bridge-sdk-rs/tree/main/bridge-cli).
Amounts are in smallest units (1 GRAM = `1000000000`).

### 1. Testnet dry run (fake GRAM)

HOT Bridge is mainnet-only, so the dry run uses `mock-mt` as fake GRAM. Omni testnet is
`omni.n-bridge.testnet`, paired with Solana devnet program
`862HdJV59Vp83PbcubUnvuXc4EAXP8CDDs6LTxFpunTe` (Omni's README lists `Gy1XPw...`, which
belongs to a different, inactive deployment). The whole run is scripted:

```bash
NEAR_ACCOUNT=yourname.testnet ./scripts/testnet-dry-run.sh all     # NEAR side
NEAR_ACCOUNT=yourname.testnet ./scripts/testnet-dry-run.sh bridge  # Solana side
```

The script signs every NEAR transaction from the near-cli keychain (bridge-cli only
builds unsigned transactions) and always uses the devnet wallet in `SOL_WALLET`
(default `~/.config/solana/wgram-devnet.json`), never `~/.config/solana/id.json`.

### 2. Deploy and initialize

```bash
near contract deploy wgram.near \
  use-file target/near/gram_wrapper/gram_wrapper.wasm \
  with-init-call new json-args '{
    "mt_contract": "v2_1.omni.hot.tg",
    "mt_token_id": "1117_",
    "metadata": { "spec": "ft-1.0.0", "name": "Wrapped GRAM", "symbol": "wGRAM", "decimals": 9 }
  }' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config mainnet sign-with-keychain send
```

Keep about 3 NEAR on the account: ~2 NEAR for contract storage plus a small buffer.

### 3. Prove HOT interop with a tiny real amount (before locking)

```bash
# register yourself on the wrapper
near contract call-function as-transaction wgram.near storage_deposit \
  json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0.00125 NEAR' \
  sign-as <you>.near network-config mainnet sign-with-keychain send

# wrap 0.1 GRAM
near contract call-function as-transaction v2_1.omni.hot.tg mt_transfer_call \
  json-args '{"receiver_id":"wgram.near","token_id":"1117_","amount":"100000000","msg":""}' \
  prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as <you>.near network-config mainnet sign-with-keychain send

# unwrap 0.05 GRAM
near contract call-function as-transaction wgram.near unwrap \
  json-args '{"amount":"50000000"}' prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as <you>.near network-config mainnet sign-with-keychain send
```

Check that `ft_total_supply` on the wrapper equals
`mt_balance_of({"account_id":"wgram.near","token_id":"1117_"})` on
`v2_1.omni.hot.tg`.

### 4. Lock the contract

Delete every access key so the code can never change. Do this **before** creating
the Solana token so it is immutable from day one.

```bash
near account list-keys wgram.near network-config mainnet now
near account delete-keys wgram.near public-keys <each-key> \
  network-config mainnet sign-with-keychain send
```

### 5. Create GRAM on Solana

```bash
# let Omni hold the token
near contract call-function as-transaction wgram.near storage_deposit \
  json-args '{"account_id":"omni.bridge.near"}' prepaid-gas '30.0 Tgas' \
  attached-deposit '0.00125 NEAR' sign-as <you>.near network-config mainnet sign-with-keychain send

bridge-cli mainnet log-metadata --token near:wgram.near
bridge-cli mainnet deploy-token --chain sol --source-chain near --tx-hash <log-metadata tx>
bridge-cli mainnet bind-token --chain sol --tx-hash <deploy-token signature>
```

`deploy-token` needs `SOLANA_KEYPAIR` with a little SOL for rent. The printed mint
is the GRAM address the launchpad will use.

### 6. First bridge transfer

```bash
bridge-cli mainnet near-storage-deposit --token wgram.near --amount <required>
bridge-cli mainnet near-init-transfer --token wgram.near \
  --amount 10000000 --recipient sol:<your-solana-wallet>
```

With a sufficient fee Omni's relayer finalizes it. Otherwise run `near-sign-transfer`
then `svm-finalize-transfer` from bridge-cli. The way back is `svm-init-transfer`
with `--recipient near:<you>.near`, then `unwrap`, then withdraw via HOT to TON.

## After launch

- Seed a GRAM/SOL pool so the launchpad has a price and exit liquidity.
- Apply for Jupiter verification at verified.jup.ag.
