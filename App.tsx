import React, { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Platform, SafeAreaView, StatusBar, Text, TextInput, TouchableOpacity, View } from "react-native";
import Constants from "expo-constants";

/* ============== Config ============== */
const API_BASE = (Constants.expoConfig?.extra as any)?.API_BASE ?? "http://127.0.0.1:8080";
const WS_URL   = (Constants.expoConfig?.extra as any)?.WS_URL ?? "ws://127.0.0.1:8080/ws";

/* ============== Types ============== */
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
  // ------ NEW: optional aggressor tag (e.g., "AT_ASK", "AT_BID", "NEAR_MID")
  aggressor?: "AT_ASK" | "AT_BID" | "NEAR_MID" | "UNKNOWN" | string;
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
};

type Watchlist = {
  equities: string[];
  options: { underlying: string; expiration: string; strike: number; right: "C"|"P" }[];
};

type Notable = {
  tag: string;              // e.g. "0DTE CALLS", "Big Put Buy"
  text: string;             // human string
  weight?: number;          // for sorting
  ts?: number;
};

/* ============== Helpers ============== */
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n:number)=> new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n);
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
const chip = (txt:string, color:"#16a34a"|"#dc2626"|"#6b7280"="#6b7280") => (
  <View style={{
    paddingHorizontal:8,paddingVertical:2,borderRadius:6,
    backgroundColor: color==="#16a34a"?"#dcfce7":color==="#dc2626"?"#fee2e2":"#f3f4f6",
    borderWidth:1,borderColor: color==="#16a34a"?"#bbf7d0":color==="#dc2626"?"#fecaca":"#e5e7eb"
  }}>
    <Text style={{fontSize:12,color}}>{txt}</Text>
  </View>
);

/* ============== Tabs ============== */
type Tab = "Headlines" | "Sweeps" | "Blocks" | "Notables" | "Watchlist";
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
  const [notables, setNotables] = useState<Notable[]>([]);
  const [wl, setWl] = useState<Watchlist>({ equities:[], options:[] });

  const [minNotional, setMinNotional] = useState<number>(20000);
  const [minQty, setMinQty] = useState<number>(50);
  const [sortKey, setSortKey] = useState<"ts"|"notional"|"qty"|"price">("ts");
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
          switch (msg.topic) {
            case "headlines": {
              const list: Headline[] = msg.data ?? [];
              // De-dup on key (type/ul/right/strike/expiry/side) keep largest notional
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
            case "sweeps": {
              const inc: SweepBlockBase[] = msg.data ?? [];
              setSweeps(prev => mergeFlow(prev, inc));
              break;
            }
            case "blocks": {
              const inc: SweepBlockBase[] = msg.data ?? [];
              setBlocks(prev => mergeFlow(prev, inc));
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

  // Notables (poll every 5s; also available via your /insights/notables)
  useEffect(() => {
    let id: any;
    const pull = async () => {
      try {
        const res = await fetch(`${API_BASE}/insights/notables?minNotional=50000&topN=20`);
        if (res.ok) {
          const data = await res.json();
          const rows: Notable[] = Array.isArray(data?.rows) ? data.rows :
                                  Array.isArray(data) ? data : [];
          setNotables(rows
            .map((r:any)=> ({ tag: r.tag || r.type || "Notable", text: r.text || r.desc || JSON.stringify(r), weight: r.weight ?? r.score ?? 0, ts: r.ts ?? Date.now() }))
            .sort((a,b)=> (b.weight - a.weight) || ((b.ts ?? 0) - (a.ts ?? 0)))
            .slice(0, 20));
        }
      } catch {}
      id = setTimeout(pull, 5000);
    };
    pull();
    return () => clearTimeout(id);
  }, []);

  /* ===== Filters & sorting ===== */
  const filterSort = (arr:SweepBlockBase[]) => {
    const rows = arr.filter(r => notionalOf(r) >= minNotional && (r.qty||0) >= minQty);
    const val = (r:SweepBlockBase) =>
      sortKey==="ts" ? r.ts :
      sortKey==="notional" ? notionalOf(r) :
      sortKey==="qty" ? r.qty :
      sortKey==="price" ? r.price : 0;
    rows.sort((a,b)=> (val(a)-val(b))*sortDir);
    return sortDir===-1 ? rows.reverse() : rows;
  };
  const sweepsV = useMemo(()=>filterSort(sweeps).slice(0,300), [sweeps, minNotional, minQty, sortKey, sortDir]);
  const blocksV = useMemo(()=>filterSort(blocks).slice(0,300), [blocks, minNotional, minQty, sortKey, sortDir]);

  /* ===== REST helpers (watchlist) ===== */
  async function addEquity(sym:string){
    const clean = (sym||"").trim().toUpperCase().replace(/^\//,"");
    if (!clean) return;
    await fetch(`${API_BASE}/watchlist/equities`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ symbol: clean }) });
  }
  async function delEquity(sym:string){
    await fetch(`${API_BASE}/watchlist/equities/${encodeURIComponent(sym)}`, { method:"DELETE" });
  }

  /* ===== UI ===== */
  const Row = ({ r }: { r: SweepBlockBase }) => {
    const sideColor = r.side === "BUY" ? "#16a34a" : r.side === "SELL" ? "#dc2626" : "#6b7280";
    const aggr = (r.aggressor || "").replace(/_/g, " ").trim();
    return (
      <View style={{paddingVertical:8, borderBottomWidth:1, borderBottomColor:"#e5e7eb", flexDirection:"row", alignItems:"center"}}>
        <View style={{width:64}}><Text style={{fontFamily: Platform.OS==="ios"?"Menlo":"monospace"}}>{r.ul}</Text></View>
        <View style={{width:42, alignItems:"center"}}>{chip(r.right==="CALL"?"C":"P", r.right==="CALL"?"#16a34a":"#dc2626")}</View>
        <View style={{width:70}}><Text>{r.strike}</Text></View>
        <View style={{width:96}}><Text>{r.expiry}</Text></View>

        {/* ===== CHANGED: Side column now shows "SIDE @ PRICE" and optional aggressor badge */}
        <View style={{width:126}}>
          <Text style={{fontWeight:"700", color: sideColor}}>
            {r.side} <Text style={{color:"#111"}}>@ {nf2.format(r.price)}</Text>
          </Text>
          {!!aggr && (
            <View style={{marginTop:2, alignSelf:"flex-start"}}>
              {chip(aggr, "#6b7280")}
            </View>
          )}
        </View>

        <View style={{flex:1, alignItems:"flex-end"}}><Text>{nf0.format(r.qty)}</Text></View>
        <View style={{width:80, alignItems:"flex-end"}}><Text>{nf2.format(r.price)}</Text></View>
        <View style={{width:100, alignItems:"flex-end"}}><Text style={{fontWeight: notionalOf(r)>=250000 ? "700" : "500"}}>{moneyCompact(notionalOf(r))}</Text></View>
        <View style={{width:64, alignItems:"flex-end"}}><Text style={{opacity:0.6}}>{tsAgo(r.ts)}</Text></View>
      </View>
    );
  };

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
        {(["Headlines","Sweeps","Blocks","Notables","Watchlist"] as Tab[]).map(t =>
          <TabButton key={t} label={t} active={tab===t} onPress={()=>setTab(t)} />
        )}
      </View>

      {/* Filters (for Sweeps/Blocks) */}
      {(tab==="Sweeps" || tab==="Blocks") && (
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
            {(["ts","notional","qty","price"] as const).map(k => (
              <TouchableOpacity key={k} onPress={()=> setSortKey(prev => prev===k ? (setSortDir(d=>d===-1?1:-1), k) : (setSortDir(-1), k))} style={{marginLeft:10}}>
                <Text style={{fontWeight: sortKey===k ? "700":"500"}}>
                  {k}{sortKey===k ? (sortDir===-1?" ▼":" ▲"):""}
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
          renderItem={({item:h})=>(
            <View style={{padding:12, borderBottomWidth:1, borderBottomColor:"#e5e7eb"}}>
              <View style={{flexDirection:"row", alignItems:"center", marginBottom:6}}>
                {chip(h.type, "#6b7280")}
                <Text style={{marginLeft:8, fontFamily: Platform.OS==="ios"?"Menlo":"monospace"}}>{h.ul}</Text>
                {h.right && <Text style={{marginLeft:6}}>{(h.right==="CALL" || h.right==="PUT") ? h.right[0] : h.right}{h.strike ? h.strike : ""}</Text>}
                {h.expiry && <Text style={{marginLeft:8, color:"#6b7280"}}>{h.expiry}</Text>}
                {h.side && h.side!=="UNKNOWN" && <View style={{marginLeft:8}}>{chip(h.side, h.side==="BUY"?"#16a34a":"#dc2626")}</View>}
                <Text style={{marginLeft:"auto"}}>{moneyCompact(h.notional)}</Text>
              </View>
              <Text style={{color:"#6b7280"}}>{new Date(h.ts).toLocaleTimeString()} · {tsAgo(h.ts)}</Text>
            </View>
          )}
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

      {tab==="Notables" && (
        <FlatList
          data={notables}
          keyExtractor={(n,i)=>`${n.ts}:${i}`}
          ListHeaderComponent={()=>(<View style={{padding:10}}><Text style={{fontWeight:"700"}}>Notable Flow</Text></View>)}
          renderItem={({item:n})=>(
            <View style={{padding:12, borderBottomWidth:1, borderBottomColor:"#e5e7eb"}}>
              <View style={{flexDirection:"row", alignItems:"center", marginBottom:6}}>
                {chip(n.tag || "Notable", "#6b7280")}
                {typeof n.weight==="number" && <Text style={{marginLeft:8, color:"#6b7280"}}>score {nf1.format(n.weight||0)}</Text>}
                <Text style={{marginLeft:"auto", color:"#6b7280"}}>{n.ts ? tsAgo(n.ts) : ""}</Text>
              </View>
              <Text>{n.text}</Text>
            </View>
          )}
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
    <Text style={{width:42, fontWeight:"700"}}>R</Text>
    <Text style={{width:70, fontWeight:"700"}}>Strike</Text>
    <Text style={{width:96, fontWeight:"700"}}>Expiry</Text>
    {/* ===== CHANGED: widen Side column label to reflect "@ Px" */}
    <Text style={{width:126, fontWeight:"700"}}>Side @ Px</Text>
    <Text style={{flex:1, textAlign:"right", fontWeight:"700"}}>Qty</Text>
    <Text style={{width:80, textAlign:"right", fontWeight:"700"}}>Price</Text>
    <Text style={{width:100, textAlign:"right", fontWeight:"700"}}>Notional</Text>
    <Text style={{width:64, textAlign:"right", fontWeight:"700"}}>Age</Text>
  </View>
);

/* ===== Small utils kept local ===== */
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
