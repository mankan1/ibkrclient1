#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
ROOT="${ROOT:-ES}"
DAYS="${DAYS:-7}"            # Expiry within next 7 days
STEP="${STEP:-5}"            # ES step 5
WIN="${WIN:-60}"             # +/- 60 points -> (2*60/5)+1 = 25 strikes
MDTYPE="${MDTYPE:-1}"        # 1 = REAL-TIME, 3 = DELAYED, 4 = FROZEN

say() { printf '\n%s\n' "$*"; }

curl_json() { # method url [data]
  local method="$1" url="$2" data="${3:-}"
  local out http
  for attempt in {1..3}; do
    if [[ -n "$data" ]]; then
      # return both http code and body; treat 2xx only as success
      http="$(curl -sS -o /tmp/.__body.$$ -w '%{http_code}' -H 'content-type: application/json' -X "$method" "$url" -d "$data" || true)"
    else
      http="$(curl -sS -o /tmp/.__body.$$ -w '%{http_code}' -X "$method" "$url" || true)"
    fi
    if [[ "$http" =~ ^2[0-9][0-9]$ ]]; then
      out="$(cat /tmp/.__body.$$)"
      rm -f /tmp/.__body.$$
      printf '%s' "$out"
      return 0
    fi
    sleep 0.2
  done
  out="$(cat /tmp/.__body.$$ 2>/dev/null || true)"
  rm -f /tmp/.__body.$$
  echo "CURL_ERROR: $method $url -> HTTP $http" >&2
  if [[ -n "$out" ]]; then
    echo "BODY: $out" >&2
  fi
  return 1
}

# 1) Set market data type
say "Setting market data type to ${MDTYPE}…"
curl_json POST "$BASE/api/debug/mdtype" "{\"type\":${MDTYPE}}" | sed -e 's/^/  /'

# 2) Get ES futures months
say "Fetching ES months…"
RAW_MONTHS="$(curl_json GET "$BASE/api/debug/months?root=${ROOT}")" || {
  echo "ERROR: months endpoint failed." >&2
  exit 1
}
if [[ -z "${RAW_MONTHS}" ]]; then
  echo "ERROR: empty payload from /api/debug/months" >&2
  exit 1
}

# 3) Pick nearest contract with ltdom >= today (fallback to first)
say "Picking nearest ${ROOT} month…"
YYYYMM="$(printf '%s' "$RAW_MONTHS" | python3 - <<'PY'
import sys, json, datetime
s=sys.stdin.read().strip()
if not s: 
    print("", end=""); raise SystemExit(0)
try:
    j=json.loads(s)
except Exception:
    print("", end=""); raise SystemExit(0)
items=j.get("items", [])
if not items:
    print("", end=""); raise SystemExit(0)

today=int(datetime.datetime.utcnow().strftime("%Y%m%d"))
def toint(x):
    try: return int(x)
    except: return 0

cand=None
for it in items:
    if toint(it.get("ltdom","0")) >= today:
        cand=it; break
if cand is None:
    cand = items[0]
print(cand.get("yyyymm",""), end="")
PY
)"

if [[ -z "${YYYYMM}" ]]; then
  echo "ERROR: could not pick a month from /api/debug/months payload:" >&2
  echo "$RAW_MONTHS" >&2
  exit 1
fi
say "Using month: ${YYYYMM}"

# 4) Seed that futures month so UL price is known
say "Subscribing nearest futures month (for UL)…"
curl_json GET "$BASE/api/debug/subscribe-future?yyyymm=${YYYYMM}" | sed -e 's/^/  /'

# 5) Optional: sanity snapshot for UL
say "UL snapshot…"
curl_json GET "$BASE/api/debug/snapshot?conId=$(printf '%s' "$RAW_MONTHS" | python3 - <<'PY'
import sys, json
j=json.load(sys.stdin)
print(j["items"][0]["conId"])
PY
)&secType=FUT" | sed -e 's/^/  /'

# 6) Batch subscribe ~25 strikes around ATM within next 7 days, Calls+Puts
say "Subscribing ~25 strikes around ATM (±${WIN}, step ${STEP}) within ${DAYS} days, C+P…"
payload="$(cat <<JSON
{
  "root": "${ROOT}",
  "days": ${DAYS},
  "atmWindow": ${WIN},
  "step": ${STEP},
  "rights": ["C","P"],
  "seedSnapshot": false
}
JSON
)"
SUBRES="$(curl_json POST "$BASE/api/options/subscribe_batch" "$payload" || true)"
if [[ -z "$SUBRES" ]]; then
  echo "ERROR: subscribe_batch failed." >&2
  exit 1
fi
echo "$SUBRES" | sed -e 's/^/  /'

# 7) (Optional) Tail WS for a bit to confirm updates (requires wscat)
if command -v wscat >/dev/null 2>&1; then
  say "Tailing WS for 20s (Ctrl+C to stop earlier)…"
  # tail option_quotes only
  wscat -c "ws://$(echo "$BASE" | sed -E 's#^https?://##')/ws" \
    | awk -v start="$(date +%s)" '
      /"topic":"option_quotes"/{print; fflush()}
      { if ((systime()-start) > 20) exit 0 }'
else
  say "Tip: install wscat (npm i -g wscat) to live-tail quotes."
fi

say "Done."

