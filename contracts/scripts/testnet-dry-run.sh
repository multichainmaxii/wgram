#!/usr/bin/env bash
# Testnet dry run of the full wGRAM path, using mock-mt as fake HOT GRAM.
#
#   NEAR_ACCOUNT=yourname.testnet ./scripts/testnet-dry-run.sh <step>...
#
# Steps run in the order given; `all` runs every NEAR step. Each step is safe to
# re-run on its own, so you can resume after a failure.
#
# Needs: near (near-cli-rs), cargo-near, python3, and NEAR_ACCOUNT's key in the
# near-cli keychain (`near account import-account` if you created it elsewhere).
set -euo pipefail

NEAR_ACCOUNT="${NEAR_ACCOUNT:?set NEAR_ACCOUNT to your funded testnet account, e.g. yourname.testnet}"
WRAPPER="${WRAPPER:-wgram.$NEAR_ACCOUNT}"
MOCK="${MOCK:-mockgram.$NEAR_ACCOUNT}"
RPC="${NEAR_RPC:-https://rpc.testnet.near.org}"
GRAM_ID="1117_"          # HOT's token id for GRAM; the mock uses the same id
ONE_GRAM=1000000000      # 9 decimals

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER_WASM="$ROOT/target/near/gram_wrapper/gram_wrapper.wasm"
MOCK_WASM="$ROOT/target/near/mock_mt/mock_mt.wasm"

# Omni Bridge testnet. `bridge-cli testnet` pairs this NEAR contract with Solana devnet
# program 862HdJV59Vp83PbcubUnvuXc4EAXP8CDDs6LTxFpunTe (not the Gy1XPw... in Omni's README).
OMNI="omni.n-bridge.testnet"
INDEXER="https://testnet.api.bridge.nearone.org"
WORMHOLESCAN="https://api.testnet.wormholescan.io"
SOL_RPC="https://api.devnet.solana.com"
# Always pass the devnet test wallet explicitly: bridge-cli otherwise falls back to
# ~/.config/solana/id.json, which may be a real wallet. Must be an absolute path.
SOL_WALLET="${SOL_WALLET:-$HOME/.config/solana/wgram-devnet.json}"
STATE="$ROOT/scripts/.dryrun-state"

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# View call via RPC, printing the decoded JSON result.
near_view() {
  local contract="$1" method="$2" args="${3:-}"
  [[ -n "$args" ]] || args='{}'
  python3 - "$RPC" "$contract" "$method" "$args" <<'PY'
import base64, json, sys, urllib.request
rpc, contract, method, args = sys.argv[1:]
body = {"jsonrpc": "2.0", "id": 1, "method": "query", "params": {
    "request_type": "call_function", "finality": "final", "account_id": contract,
    "method_name": method, "args_base64": base64.b64encode(args.encode()).decode()}}
req = urllib.request.Request(rpc, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
res = json.load(urllib.request.urlopen(req, timeout=30))
if "error" in res or "error" in res.get("result", {}):
    sys.exit(f"view {contract}.{method} failed: {json.dumps(res)[:400]}")
print(json.dumps(json.loads(bytes(res["result"]["result"]).decode() or "null")))
PY
}

account_exists() {
  python3 - "$RPC" "$1" <<'PY'
import json, sys, urllib.request
rpc, account = sys.argv[1:]
body = {"jsonrpc": "2.0", "id": 1, "method": "query",
        "params": {"request_type": "view_account", "finality": "final", "account_id": account}}
req = urllib.request.Request(rpc, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
res = json.load(urllib.request.urlopen(req, timeout=30))
sys.exit(0 if "result" in res and "error" not in res["result"] else 1)
PY
}

call() {  # call <contract> <method> <json> <deposit> [signer]
  near contract call-function as-transaction "$1" "$2" json-args "$3" \
    prepaid-gas '100.0 Tgas' attached-deposit "$4" \
    sign-as "${5:-$NEAR_ACCOUNT}" network-config testnet sign-with-keychain send
}

unquote() { tr -d '"'; }

die() { echo "ERROR: $*" >&2; exit 1; }

# Values carried between steps (tx hashes, mint, nonces), so steps can resume.
save() {
  touch "$STATE"
  grep -v "^$1=" "$STATE" > "$STATE.tmp" || true
  echo "$1=$2" >> "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}
load() { if [[ -f "$STATE" ]]; then source "$STATE"; fi; }

# bridge-cli pinned to the devnet test wallet, without colors so output parses.
bcli() {
  NO_COLOR=1 SOLANA_KEYPAIR="$SOL_WALLET" NEAR_SIGNER="$NEAR_ACCOUNT" bridge-cli testnet "$@"
}

signer_pubkey() {
  python3 - "$RPC" "$NEAR_ACCOUNT" <<'PY'
import json, sys, urllib.request
rpc, account = sys.argv[1:]
body = {"jsonrpc": "2.0", "id": 1, "method": "query",
        "params": {"request_type": "view_access_key_list", "finality": "final", "account_id": account}}
req = urllib.request.Request(rpc, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
keys = json.load(urllib.request.urlopen(req, timeout=30))["result"]["keys"]
print(next(k["public_key"] for k in keys if k["access_key"]["permission"] == "FullAccess"))
PY
}

# Reads `bridge-cli ... --dry-run` output on stdin, signs the unsigned transaction
# with the near-cli keychain (bridge-cli never sees a private key), sends it and
# prints the transaction hash.
sign_and_send() {
  local out b64
  out=$(cat)
  b64=$(printf '%s\n' "$out" | awk '/unsigned transaction \(base64/{getline; print; exit}')
  [[ -n "$b64" ]] || { printf '%s\n' "$out" >&2; die "bridge-cli printed no unsigned transaction"; }
  near transaction sign-transaction "$b64" network-config testnet sign-with-keychain send </dev/null 2>&1 \
    | tee /dev/stderr | sed -nE 's/.*Transaction ID: ([1-9A-HJ-NP-Za-km-z]{32,44}).*/\1/p' | head -1
}

# Prints every log line from a NEAR transaction's receipts. Exits non-zero if any
# receipt failed, since bridge-cli reports success even when they do.
tx_logs() {
  python3 - "$RPC" "$1" "$NEAR_ACCOUNT" <<'PY'
import json, sys, urllib.request
rpc, tx, sender = sys.argv[1:]
body = {"jsonrpc": "2.0", "id": 1, "method": "tx",
        "params": {"tx_hash": tx, "sender_account_id": sender, "wait_until": "FINAL"}}
import time
# MPC signing can take a few blocks after the tx lands, so FINAL may time out at first.
for attempt in range(12):
    req = urllib.request.Request(rpc, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        res = json.load(urllib.request.urlopen(req, timeout=60))
    except Exception as e:
        res = {"error": {"message": str(e)}}
    if "error" not in res:
        break
    time.sleep(5)
else:
    sys.exit(f"tx lookup failed: {json.dumps(res['error'])[:300]}")
failed = False
for r in res["result"]["receipts_outcome"]:
    for line in r["outcome"]["logs"]:
        print(line)
    if "Failure" in r["outcome"]["status"]:
        failed = True
        print(f"RECEIPT FAILED in {r['outcome']['executor_id']}: {json.dumps(r['outcome']['status'])[:300]}", file=sys.stderr)
sys.exit(2 if failed else 0)
PY
}

# Prints the JSON payload of the first `<Event>` found in a transaction's logs.
event_json() {
  tx_logs "$1" | python3 -c '
import json, sys
name = sys.argv[1]
for line in sys.stdin:
    try:
        obj = json.loads(line)
    except ValueError:
        continue
    if isinstance(obj, dict) and name in obj:
        print(json.dumps(obj[name])); break
' "$2"
}

sol_address() { solana-keygen pubkey "$SOL_WALLET"; }

sol_balance_lamports() {
  python3 - "$SOL_RPC" "$(sol_address)" <<'PY'
import json, sys, urllib.request
rpc, owner = sys.argv[1:]
body = {"jsonrpc": "2.0", "id": 1, "method": "getBalance", "params": [owner]}
req = urllib.request.Request(rpc, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
print(json.load(urllib.request.urlopen(req, timeout=30))["result"]["value"])
PY
}

omni_token_address() {  # "sol:<mint>" once wGRAM is bound on the bridge, else null
  near_view "$OMNI" get_token_address "{\"chain_kind\":\"Sol\",\"token\":\"$WRAPPER\"}" | unquote
}

step_build() {
  log "Build contracts"
  (cd "$ROOT/gram-wrapper" && cargo near build non-reproducible-wasm)
  (cd "$ROOT/mock-mt" && cargo near build non-reproducible-wasm)
}

step_accounts() {
  log "Create $MOCK and $WRAPPER (funded from $NEAR_ACCOUNT)"
  for pair in "$MOCK:2" "$WRAPPER:3"; do
    local acct="${pair%%:*}" amount="${pair##*:}"
    if account_exists "$acct"; then echo "$acct exists, skipping"; continue; fi
    near account create-account fund-myself "$acct" "$amount NEAR" \
      autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
      sign-as "$NEAR_ACCOUNT" network-config testnet sign-with-keychain send
  done
}

step_deploy() {
  log "Deploy fake GRAM ($MOCK) and mint 1000 to $NEAR_ACCOUNT"
  near contract deploy "$MOCK" use-file "$MOCK_WASM" with-init-call new json-args '{}' \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
  call "$MOCK" mint "{\"account_id\":\"$NEAR_ACCOUNT\",\"token_id\":\"$GRAM_ID\",\"amount\":\"$((1000 * ONE_GRAM))\"}" '0 NEAR'

  log "Deploy wrapper ($WRAPPER) backed by $MOCK"
  near contract deploy "$WRAPPER" use-file "$WRAPPER_WASM" with-init-call new json-args "{
      \"mt_contract\": \"$MOCK\",
      \"mt_token_id\": \"$GRAM_ID\",
      \"metadata\": {\"spec\": \"ft-1.0.0\", \"name\": \"Wrapped GRAM\", \"symbol\": \"wGRAM\", \"decimals\": 9}
    }" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
  near_view "$WRAPPER" ft_metadata
}

step_wrap() {
  log "Register $NEAR_ACCOUNT on the wrapper, then wrap 100 GRAM"
  call "$WRAPPER" storage_deposit '{}' '0.00125 NEAR'
  call "$MOCK" mt_transfer_call \
    "{\"receiver_id\":\"$WRAPPER\",\"token_id\":\"$GRAM_ID\",\"amount\":\"$((100 * ONE_GRAM))\",\"msg\":\"\"}" '1 yoctoNEAR'
  step_verify
}

step_unwrap() {
  log "Unwrap 10 GRAM"
  call "$WRAPPER" unwrap "{\"amount\":\"$((10 * ONE_GRAM))\"}" '1 yoctoNEAR'
  step_verify
}

step_verify() {
  log "Check wrapped supply equals backing"
  local supply backing mine
  supply=$(near_view "$WRAPPER" ft_total_supply | unquote)
  backing=$(near_view "$MOCK" mt_balance_of "{\"account_id\":\"$WRAPPER\",\"token_id\":\"$GRAM_ID\"}" | unquote)
  mine=$(near_view "$WRAPPER" ft_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\"}" | unquote)
  echo "wGRAM supply:          $supply"
  echo "GRAM held by wrapper:  $backing"
  echo "your wGRAM:            $mine"
  if [[ "$supply" != "$backing" ]]; then echo "MISMATCH: supply != backing" >&2; exit 1; fi
  echo "OK: fully backed"
}

step_lock() {
  log "Lock $WRAPPER by deleting every access key (rehearsal of mainnet step 4)"
  near account list-keys "$WRAPPER" network-config testnet now
  local keys
  keys=$(python3 - "$RPC" "$WRAPPER" <<'PY'
import json, sys, urllib.request
rpc, account = sys.argv[1:]
body = {"jsonrpc": "2.0", "id": 1, "method": "query",
        "params": {"request_type": "view_access_key_list", "finality": "final", "account_id": account}}
req = urllib.request.Request(rpc, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
print(",".join(k["public_key"] for k in json.load(urllib.request.urlopen(req, timeout=30))["result"]["keys"]))
PY
)
  if [[ -z "$keys" ]]; then echo "already locked"; return; fi
  near account delete-keys "$WRAPPER" public-keys "$keys" network-config testnet sign-with-keychain send
  near account list-keys "$WRAPPER" network-config testnet now
}

step_all() {
  step_build; step_accounts; step_deploy; step_wrap; step_unwrap; step_lock
}

# ---- Solana half: Omni Bridge testnet -> Solana devnet ----

step_bridge_register() {
  log "Register $OMNI as a wGRAM holder (it receives wGRAM on every bridge-out)"
  call "$WRAPPER" storage_deposit "{\"account_id\":\"$OMNI\",\"registration_only\":true}" '0.00125 NEAR'
}

step_log_metadata() {
  log "log_metadata: Omni's MPC signs wGRAM's name, symbol and decimals"
  local tx event
  tx=$(bcli log-metadata --token "near:$WRAPPER" --near-public-key "$(signer_pubkey)" --dry-run | sign_and_send)
  [[ -n "$tx" ]] || die "no transaction hash from log_metadata"
  event=$(event_json "$tx" LogMetadataEvent) || die "log_metadata receipt failed (tx $tx)"
  [[ -n "$event" ]] || die "no LogMetadataEvent in $tx (MPC signing failed; it logs nothing on error)"
  echo "LogMetadataEvent: ${event:0:200}..."
  save LOG_TX "$tx"
}

step_deploy_sol() {
  load
  [[ -n "${LOG_TX:-}" ]] || die "run log_metadata first"
  local lamports out sig
  lamports=$(sol_balance_lamports)
  (( lamports >= 30000000 )) || die "devnet wallet $(sol_address) has $lamports lamports; needs >= 0.03 SOL"
  log "deploy_token on Solana devnet (creates the wGRAM mint, ~0.019 SOL)"
  out=$(bcli deploy-token --chain sol --source-chain near --tx-hash "$LOG_TX" 2>&1) || { echo "$out"; die "deploy-token failed"; }
  echo "$out" | tail -5
  sig=$(printf '%s\n' "$out" | grep -A3 'Sent deploy token' | grep -oE '[1-9A-HJ-NP-Za-km-z]{80,90}' | head -1)
  [[ -n "$sig" ]] || die "could not find the Solana signature in deploy-token output"
  save DEPLOY_SIG "$sig"
  echo "Solana deploy tx: https://explorer.solana.com/tx/$sig?cluster=devnet"
}

step_bind() {
  load
  [[ -n "${DEPLOY_SIG:-}" ]] || die "run deploy_sol first"
  local addr tx i
  addr=$(omni_token_address)
  if [[ "$addr" == null ]]; then
    log "Waiting for the Wormhole VAA of the Solana deploy"
    for i in $(seq 1 36); do
      curl -sf "$WORMHOLESCAN/api/v1/vaas/?txHash=$DEPLOY_SIG" | grep -q '"vaa"' && break
      sleep 5
    done
    # The testnet relayer sometimes binds on its own; binding twice fails harmlessly.
    for i in $(seq 1 12); do addr=$(omni_token_address); [[ "$addr" != null ]] && break; sleep 5; done
  fi
  if [[ "$addr" == null ]]; then
    log "bind_token: register the Solana mint on NEAR (proved by the Wormhole VAA)"
    tx=$(bcli bind-token --chain sol --tx-hash "$DEPLOY_SIG" --near-public-key "$(signer_pubkey)" --dry-run | sign_and_send)
    [[ -n "$(event_json "$tx" BindTokenEvent)" ]] || die "no BindTokenEvent in $tx"
    addr=$(omni_token_address)
  else
    echo "already bound (by the relayer or an earlier run)"
  fi
  [[ "$addr" == sol:* ]] || die "unexpected token address: $addr"
  save MINT "${addr#sol:}"
  echo "wGRAM mint on Solana devnet: ${addr#sol:}"
  echo "https://explorer.solana.com/address/${addr#sol:}?cluster=devnet"
}

step_transfer() {
  load
  [[ -n "${MINT:-}" ]] || die "run bind first"
  local to amount fee need avail tx event
  to=$(sol_address)
  amount=$((5 * ONE_GRAM))
  fee=$(curl -sf "$INDEXER/api/v3/transfer-fee?sender=near:$NEAR_ACCOUNT&recipient=sol:$to&token=near:$WRAPPER&amount=$amount" \
    | python3 -c 'import json,sys; print(int(json.load(sys.stdin).get("native_token_fee") or 0))' 2>/dev/null || true)
  # Pay at least the quote so the relayer is willing to sign and finalize.
  [[ -n "$fee" && "$fee" != 0 ]] || fee=70000000000000000000000
  log "Bridge 5 wGRAM to sol:$to (relayer fee $fee yoctoNEAR)"

  # The bridge takes storage and the native fee from the sender's balance held on it.
  need=$(python3 - "$(near_view "$OMNI" required_balance_for_init_transfer)" \
    "$(near_view "$OMNI" required_balance_for_account)" \
    "$(near_view "$OMNI" storage_balance_of "{\"account_id\":\"$NEAR_ACCOUNT\"}")" "$fee" <<'PY'
import json, sys
per_transfer, per_account, bal, fee = sys.argv[1:]
per_transfer, per_account, fee = int(json.loads(per_transfer)), int(json.loads(per_account)), int(fee)
bal = json.loads(bal)
available = int(bal["available"]) if bal else 0
first = per_account if not bal else 0
print(max(0, first + per_transfer + fee - available))
PY
)
  if [[ "$need" != 0 ]]; then  # yoctoNEAR values overflow bash integers; compare as text
    near account manage-storage-deposit "$OMNI" deposit "$NEAR_ACCOUNT" "$need yoctoNEAR" \
      sign-as "$NEAR_ACCOUNT" network-config testnet sign-with-keychain send </dev/null
  fi

  local msg args
  msg="{\\\"recipient\\\":\\\"sol:$to\\\",\\\"fee\\\":\\\"0\\\",\\\"native_token_fee\\\":\\\"$fee\\\"}"
  args="{\"receiver_id\":\"$OMNI\",\"amount\":\"$amount\",\"msg\":\"$msg\"}"
  tx=$(near contract call-function as-transaction "$WRAPPER" ft_transfer_call json-args "$args" \
    prepaid-gas '300.0 Tgas' attached-deposit '1 yoctoNEAR' \
    sign-as "$NEAR_ACCOUNT" network-config testnet sign-with-keychain send </dev/null 2>&1 \
    | tee /dev/stderr | sed -nE 's/.*Transaction ID: ([1-9A-HJ-NP-Za-km-z]{32,44}).*/\1/p' | head -1)
  event=$(event_json "$tx" InitTransferEvent) || die "transfer receipt failed (tx $tx)"
  [[ -n "$event" ]] || die "no InitTransferEvent in $tx (was wGRAM refunded?)"
  save INIT_TX "$tx"; save FEE "$fee"
  save NONCE "$(printf '%s' "$event" | python3 -c 'import json,sys; print(json.load(sys.stdin)["transfer_message"]["origin_nonce"])')"
  save DEST_NONCE "$(printf '%s' "$event" | python3 -c 'import json,sys; print(json.load(sys.stdin)["transfer_message"]["destination_nonce"])')"
  load
  echo "origin nonce $NONCE, destination nonce $DEST_NONCE"
}

step_sol_balance() {
  load
  [[ -n "${MINT:-}" ]] || die "run bind first"
  python3 - "$SOL_RPC" "$(sol_address)" "$MINT" <<'PY'
import json, sys, urllib.request
rpc, owner, mint = sys.argv[1:]
body = {"jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner",
        "params": [owner, {"mint": mint}, {"encoding": "jsonParsed"}]}
req = urllib.request.Request(rpc, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
accts = json.load(urllib.request.urlopen(req, timeout=30))["result"]["value"]
total = sum(float(a["account"]["data"]["parsed"]["info"]["tokenAmount"]["uiAmountString"]) for a in accts)
print(f"wGRAM on Solana devnet for {owner}: {total}")
PY
}

transfer_finalised() {
  bcli is-transfer-finalised --origin-chain near --destination-chain sol --nonce "$DEST_NONCE" 2>&1 | grep -q 'finalised: true'
}

step_await_relayer() {
  load
  [[ -n "${DEST_NONCE:-}" ]] || die "run transfer first"
  log "Waiting up to 5 minutes for Omni's relayer to sign and finalize on Solana"
  local i
  for i in $(seq 1 30); do
    if transfer_finalised; then echo "finalized by the relayer"; step_sol_balance; return; fi
    sleep 10
  done
  echo "not finalized yet; run the self_relay step to finish it yourself"
  return 1
}

# Fallback: become a testnet relayer (1 test NEAR stake, 5 minute wait) and sign and
# finalize our own transfer. Mainnet requires 1000 NEAR and 7 days, so there we rely
# on the paid relayer.
step_self_relay() {
  load
  [[ -n "${NONCE:-}" && -n "${MINT:-}" ]] || die "run transfer first"
  if transfer_finalised; then echo "already finalized"; step_sol_balance; return; fi
  local i tx out sig
  if [[ "$(near_view "$OMNI" is_trusted_relayer "{\"account_id\":\"$NEAR_ACCOUNT\"}")" != true ]]; then
    if [[ "$(near_view "$OMNI" get_relayer_application "{\"account_id\":\"$NEAR_ACCOUNT\"}")" == null ]]; then
      log "Apply as a testnet relayer (stakes 1 test NEAR)"
      call "$OMNI" apply_for_trusted_relayer '{}' '1 NEAR'
    fi
    log "Waiting for the 5 minute relayer activation period"
    for i in $(seq 1 45); do
      [[ "$(near_view "$OMNI" is_trusted_relayer "{\"account_id\":\"$NEAR_ACCOUNT\"}")" == true ]] && break
      sleep 10
    done
    [[ "$(near_view "$OMNI" is_trusted_relayer "{\"account_id\":\"$NEAR_ACCOUNT\"}")" == true ]] || die "still not an active relayer"
  fi
  log "sign_transfer: Omni's MPC signs the transfer for Solana"
  tx=$(bcli near-sign-transfer --origin-chain near --origin-nonce "$NONCE" --fee 0 --native-fee "$FEE" \
    --fee-recipient "$NEAR_ACCOUNT" --near-public-key "$(signer_pubkey)" --dry-run | sign_and_send)
  [[ -n "$(event_json "$tx" SignTransferEvent)" ]] || die "no SignTransferEvent in $tx"
  save SIGN_TX "$tx"
  log "finalize_transfer on Solana devnet (mints wGRAM to the recipient)"
  out=$(bcli svm-finalize-transfer --chain sol --tx-hash "$tx" --sender-id "$NEAR_ACCOUNT" --svm-token "$MINT" 2>&1) \
    || { echo "$out"; die "svm-finalize-transfer failed"; }
  sig=$(printf '%s\n' "$out" | grep -A3 'Sent finalize transfer' | grep -oE '[1-9A-HJ-NP-Za-km-z]{80,90}' | head -1)
  echo "Solana finalize tx: https://explorer.solana.com/tx/$sig?cluster=devnet"
  step_sol_balance
}

step_bridge() {
  step_bridge_register; step_log_metadata; step_deploy_sol; step_bind; step_transfer
  step_await_relayer || step_self_relay
}

[[ $# -gt 0 ]] || {
  echo "usage: $0 <step>..." >&2
  echo "  NEAR:   build accounts deploy wrap unwrap verify lock | all" >&2
  echo "  Solana: bridge_register log_metadata deploy_sol bind transfer await_relayer self_relay sol_balance | bridge" >&2
  exit 1
}
for s in "$@"; do
  declare -F "step_$s" >/dev/null || { echo "unknown step: $s" >&2; exit 1; }
  "step_$s"
done
