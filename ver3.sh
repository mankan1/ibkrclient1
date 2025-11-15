#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
ROOT="${ROOT:-ES}"
DAYS="${DAYS:-7}"            # pick an expiry on/after N days from now
STEP="${STEP:-5}"            # ES strikes step
WIN="${WIN:-60}"             # +/- window around ATM -> about 25 strikes
MDTYPE="${MDTYPE:-1}"        # 1=real-time

say(){ printf '\n%s\n' "$*"; }

curl_json(){ # method url [data]
  local method="$1" url="$2" data="${3:-}" http out
  for attempt in 1 2 3; do
    if [ -n "$data" ]; then
      http="$(curl -sS -o /tmp/.body.$$ -w '%{http_code}' -H 'content-type: application/json' -X "$method" "$url" -d "$data" || true)"
    else
      http="$(curl -sS -o /tmp/.body.$$ -w '%{http_code}' -X "$method" "$url" || true)"
    fi
    if printf '%s' "$http" | grep -qE '^2[0-9][0-9]$'; then
      out="$(cat /tmp/.body.$$)"; rm -f /tmp/.body.$$
      printf '%s' "$out"; return 0
    fi
    sleep 0.2
  done
  out="$(cat /tmp/.body.$$ 2>/dev/null || true)"; rm -f /tmp/.body.$$
  echo "CURL_ERROR: $method $url -> HTTP $http" >&2
  [ -n "$out" ] && echo "BODY: $out" >&2
  return 1
}

say "Setting market data type to ${MDTYPE}…"
curl_json POST "$BASE/api/debug/mdtype" "{\"type\":${MDTYPE}}"

say "Fetching ES months…"
RAW_MONTHS="$(curl_json GET "$BASE/api/debug/months?root=${ROOT}")" || { echo "months failed"; exit 1; }
[ -n "$RAW_MONTHS" ] || { echo "empty months payload"; exit 1; }

# Pick nearest non-expired month yyyymm
YYYYMM="$(printf '%s' "$RAW_MONTHS" | python3 - <<'PY'
import sys, json, datetime
s=sys.stdin.read().strip()
j=json.loads(s)
items=j.get("items", [])
if not items: print("", end=""); raise SystemExit(0)
today=int(datetime.datetime.utcnow().strftime("%Y%m%d"))
pick=None
for it in items:
    try:
        if int(it.get("ltdom","0"))>=today: pick=it; break
    except: pass
if pick is None: pick=items[0]
print(pick.get("yyyymm",""), end="")
PY
)"
[ -n "$YYYYMM" ] || { echo "ERROR: could not pick a month from /api/debug/months payload:"; echo "$RAW_MONTHS"; exit 1; }
say "Using month: ${YYYYMM}"

say "Subscribing nearest futures month (for UL)…"
curl_json GET "$BASE/api/debug/subscribe-future?yyyymm=${YYYYMM}"

# UL snapshot using the *first* month’s conId (just to warm the cache)
CONID_FIRST="$(printf '%s' "$RAW_MONTHS" | python3 - <<'PY'
import sys, json
j=json.load(sys.stdin)
print(j["items"][0]["conId"])
PY
)"
say "UL snapshot…"
curl_json GET "$BASE/api/debug/snapshot?conId=${CONID_FIRST}&secType=FUT" >/dev/null || true

# Batch subscribe ~25 strikes around ATM within next 7 days, C+P
say "Subscribing ~25 strikes around ATM (±${WIN}, step ${STEP}) within ${DAYS} days, C+P…"
payload="$(cat <<JSON
{"root":"${ROOT}","days":${DAYS},"atmWindow":${WIN},"step":${STEP},"rights":["C","P"],"seedSnapshot":false}
JSON
)"
SUBRES="$(curl_json POST "$BASE/api/options/subscribe_batch" "$payload" || true)"
[ -n "$SUBRES" ] || { echo "subscribe_batch failed"; exit 1; }
echo "$SUBRES"

# Optional: tail WS if wscat is installed
if command -v wscat >/dev/null 2>&1; then
  say "Tailing WS for 20s…"
  host="$(echo "$BASE" | sed -E 's#^https?://##')"
  wscat -c "ws://${host}/ws" | awk -v start="$(date +%s)" '/"topic":"option_quotes"/{print; fflush()} { if ((systime()-start)>20) exit 0 }'
else
  say "Tip: npm i -g wscat to live-tail quotes."
fi

say "Done."
