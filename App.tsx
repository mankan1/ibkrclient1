// src/App.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Platform, SafeAreaView, StatusBar, Text, TextInput, TouchableOpacity, View } from "react-native";
import Constants from "expo-constants";

/* ============== Config ============== */
const API_BASE = (Constants.expoConfig?.extra as any)?.API_BASE ?? "http://127.0.0.1:8080";
const WS_URL   = (Constants.expoConfig?.extra as any)?.WS_URL   ?? "ws://127.0.0.1:8080/ws";

/* ============== Types ============== */
type ActionLabel = "BTO" | "BTO?" | "BTC" | "STO" | "STO?" | "STC" | "CLOSE?" | "—";
type ActionConf  = "high" | "medium" | "low";

type SweepBlockBase = {
  ul: string;
  right: "CALL" | "PUT";
  strike: number;
  expiry: string;
  side: "BUY" | "SELL" | "UNKNOWN";
  qty: number;
  price: number;
  notional?: number;
  prints?: number;
  ts: number;

  aggressor?: "AT_ASK" | "AT_BID" | "NEAR_MID" | "UNKNOWN" | string;

  action?: ActionLabel;
  action_conf?: ActionConf;
  at?: "bid" | "ask" | "mid" | "between";
  oi?: number | null;
  priorVol?: number | null;
  volume?: number | null; // current-day option volume
  reason?: string;

  ul_px?: number;

  // NEW: option-quote bits (optional) to enable Mark/Δ even without a quotes stream
  occ?: string;
  bid?: number;
  ask?: number;
  mid?: number;
};

type Headline = {
  type: "SWEEP" | "BLOCK" | "PRINT";
  ul: string;
  right?: "C"|"P"|"CALL"|"PUT";
  strike?: number;
  expiry?: string;
  side?: "BUY"|"SELL"|"UNKNOWN";
  notional: number;
  ts: number;
  action?: ActionLabel;
  action_conf?: ActionConf;
  at?: "bid" | "ask" | "mid" | "between";
  ul_px?: number;
};

type Watchlist = {
  equities: string[];
  options: { underlying: string; expiration: string; strike: number; right: "C"|"P" }[];
};

type Notable = {
  tag?: string;            // e.g., "BLOCKS" or "SWEEPS"
  kind?: "blocks" | "sweeps" | "prints";
  text?: string;
  headline?: string;

  ul?: string;
  ul_px?: number;

  // scoring/summary coming from server
  weight?: number;
  score?: number;
  dteAvg?: number;
  qty$?: number;
  notional$?: number;
  burst?: number;

  ts?: number;
  action?: ActionLabel;
  action_conf?: ActionConf;
  at?: "bid" | "ask" | "mid" | "between";
};

/* ============== Helpers ============== */
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyCompact = (n:number)=> new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",notation:"compact",maximumFractionDigits:1}).format(Math.max(0,Math.round(n||0)));
const notionalOf = (m: Partial<SweepBlockBase>) => Math.round((m.notional ?? 0) || (m.qty! * m.price! * 100));
const tsAgo = (t:number) => {
  const d = Date.now() - t;
  if (d < 1500) return "now";
  const s = Math.floor(d/1000); if (s < 60) return `${s}s`;
  const m = Math.floor(s/60);   if (m < 60) return `${m}m`;
  const h = Math.floor(m/60);   if (h < 24) return `${h}h`;
  return `${Math.floor(h/24)}d`;
};

const chip = (txt: string, color: string = "#6b7280") => (
  <View style={{
    paddingHorizontal:8,paddingVertical:2,borderRadius:6,
    backgroundColor: color==="#16a34a"?"#dcfce7":color==="#dc2626"?"#fee2e2":"#f3f4f6",
    borderWidth:1,borderColor: color==="#16a34a"?"#bbf7d0":color==="#dc2626"?"#fecaca":"#e5e7eb"
  }}>
    <Text style={{fontSize:12,color}}>{txt}</Text>
  </View>
);

function toNum(n:any): number | undefined {
  const v = Number(n);
  return Number.isFinite(v) ? v : undefined;
}
function norm(sym?: string) {
  return (sym ?? "").toString().trim().toUpperCase();
}

/* ---------- UL/print normalizers (robust) ---------- */
function coerceUl(x:any): string {
  let ul =
    x.ul ?? x.underlying ?? x.ul_symbol ?? x.symbol ?? x.root ?? x.underlyingSymbol ?? "";

  if (!ul && typeof x.occ === "string") {
    const m = x.occ.match(/^([A-Z]{1,6})\s/);
    if (m) ul = m[1];
  }
  if (!ul && typeof x.ticker === "string") {
    ul = x.ticker.split(/\s+/)[0] || "";
  }
  return String(ul || "—").toUpperCase();
}

function occFromParts(ul: string, expiry?: string, right?: "CALL"|"PUT", strike?: number) {
  if (!ul || !expiry || !right || !Number.isFinite(strike)) return undefined;
  const root = (ul + "      ").slice(0, 6);
  const yymmdd = String(expiry).replace(/-/g, "").slice(2, 8);
  const cp = right === "CALL" ? "C" : "P";
  const k = String(Math.round((strike ?? 0) * 1000)).padStart(8, "0");
  return `${root}${yymmdd}${cp}${k}`; // OCC 21 format
}

function standardizePrint(x: any): SweepBlockBase {
  const rightRaw = String(x.right ?? x.r ?? "").toUpperCase();
  const sideRaw  = String(x.side  ?? x.action ?? "").toUpperCase();

  const price = Number(x.price ?? x.px ?? x.last ?? x.bid ?? x.ask ?? 0);
  const qty   = Number(x.qty   ?? x.size ?? x.quantity ?? 0);
  const ul_px = toNum(x.ul_px);

  const ul = coerceUl(x);
  const right: "CALL"|"PUT" = (rightRaw==="C"||rightRaw==="CALL") ? "CALL" : "PUT";
  const strike = Number(x.strike ?? x.k ?? 0);
  const expiry = String(x.expiry ?? x.expiration ?? x.exp ?? "");

  const occ = String(x.occ || "").trim() || occFromParts(ul, expiry, right, strike);

  const bid = toNum(x.bid);
  const ask = toNum(x.ask);
  const mid = toNum(x.mid ?? ((Number.isFinite(bid) && Number.isFinite(ask)) ? ((bid!+ask!)/2) : undefined));

  return {
    ul,
    right,
    strike,
    expiry,
    side: sideRaw==="BUY"||sideRaw==="B" ? "BUY" : sideRaw==="SELL"||sideRaw==="S" ? "SELL" : "UNKNOWN",
    qty,
    price,
    notional: Number(x.notional ?? (qty && price ? qty*price*100 : 0)),
    prints: Number(x.prints ?? x.parts ?? 1),
    ts: Number(x.ts ?? x.time ?? Date.now()),
    aggressor: x.aggressor ?? x.liq ?? x.liq_ind ?? x.at,
    action: x.action,
    action_conf: x.action_conf,
    at: (x.at ?? x.aggressor ?? "").toLowerCase() || undefined,
    oi: toNum(x.oi),
    priorVol: toNum(x.priorVol),
    volume: toNum(x.volume ?? x.vol ?? x.day_volume),
    reason: x.reason,
    ul_px,
    occ,
    bid,
    ask,
    mid,
  };
}

function standardizeHeadline(h:any): Headline {
  const rightRaw = String(h.right ?? h.r ?? "").toUpperCase();
  const type = String(h.type ?? "PRINT").toUpperCase();
  return {
    type: (type === "SWEEP" || type === "BLOCK" || type === "PRINT") ? type : "PRINT",
    ul: coerceUl(h),
    right: (rightRaw==="C"||rightRaw==="CALL") ? "C" : (rightRaw==="P"||rightRaw==="PUT") ? "P" : undefined,
    strike: toNum(h.strike ?? h.k),
    expiry: String(h.expiry ?? h.expiration ?? h.exp ?? "") || undefined,
    side: (h.side ?? h.action ?? "UNKNOWN").toUpperCase(),
    notional: Number(h.notional ?? h.notl ?? 0),
    ts: Number(h.ts ?? h.time ?? Date.now()),
    action: h.action,
    action_conf: h.action_conf,
    at: (h.at ?? h.aggressor ?? "").toLowerCase() || undefined,
    ul_px: toNum(h.ul_px),
  };
}

/* ===== ActionBadge (RN) ===== */
function ActionBadge({ action, conf, at }: { action?: ActionLabel; conf?: ActionConf; at?: "bid"|"ask"|"mid"|"between" }) {
  const label = action ?? "—";
  const colorMap: Record<ActionLabel, string> = {
    BTO: "#2563eb", "BTO?": "#60a5fa",
    BTC: "#16a34a",
    STO: "#dc2626", "STO?": "#f87171",
    STC: "#ea580c",
    "CLOSE?": "#f59e0b",
    "—": "#6b7280",
  };
  const bg = colorMap[label] ?? "#6b7280";
  const ring = conf === "high" ? 3 : conf === "medium" ? 2 : 1;

  return (
    <View style={{flexDirection:"row", alignItems:"center"}}>
      <View style={{
        backgroundColor: bg, borderRadius:9999,
        paddingVertical:4, paddingHorizontal:10,
        borderWidth: ring, borderColor: "rgba(255,255,255,0.6)"
      }}>
        <Text style={{fontSize:12, color:"#fff", fontWeight:"800"}}>{label}</Text>
      </View>
      {at ? (
        <View style={{marginLeft:6, paddingHorizontal:6, paddingVertical:2, borderRadius:6, borderWidth:1, borderColor:"#e5e7eb"}}>
          <Text style={{fontSize:10, color:"#374151"}}>{String(at).toUpperCase()}</Text>
        </View>
      ) : null}
    </View>
  );
}

/* ===== Notables helpers ===== */
function standardizeNotable(x:any): Notable {
  const ul = coerceUl(x);
  const weight = toNum(x.score) ?? toNum(x.weight);
  const notl = toNum(x.notional) ?? toNum(x.notional$) ?? toNum(x.notional_usd);
  const qty  = toNum(x.qty) ?? toNum(x.qty$) ?? toNum(x.count) ?? toNum(x.size);
  const burst = toNum(x.burst);
  const dte   = toNum(x.dteAvg ?? x.dte);

  const text =
    x.headline ||
    [
      ul,
      String(x.side ?? "").toUpperCase(),
      notl != null ? moneyCompact(notl) : undefined,
      qty  != null ? `• ${nf0.format(qty)}x` : undefined,
      burst!= null ? `• burst ${nf0.format(burst)}` : undefined,
      dte  != null ? `• dte ${nf1.format(dte)}` : undefined,
    ].filter(Boolean).join(" ");

  return {
    tag: String(x.kind ?? x.tag ?? "Notable").toUpperCase(),
    text,
    weight,
    ts: toNum(x.ts) ?? Date.now(),
    action: x.action,
    action_conf: x.action_conf,
    at: (x.at ?? x.aggressor)?.toLowerCase(),
    ul,
    ul_px: toNum(x.ul_px),
    kind: x.kind,
    score: weight,
    dteAvg: dte,
    qty$: qty,
    notional$: notl,
    burst,
    headline: x.headline,
  };
}

function pickContractsForNotable(
  n: Notable,
  { blocks, sweeps, prints }: { blocks: SweepBlockBase[]; sweeps: SweepBlockBase[]; prints: SweepBlockBase[] },
  now = Date.now()
) {
  const UL = norm(n.ul || "");
  if (!UL) return [];

  const center = n.ts ?? now;
  const windowMs = 60_000;
  const since = center - windowMs;
  const until = center + windowMs;

  const inWin = (r: SweepBlockBase) => r.ts >= since && r.ts <= until && norm(r.ul) === UL;

  let pool: SweepBlockBase[] = [];
  if (n.kind === "blocks") pool = blocks.filter(inWin);
  else if (n.kind === "sweeps") pool = sweeps.filter(inWin);
  else if (n.kind === "prints") pool = prints.filter(inWin);
  else pool = [...blocks, ...sweeps, ...prints].filter(inWin);

  const key = (r: SweepBlockBase) => [r.right, r.strike, r.expiry, r.at ?? ""].join("|");
  const agg = new Map<string, { sample: SweepBlockBase; qty: number; notional: number }>();
  for (const r of pool) {
    const k = key(r);
    const cur = agg.get(k);
    const notl = notionalOf(r);
    if (!cur) agg.set(k, { sample: r, qty: r.qty || 0, notional: notl });
    else { cur.qty += r.qty || 0; cur.notional += notl; }
  }

  const rows = Array.from(agg.values())
    .sort((a, b) => (b.notional - a.notional) || (b.qty - a.qty))
    .slice(0, 3);

  return rows.map(x => x.sample);
}

function daysToExpiry(exp?: string) {
  if (!exp) return undefined;
  const d = new Date(exp + (exp.length === 10 ? "T20:00:00Z" : ""));
  if (isNaN(+d)) return undefined;
  return Math.max(0, Math.round((+d - Date.now()) / 86_400_000));
}

function ContractChip({ r }: { r: SweepBlockBase }) {
  const dte = daysToExpiry(r.expiry);
  return (
    <View style={{flexDirection:"row", alignItems:"center", marginRight:8, paddingHorizontal:8, paddingVertical:4, borderWidth:1, borderColor:"#e5e7eb", borderRadius:8}}>
      {chip(r.right === "CALL" ? "C" : "P", r.right === "CALL" ? "#16a34a" : "#dc2626")}
      <Text style={{marginLeft:6}}>{r.strike}</Text>
      {!!r.expiry && <Text style={{marginLeft:6, color:"#6b7280"}}>{r.expiry}</Text>}
      {typeof dte === "number" && <Text style={{marginLeft:6, color:"#6b7280"}}>{dte} DTE</Text>}
      {!!r.at && <Text style={{marginLeft:6, color:"#374151"}}>{String(r.at).toUpperCase()}</Text>}
    </View>
  );
}

/* ===== Vol/OI Ratio Chip ===== */
function RatioChip({ vol, oi }: { vol?: number | null; oi?: number | null }) {
  const v = typeof vol === "number" && Number.isFinite(vol) ? vol : 0;
  const o = typeof oi  === "number" && Number.isFinite(oi)  ? oi  : 0;
  const ratio = o > 0 ? v / o : (v > 0 ? Infinity : 0);
  const label = Number.isFinite(ratio) ? ratio.toFixed(2) : "∞";
  const bg = ratio > 1 ? "#DCFCE7" : ratio >= 0.5 ? "#E5E7EB" : "#F3F4F6";
  const fg = ratio > 1 ? "#065F46" : "#111827";
  return (
    <View style={{borderRadius:12, paddingHorizontal:8, paddingVertical:2, backgroundColor:bg}}>
      <Text style={{fontSize:12, fontWeight:"700", color:fg}}>Vol/OI {label}</Text>
    </View>
  );
}

/* ============== Tabs ============== */
type Tab = "Headlines" | "Sweeps" | "Blocks" | "Prints" | "Notables" | "Watchlist";
const TabButton = ({active, label, onPress}:{active:boolean;label:Tab;onPress:()=>void}) => (
  <TouchableOpacity onPress={onPress} style={{paddingVertical:8,paddingHorizontal:12,borderBottomWidth:3,borderBottomColor: active?"#1f2937":"transparent"}}>
    <Text style={{fontWeight: active?"700":"500"}}>{label}</Text>
  </TouchableOpacity>
);

/* ============== App ============== */
export default function App() {
  const [tab, setTab] = useState<Tab>("Headlines");
  const [headlines, setHeadlines] = useState<Headline[]>([]);
  const [sweeps, setSweeps] = useState<SweepBlockBase[]>([]);
  const [blocks, setBlocks] = useState<SweepBlockBase[]>([]);
  const [prints, setPrints] = useState<SweepBlockBase[]>([]);
  const [notables, setNotables] = useState<Notable[]>([]);
  const [wl, setWl] = useState<Watchlist>({ equities:[], options:[] });

  // Underlying prices cache
  const [ulPrices, setUlPrices] = useState<Record<string, number>>({});
  const setPrice = (sym:string, px:number|undefined|null) => {
    const s = norm(sym);
    if (!s) return;
    if (typeof px !== "number" || !Number.isFinite(px)) return;
    setUlPrices(prev => (prev[s] === px ? prev : { ...prev, [s]: px }));
  };

  // NEW: option marks (mid) by OCC
  const [optMarks, setOptMarks] = useState<Record<string, number>>({});

  const [minNotional, setMinNotional] = useState<number>(20000);
  const [minQty, setMinQty] = useState<number>(50);
  const [sortKey, setSortKey] = useState<"ts"|"notional"|"qty"|"price"|"vol"|"oi"|"voloi">("ts");
  const [sortDir, setSortDir] = useState<1|-1>(-1); // -1 = desc

  const [newSym, setNewSym] = useState("");

  // WS
  const wsRef = useRef<WebSocket|null>(null);
  useEffect(() => {
    let stop = false;
    let retry = 0;
    const connect = () => {
      if (stop) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onclose = () => { if (!stop) setTimeout(connect, Math.min(1000*Math.pow(2,retry++), 10000)); };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);

          const seedFromMap = (m:any) => {
            if (m && typeof m === "object") {
              for (const [k,v] of Object.entries(m)) setPrice(String(k), toNum(v as any));
            }
          };

          switch (msg.topic) {
            case "equity_ts":
            case "quotes":
            case "ticks": {
              const rows = Array.isArray(msg.data) ? msg.data : [];
              for (const q of rows) {
                const sym = coerceUl(q);
                const last = toNum(q.last ?? q.price ?? q.close ?? q.bid ?? q.ask);
                if (sym && last != null) setPrice(sym, last);
              }
              break;
            }

            // NEW: stream of option quotes to compute Mark; expect items { occ, bid, ask, mid? }
            case "option_quotes": {
              const rows = Array.isArray(msg.data) ? msg.data : [msg.data];
              setOptMarks(prev => {
                const next = { ...prev };
                for (const q of rows) {
                  const occ = String(q.occ || "").trim();
                  const bid = toNum(q.bid);
                  const ask = toNum(q.ask);
                  const mid = toNum(q.mid ?? ((Number.isFinite(bid) && Number.isFinite(ask)) ? ((bid!+ask!)/2) : undefined));
                  if (occ && Number.isFinite(mid)) next[occ] = mid!;
                }
                return next;
              });
              break;
            }

            case "prints": {
              const arr = Array.isArray(msg.data) ? msg.data : [msg.data];
              const inc: SweepBlockBase[] = arr.map(standardizePrint);

              // use embedded bid/ask to seed optMarks opportunistically
              setOptMarks(prev => {
                const next = { ...prev };
                for (const r of inc) {
                  if (r.occ) {
                    const m = Number.isFinite(r.mid) ? r.mid
                        : (Number.isFinite(r.bid) && Number.isFinite(r.ask)) ? ((r.bid!+r.ask!)/2)
                        : undefined;
                    if (Number.isFinite(m)) next[r.occ] = m!;
                  }
                }
                return next;
              });

              for (const m of inc) {
                const ul = coerceUl(m);
                const px = toNum(m.ul_px)
                        ?? toNum((m as any).last)
                        ?? toNum((m as any).underlyingPrice);
                if (ul && px != null) setPrice(ul, px);
              }
              if (msg.ul_prices) seedFromMap(msg.ul_prices);
              setPrints(prev => mergeFlow(prev, inc, 1000));
              break;
            }

            case "sweeps": {
              const inc: SweepBlockBase[] = (msg.data ?? []).map(standardizePrint);
              setOptMarks(prev => {
                const next = { ...prev };
                for (const r of inc) {
                  if (r.occ) {
                    const m = Number.isFinite(r.mid) ? r.mid
                        : (Number.isFinite(r.bid) && Number.isFinite(r.ask)) ? ((r.bid!+r.ask!)/2)
                        : undefined;
                    if (Number.isFinite(m)) next[r.occ] = m!;
                  }
                }
                return next;
              });
              for (const r of inc) setPrice(r.ul, r.ul_px);
              if (msg.ul_prices) seedFromMap(msg.ul_prices);
              setSweeps(prev => mergeFlow(prev, inc));
              break;
            }

            case "blocks": {
              const inc: SweepBlockBase[] = (msg.data ?? []).map(standardizePrint);
              setOptMarks(prev => {
                const next = { ...prev };
                for (const r of inc) {
                  if (r.occ) {
                    const m = Number.isFinite(r.mid) ? r.mid
                        : (Number.isFinite(r.bid) && Number.isFinite(r.ask)) ? ((r.bid!+r.ask!)/2)
                        : undefined;
                    if (Number.isFinite(m)) next[r.occ] = m!;
                  }
                }
                return next;
              });
              for (const r of inc) setPrice(r.ul, r.ul_px);
              if (msg.ul_prices) seedFromMap(msg.ul_prices);
              setBlocks(prev => mergeFlow(prev, inc));
              break;
            }

            case "headlines": {
              const list: Headline[] = (msg.data ?? []).map(standardizeHeadline);
              for (const h of list) if (h.ul && h.ul_px != null) setPrice(h.ul, h.ul_px);

              setHeadlines(prev => {
                const recent = prev.filter(p => Date.now()-p.ts <= 60_000);
                const key = (h:Headline)=>[h.type,h.ul,h.right?.toString().slice(0,1)??"",h.strike??"",h.expiry??"",h.side??""].join("|");
                const m = new Map<string, Headline>();
                [...recent, ...list].forEach(h=>{
                  const k = key(h); const cur = m.get(k);
                  if (!cur || h.notional > cur.notional || (h.notional===cur.notional && h.ts>cur.ts)) m.set(k,h);
                });
                return Array.from(m.values()).sort((a,b)=> (b.notional-a.notional) || (b.ts-a.ts)).slice(0,12);
              });
              break;
            }

            case "notables": {
              const raw = Array.isArray(msg.data) ? msg.data : [];
              const list: Notable[] = raw.map(standardizeNotable);

              for (const n of list) {
                if (n.ul && n.ul_px != null) setPrice(n.ul, n.ul_px);
              }
              if (msg.ul_prices && typeof msg.ul_prices === "object") {
                for (const [k, v] of Object.entries(msg.ul_prices)) setPrice(String(k), toNum(v as any));
              }
              setNotables(list);
              break;
            }

            case "watchlist": {
              setWl(normalizeWatchlist(msg.data));
              break;
            }
          }
        } catch {}
      };
    };
    connect();
    return () => { stop = true; wsRef.current?.close(); };
  }, []);

  // First-load fallback — backfill notables
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/insights/notables`);
        if (res.ok) setNotables(await res.json());
      } catch {}
    })();
  }, []);

  // OPTIONAL: gentle polling to backfill UL prices
  useEffect(() => {
    let id:any;
    const poll = async () => {
      try {
        const uls = Array.from(new Set([
          ...sweeps.map(s=>s.ul), ...blocks.map(b=>b.ul),
          ...prints.map(p=>p.ul), ...headlines.map(h=>h.ul),
          ...notables.map(n=>n.ul).filter(Boolean) as string[]
        ].filter(Boolean)));
        if (uls.length) {
          const url = `${API_BASE}/prices?symbols=${encodeURIComponent(uls.join(","))}`;
          const res = await fetch(url);
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data?.rows)) {
              data.rows.forEach((q:any) => setPrice(coerceUl(q), toNum(q.last ?? q.price)));
            } else if (Array.isArray(data)) {
              data.forEach((q:any)=> setPrice(coerceUl(q), toNum(q.last ?? q.price)));
            } else if (data && typeof data === "object") {
              for (const [k,v] of Object.entries(data)) setPrice(String(k).toUpperCase(), toNum(v as any));
            }
          }
        }
      } catch {}
      id = setTimeout(poll, 8000);
    };
    poll();
    return () => clearTimeout(id);
  }, [sweeps, blocks, prints, headlines, notables]);

  /* ===== Filters & sorting ===== */
  const metric = (r:SweepBlockBase, key: typeof sortKey) => {
    switch (key) {
      case "ts": return r.ts;
      case "notional": return notionalOf(r);
      case "qty": return r.qty;
      case "price": return r.price;
      case "vol": return r.volume ?? -1;
      case "oi": return r.oi ?? -1;
      case "voloi": {
        const v = r.volume ?? 0;
        const o = r.oi ?? 0;
        return o > 0 ? v / o : (v > 0 ? Number.POSITIVE_INFINITY : -1);
      }
    }
  };
  const filterSort = (arr:SweepBlockBase[]) => {
    const rows = arr.filter(r => notionalOf(r) >= minNotional && (r.qty||0) >= minQty);
    rows.sort((a,b)=> (metric(a, sortKey) - metric(b, sortKey)) * sortDir);
    return sortDir===-1 ? rows.reverse() : rows;
  };
  const sweepsV = useMemo(()=>filterSort(sweeps).slice(0,300), [sweeps, minNotional, minQty, sortKey, sortDir]);
  const blocksV = useMemo(()=>filterSort(blocks).slice(0,300), [blocks, minNotional, minQty, sortKey, sortDir]);
  const printsV = useMemo(()=>filterSort(prints).slice(0,300), [prints, minNotional, minQty, sortKey, sortDir]);

  /* ===== REST helpers (watchlist) ===== */
  async function addEquity(sym:string){
    const clean = (sym||"").trim().toUpperCase().replace(/^\//,"");
    if (!clean) return;
    await fetch(`${API_BASE}/watchlist/equities`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ symbol: clean }) });
  }
  async function delEquity(sym:string){
    await fetch(`${API_BASE}/watchlist/equities/${encodeURIComponent(sym)}`, { method:"DELETE" });
  }

  /* ===== Row components ===== */
  const Row = ({ r }: { r: SweepBlockBase }) => {
    const sideColorHex = r.side === "BUY" ? "#16a34a" : r.side === "SELL" ? "#dc2626" : "#6b7280";
    const aggr = (r.aggressor || "").replace(/_/g, " ").trim();
    const ulText = norm(r.ul || "—");

    // UL prices: show now + @trade if present
    const ulPxNow = ulPrices[ulText];
    const ulPxTrade = toNum(r.ul_px);
    const ulNowDisp = Number.isFinite(ulPxNow) ? nf2.format(ulPxNow as number) : "—";
    const ulTradeDisp = Number.isFinite(ulPxTrade) ? nf2.format(ulPxTrade as number) : undefined;

    // Option mark + delta
    const occ = r.occ || occFromParts(r.ul, r.expiry, r.right, r.strike);
    const mark = (() => {
      if (occ && Number.isFinite(optMarks[occ])) return optMarks[occ];
      if (Number.isFinite(r.mid)) return r.mid;
      if (Number.isFinite(r.bid) && Number.isFinite(r.ask)) return (r.bid! + r.ask!) / 2;
      return undefined;
    })();
    const delta = Number.isFinite(mark) ? (mark as number) - r.price : undefined;

    const volDisp = typeof r.volume === "number" && Number.isFinite(r.volume) ? nf0.format(r.volume) : "—";
    const oiDisp  = typeof r.oi     === "number" && Number.isFinite(r.oi)     ? nf0.format(r.oi)     : "—";

    return (
      <View style={{paddingVertical:8, borderBottomWidth:1, borderBottomColor:"#e5e7eb", flexDirection:"row", alignItems:"center"}}>
        <View style={{width:64}}>
          <Text style={{fontFamily: Platform.OS==="ios"?"Menlo":"monospace"}}>{ulText}</Text>
        </View>

        <View style={{width:90, alignItems:"flex-end"}}>
          <Text>{ulNowDisp}</Text>
          {ulTradeDisp && <Text style={{fontSize:12, color:"#6b7280"}}>@trade {ulTradeDisp}</Text>}
        </View>

        <View style={{width:42, alignItems:"center"}}>{chip(r.right==="CALL"?"C":"P", r.right==="CALL"?"#16a34a":"#dc2626")}</View>
        <View style={{width:70}}><Text>{r.strike}</Text></View>
        <View style={{width:96}}><Text>{r.expiry}</Text></View>

        <View style={{width:110}}>
          <ActionBadge action={r.action} conf={r.action_conf} at={r.at} />
        </View>

        <View style={{width:160}}>
          <Text style={{fontWeight:"700", color: sideColorHex}}>
            {r.side} <Text style={{color:"#111"}}>@ {nf2.format(r.price)}</Text>
          </Text>
          {!!aggr && (
            <View style={{marginTop:2, alignSelf:"flex-start"}}>
              {chip(aggr, "#6b7280")}
            </View>
          )}
        </View>

        {/* NEW: Mark + Δ */}
        <View style={{width:90, alignItems:"flex-end"}}>
          <Text>{Number.isFinite(mark) ? nf2.format(mark as number) : "—"}</Text>
        </View>
        <View style={{width:90, alignItems:"flex-end"}}>
          <Text style={{color: (delta ?? 0) > 0 ? "#16a34a" : (delta ?? 0) < 0 ? "#dc2626" : "#111827"}}>
            {Number.isFinite(delta) ? nf2.format(delta as number) : "—"}
          </Text>
        </View>

        <View style={{width:90, alignItems:"flex-end"}}><Text>{nf0.format(r.qty)}</Text></View>

        <View style={{width:100, alignItems:"flex-end"}}>
          <Text style={{fontWeight: notionalOf(r)>=250000 ? "700" : "500"}}>{moneyCompact(notionalOf(r))}</Text>
        </View>

        <View style={{width:90, alignItems:"flex-end"}}><Text>{volDisp}</Text></View>
        <View style={{width:90, alignItems:"flex-end"}}><Text>{oiDisp}</Text></View>
        <View style={{width:100, alignItems:"flex-end"}}><RatioChip vol={r.volume} oi={r.oi} /></View>

        <View style={{width:64, alignItems:"flex-end"}}><Text style={{opacity:0.6}}>{tsAgo(r.ts)}</Text></View>
      </View>
    );
  };

  const HeadlineRow = ({ h }: { h: Headline }) => {
    const sideColorHex = h.side==="BUY" ? "#16a34a" : h.side==="SELL" ? "#dc2626" : "#6b7280";
    const rShort = h.right ? ((h.right==="CALL" || h.right==="PUT") ? h.right[0] : h.right) : "";
    const ulPx = toNum(h.ul_px) ?? ulPrices[h.ul];
    const ulPxDisp = typeof ulPx === "number" && Number.isFinite(ulPx) ? nf2.format(ulPx) : "—";
    return (
      <View style={{padding:12, borderBottomWidth:1, borderBottomColor:"#e5e7eb"}}>
        <View style={{flexDirection:"row", alignItems:"center", marginBottom:6}}>
          {chip(h.type, "#6b7280")}
          <Text style={{marginLeft:8, fontFamily: Platform.OS==="ios"?"Menlo":"monospace"}}>{h.ul}</Text>
          <Text style={{marginLeft:8, color:"#6b7280"}}>UL {ulPxDisp}</Text>
          {!!rShort && <Text style={{marginLeft:6}}>{rShort}{h.strike ?? ""}</Text>}
          {!!h.expiry && <Text style={{marginLeft:8, color:"#6b7280"}}>{h.expiry}</Text>}
          {h.side && h.side!=="UNKNOWN" && <View style={{marginLeft:8}}>{chip(h.side, sideColorHex as any)}</View>}
          {h.action && <View style={{marginLeft:8}}><ActionBadge action={h.action} conf={h.action_conf} at={h.at} /></View>}
          <Text style={{marginLeft:"auto"}}>{moneyCompact(h.notional)}</Text>
        </View>
        <Text style={{color:"#6b7280"}}>{new Date(h.ts).toLocaleTimeString()} · {tsAgo(h.ts)}</Text>
      </View>
    );
  };

  const NotableRow = ({ n }: { n: Notable }) => {
    const ul = n.ul ? norm(n.ul) : undefined;
    const ulPx = ul ? (toNum(n.ul_px) ?? ulPrices[ul]) : undefined;
    const legs = pickContractsForNotable(n, { blocks, sweeps, prints });

    return (
      <View style={{padding:12, borderBottomWidth:1, borderBottomColor:"#e5e7eb"}}>
        <View style={{flexDirection:"row", alignItems:"center", marginBottom:6}}>
          {chip((n.tag || n.kind || "Notable").toString().toUpperCase(), "#6b7280")}
          {typeof n.score === "number" && <Text style={{marginLeft:8, color:"#6b7280"}}>score {nf1.format(n.score)}</Text>}
          {typeof n.dteAvg === "number" && <Text style={{marginLeft:8, color:"#6b7280"}}>avg {nf1.format(n.dteAvg)} DTE</Text>}
          {!!ul && <Text style={{marginLeft:8, fontFamily: Platform.OS==="ios"?"Menlo":"monospace"}}>{ul} {ulPx!=null?`· ${nf2.format(ulPx)}`:""}</Text>}
          <Text style={{marginLeft:"auto", color:"#6b7280"}}>{n.ts ? tsAgo(n.ts) : ""}</Text>
        </View>

        {!!n.headline && <Text style={{marginBottom:6}}>{n.headline}</Text>}
        {!n.headline && !!n.text && <Text style={{marginBottom:6}}>{n.text}</Text>}

        {legs.length > 0 ? (
          <View style={{flexDirection:"row", flexWrap:"wrap", marginTop:2}}>
            {legs.map((r, i) => <ContractChip key={i} r={r} />)}
          </View>
        ) : (
          <Text style={{color:"#9ca3af"}}>No matching legs found in recent window.</Text>
        )}
      </View>
    );
  };

  /* ===== UI ===== */
  return (
    <SafeAreaView style={{flex:1, backgroundColor:"#fff"}}>
      <StatusBar barStyle="dark-content" />
      {/* Header */}
      <View style={{padding:12, borderBottomWidth:1, borderBottomColor:"#e5e7eb", flexDirection:"row", alignItems:"center"}}>
        <Text style={{fontSize:18, fontWeight:"800"}}>TradeFlash Mobile</Text>
        <Text style={{marginLeft:8, color:"#6b7280"}}>({API_BASE.replace(/^https?:\/\//,'')})</Text>
      </View>

      {/* Tabs */}
      <View style={{flexDirection:"row", paddingHorizontal:8}}>
        {(["Headlines","Sweeps","Blocks","Prints","Notables","Watchlist"] as Tab[]).map(t =>
          <TabButton key={t} label={t} active={tab===t} onPress={()=>setTab(t)} />
        )}
      </View>

      {/* Filters (for Sweeps/Blocks/Prints) */}
      {(tab==="Sweeps" || tab==="Blocks" || tab==="Prints") && (
        <View style={{padding:10, borderBottomWidth:1, borderBottomColor:"#e5e7eb", flexDirection:"row", alignItems:"center"}}>
          <Text>Min $</Text>
          <TextInput
            keyboardType="numeric"
            value={String(minNotional)}
            onChangeText={v=>setMinNotional(Math.max(0, Number(v||0)))}
            style={{borderWidth:1,borderColor:"#e5e7eb",borderRadius:6, paddingHorizontal:8, paddingVertical:6, marginHorizontal:8, width:110}}
          />
          <Text>Min qty</Text>
          <TextInput
            keyboardType="numeric"
            value={String(minQty)}
            onChangeText={v=>setMinQty(Math.max(0, Number(v||0)))}
            style={{borderWidth:1,borderColor:"#e5e7eb",borderRadius:6, paddingHorizontal:8, paddingVertical:6, marginHorizontal:8, width:90}}
          />
          <TouchableOpacity onPress={()=>{ setMinNotional(20000); setMinQty(50); }} style={{marginLeft:6, paddingHorizontal:10, paddingVertical:8, borderWidth:1, borderColor:"#e5e7eb", borderRadius:6}}>
            <Text>Reset</Text>
          </TouchableOpacity>

          <View style={{marginLeft:"auto", flexDirection:"row", alignItems:"center"}}>
            {(["ts","notional","qty","price","mark","vol","oi","voloi"] as const).map(k => (
              <TouchableOpacity
                key={String(k)}
                onPress={()=>{
                  // "mark" isn't a real sort key in metric(); map it to price for now
                  const mapped = (k as any) === "mark" ? "price" : (k as any);
                  setSortKey(prev => prev===mapped ? (setSortDir(d=>d===-1?1:-1), mapped as any) : (setSortDir(-1), mapped as any));
                }}
                style={{marginLeft:10}}
              >
                <Text style={{fontWeight: (k==="mark"?"price":k)===sortKey ? "700":"500"}}>
                  {String(k)}{(k==="mark"?"price":k)===sortKey ? (sortDir===-1?" ▼":" ▲"):""}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* Content */}
      {tab==="Headlines" && (
        <FlatList
          data={headlines}
          keyExtractor={(h,i)=>`${h.ts}:${i}`}
          ListHeaderComponent={()=>(<View style={{padding:10}}><Text style={{fontWeight:"700"}}>Top Flow (rolling 60s)</Text></View>)}
          renderItem={({item})=> <HeadlineRow h={item} />}
        />
      )}

      {tab==="Sweeps" && (
        <FlatList
          data={sweepsV}
          keyExtractor={(r,i)=>`${r.ts}:${r.ul}:${i}`}
          ListHeaderComponent={()=>(<HeaderRow />)}
          renderItem={({item}) => <Row r={item} />}
        />
      )}

      {tab==="Blocks" && (
        <FlatList
          data={blocksV}
          keyExtractor={(r,i)=>`${r.ts}:${r.ul}:${i}`}
          ListHeaderComponent={()=>(<HeaderRow />)}
          renderItem={({item}) => <Row r={item} />}
        />
      )}

      {tab==="Prints" && (
        <FlatList
          data={printsV}
          keyExtractor={(r,i)=>`${r.ts}:${r.ul}:${i}`}
          ListHeaderComponent={()=>(<HeaderRow />)}
          renderItem={({item}) => <Row r={item} />}
        />
      )}

      {tab==="Notables" && (
        <FlatList
          data={notables}
          keyExtractor={(n,i)=>`${n.ts}:${i}`}
          ListHeaderComponent={()=>(<View style={{padding:10}}><Text style={{fontWeight:"700"}}>Notable Flow</Text></View>)}
          renderItem={({item})=> <NotableRow n={item} />}
        />
      )}

      {tab==="Watchlist" && (
        <View style={{flex:1}}>
          <View style={{padding:12, borderBottomWidth:1, borderBottomColor:"#e5e7eb"}}>
            <Text style={{fontWeight:"700", marginBottom:8}}>Add Equity</Text>
            <View style={{flexDirection:"row", alignItems:"center"}}>
              <TextInput
                value={newSym}
                onChangeText={setNewSym}
                placeholder="e.g., NVDA or /ES"
                autoCapitalize="characters"
                style={{flex:1, borderWidth:1, borderColor:"#e5e7eb", borderRadius:6, paddingHorizontal:10, paddingVertical:8}}
              />
              <TouchableOpacity onPress={()=>{ if(newSym.trim()){ addEquity(newSym); setNewSym(""); }}} style={{marginLeft:8, paddingHorizontal:12, paddingVertical:10, borderWidth:1, borderColor:"#e5e7eb", borderRadius:6}}>
                <Text>Add</Text>
              </TouchableOpacity>
            </View>
          </View>
          <FlatList
            data={wl.equities}
            keyExtractor={(s)=>s}
            ListHeaderComponent={()=>(<View style={{padding:10}}><Text style={{fontWeight:"700"}}>Equities</Text></View>)}
            renderItem={({item:s})=>(
              <View style={{padding:12, borderBottomWidth:1, borderBottomColor:"#e5e7eb", flexDirection:"row", alignItems:"center"}}>
                <Text style={{fontFamily: Platform.OS==="ios"?"Menlo":"monospace"}}>{s}</Text>
                <TouchableOpacity onPress={()=>delEquity(s)} style={{marginLeft:"auto"}}>
                  <Text style={{color:"#dc2626"}}>remove</Text>
                </TouchableOpacity>
              </View>
            )}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

/* ===== Header row for tables ===== */
const HeaderRow = () => (
  <View style={{paddingVertical:8, paddingHorizontal:12, borderBottomWidth:1, borderBottomColor:"#e5e7eb", backgroundColor:"#f9fafb", flexDirection:"row"}}>
    <Text style={{width:64, fontWeight:"700"}}>UL</Text>
    <Text style={{width:90, textAlign:"right", fontWeight:"700"}}>UL Px</Text>
    <Text style={{width:42, fontWeight:"700"}}>R</Text>
    <Text style={{width:70, fontWeight:"700"}}>Strike</Text>
    <Text style={{width:96, fontWeight:"700"}}>Expiry</Text>
    <Text style={{width:110, fontWeight:"700"}}>Action</Text>
    <Text style={{width:160, fontWeight:"700"}}>Side @ Px</Text>
    <Text style={{width:90, textAlign:"right", fontWeight:"700"}}>Mark</Text>
    <Text style={{width:90, textAlign:"right", fontWeight:"700"}}>Δ</Text>
    <Text style={{width:90, textAlign:"right", fontWeight:"700"}}>Qty</Text>
    <Text style={{width:100, textAlign:"right", fontWeight:"700"}}>Notional</Text>
    <Text style={{width:90, textAlign:"right", fontWeight:"700"}}>Vol</Text>
    <Text style={{width:90, textAlign:"right", fontWeight:"700"}}>OI</Text>
    <Text style={{width:100, textAlign:"right", fontWeight:"700"}}>Vol/OI</Text>
    <Text style={{width:64, textAlign:"right", fontWeight:"700"}}>Age</Text>
  </View>
);

/* ===== Small utils ===== */
function mergeFlow(prev:SweepBlockBase[], incoming:SweepBlockBase[], cap=1200){
  const key = (r:SweepBlockBase)=> [r.ul,r.right,r.strike,r.expiry,r.side,r.ts,r.qty,Math.round((r.price||0)*10000)].join("|");
  const m = new Map<string, SweepBlockBase>();
  prev.forEach(r=>m.set(key(r), r));
  incoming.forEach(r=>m.set(key(r), r));
  const rows = Array.from(m.values());
  rows.sort((a,b)=> (b.ts - a.ts) || (notionalOf(b) - notionalOf(a)));
  return rows.slice(0, cap);
}
function normalizeWatchlist(raw:any):Watchlist{
  const arr = Array.isArray(raw?.equities) ? raw.equities : [];
  const eqs = Array.from(new Set(arr.map((s:any)=> String(s).trim().toUpperCase().replace(/^\//,"")).filter(Boolean)));
  const opts = Array.isArray(raw?.options) ? raw.options : [];
  return { equities: eqs, options: opts };
}
