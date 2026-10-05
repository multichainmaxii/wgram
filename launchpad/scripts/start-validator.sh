#!/usr/bin/env bash
# Local Solana validator running Meteora's live mainnet programs, so the launchpad
# smoke test exercises exactly what production runs.
set -euo pipefail

LEDGER="${LEDGER:-/tmp/wgram-launchpad-ledger}"
# Non-default ports so it can run beside another local validator on 8899.
RPC_PORT="${RPC_PORT:-11899}"
MAINNET="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"

DBC=dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN        # Meteora Dynamic Bonding Curve
DAMM_V2=cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG    # Meteora DAMM v2 (graduated pools)
METAPLEX=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s   # token metadata
# DAMM v2 config that DBC graduates into (MigrationFeeOption.FixedBps100, 1% LP fee)
DAMM_V2_CONFIG_1PCT=Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp
# Coin pages read trades back from transaction history. The default (10,000 shreds)
# keeps about 4 minutes of it; 2M shreds keeps about 13 hours.
LEDGER_SHREDS="${LEDGER_SHREDS:-2000000}"

exec solana-test-validator --reset --quiet --ledger "$LEDGER" --url "$MAINNET" \
  --rpc-port "$RPC_PORT" --faucet-port 11910 --gossip-port 11010 --dynamic-port-range 11100-11200 \
  --limit-ledger-size "$LEDGER_SHREDS" \
  --clone-upgradeable-program "$DBC" \
  --clone-upgradeable-program "$DAMM_V2" \
  --clone-upgradeable-program "$METAPLEX" \
  --clone "$DAMM_V2_CONFIG_1PCT"
