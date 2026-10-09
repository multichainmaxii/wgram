#!/usr/bin/env bash
# Turns SOL into wGRAM on Solana, end to end on mainnet:
#
#   SOL ──NEAR Intents (1Click)──► GRAM on NEAR ──wgram.near──► wGRAM ──Omni Bridge──► wGRAM on Solana
#
# Every step that moves funds prints what it will do and waits for "yes" (YES=1 skips the
# prompts). Progress is saved, so re-running continues where it stopped.
#
#   ./bridge-in.sh <SOL amount>        e.g. ./bridge-in.sh 4
#   ./bridge-in.sh --dry-run <SOL>     quote and checks only, nothing is sent
#   ./bridge-in.sh --reset             forget a finished or abandoned run
#
# Environment (defaults in brackets):
#   NEAR_ACCOUNT    NEAR account that receives the GRAM and wraps it (required)
#   NEAR_KEY_FILE   its access key file [~/.near-credentials/implicit/$NEAR_ACCOUNT.json]
#   SOL_KEYPAIR     Solana keypair that pays the SOL [~/.config/solana/wgram-mainnet.json]
#   SOL_RECIPIENT   Solana address that receives the wGRAM [SOL_KEYPAIR's address]
#   YES=1           don't ask before each step
#   BRIDGE_IN_STATE progress file [next to this script]

set -euo pipefail

WRAPPER="wgram.near"
HOT="v2_1.omni.hot.tg"
GRAM_ID="1117_"
GRAM_ASSET="nep245:$HOT:$GRAM_ID"
SOL_ASSET="nep141:sol.omft.near"
OMNI="omni.bridge.near"
WGRAM_MINT="B1ZqtPMn2m6rgZCynGPfhWmo41h8xSwb6A2UZsB5GNq8"
ONECLICK="https://1click.chaindefuser.com/v0"
OMNI_API="https://mainnet.api.bridge.nearone.org/api/v3"
NEAR_RPC="${NEAR_RPC:-https://rpc.mainnet.near.org}"
SOL_RPC="${SOL_RPC:-https://api.mainnet-beta.solana.com}"
STATE="${BRIDGE_IN_STATE:-$(cd "$(dirname "$0")" && pwd)/.bridge-in-state}"

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

near_tx() {  # near_tx <contract> <method> <json args> <deposit> [gas]: signs with NEAR_KEY_FILE
  near contract call-function as-transaction "$1" "$2" json-args "$3" prepaid-gas "${5:-100.0 Tgas}" \
    attached-deposit "$4" sign-as "$NEAR_ACCOUNT" network-config mainnet \
    sign-with-access-key-file "$NEAR_KEY_FILE" send </dev/null 2>&1 \
    | grep -v -i -E "private|secret|seed" | grep -E "Transaction ID|succeeded|Error|error|Failure|panicked" || true
}

sol_wgram() {  # wGRAM (raw units) held by SOL_RECIPIENT
  python3 - "$SOL_RPC" "$SOL_RECIPIENT" "$WGRAM_MINT" <<'PY'
import json, sys, urllib.request
rpc, owner, mint = sys.argv[1:]
body = {"jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner",
        "params": [owner, {"mint": mint}, {"encoding": "jsonParsed", "commitment": "confirmed"}]}
req = urllib.request.Request(rpc, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
accts = json.load(urllib.request.urlopen(req, timeout=30))["result"]["value"]
print(sum(int(a["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"]) for a in accts))
PY
}

quote() {  # quote <dry true|false> <lamports> -> 1Click quote JSON
  local deadline
  deadline=$(python3 -c 'import datetime; print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z"))')
  curl -sf --max-time 30 -X POST "$ONECLICK/quote" -H 'Content-Type: application/json' -d "{
    \"dry\": $1, \"swapType\": \"EXACT_INPUT\", \"slippageTolerance\": 100,
    \"originAsset\": \"$SOL_ASSET\", \"depositType\": \"ORIGIN_CHAIN\",
    \"destinationAsset\": \"$GRAM_ASSET\", \"amount\": \"$2\",
    \"recipient\": \"$NEAR_ACCOUNT\", \"recipientType\": \"INTENTS\",
    \"refundTo\": \"$SOL_PAYER\", \"refundType\": \"ORIGIN_CHAIN\", \"deadline\": \"$deadline\"}" \
    || die "1Click quote request failed"
}

# --- arguments and setup ---------------------------------------------------------------

DRY=0
case "${1:-}" in
  --reset) rm -f "$STATE"; echo "state cleared"; exit 0 ;;
  --dry-run) DRY=1; shift ;;
esac
SOL_AMOUNT="${1:-}"
[[ -n "${NEAR_ACCOUNT:-}" ]] || die "set NEAR_ACCOUNT (the NEAR account that receives and wraps the GRAM)"
NEAR_KEY_FILE="${NEAR_KEY_FILE:-$HOME/.near-credentials/implicit/$NEAR_ACCOUNT.json}"
SOL_KEYPAIR="${SOL_KEYPAIR:-$HOME/.config/solana/wgram-mainnet.json}"
for tool in near solana curl python3; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
[[ -f "$NEAR_KEY_FILE" ]] || die "no NEAR key file at $NEAR_KEY_FILE"
[[ -f "$SOL_KEYPAIR" ]] || die "no Solana keypair at $SOL_KEYPAIR"
SOL_PAYER=$(solana-keygen pubkey "$SOL_KEYPAIR")
SOL_RECIPIENT="${SOL_RECIPIENT:-$SOL_PAYER}"
load
SOL_AMOUNT="${SOL_AMOUNT:-${AMOUNT_SOL:-}}"
[[ "$SOL_AMOUNT" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "usage: $0 [--dry-run] <SOL amount>"
LAMPORTS=$(python3 -c 'import sys; from decimal import Decimal; print(int(Decimal(sys.argv[1]) * 10**9))' "$SOL_AMOUNT")

log "bridge-in: $SOL_AMOUNT SOL -> wGRAM on Solana"
echo "  pays SOL from   $SOL_PAYER ($(solana balance "$SOL_PAYER" --url "$SOL_RPC" 2>/dev/null || echo '?'))"
echo "  NEAR account    $NEAR_ACCOUNT"
echo "  wGRAM goes to   $SOL_RECIPIENT on Solana"

# --- 1. swap SOL for GRAM on NEAR Intents --------------------------------------------------

if [[ -z "${DEPOSIT:-}" ]]; then
  q=$(quote true "$LAMPORTS")
  out=$(printf '%s' "$q" | python3 -c 'import json,sys; q=json.load(sys.stdin)["quote"]; print(q["amountOutFormatted"], q["amountOutUsd"][:8], q["amountInUsd"][:8])')
  set -- $out
  echo "  quote           $SOL_AMOUNT SOL (\$$3) -> about $1 GRAM (\$$2), 1% max slippage"
  [[ "$DRY" == 1 ]] && { echo; echo "Dry run: nothing was sent."; exit 0; }
  confirm "Step 1: send $SOL_AMOUNT SOL to a NEAR Intents deposit address to buy GRAM for $NEAR_ACCOUNT."
  q=$(quote false "$LAMPORTS")
  DEPOSIT=$(printf '%s' "$q" | python3 -c 'import json,sys; print(json.load(sys.stdin)["quote"]["depositAddress"])')
  [[ -n "$DEPOSIT" ]] || die "quote had no deposit address"
  save DEPOSIT "$DEPOSIT"; save AMOUNT_SOL "$SOL_AMOUNT"
  GRAM_BEFORE=$(near_view intents.near mt_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\",\"token_id\":\"$GRAM_ASSET\"}" | unquote)
  save GRAM_BEFORE "$GRAM_BEFORE"
  solana transfer "$DEPOSIT" "$SOL_AMOUNT" --keypair "$SOL_KEYPAIR" --url "$SOL_RPC" \
    --allow-unfunded-recipient --commitment confirmed || die "SOL transfer failed; re-run to retry"
fi

if [[ -z "${SWAPPED:-}" ]]; then
  log "Waiting for the swap (usually under a minute)"
  for _ in $(seq 1 90); do
    status=$(curl -sf --max-time 15 "$ONECLICK/status?depositAddress=$DEPOSIT" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)
    case "$status" in
      SUCCESS) break ;;
      REFUNDED|FAILED) die "swap $status: NEAR Intents returns the SOL to $SOL_PAYER (run --reset, then try again)" ;;
      INCOMPLETE_DEPOSIT) die "deposit incomplete; check $DEPOSIT on the NEAR Intents explorer" ;;
    esac
    sleep 10
  done
  [[ "$status" == SUCCESS ]] || die "swap not finished after 15 minutes (status $status); re-run to keep waiting"
  now=$(near_view intents.near mt_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\",\"token_id\":\"$GRAM_ASSET\"}" | unquote)
  SWAPPED=$(python3 -c 'import sys; print(max(0, int(sys.argv[1]) - int(sys.argv[2])))' "$now" "$GRAM_BEFORE")
  [[ "$SWAPPED" != 0 ]] || die "swap reported SUCCESS but no new GRAM in NEAR Intents for $NEAR_ACCOUNT"
  save SWAPPED "$SWAPPED"
  echo "  received $(fmt9 "$SWAPPED") GRAM in NEAR Intents"
fi

# --- 2. withdraw the GRAM to the NEAR account -----------------------------------------------

if [[ -z "${WITHDRAWN:-}" ]]; then
  confirm "Step 2: withdraw $(fmt9 "$SWAPPED") GRAM from NEAR Intents to $NEAR_ACCOUNT."
  HOT_BEFORE=$(near_view "$HOT" mt_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\",\"token_id\":\"$GRAM_ID\"}" | unquote)
  near_tx intents.near mt_withdraw \
    "{\"token\":\"$HOT\",\"receiver_id\":\"$NEAR_ACCOUNT\",\"token_ids\":[\"$GRAM_ID\"],\"amounts\":[\"$SWAPPED\"]}" '1 yoctoNEAR'
  sleep 3
  hot_now=$(near_view "$HOT" mt_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\",\"token_id\":\"$GRAM_ID\"}" | unquote)
  python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) - int(sys.argv[2]) >= int(sys.argv[3]) else 1)' "$hot_now" "$HOT_BEFORE" "$SWAPPED" \
    || die "GRAM did not arrive on $HOT (NEAR Intents refunds a failed withdrawal); re-run to retry"
  save WITHDRAWN 1
fi

# --- 3. wrap it into wGRAM -------------------------------------------------------------------

if [[ -z "${WRAPPED:-}" ]]; then
  if [[ "$(near_view "$WRAPPER" storage_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\"}")" == null ]]; then
    confirm "Register $NEAR_ACCOUNT on $WRAPPER (0.00125 NEAR)."
    near_tx "$WRAPPER" storage_deposit '{}' '0.00125 NEAR' '30.0 Tgas'
  fi
  confirm "Step 3: wrap $(fmt9 "$SWAPPED") GRAM into wGRAM at $WRAPPER."
  W_BEFORE=$(near_view "$WRAPPER" ft_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\"}" | unquote)
  near_tx "$HOT" mt_transfer_call \
    "{\"receiver_id\":\"$WRAPPER\",\"token_id\":\"$GRAM_ID\",\"amount\":\"$SWAPPED\",\"msg\":\"\"}" '1 yoctoNEAR'
  sleep 3
  w_now=$(near_view "$WRAPPER" ft_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\"}" | unquote)
  python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) - int(sys.argv[2]) >= int(sys.argv[3]) else 1)' "$w_now" "$W_BEFORE" "$SWAPPED" \
    || die "wrap did not mint wGRAM (the GRAM is refunded to $NEAR_ACCOUNT); re-run to retry"
  supply=$(near_view "$WRAPPER" ft_total_supply | unquote)
  backing=$(near_view "$HOT" mt_balance_of "{\"account_id\":\"$WRAPPER\",\"token_id\":\"$GRAM_ID\"}" | unquote)
  [[ "$supply" == "$backing" ]] || die "wGRAM supply $supply != backing $backing; stop and investigate"
  echo "  wrapped; wGRAM supply $(fmt9 "$supply") = GRAM backing $(fmt9 "$backing")"
  save WRAPPED 1
fi

# --- 4. bridge the wGRAM to Solana ------------------------------------------------------------

if [[ -z "${BRIDGED:-}" ]]; then
  fee=$(curl -sf --max-time 20 "$OMNI_API/transfer-fee?sender=near:$NEAR_ACCOUNT&recipient=sol:$SOL_RECIPIENT&token=near:$WRAPPER&amount=$SWAPPED" \
    | python3 -c 'import json,sys; f=int(json.load(sys.stdin).get("native_token_fee") or 0); print(f + f // 10)') \
    || die "could not get the Omni Bridge fee"
  [[ "$fee" != 0 ]] || die "Omni Bridge quoted no relayer fee"
  need=$(python3 - "$(near_view "$OMNI" required_balance_for_init_transfer)" \
    "$(near_view "$OMNI" required_balance_for_account)" \
    "$(near_view "$OMNI" storage_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\"}")" "$fee" <<'PY'
import json, sys
per_transfer, per_account, bal, fee = sys.argv[1:]
bal = json.loads(bal)
available = int(bal["available"]) if bal else 0
first = 0 if bal else int(json.loads(per_account))
print(max(0, first + int(json.loads(per_transfer)) + int(fee) - available))
PY
)
  near_fee=$(python3 -c 'import sys; print(f"{int(sys.argv[1])/1e24:.4f}")' "$fee")
  if [[ "$need" != 0 ]]; then
    near_need=$(python3 -c 'import sys; print(f"{int(sys.argv[1])/1e24 + 0.0001:.4f}")' "$need")
    confirm "Prepay Omni Bridge storage and the relayer fee: $near_need NEAR."
    near_tx "$OMNI" storage_deposit "{\"account_id\":\"$NEAR_ACCOUNT\"}" "$near_need NEAR" '30.0 Tgas'
  fi
  SOL_BEFORE=$(sol_wgram)
  save SOL_BEFORE "$SOL_BEFORE"
  confirm "Step 4: bridge $(fmt9 "$SWAPPED") wGRAM to $SOL_RECIPIENT on Solana (relayer fee $near_fee NEAR)."
  msg="{\\\"recipient\\\":\\\"sol:$SOL_RECIPIENT\\\",\\\"fee\\\":\\\"0\\\",\\\"native_token_fee\\\":\\\"$fee\\\"}"
  near_tx "$WRAPPER" ft_transfer_call "{\"receiver_id\":\"$OMNI\",\"amount\":\"$SWAPPED\",\"msg\":\"$msg\"}" '1 yoctoNEAR' '300.0 Tgas'
  save BRIDGED 1
fi

log "Waiting for the relayer to finish on Solana (usually a few minutes)"
for _ in $(seq 1 60); do
  now=$(sol_wgram)
  if python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) - int(sys.argv[2]) >= int(sys.argv[3]) else 1)' "$now" "$SOL_BEFORE" "$SWAPPED"; then
    echo "  done: $SOL_RECIPIENT now holds $(fmt9 "$now") wGRAM on Solana"
    rm -f "$STATE"
    exit 0
  fi
  sleep 15
done
die "wGRAM not on Solana after 15 minutes; Omni relayers can be slow, so re-run later to keep checking"
