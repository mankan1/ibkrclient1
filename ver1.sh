say "Picking nearest $ROOT month…"
YYYYMM="$(printf '%s' "$RAW_MONTHS" | python3 - <<'PY'
import sys, json, datetime
j = json.load(sys.stdin)
items = j.get("items", [])
if not items:
    print("", end=""); raise SystemExit(0)

# Prefer the first contract in the list that has ltdom >= today; else fallback to the first item
today = int(datetime.datetime.utcnow().strftime("%Y%m%d"))
def toint(s): 
    try: return int(s)
    except: return 0

cand = next((it for it in items if toint(it.get("ltdom","0")) >= today), None)
print((cand or items[0]).get("yyyymm",""), end="")
PY
)"
if [[ -z "$YYYYMM" ]]; then
  echo "ERROR: could not pick a month from /api/debug/months payload:"
  echo "$RAW_MONTHS"
  exit 1
fi
echo "Using month: $YYYYMM"
