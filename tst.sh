ATM=6805
for K in $((ATM-10)) $((ATM-5)) $ATM $((ATM+5)) $((ATM+10)); do
  for R in C P; do
    echo "Subscribing ES $R $K 20251114"
    curl -sX POST 'http://localhost:8080/api/options/subscribe' \
      -H 'content-type: application/json' \
      -d "{ \"root\":\"ES\", \"expiry\":\"20251114\", \"right\":\"$R\", \"strike\":$K }"
  done
done

# See what's live:
curl -s 'http://localhost:8080/api/options/subscriptions' | jq
