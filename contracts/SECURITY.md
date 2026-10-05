# wGRAM wrapper: threat model and security review

Scope: `gram-wrapper/src/lib.rs` (near-sdk 5.29.1, near-contract-standards 5.29.1), the
parts of near-contract-standards' `FungibleToken` it relies on, and the near-sdk macro
guards (`#[init]`, `#[private]`, payable checks). Reviewed October 2026, before mainnet.

**Result:** one economic weakness was found (L1: the contract paid for re-registrations,
and that deposit could be collected back). It is fixed in code by an in-flight guard: an
account can't unregister while one of its transfers or unwraps is unsettled, so the contract
never has to re-register anyone. No other issue needed a code change. The pre-mainnet
checklist at the end has open items that must be done before the keys are deleted.

## What is at stake

| Asset | Where it lives | Who could lose it |
|---|---|---|
| Backing GRAM | Wrapper's balance of `1117_` on `v2_1.omni.hot.tg` | Every wGRAM holder, on NEAR and on Solana |
| wGRAM balances | The wrapper's NEP-141 ledger | Individual holders |
| NEAR on the wrapper account | Code storage (~1.97 NEAR for the 197 KB wasm) plus a small buffer | Nobody directly. The buffer stakes storage for in-flight records, which are deleted when each transfer or unwrap settles |

Once its keys are deleted the wrapper is immutable: no bug can be patched, and Omni ties
the Solana mint to `wgram.near` for good. That is why the bar here is "provably correct"
rather than "fixable later".

## Trust assumptions

The wrapper guarantees only its own leg: on NEAR, wGRAM supply equals the GRAM it holds.
Everything else is trusted.

- **HOT Bridge** (`v2_1.omni.hot.tg`). HOT holds the GRAM on TON and controls minting and
  burning of the NEP-245 GRAM on NEAR, so wGRAM is only as good as HOT's custody and
  signers. HOT's contract is upgradable and pausable by its admins (see L2). The wrapper
  also relies on these NEP-245 behaviours, which the sandbox mock reproduces and step 8 of
  the checklist confirms on mainnet:
  - HOT calls `mt_on_transfer` only after moving the tokens, with the real `sender_id`,
    token ids and amounts, and with no attached deposit (the hook isn't payable).
  - HOT's resolver honours the refund vector the hook returns, so refunded GRAM leaves
    the wrapper and kept GRAM stays.
  - `mt_transfer` settles within its own receipt. If it returned a promise that could fail
    after debiting the wrapper, `on_unwrap` would see a failure and re-mint unbacked wGRAM.
- **Omni Bridge** (`omni.bridge.near` plus the Solana program in the README). wGRAM on
  Solana is backed by wGRAM locked in Omni's NEAR contract. Transfers back to NEAR are
  proven through Wormhole: a Wormhole compromise could unlock wGRAM on NEAR without a burn
  on Solana. That wGRAM is real and redeemable, so it drains the backing of Solana-side
  holders, not the wrapper's own invariant.
- **NEAR MPC** (chain signatures). Omni's NEAR-to-Solana transfers are authorised by
  signatures from NEAR's MPC network. A threshold of colluding MPC nodes could mint
  unbacked wGRAM on Solana.
- **NEAR protocol and dependencies.** The wrapper inherits near-contract-standards'
  NEP-141/NEP-145 logic, so the exact versions in `Cargo.lock` are part of what gets
  audited. The reproducible build pins the toolchain.
- **The deployer, until the keys are deleted.** A full-access key can deploy any code.
  Holders should only trust the contract after step 9 of the checklist.

## External entry points

Every exported method of the built wasm, and why each is safe.

| Method | Caller and deposit | Why it is safe |
|---|---|---|
| `new` | Anyone, once; no deposit | Fails with "already been initialized" once state exists. It is not `#[private]`, so deploy and init must be one transaction (README step 2), or someone could init it first with their own `mt_contract`. It checks the metadata, a non-empty name and symbol, and a non-empty token id. |
| `mt_on_transfer` | Anyone; no deposit | Mints only if the predecessor is `mt_contract`. Anyone else gets every amount back and nothing is minted. It mints only for `token_id == mt_token_id`, refunds other ids one by one, and refunds everything for a malformed `msg` or an unregistered receiver. It returns refunds rather than panicking, so the sender's GRAM comes back cleanly. The batch sum and the deposits are overflow-checked. |
| `unwrap` | Holder; exactly 1 yoctoNEAR, so a full-access key is needed | `amount > 0`. It burns first: `internal_withdraw` panics on an unregistered account or a short balance, and the panic reverts everything. It records the unwrap as in flight, then sends exactly `amount` of `mt_token_id` to `receiver_id` (the caller by default), attaching the user's 1 yocto, with `on_unwrap` chained after. |
| `on_unwrap` | `#[private]`: only the wrapper's own callback; no deposit | Clears the in-flight record. Re-mints only on an explicit `PromiseError::Failed`. A success, including one that returns data (`TooLong`), never re-mints. The refund always goes to the owner, not `receiver_id`. The owner can't have unregistered meanwhile (L1); a re-registration stays only as an unreachable safety net. |
| `ft_transfer` | Holder; 1 yocto | Standard NEP-141. Sender and receiver must be registered and different, and `amount > 0`. |
| `ft_transfer_call` | Holder; 1 yocto | As above, and records the transfer as in flight until the resolver runs. The receiver gets all unused gas. The resolver gets a fixed 5 Tgas; it burned 2.0 Tgas in the sandbox. |
| `ft_resolve_transfer` | `#[private]`; no deposit | Clears the in-flight record, then the standard refund: at most `amount`, and at most what the receiver still holds. The sender can't have unregistered while the call was in flight, so the standard's burn path is unreachable; a re-registration stays as a safety net. |
| `storage_deposit` | Anyone, for themselves or for `account_id`; payable | Needs at least the minimum (0.00125 NEAR). Any excess, and the whole deposit for an account that is already registered, is refunded. |
| `storage_withdraw` | Registered account; 1 yocto | Min equals max, so nothing is ever withdrawable. No state change. |
| `storage_unregister` | Registered account; 1 yocto | `force` is ignored, a positive balance always refuses, and so does any transfer or unwrap still in flight (L1). Unregistering never burns supply, and the contract never pays to bring an account back. It returns the 0.00125 NEAR deposit plus the 1 yocto. |
| `ft_total_supply`, `ft_balance_of`, `ft_metadata`, `storage_balance_bounds`, `storage_balance_of`, `mt_contract`, `mt_token_id`, `contract_source_metadata` (NEP-330), `__contract_abi` (embedded ABI) | Views | Read only. |

Deliberately absent: owner or admin, mint, pause, upgrade or migrate, metadata setters,
NEAR withdrawal, and `ft_on_transfer` (NEP-141 tokens sent to the wrapper with
`ft_transfer_call` are refunded by their own resolver). The only actions the code ever
creates are:

- function calls to `mt_contract` (`mt_transfer`), to NEP-141 receivers
  (`ft_on_transfer`) and to itself (the two callbacks);
- NEAR transfers that refund storage.

It never creates DeployContract, AddKey, DeleteKey, DeleteAccount or Stake actions, so
once the keys are deleted nothing can change the code.

The `#[private]`, `#[init]` and payable guards exist only in the generated wasm entry
points, so native unit tests cannot see them. The sandbox test
`outsiders_cannot_mint_or_reach_callbacks` checks them on a real runtime.

## Invariants and the tests that cover them

Tests live in `gram-wrapper/src/lib.rs` (16 unit tests), `gram-wrapper/tests/properties.rs`
(2 property tests, 1,280 generated cases per run) and `gram-wrapper/tests/sandbox.rs`
(11 tests on a local NEAR sandbox against `mock-mt` and `mock-ft-receiver`).

The property tests run random sequences of up to 47 operations on near-sdk's mocked
blockchain:

- wraps from HOT or from impostors, with random batches, amounts from 0 to `u128::MAX`,
  other or look-alike token ids, and valid, extended or garbage `msg`;
- unwraps to the owner or someone else;
- HOT payouts that succeed, succeed with data, or fail;
- `ft_transfer`;
- `ft_transfer_call`, with receivers that keep some, keep all, over-claim, return
  garbage or fail;
- unregistering in the same transaction as an unwrap or `ft_transfer_call`;
- registering, unregistering (with and without `force`) and storage withdrawals;
- wrong deposits.

They check every step against a reference model. A call that panics is rolled back like
a failed receipt and must have panicked for the reason the model predicts. Each run also
asserts that the generator actually reached the rare paths: unregistering refused while a
transfer or unwrap is in flight, partial refunds, capped refunds, and mints above
`u64::MAX`.

| # | Invariant | Tests |
|---|---|---|
| I1 | **Fully backed.** wGRAM supply plus unwraps still in flight equals the GRAM the wrapper holds on HOT, after every step. With nothing in flight, `ft_total_supply == mt_balance_of(wrapper, 1117_)`. | properties: `random_operations_keep_wgram_fully_backed` (every step, then exact equality after settling everything). Sandbox: `assert_fully_backed` after every step of all 10 tests. |
| I2 | **Only HOT GRAM mints.** Minting needs predecessor `mt_contract`, token `mt_token_id` and a registered receiver. Anything else is refunded in full. | unit: `wraps_backing_token_one_to_one`, `refunds_tokens_from_any_other_contract`, `refunds_other_token_ids_in_a_batch`, `refunds_unregistered_receiver`, `refunds_malformed_msg`, `mints_to_receiver_named_in_msg`. properties: impostor, look-alike token and garbage-msg wraps, with refund vectors checked exactly. Sandbox: `unregistered_sender_gets_everything_back`, `wrap_to_another_account`, `outsiders_cannot_mint_or_reach_callbacks` (another HOT token, and a direct hook call). |
| I3 | **Mint arithmetic never wraps around.** An oversized batch panics with no state change (HOT then refunds), even if HOT called the hook with amounts it could never hold. | properties: `oversized_wraps_never_overflow` |
| I4 | **Only the owner burns, and the payout is exact.** `unwrap` burns exactly `amount` from the caller and sends exactly `amount` of `1117_` to `receiver_id` (or the owner), with `on_unwrap` chained on that transfer. | unit: `unwrap_burns_before_sending`, `unwrap_requires_one_yocto`, `unwrap_more_than_balance_fails`. properties: receipts checked on every successful unwrap. Sandbox: `wrap_and_unwrap_round_trip`, `unwrap_pays_another_receiver` |
| I5 | **A failed payout is reverted to the owner; a successful one never re-mints.** | unit: `failed_unwrap_is_reverted`, `successful_unwrap_returning_data_does_not_remint`. properties: payouts that succeed, succeed with data, or fail, with the owner always still registered. Sandbox: `failed_unwrap_restores_balance`, `unwrap_pays_another_receiver`, `owner_cannot_unregister_mid_unwrap` (also runs on_unwrap near its 10 Tgas floor) |
| I6 | **Nothing burns supply while leaving its GRAM behind.** `force` is ignored, and no account can unregister while a transfer or unwrap is in flight, so refunds and reverted unwraps always land on a registered account. | unit: `cannot_force_unregister_with_balance`, `cannot_unregister_with_unwrap_in_flight`, `cannot_unregister_with_transfer_call_in_flight`, `can_unregister_once_unwrap_settles`. properties: unregistering with `force`, while calls are pending, and in the same transaction as an `ft_transfer_call` or unwrap. Sandbox: `sender_cannot_unregister_mid_transfer`, `owner_cannot_unregister_mid_unwrap`, `outsiders_cannot_mint_or_reach_callbacks` |
| I7 | **Conservation.** Balances sum to supply, no balance exceeds supply, transfers move exact amounts, and a refund never exceeds the amount sent or what the receiver still holds. | properties: checked after every step, including the used amount `ft_resolve_transfer` returns. Sandbox: `transfer_call_refunds_what_the_receiver_hands_back` (keeps part, refunds part, over-claim capped), `transfers_between_holders_stay_backed` |
| I8 | **Callbacks are private and init runs once.** | Sandbox: `outsiders_cannot_mint_or_reach_callbacks` |
| I9 | **A failing call changes nothing, and fails only for the expected reason** (one yocto, zero amount, unregistered account, short balance, positive balance or a transfer in flight on unregister, short storage deposit, overflow). | properties: every expected panic is rolled back and its message matched; an unexpected panic fails the run. |

The tests were themselves checked by injecting bugs into `lib.rs`, one at a time. After
the L1 fix, removing the in-flight check in `storage_unregister` fails two unit tests, and
never clearing the record when a transfer settles fails the property test. The list below
was run against the code before that fix. The
property tests catch every one of these. The sandbox tests were also run against the two
re-registration bugs, `force`, the caller check, and paying the owner instead of
`receiver_id`, and catch those too:

- dropping the re-registration in `ft_resolve_transfer` or in `on_unwrap`;
- re-minting on a successful payout that returns data;
- honouring `force`;
- dropping the caller check in `mt_on_transfer`;
- ignoring `msg.receiver_id`;
- paying the owner instead of `receiver_id`;
- matching token ids by prefix;
- an unchecked batch sum;
- auto-registering unknown receivers.

## Known limitations

**L1 (fixed). Contract-paid re-registration could be farmed.**
As first reviewed, when a sender had unregistered by the time `ft_resolve_transfer` ran, or
an owner had by the time a failed payout was reverted, the wrapper re-registered them from
its own NEAR (0.00125 NEAR). The account could then unregister and collect that deposit. A
loop of one batch transaction (`ft_transfer_call` of the whole balance, then
`storage_unregister`) netted about 0.00048 NEAR per round at the minimum gas price, and
draining a 3 NEAR buffer took about 2,600 transactions. GRAM was never at risk, but once the
buffer was empty a sender who had left could forfeit a refund, and an owner who left
mid-unwrap could lose a failed payout.

**Fix:** `ft_transfer_call` and `unwrap` record each pending operation per account, and the
resolver and `on_unwrap` clear it. `storage_unregister` refuses while the account has
anything in flight. The farming loop now fails atomically (the whole batch reverts), and no
refund or reverted unwrap can find its account gone. Covered by the unit, property and
sandbox tests listed under I5 and I6.

Residual cost: the contract stakes storage for an in-flight record (one per account with
something pending, deleted on settlement), so a holder ties up roughly 0.0008 NEAR of the
buffer for the few blocks a transfer takes. Callbacks always run on NEAR, so a record can't
outlive its transfer; if one somehow did, that account could not unregister, but no tokens
would be lost.

**L2. HOT's admin and pause powers.**

- A pause makes wraps fail on HOT's side. Unwraps fail and are re-minted, so wGRAM stays
  redeemable once HOT resumes, but nobody can redeem while HOT is paused.
- An upgrade of HOT's contract could freeze or move the wrapper's GRAM, change transfer or
  refund semantics, or call `mt_on_transfer` without moving tokens. Any of these mints or
  leaves unbacked wGRAM.

The wrapper cannot defend against the issuer of its own backing. Watch HOT's
announcements.

**L3. `msg.receiver_id` semantics.**

- An empty `msg` mints to `sender_id`: whoever called HOT's `mt_transfer_call`. For an
  approved transfer that is the approved account, not `previous_owner_ids`.
- `{"receiver_id": "..."}` mints to that account if it is registered, and extra fields
  are ignored. If the account is not registered, everything is refunded. Any other
  non-empty `msg` refunds everything, including whitespace, `null`, or a malformed or
  invalid account id.
- Beyond registration nothing is checked, so the mint to any registered account is final.
  This includes contracts, Omni's `omni.bridge.near` (wGRAM minted there is not bridged
  and is effectively lost), and the wrapper itself if someone registered it.
- The same goes for `unwrap`'s `receiver_id`: GRAM paid on HOT to a mistyped or
  non-existent account is gone. A failed payout always goes back to the owner.

**L4. No upgrade path, by design.** A bug found after the keys are deleted can only be
handled by migration: a new wrapper and a new Solana mint, with holders unwrapping from the
old one. Because `new` is not `#[private]`, deploy and init must be atomic.

**L5. Self-addressed tokens.** Anyone can register the wrapper's own account and transfer
wGRAM to it. The wrapper never moves its own balance, so those tokens are stuck forever,
though still counted and still backed.

An `unwrap` with `receiver_id` set to the wrapper asks HOT for a self-transfer. HOT should
refuse it, which triggers the re-mint. If HOT allowed it, the burn would stand and the
GRAM would become surplus.

**L6. Fixed gas floors.** `mt_transfer` gets 30 Tgas plus half the unused gas, `on_unwrap`
gets 10 Tgas plus half, and `ft_resolve_transfer` gets a fixed 5 Tgas.

- If HOT's `mt_transfer` ever needs more than its share, unwraps with little gas fail
  safely (re-minted). Attach 100 Tgas, as the README does.
- If a resolver ever ran out of gas, the receiver would keep the refund. This is standard
  NEP-141 behaviour, and nothing is burned.

**L7. Events on a failed payout.** A failed payout logs `ft_burn` ("unwrap") followed by
`ft_mint` ("unwrap refund"). An indexer that counts only burns overstates redemptions.

## Pre-mainnet checklist

1. **Baked-in metadata (done).** `contract_source_metadata` (NEP-330) links
   `https://github.com/multichainmaxii/wgram` and declares nep141, nep145 and nep148
   beside nep330. It becomes permanent at deploy. The sandbox test
   `source_metadata_links_the_repo` checks it.
2. **Build reproducibly.** `gram-wrapper/Cargo.toml` pins the cargo-near Docker image by
   digest. Build with `cargo near build reproducible-wasm` from a clean, tagged commit
   that is pushed to the public repo, then publish the wasm sha256 and the code hash.
3. **Run every test at that commit:** `cargo test -p gram-wrapper` (unit, properties and
   sandbox).
4. **Get an external audit** of `src/lib.rs` and its use of near-contract-standards
   5.29.1, using this document, including the L1 in-flight guard. Any change means
   redoing steps 2 and 3.
5. **Deploy and initialise.** Use a fresh `wgram.near` that is used for nothing else, and
   deploy and init in **one** transaction (README step 2).
6. **Verify on chain before locking.**
   - The code hash matches the reproducible build.
   - `mt_contract` is `v2_1.omni.hot.tg` and `mt_token_id` is `1117_`.
   - `ft_metadata` is Wrapped GRAM / wGRAM / 9 decimals.
   - `ft_total_supply` is 0.
7. **Fund the account and set up monitoring.** About 3 NEAR covers code storage (~2 NEAR)
   plus a buffer for in-flight records. Alert on the free NEAR balance, and on
   `ft_total_supply` differing from
   `mt_balance_of(wgram.near, 1117_)` whenever no unwrap is pending.
8. **Do a tiny real wrap and unwrap** (README step 3), plus:
   - a wrap with `msg: "x"`, to confirm HOT returns refunded GRAM;
   - an unwrap with `receiver_id` set to a second account you control;
   - in the explorer, confirm HOT's `mt_transfer` returns no promise, and note its gas
     against the 30 Tgas floor;
   - after each step, confirm supply equals backing.
9. **Delete every access key**, full-access and function-call (README step 4), before
   Omni's `log-metadata`. Confirm `list-keys` is empty and the code hash is unchanged.
10. **After the lock,** re-run the step 6 checks, and keep the monitoring from step 7
    running.

## Running the tests

```bash
cargo test -p gram-wrapper --lib               # 16 unit tests
cargo test -p gram-wrapper --test properties   # 1,280 generated cases, ~5 s
cargo test -p gram-wrapper --test sandbox      # 11 end-to-end tests, ~40 s (builds 3 contracts once)
cargo test -p gram-wrapper                     # all of the above
```

The property tests draw a fresh random seed on every run. A failure prints the shrunk,
minimal sequence of operations that reproduces it.
