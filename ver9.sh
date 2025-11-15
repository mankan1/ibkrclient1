#!/usr/bin/env bash
set -Eeuo pipefail

# ===== Config =====
BASE_URL="${BASE_URL:-http://localhost:8080}"
ROOT="${ROOT:-ES}"
RIGHTS=("C" "P")
OFFSETS=(-10 -5 0 5 10)
EXPIRY="${1-}"                       # required arg (e.g., 20251114)

die() { echo "ERROR: $*" >&2; exit 1; }
info() { printf '[%s] %s\n' "$(date +%T)" "$*"; }

[[ -n "$EXPIRY" ]] || die "Usage: $0 YYYYMMDD   e.g.  $0 20251114"

# ===== Try to set Market Data Type (best-effort) =====
set_mdtype() {
  local body='{"type":1}'
  local candidates=(
    "/api/debug/market-data-type"
    "/api/debug/market_data_type"
    "/api/debug/set-market-data-type"
    "/api/debug/set_market_data_type"
  )
  info "Setting market data type to 1…"
  for path in "${candidates[@]}"; do
    if curl -sS -X POST --fail-with-body \
         -H 'content-type: application/json' \
         -d "$body" \
         "$BASE_URL$path" >/dev/null 2>&1; then
      info "Market data type set via $path"
      return 0
    fi
  done
  info "Could not set market data type (continuing anyway)."
}
set_mdtype

# ===== Helpers =====
round_to_5() {
  python3 - "$1" <<'PY'
import math, sys
v = float(sys.argv[1])
print(int(round(v/5.0)*5))
PY
}

parse_price_rows_last() {
  # stdin: {"rows":[{"symbol":"ES","last":...}]}
  python3 - "$ROOT" <<'PY'
import json, sys
sym = sys.argv[1]
try:
    data = json.loads(sys.stdin.read() or "null")
    for row in (data or {}).get("rows", []):
        if row.get("symbol")==sym:
            v=row.get("last")
            if v is not None:
                print(v)
                sys.exit(0)
except Exception:
    pass
PY
}

get_conid_for_symbol() {
  # stdin: {"symbol":"ES","conid":"11004968"} or similar
  python3 - <<'PY'
import json, sys
try:
    d=json.loads(sys.stdin.read() or "null")
    v=d.get("conid") or d.get("conidEx") or d.get("conId") or d.get("conid_ex")
    if v is not None:
        print(str(v))
except Exception:
    pass
PY
}

extract_snapshot_price() {
  # stdin: [{"31":"C6720.32","2":"6718.98","3":"6721.66",...}]
  # priority: last(31) -> mark(84) -> mid(bid(2),ask(3)) -> close(9) -> open(14)
  python3 - <<'PY'
import json, re, sys, math
def to_float(x):
    if x is None: return None
    if isinstance(x,(int,float)): return float(x)
    # strip any leading non-numeric (e.g., "C6720.32")
    m = re.search(r'[-+]?\d+(\.\d+)?', str(x))
    return float(m.group()) if m else None

try:
    arr = json.loads(sys.stdin.read() or "[]")
    if not isinstance(arr, list) or not arr:
        sys.exit(1)
    d = arr[0]

    last = to_float(d.get("31"))
    mark = to_float(d.get("84"))
    bid  = to_float(d.get("2"))
    ask  = to_float(d.get("3"))
    close= to_float(d.get("9"))
    open_= to_float(d.get("14"))

    if last and last>0: print(last); sys.exit(0)
    if mark and mark>0: print(mark); sys.exit(0)
    if bid and ask and bid>0 and ask>0: print((bid+ask)/2.0); sys.exit(0)
    if close and close>0: print(close); sys.exit(0)
    if open_ and open_>0: print(open_); sys.exit(0)
    sys.exit(2)
except Exception:
    sys.exit(3)
PY
}

subscribe_one() {
  local root="$1" expiry="$2" right="$3" strike="$4"
  local payload='{"root":"'"$root"'","expiry":"'"$expiry"'","right":"'"$right"'","strike":'"$strike"'}'
  curl -sS -X POST --fail-with-body \
    -H 'content-type: application/json' \
    -d "$payload" \
    "$BASE_URL/api/options/subscribe"
}

# ===== Determine ATM =====
ATM="${ATM:-}"
if [[ -z "$ATM" ]]; then
  info "Fetching last price for ${ROOT} (prices endpoint)…"
  price_json="$(curl -sS --fail-with-body "$BASE_URL/prices?symbols=${ROOT}" || true)"
  last_px="$(printf '%s' "${price_json}" | parse_price_rows_last || true)"

  if [[ -n "${last_px}" ]] && awk "BEGIN{exit !(${last_px} > 0)}"; then
    info "Prices endpoint gave LAST=${last_px}"
    ATM="$(round_to_5 "${last_px}")"
  else
    info "Prices endpoint not usable (last=${last_px:-N/A}). Falling back to snapshot…"
    info "Resolving ${ROOT} conid…"
    conid_json="$(curl -sS --fail-with-body "$BASE_URL/debug/conid?symbol=${ROOT}")" || die "Failed to resolve conid for ${ROOT}"
    conid="$(printf '%s' "$conid_json" | get_conid_for_symbol || true)"
    [[ -n "$conid" ]] || die "Could not parse conid from: $conid_json"

    info "Fetching snapshot for conid=${conid}…"
    snap_json="$(curl -sS --fail-with-body "$BASE_URL/debug/snapshot_raw?conids=${conid}")" || die "Snapshot fetch failed"
    ref_px="$(printf '%s' "$snap_json" | extract_snapshot_price || true)"
    [[ -n "$ref_px" ]] || die "Could not extract a usable price from snapshot. Raw: $snap_json"

    info "Snapshot reference price=${ref_px}"
    ATM="$(round_to_5 "${ref_px}")"
  fi

  info "Using ATM=${ATM}"
else
  info "Using provided ATM=${ATM}"
fi

# ===== Subscribe around ATM =====
info "Subscribing ${ROOT} options around ATM=${ATM} for expiry ${EXPIRY}…"
for off in "${OFFSETS[@]}"; do
  strike=$(( ATM + off ))
  for right in "${RIGHTS[@]}"; do
    info "Subscribe ${ROOT} ${right} ${strike} ${EXPIRY}"
    if ! subscribe_one "$ROOT" "$EXPIRY" "$right" "$strike" >/dev/null; then
      echo "WARN: subscribe failed for ${ROOT} ${right} ${strike} ${EXPIRY}" >&2
    fi
  done
done

# ===== Show what's live =====
info "Current option subscriptions (raw):"
curl -sS --fail-with-body "$BASE_URL/api/options/subscriptions" || echo "{}"
echo

