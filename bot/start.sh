#!/usr/bin/env bash
# Container entrypoint: writes the keys from environment variables to files the bot
# reads, then runs it. Required variables:
#   RPC_URL             Solana RPC (Helius), kept secret
#   BUYBACK_KEYPAIR     the buyback wallet's keypair JSON (64 numbers): owns the pool
#   NEAR_ACCOUNT        NEAR account that buys and wraps GRAM
#   NEAR_KEY            its access key file JSON
#   TARGET_SOL          SOL the pool should keep on its SOL side
# Optional: WGRAM_MINT, MIN_CONVERT (SOL, default 1), MAX_CONVERT_OUT (wGRAM per sell cycle,
#           0 = no cap), INTERVAL (seconds, default 60),
#           LIVE=1 to act (otherwise watch-only).
set -euo pipefail
: "${RPC_URL:?}" "${BUYBACK_KEYPAIR:?}" "${NEAR_ACCOUNT:?}" "${NEAR_KEY:?}" "${TARGET_SOL:?}"
umask 077
mkdir -p /run/keys /data
printf '%s' "$BUYBACK_KEYPAIR" > /run/keys/buyback.json
printf '%s' "$NEAR_KEY" > /run/keys/near.json
unset BUYBACK_KEYPAIR NEAR_KEY

# bridge-in's Solana CLI calls use the same keyed RPC: the public one rejects cloud servers.
export SOL_RPC="$RPC_URL"

cd /app/launchpad
# BOT=mm runs the market maker (mm-bot.ts); otherwise the refill bot.
if [[ "${BOT:-}" == mm ]]; then
  exec pnpm mm-bot --rpc "$RPC_URL" --owner-keypair /run/keys/buyback.json \
    --wgram "${WGRAM_MINT:-B1ZqtPMn2m6rgZCynGPfhWmo41h8xSwb6A2UZsB5GNq8}" \
    --near-account "$NEAR_ACCOUNT" --near-key-file /run/keys/near.json \
    --min-convert "${MIN_CONVERT:-1}" --interval "${INTERVAL:-30}" \
    $([[ "${LIVE:-}" == 1 ]] && echo --live)
fi
exec pnpm refill-bot --rpc "$RPC_URL" --owner-keypair /run/keys/buyback.json \
  --wgram "${WGRAM_MINT:-B1ZqtPMn2m6rgZCynGPfhWmo41h8xSwb6A2UZsB5GNq8}" \
  --near-account "$NEAR_ACCOUNT" --near-key-file /run/keys/near.json \
  --target-sol "$TARGET_SOL" --min-convert "${MIN_CONVERT:-1}" --max-convert-out "${MAX_CONVERT_OUT:-0}" --interval "${INTERVAL:-60}" \
  $([[ "${LIVE:-}" == 1 ]] && echo --live)
