#!/usr/bin/env bash
# Turns wGRAM on Solana back into SOL on Solana, end to end on mainnet (the reverse of
# bridge-in.sh):
#
#   wGRAM on Solana ──Omni Bridge──► wGRAM on NEAR ──unwrap at wgram.near──► GRAM
#     ──deposit into NEAR Intents, 1Click swap──► SOL on Solana
#
# Every step that moves funds prints what it will do and waits for "yes" (YES=1 skips the
# prompts). Progress is saved, so re-running continues where it stopped.
#
#   ./bridge-out.sh <wGRAM amount>        e.g. ./bridge-out.sh 50
#   ./bridge-out.sh --dry-run <wGRAM>     quote and checks only, nothing is sent
#   ./bridge-out.sh --reset               forget a finished or abandoned run
#
# Environment (defaults in brackets):
#   NEAR_ACCOUNT     NEAR account that receives, unwraps and sells the GRAM (required)
#   NEAR_KEY_FILE    its access key file [~/.near-credentials/implicit/$NEAR_ACCOUNT.json]
#   SOL_KEYPAIR      Solana keypair holding the wGRAM [~/.config/solana/wgram-mainnet.json]
#   SOL_RECIPIENT    Solana address that receives the SOL [SOL_KEYPAIR's address]
#   SOL_RPC          Solana RPC [public mainnet]
#   YES=1            don't ask before each step
#   BRIDGE_OUT_STATE progress file [next to this script]

set -euo pipefail

WRAPPER="wgram.near"
HOT="v2_1.omni.hot.tg"
GRAM_ID="1117_"
GRAM_ASSET="nep245:$HOT:$GRAM_ID"
SOL_ASSET="nep141:sol.omft.near"
WGRAM_MINT="B1ZqtPMn2m6rgZCynGPfhWmo41h8xSwb6A2UZsB5GNq8"
ONECLICK="https://1click.chaindefuser.com/v0"
OMNI_API="https://mainnet.api.bridge.nearone.org/api/v3"
NEAR_RPC="${NEAR_RPC:-https://rpc.mainnet.near.org}"
SOL_RPC="${SOL_RPC:-https://api.mainnet-beta.solana.com}"
STATE="${BRIDGE_OUT_STATE:-$(cd "$(dirname "$0")" && pwd)/.bridge-out-state}"

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
save() { grep -v "^$1=" "$STATE" 2>/dev/null > "$STATE.tmp" || true; echo "$1=$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }
load() { [[ -f "$STATE" ]] && . "$STATE" || true; }
confirm() {
  [[ "${YES:-}" == 1 ]] && return 0
  printf '%s\nType yes to continue: ' "$1"
  local answer; read -r answer < /dev/tty
  [[ "$answer" == yes ]] || die "stopped; re-run to continue from here"
}

near_view() {  # near_view <contract> <method> [json args] -> raw JSON result
  python3 - "$NEAR_RPC" "$1" "$2" "${3:-}" <<'PY'
import base64, json, sys, urllib.request
rpc, contract, method, args = sys.argv[1:]
args = args or "{}"
body = {"jsonrpc": "2.0", "id": 1, "method": "query", "params": {
    "request_type": "call_function", "finality": "final", "account_id": contract,
    "method_name": method, "args_base64": base64.b64encode(args.encode()).decode()}}
req = urllib.request.Request(rpc, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
r = json.load(urllib.request.urlopen(req, timeout=30))
if "result" not in r or "result" not in r["result"]:
    sys.exit(f"view {contract}.{method} failed: {r.get('error') or r['result'].get('error')}")
print(bytes(r["result"]["result"]).decode())
PY
}
unquote() { python3 -c 'import json,sys; v=json.loads(sys.stdin.read()); print("" if v is None else v)'; }
fmt9() { python3 -c 'import sys; print(f"{int(sys.argv[1])/1e9:,.6f}")' "$1"; }
grew() { python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) - int(sys.argv[2]) >= int(sys.argv[3]) else 1)' "$@"; }

near_tx() {  # near_tx <contract> <method> <json args> <deposit> [gas]: signs with NEAR_KEY_FILE
  near contract call-function as-transaction "$1" "$2" json-args "$3" prepaid-gas "${5:-100.0 Tgas}" \
    attached-deposit "$4" sign-as "$NEAR_ACCOUNT" network-config mainnet \
    sign-with-access-key-file "$NEAR_KEY_FILE" send </dev/null 2>&1 \
    | grep -v -i -E "private|secret|seed" | grep -E "Transaction ID|succeeded|Error|error|Failure|panicked" || true
}

sol_wgram() {  # wGRAM (raw units) held by the Solana keypair
  python3 - "$SOL_RPC" "$SOL_OWNER" "$WGRAM_MINT" <<'PY'
import json, sys, urllib.request
rpc, owner, mint = sys.argv[1:]
body = {"jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner",
        "params": [owner, {"mint": mint}, {"encoding": "jsonParsed", "commitment": "confirmed"}]}
req = urllib.request.Request(rpc, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
accts = json.load(urllib.request.urlopen(req, timeout=30))["result"]["value"]
print(sum(int(a["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"]) for a in accts))
PY
}
sol_lamports() {
  python3 - "$SOL_RPC" "$1" <<'PY'
import json, sys, urllib.request
rpc, owner = sys.argv[1:]
body = {"jsonrpc": "2.0", "id": 1, "method": "getBalance", "params": [owner, {"commitment": "confirmed"}]}
req = urllib.request.Request(rpc, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
print(json.load(urllib.request.urlopen(req, timeout=30))["result"]["value"])
PY
}
near_wgram() { near_view "$WRAPPER" ft_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\"}" | unquote; }
hot_gram() { near_view "$HOT" mt_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\",\"token_id\":\"$GRAM_ID\"}" | unquote; }
intents_gram() { near_view intents.near mt_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\",\"token_id\":\"$GRAM_ASSET\"}" | unquote; }

quote() {  # quote <dry true|false> <raw GRAM> -> 1Click quote JSON
  local deadline
  deadline=$(python3 -c 'import datetime; print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z"))')
  curl -sf --max-time 30 -X POST "$ONECLICK/quote" -H 'Content-Type: application/json' -d "{
    \"dry\": $1, \"swapType\": \"EXACT_INPUT\", \"slippageTolerance\": 100,
    \"originAsset\": \"$GRAM_ASSET\", \"depositType\": \"INTENTS\",
    \"destinationAsset\": \"$SOL_ASSET\", \"amount\": \"$2\",
    \"recipient\": \"$SOL_RECIPIENT\", \"recipientType\": \"DESTINATION_CHAIN\",
    \"refundTo\": \"$NEAR_ACCOUNT\", \"refundType\": \"INTENTS\", \"deadline\": \"$deadline\"}" \
    || die "1Click quote request failed"
}

# --- arguments and setup ---------------------------------------------------------------

DRY=0
case "${1:-}" in
  --reset) rm -f "$STATE"; echo "state cleared"; exit 0 ;;
  --dry-run) DRY=1; shift ;;
esac
WGRAM_AMOUNT="${1:-}"
[[ -n "${NEAR_ACCOUNT:-}" ]] || die "set NEAR_ACCOUNT (the NEAR account that unwraps and sells the GRAM)"
NEAR_KEY_FILE="${NEAR_KEY_FILE:-$HOME/.near-credentials/implicit/$NEAR_ACCOUNT.json}"
SOL_KEYPAIR="${SOL_KEYPAIR:-$HOME/.config/solana/wgram-mainnet.json}"
for tool in near solana bridge-cli curl python3; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
[[ -f "$NEAR_KEY_FILE" ]] || die "no NEAR key file at $NEAR_KEY_FILE"
[[ -f "$SOL_KEYPAIR" ]] || die "no Solana keypair at $SOL_KEYPAIR"
SOL_OWNER=$(solana-keygen pubkey "$SOL_KEYPAIR")
SOL_RECIPIENT="${SOL_RECIPIENT:-$SOL_OWNER}"
load
WGRAM_AMOUNT="${WGRAM_AMOUNT:-${AMOUNT_WGRAM:-}}"
[[ "$WGRAM_AMOUNT" =~ ^[0-9]+(\.[0-9]{1,9})?$ ]] || die "usage: $0 [--dry-run] <wGRAM amount>"
RAW=$(python3 -c 'import sys; from decimal import Decimal; print(int(Decimal(sys.argv[1]) * 10**9))' "$WGRAM_AMOUNT")

log "bridge-out: $WGRAM_AMOUNT wGRAM on Solana -> SOL"
echo "  wGRAM from      $SOL_OWNER ($(fmt9 "$(sol_wgram)") wGRAM)"
echo "  NEAR account    $NEAR_ACCOUNT"
echo "  SOL goes to     $SOL_RECIPIENT"
q=$(quote true "$RAW")
out=$(printf '%s' "$q" | python3 -c 'import json,sys; q=json.load(sys.stdin)["quote"]; print(q["amountOutFormatted"], q["amountOutUsd"][:8])')
set -- $out
echo "  quote now       $WGRAM_AMOUNT GRAM -> about $1 SOL (\$$2), 1% max slippage"
[[ "$DRY" == 1 ]] && { echo; echo "Dry run: nothing was sent."; exit 0; }

# --- 1. Solana -> NEAR over Omni Bridge ---------------------------------------------------

if [[ -z "${SENT:-}" ]]; then
  have=$(sol_wgram)
  grew "$have" 0 "$RAW" || die "$SOL_OWNER holds $(fmt9 "$have") wGRAM, less than $WGRAM_AMOUNT"
  fee=$(curl -sf --max-time 20 "$OMNI_API/transfer-fee?sender=sol:$SOL_OWNER&recipient=near:$NEAR_ACCOUNT&token=sol:$WGRAM_MINT&amount=$RAW" \
    | python3 -c 'import json,sys; f=int(json.load(sys.stdin).get("native_token_fee") or 0); print(max(f + f // 2, 100000))') \
    || die "could not get the Omni Bridge fee"
  confirm "Step 1: bridge $WGRAM_AMOUNT wGRAM from Solana to $NEAR_ACCOUNT (relayer fee $fee lamports)."
  save AMOUNT_WGRAM "$WGRAM_AMOUNT"
  save NEAR_BEFORE "$(near_wgram)"
  NO_COLOR=1 SOLANA_KEYPAIR="$SOL_KEYPAIR" bridge-cli mainnet svm-init-transfer --chain sol --solana-rpc "$SOL_RPC" \
    --token "$WGRAM_MINT" --amount "$RAW" --recipient "near:$NEAR_ACCOUNT" --fee 0 --native-fee "$fee" 2>&1 \
    | grep -v -i -E "private|secret" | tail -3
  grew "$have" "$(sol_wgram)" "$RAW" || die "the wGRAM did not leave $SOL_OWNER; re-run to retry"
  save SENT 1
fi
load

if [[ -z "${ARRIVED:-}" ]]; then
  log "Waiting for the relayer to finish on NEAR (usually a few minutes)"
  for _ in $(seq 1 80); do
    grew "$(near_wgram)" "$NEAR_BEFORE" "$RAW" && { save ARRIVED 1; break; }
    sleep 15
  done
  load
  [[ -n "${ARRIVED:-}" ]] || die "wGRAM not on NEAR after 20 minutes; Omni relayers can be slow, so re-run later to keep waiting"
fi

# --- 2. unwrap into GRAM ---------------------------------------------------------------------

if [[ -z "${UNWRAPPED:-}" ]]; then
  confirm "Step 2: unwrap $WGRAM_AMOUNT wGRAM into GRAM at $WRAPPER."
  before=$(hot_gram)
  near_tx "$WRAPPER" unwrap "{\"amount\":\"$RAW\"}" '1 yoctoNEAR'
  sleep 3
  grew "$(hot_gram)" "$before" "$RAW" || die "unwrap did not deliver GRAM (a failed unwrap is re-minted); re-run to retry"
  supply=$(near_view "$WRAPPER" ft_total_supply | unquote)
  backing=$(near_view "$HOT" mt_balance_of "{\"account_id\":\"$WRAPPER\",\"token_id\":\"$GRAM_ID\"}" | unquote)
  [[ "$supply" == "$backing" ]] || die "wGRAM supply $supply != backing $backing; stop and investigate"
  echo "  unwrapped; wGRAM supply $(fmt9 "$supply") = GRAM backing $(fmt9 "$backing")"
  save UNWRAPPED 1
fi

# --- 3. GRAM into NEAR Intents, swap to SOL on Solana ------------------------------------------

if [[ -z "${DEPOSITED:-}" ]]; then
  confirm "Step 3: deposit $WGRAM_AMOUNT GRAM into NEAR Intents for $NEAR_ACCOUNT."
  before=$(intents_gram)
  near_tx "$HOT" mt_transfer_call "{\"receiver_id\":\"intents.near\",\"token_id\":\"$GRAM_ID\",\"amount\":\"$RAW\",\"msg\":\"\"}" '1 yoctoNEAR'
  sleep 3
  grew "$(intents_gram)" "$before" "$RAW" || die "GRAM did not arrive in NEAR Intents (HOT refunds a failed deposit); re-run to retry"
  save DEPOSITED 1
fi

if [[ -z "${SWAP_ADDRESS:-}" ]]; then
  confirm "Step 4: swap $WGRAM_AMOUNT GRAM for SOL, delivered to $SOL_RECIPIENT."
  q=$(quote false "$RAW")
  SWAP_ADDRESS=$(printf '%s' "$q" | python3 -c 'import json,sys; print(json.load(sys.stdin)["quote"]["depositAddress"])')
  [[ -n "$SWAP_ADDRESS" ]] || die "quote had no deposit address"
  save SWAP_ADDRESS "$SWAP_ADDRESS"
  save SOL_BEFORE "$(sol_lamports "$SOL_RECIPIENT")"
  near_tx intents.near mt_transfer "{\"receiver_id\":\"$SWAP_ADDRESS\",\"token_id\":\"$GRAM_ASSET\",\"amount\":\"$RAW\"}" '1 yoctoNEAR'
fi
load

log "Waiting for the swap and the SOL payout (usually a minute or two)"
for _ in $(seq 1 90); do
  status=$(curl -sf --max-time 15 "$ONECLICK/status?depositAddress=$SWAP_ADDRESS" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)
  case "$status" in
    SUCCESS)
      now=$(sol_lamports "$SOL_RECIPIENT")
      echo "  done: $SOL_RECIPIENT received $(python3 -c 'import sys; print(f"{(int(sys.argv[1]) - int(sys.argv[2]))/1e9:.6f}")' "$now" "$SOL_BEFORE") SOL"
      rm -f "$STATE"
      exit 0 ;;
    REFUNDED|FAILED) die "swap $status: the GRAM is back in NEAR Intents for $NEAR_ACCOUNT (run --reset, then retry from step 4 by hand)" ;;
  esac
  sleep 10
done
die "swap not finished after 15 minutes (status $status); re-run to keep waiting"
