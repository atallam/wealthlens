import { useState, useEffect, useCallback, useRef } from "react";
import Papa from "papaparse";
import { supabase, signInWithGoogle, signOut } from "./supabase.js";

const GF = `@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');`;

const AT = {
  FD:          { label:"Fixed Deposit", color:"#c9a84c", icon:"🏦", cat:"Debt" },
  PPF:         { label:"PPF",           color:"#4caf9a", icon:"📗", cat:"Debt" },
  EPF:         { label:"EPF",           color:"#6ec0c9", icon:"🏛️", cat:"Debt" },
  MF:          { label:"Mutual Fund",   color:"#a084ca", icon:"📊", cat:"Market" },
  IN_STOCK:    { label:"Indian Stocks", color:"#e07c5a", icon:"📈", cat:"Market" },
  IN_ETF:      { label:"Indian ETF",   color:"#f0a050", icon:"🔷", cat:"Market" },
  US_STOCK:    { label:"US Stocks",     color:"#5a9ce0", icon:"🇺🇸", cat:"Market" },
  REAL_ESTATE: { label:"Real Estate",  color:"#7cb87c", icon:"🏠", cat:"Physical" },
};
const PPF_R=7.1, EPF_R=8.15;

// ── Math ─────────────────────────────────────────────────────────
function calcFD(p,r,s,mat){const start=new Date(s),now=new Date(),m=new Date(mat);const end=now<m?now:m;const y=Math.max(0,(end-start)/(864e5*365.25));return p*Math.pow(1+r/400,y*4);}
function calcAccr(p,rate,s){const y=Math.max(0,(new Date()-new Date(s))/(864e5*365.25));return p*Math.pow(1+rate/100,y);}
function getVal(h){
  const units = h.net_units!=null ? h.net_units : (h.units||0);
  switch(h.type){
    case"FD":          return calcFD(h.principal,h.interest_rate,h.start_date,h.maturity_date);
    case"PPF":         return calcAccr(h.principal,PPF_R,h.start_date);
    case"EPF":         return calcAccr(h.principal,EPF_R,h.start_date);
    case"MF":          return units*(h.current_nav||h.purchase_nav||0);
    case"IN_STOCK":
    case"IN_ETF":      return units*(h.current_price||h.purchase_price||0);
    case"US_STOCK":    return units*(h.current_price||h.purchase_price||0)*(h.usd_inr_rate||83.2);
    case"REAL_ESTATE": return h.current_value||h.purchase_value||0;
    default:           return h.principal||0;
  }
}
function getInv(h){
  // If transactions exist, avg_cost is already in INR (price field stores INR)
  if(h.avg_cost!=null && h.net_units!=null) return h.net_units * h.avg_cost;
  switch(h.type){
    case"MF":          return(h.units||0)*(h.purchase_nav||0);
    case"IN_STOCK":
    case"IN_ETF":      return(h.units||0)*(h.purchase_price||0);
    case"US_STOCK":    return(h.units||0)*(h.purchase_price||0)*(h.usd_inr_rate||83.2);
    case"REAL_ESTATE": return h.purchase_value||0;
    default:           return h.principal||0;
  }
}
function xirr(cfs,dates){if(cfs.length<2)return null;const d0=dates[0],yrs=dates.map(d=>(d-d0)/(864e5*365.25));const npv=r=>cfs.reduce((s,c,i)=>s+c/Math.pow(1+r,yrs[i]),0);const dnpv=r=>cfs.reduce((s,c,i)=>s-yrs[i]*c/Math.pow(1+r,yrs[i]+1),0);let r=0.1;for(let i=0;i<100;i++){const f=npv(r),df=dnpv(r);if(Math.abs(df)<1e-12)break;const nr=r-f/df;if(Math.abs(nr-r)<1e-7){r=nr;break;}r=nr;if(r<-0.999)r=-0.999;}return isFinite(r)?r*100:null;}
function getXIRR(h){const cur=getVal(h),inv=getInv(h);if(!h.start_date||cur<=0)return null;const s=new Date(h.start_date),n=new Date();if(n<=s)return null;return xirr([-inv,cur],[s,n]);}

const fmt=n=>`₹${Math.abs(n).toLocaleString("en-IN",{maximumFractionDigits:0})}`;
const fmtCr=n=>n>=1e7?`₹${(n/1e7).toFixed(2)}Cr`:n>=1e5?`₹${(n/1e5).toFixed(2)}L`:fmt(n);
const fmtPct=n=>`${n>=0?"+":""}${n.toFixed(2)}%`;
const uid=()=>"x"+Date.now()+Math.random().toString(36).slice(2,6);
const ago=d=>{if(!d)return"Never";const s=Math.floor((Date.now()-new Date(d))/1000);if(s<60)return`${s}s ago`;if(s<3600)return`${Math.floor(s/60)}m ago`;if(s<86400)return`${Math.floor(s/3600)}h ago`;return`${Math.floor(s/86400)}d ago`;};
const fmtSize=b=>b>1e6?`${(b/1e6).toFixed(1)}MB`:b>1e3?`${(b/1e3).toFixed(0)}KB`:`${b}B`;

// Holding form — instrument details only, no transaction data
const BF={member_id:"",type:"IN_STOCK",name:"",ticker:"",scheme_code:"",interest_rate:"",start_date:"",maturity_date:"",purchase_value:"",current_value:"",principal:"",usd_inr_rate:"83.2"};
// Transaction form
const BT={holding_id:"",txn_type:"BUY",units:"",price:"",price_usd:"",txn_date:new Date().toISOString().slice(0,10),notes:""};
const BG={name:"",targetAmount:"",targetDate:"",linkedMember:"all",category:"Retirement",color:"#c9a84c",notes:""};
const BA={type:"ALLOCATION_DRIFT",assetType:"IN_STOCK",threshold:"",label:"",active:true};

// ── API helper (attaches Supabase JWT) ───────────────────────────
async function api(path, opts={}) {
  const { data:{ session } } = await supabase.auth.getSession();
  const token = session?.access_token || "";
  const isForm = opts.body instanceof FormData;
  const headers = { Authorization:`Bearer ${token}`, ...(isForm?{}:{"Content-Type":"application/json"}), ...(opts.headers||{}) };
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) { const e=await res.json().catch(()=>({})); throw new Error(e.error||res.statusText); }
  return res.json();
}

/* ══════════════════════════════════════════════
   LOGIN SCREEN
══════════════════════════════════════════════ */
function LoginScreen({ error }) {
  const [loading, setLoading] = useState(false);
  async function login(){ setLoading(true); await signInWithGoogle().catch(()=>setLoading(false)); }
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="logo" style={{fontSize:"2rem",marginBottom:".4rem"}}>Wealth<span>Lens</span></div>
        <div style={{fontSize:".7rem",letterSpacing:".14em",textTransform:"uppercase",color:"rgba(232,224,208,.32)",marginBottom:"2.2rem"}}>Family Portfolio · Pro</div>
        <div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.3rem",color:"#e8e0d0",marginBottom:".4rem",fontWeight:300}}>Welcome back</div>
        <div style={{fontSize:".78rem",color:"rgba(232,224,208,.38)",marginBottom:"2rem",lineHeight:1.6}}>Sign in with your Google account to access the family portfolio.</div>
        {error&&<div style={{background:"rgba(224,124,90,.1)",border:"1px solid rgba(224,124,90,.3)",borderRadius:7,padding:".7rem 1rem",fontSize:".78rem",color:"#e07c5a",marginBottom:"1.25rem"}}>{error}</div>}
        <button className="google-btn" onClick={login} disabled={loading}>
          {!loading&&<svg width="18" height="18" viewBox="0 0 18 18" style={{marginRight:".6rem",flexShrink:0}}>
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
            <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
          </svg>}
          {loading?"Redirecting…":"Sign in with Google"}
        </button>
        <div style={{marginTop:"1.5rem",fontSize:".68rem",color:"rgba(232,224,208,.2)"}}>Access restricted to authorised family members</div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   TRANSACTION PANEL (per holding)
══════════════════════════════════════════════ */
function TransactionPanel({ holding, onAddTxn, onReload, onDeleteTxn, txnForm, setTxnForm, onClose, onFetchFx, fxRate, fxLoading }) {
  const txns = (holding.transactions || []).slice().sort((a,b)=>new Date(a.txn_date)-new Date(b.txn_date));
  const buys  = txns.filter(t=>t.txn_type==="BUY");
  const sells = txns.filter(t=>t.txn_type==="SELL");
  const netUnits = buys.reduce((s,t)=>s+Number(t.units),0) - sells.reduce((s,t)=>s+Number(t.units),0);
  const avgCost  = buys.length>0 ? buys.reduce((s,t)=>s+Number(t.units)*Number(t.price),0)/buys.reduce((s,t)=>s+Number(t.units),0) : 0;
  const isUS   = holding.type==="US_STOCK";
  const isMF   = holding.type==="MF";
  const priceLabel = isMF ? "NAV" : isUS ? "Price $" : "Price ₹";
  const fx = +(holding.usd_inr_rate||fxRate||83.2);

  // SIP state
  const [sipMode,       setSipMode]       = useState(false);
  const [sipAmount,     setSipAmount]     = useState("");
  const [sipDay,        setSipDay]        = useState("5");
  const [sipStartMonth, setSipStartMonth] = useState(() => { const d=new Date(); d.setMonth(d.getMonth()-11); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; });
  const [sipEndMonth,   setSipEndMonth]   = useState(() => { const d=new Date(); const next=new Date(d.getFullYear(), d.getMonth()+3, 1); return `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}`; });
  const [sipPreview,    setSipPreview]    = useState([]);
  const [sipFetching,   setSipFetching]   = useState(false);
  const [sipImporting,  setSipImporting]  = useState(false);
  const [sipError,      setSipError]      = useState("");

  async function fetchSipNavs(){
    if(!sipAmount||!sipDay||!sipStartMonth||!sipEndMonth){ setSipError("Fill in all fields"); return; }
    setSipError(""); setSipFetching(true); setSipPreview([]);
    // Build months array
    const [sy,sm] = sipStartMonth.split("-").map(Number);
    const [ey,em] = sipEndMonth.split("-").map(Number);
    const months = [];
    let y=sy, m=sm;
    while(y<ey||(y===ey&&m<=em)){
      months.push({year:y, month:m, sip_date:+sipDay});
      m++; if(m>12){m=1;y++;}
      if(months.length>120) break; // safety cap 10 years
    }
    try{
      const { data:{ session } } = await supabase.auth.getSession();
      const token = session?.access_token||"";
      const res = await fetch("/api/mf/sip-navs",{method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`},
        body:JSON.stringify({scheme_code:holding.scheme_code, months})});
      const data = await res.json();
      if(data.error) throw new Error(data.error);
      // Enrich with units = amount / nav
      const preview = data.results.map(r=>({
        ...r,
        units: r.nav ? (+sipAmount/r.nav) : null,
        amount: +sipAmount,
      }));
      setSipPreview(preview);
    }catch(e){ setSipError(e.message); }
    setSipFetching(false);
  }

  async function importSip(){
    const valid = sipPreview.filter(r=>r.nav&&r.txn_date&&r.units);
    if(!valid.length){ setSipError("No valid transactions to import"); return; }
    setSipImporting(true);
    try{
      const { data:{ session } } = await supabase.auth.getSession();
      const token = session?.access_token||"";
      for(const r of valid){
        await fetch("/api/transactions",{method:"POST",
          headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`},
          body:JSON.stringify({
            holding_id: holding.id,
            txn_type:   "BUY",
            units:      +r.units.toFixed(4),
            price:      +r.nav.toFixed(4),
            txn_date:   r.txn_date,
            notes:      `SIP ₹${r.amount.toLocaleString("en-IN")}${r.is_future?" (scheduled)":r.is_estimated?" (est. NAV)":""}`,
          })});
      }
      // Reload holdings via parent
      await onReload(holding.id);
      setSipMode(false); setSipPreview([]);
    }catch(e){ setSipError(e.message); }
    setSipImporting(false);
  }

  // SIP summary stats
  const validRows    = sipPreview.filter(r=>r.nav&&r.units);
  const futureRows   = sipPreview.filter(r=>r.is_future);
  const pastRows     = sipPreview.filter(r=>!r.is_future&&r.nav);
  const totalInvested= validRows.reduce((s,r)=>s+r.amount,0);
  const totalUnits   = validRows.reduce((s,r)=>s+(r.units||0),0);
  const avgNav       = totalUnits>0 ? totalInvested/totalUnits : 0;

  return (
    <div className="ovl" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="mod" style={{maxWidth:660}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"1.2rem"}}>
          <div>
            <div className="modtitle" style={{marginBottom:".15rem"}}>📋 Transactions</div>
            <div style={{fontSize:".73rem",color:"rgba(232,224,208,.38)"}}>{holding.name} {isUS&&<span style={{fontSize:".65rem",color:"#5a9ce0",marginLeft:4}}>🇺🇸 USD input</span>}</div>
          </div>
          <div style={{display:"flex",gap:".4rem",alignItems:"center"}}>
            {isMF&&holding.scheme_code&&(
              <button onClick={()=>{setSipMode(p=>!p);setSipPreview([]);setSipError("");}}
                style={{background:sipMode?"rgba(160,132,202,.2)":"rgba(160,132,202,.1)",border:`1px solid rgba(160,132,202,${sipMode?".5":".25"})`,color:"#a084ca",borderRadius:5,padding:".28rem .65rem",cursor:"pointer",fontSize:".68rem",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}}>
                {sipMode?"✕ Cancel SIP":"📅 Add SIP History"}
              </button>
            )}
            <button className="delbtn" style={{fontSize:"1rem"}} onClick={onClose}>✕</button>
          </div>
        </div>

        {/* ── SIP BULK ENTRY MODE ── */}
        {sipMode&&(
          <div style={{background:"rgba(160,132,202,.06)",border:"1px solid rgba(160,132,202,.2)",borderRadius:10,padding:"1.1rem",marginBottom:"1.2rem"}}>
            <div style={{fontSize:".7rem",letterSpacing:".1em",textTransform:"uppercase",color:"#a084ca",marginBottom:".9rem",fontWeight:600}}>📅 SIP Bulk Import</div>

            <div className="frow" style={{marginBottom:".7rem"}}>
              <FG label="Monthly SIP ₹">
                <input type="number" className="fi" placeholder="e.g. 10000" value={sipAmount} onChange={e=>setSipAmount(e.target.value)}/>
              </FG>
              <FG label="SIP Date (day of month)">
                <select className="fi fs" value={sipDay} onChange={e=>setSipDay(e.target.value)}>
                  {Array.from({length:31},(_,i)=>i+1).map(d=><option key={d} value={d}>{d}{d===1?"st":d===2?"nd":d===3?"rd":"th"}</option>)}
                </select>
              </FG>
            </div>
            <div className="frow" style={{marginBottom:".9rem"}}>
              <FG label="Start Month">
                <input type="month" className="fi" value={sipStartMonth} onChange={e=>setSipStartMonth(e.target.value)}/>
              </FG>
              <FG label="End Month (can be future)">
                <input type="month" className="fi" value={sipEndMonth} onChange={e=>setSipEndMonth(e.target.value)}/>
              </FG>
            </div>

            {sipError&&<div style={{fontSize:".75rem",color:"#e07c5a",marginBottom:".7rem"}}>⚠ {sipError}</div>}

            <button onClick={fetchSipNavs} disabled={sipFetching||!sipAmount}
              style={{width:"100%",background:"rgba(160,132,202,.15)",border:"1px solid rgba(160,132,202,.35)",color:"#a084ca",borderRadius:6,padding:".55rem",cursor:"pointer",fontSize:".8rem",fontFamily:"'DM Sans',sans-serif",fontWeight:500,marginBottom:sipPreview.length?".9rem":"0"}}>
              {sipFetching?"⟳ Fetching NAVs from MFAPI…":"🔍 Fetch NAVs & Preview"}
            </button>

            {/* Preview table */}
            {sipPreview.length>0&&(
              <>
                {/* Summary stats */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:".5rem",marginBottom:".85rem"}}>
                  {[
                    {label:"Months",     val:sipPreview.length},
                    {label:"Past SIPs",  val:pastRows.length},
                    {label:"Future SIPs",val:futureRows.length, note:"estimated NAV"},
                    {label:"Avg NAV",    val:`₹${avgNav.toFixed(4)}`},
                  ].map(s=>(
                    <div key={s.label} style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.07)",borderRadius:7,padding:".55rem .7rem",textAlign:"center"}}>
                      <div style={{fontSize:".58rem",letterSpacing:".07em",textTransform:"uppercase",color:"rgba(232,224,208,.3)",marginBottom:".2rem"}}>{s.label}</div>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:".82rem",color:s.label==="Future SIPs"?"#5a9ce0":"#c9a84c"}}>{s.val}</div>
                      {s.note&&<div style={{fontSize:".58rem",color:"rgba(232,224,208,.28)",marginTop:".1rem"}}>{s.note}</div>}
                    </div>
                  ))}
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:".5rem"}}>
                  <div style={{fontSize:".72rem",color:"rgba(232,224,208,.45)"}}>
                    Total invested: <span style={{fontFamily:"'DM Mono',monospace",color:"#c9a84c"}}>₹{totalInvested.toLocaleString("en-IN")}</span>
                    <span style={{marginLeft:".75rem"}}>Total units: <span style={{fontFamily:"'DM Mono',monospace",color:"#c9a84c"}}>{totalUnits.toFixed(4)}</span></span>
                  </div>
                </div>

                {/* Scrollable preview */}
                <div style={{maxHeight:220,overflowY:"auto",marginBottom:".85rem",border:"1px solid rgba(255,255,255,.07)",borderRadius:7}}>
                  <table className="ht" style={{fontSize:".72rem"}}>
                    <thead style={{position:"sticky",top:0,background:"#0c1526",zIndex:1}}>
                      <tr>
                        <th>Month</th><th>Txn Date</th><th className="r">NAV ₹</th>
                        <th className="r">Units</th><th className="r">Amount</th><th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sipPreview.map((r,i)=>(
                        <tr key={i} style={{opacity:r.nav?1:.5}}>
                          <td className="mono">{String(r.month).padStart(2,'0')}/{r.year}</td>
                          <td className="mono dim">{r.txn_date||"—"}</td>
                          <td className="r mono">{r.nav?`₹${r.nav.toFixed(4)}`:"—"}</td>
                          <td className="r mono">{r.units?r.units.toFixed(4):"—"}</td>
                          <td className="r mono dim">₹{r.amount.toLocaleString("en-IN")}</td>
                          <td>
                            {r.is_future
                              ? <span style={{fontSize:".62rem",color:"#5a9ce0",background:"rgba(90,156,224,.12)",padding:"1px 6px",borderRadius:3}}>Scheduled</span>
                              : r.is_estimated
                                ? <span style={{fontSize:".62rem",color:"#c9a84c",background:"rgba(201,168,76,.1)",padding:"1px 6px",borderRadius:3}}>Est. NAV</span>
                                : r.nav
                                  ? <span style={{fontSize:".62rem",color:"#4caf9a",background:"rgba(76,175,154,.1)",padding:"1px 6px",borderRadius:3}}>✓ Exact</span>
                                  : <span style={{fontSize:".62rem",color:"#e07c5a"}}>No NAV</span>
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {futureRows.length>0&&(
                  <div style={{fontSize:".7rem",color:"rgba(90,156,224,.7)",marginBottom:".7rem",padding:".5rem .7rem",background:"rgba(90,156,224,.06)",borderRadius:6,border:"1px solid rgba(90,156,224,.15)"}}>
                    ℹ {futureRows.length} future SIP{futureRows.length>1?"s":""} will use today's NAV as a placeholder and be marked as scheduled. Update them after each actual investment.
                  </div>
                )}

                <button onClick={importSip} disabled={sipImporting||validRows.length===0}
                  style={{width:"100%",background:"rgba(76,175,154,.15)",border:"1px solid rgba(76,175,154,.35)",color:"#4caf9a",borderRadius:6,padding:".6rem",cursor:"pointer",fontSize:".82rem",fontFamily:"'DM Sans',sans-serif",fontWeight:600}}>
                  {sipImporting?`⟳ Importing ${validRows.length} transactions…`:`⇩ Import ${validRows.length} SIP Transactions`}
                </button>
              </>
            )}
          </div>
        )}

        {/* Summary bar — shown when not in SIP mode */}
        {!sipMode&&txns.length>0&&(
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:".6rem",marginBottom:"1.2rem"}}>
            {[
              {label:"Net Units", val:netUnits.toFixed(4)},
              {label:"Avg Cost (INR)", val:`₹${avgCost.toLocaleString("en-IN",{maximumFractionDigits:2})}`},
              {label:"Transactions", val:txns.length},
            ].map(s=>(
              <div key={s.label} style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.07)",borderRadius:8,padding:".7rem .9rem",textAlign:"center"}}>
                <div style={{fontSize:".62rem",letterSpacing:".08em",textTransform:"uppercase",color:"rgba(232,224,208,.35)",marginBottom:".3rem"}}>{s.label}</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:".95rem",color:"#c9a84c"}}>{s.val}</div>
              </div>
            ))}
          </div>
        )}

        {/* Transaction list */}
        {!sipMode&&(txns.length===0
          ? <div className="empty" style={{padding:"1.5rem"}}>No transactions yet — add one below or use 📅 Add SIP History</div>
          : <div style={{maxHeight:220,overflowY:"auto",marginBottom:"1.2rem"}}>
              <table className="ht" style={{fontSize:".75rem"}}>
                <thead><tr>
                  <th>Date</th><th>Type</th><th className="r">Units</th>
                  <th className="r">{isUS?"Price $":"Price ₹"}</th>
                  {isUS&&<th className="r">Price ₹</th>}
                  <th className="r">Total ₹</th>
                  <th>Notes</th><th/>
                </tr></thead>
                <tbody>
                  {txns.map(t=>(
                    <tr key={t.id}>
                      <td className="mono dim">{t.txn_date}</td>
                      <td><span style={{fontSize:".65rem",padding:"2px 7px",borderRadius:3,fontWeight:600,background:t.txn_type==="BUY"?"rgba(76,175,154,.15)":"rgba(224,124,90,.15)",color:t.txn_type==="BUY"?"#4caf9a":"#e07c5a"}}>{t.txn_type}</span></td>
                      <td className="r mono">{Number(t.units).toFixed(4)}</td>
                      {isUS
                        ? <><td className="r mono dim">${t.price_usd!=null?Number(t.price_usd).toFixed(2):(Number(t.price)/fx).toFixed(2)}</td><td className="r mono dim">₹{Number(t.price).toLocaleString("en-IN",{maximumFractionDigits:0})}</td></>
                        : <td className="r mono dim">₹{Number(t.price).toLocaleString("en-IN",{maximumFractionDigits:2})}</td>
                      }
                      <td className="r mono" style={{color:"#e8e0d0"}}>₹{(Number(t.units)*Number(t.price)).toLocaleString("en-IN",{maximumFractionDigits:0})}</td>
                      <td className="dim" style={{maxWidth:110,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.notes||"—"}</td>
                      <td><button className="delbtn" onClick={()=>onDeleteTxn(t.id, holding.id)}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        )}

        {/* Add single transaction form — hidden in SIP mode */}
        {!sipMode&&(
        <div style={{background:"rgba(255,255,255,.02)",border:"1px solid rgba(255,255,255,.07)",borderRadius:9,padding:"1rem"}}>
          <div style={{fontSize:".68rem",letterSpacing:".1em",textTransform:"uppercase",color:"rgba(232,224,208,.35)",marginBottom:".8rem"}}>Add Transaction</div>
          <div className="frow">
            <FG label="Type">
              <select className="fi fs" value={txnForm.txn_type} onChange={e=>setTxnForm(p=>({...p,txn_type:e.target.value}))}>
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
            </FG>
            <FG label="Units"><input type="number" className="fi" placeholder="e.g. 100" value={txnForm.units} onChange={e=>setTxnForm(p=>({...p,units:e.target.value}))}/></FG>
            {isUS ? (
              <FG label="Price $ per unit">
                <input type="number" className="fi" placeholder="e.g. 189.50" value={txnForm.price_usd||""}
                  onChange={e=>{const usd=e.target.value;setTxnForm(p=>({...p,price_usd:usd,price:usd?(+usd*fx).toFixed(2):""}));}}/>
              </FG>
            ) : (
              <FG label={`${priceLabel} per unit`}><input type="number" className="fi" placeholder="per unit" value={txnForm.price} onChange={e=>setTxnForm(p=>({...p,price:e.target.value}))}/></FG>
            )}
            <FG label="Date"><input type="date" className="fi" value={txnForm.txn_date} onChange={e=>setTxnForm(p=>({...p,txn_date:e.target.value}))}/></FG>
          </div>
          {isUS&&(
            <div style={{display:"flex",alignItems:"center",gap:".75rem",marginBottom:".7rem",padding:".5rem .8rem",background:"rgba(90,156,224,.06)",border:"1px solid rgba(90,156,224,.18)",borderRadius:6}}>
              <div style={{flex:1,fontSize:".75rem"}}>
                <span style={{color:"rgba(232,224,208,.4)"}}>1 USD = </span>
                <span style={{fontFamily:"'DM Mono',monospace",color:"#5a9ce0"}}>₹{fx.toFixed(2)}</span>
                {txnForm.price_usd&&<span style={{marginLeft:".75rem",color:"rgba(232,224,208,.4)"}}>→ ₹<span style={{fontFamily:"'DM Mono',monospace",color:"#c9a84c"}}>{(+txnForm.price_usd*fx).toLocaleString("en-IN",{maximumFractionDigits:0})}</span> per unit</span>}
              </div>
              <button onClick={onFetchFx} disabled={fxLoading} style={{background:"rgba(90,156,224,.15)",border:"1px solid rgba(90,156,224,.3)",color:"#5a9ce0",borderRadius:4,padding:"2px 8px",cursor:"pointer",fontSize:".65rem",fontFamily:"'DM Sans',sans-serif"}}>
                {fxLoading?"…":"⟳ Rate"}
              </button>
            </div>
          )}
          <FG label="Notes (optional)"><input className="fi" placeholder="e.g. SIP, bonus units, tax harvesting" value={txnForm.notes} onChange={e=>setTxnForm(p=>({...p,notes:e.target.value}))}/></FG>
          <MA>
            <button className="btnc" onClick={onClose}>Close</button>
            <button className="btns" onClick={()=>onAddTxn()} disabled={!txnForm.units||!txnForm.price||!txnForm.txn_date}>+ Add Transaction</button>
          </MA>
        </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   ARTIFACT PANEL (per holding)
══════════════════════════════════════════════ */
function ArtifactPanel({ holding, token, onClose }) {
  const [artifacts, setArtifacts] = useState(holding.artifacts || []);
  const [uploading, setUploading] = useState(false);
  const [desc, setDesc]   = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();

  async function upload(file) {
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("holdingId", holding.id);
    fd.append("description", desc);
    try {
      const result = await api("/api/artifacts/upload", { method:"POST", body:fd });
      setArtifacts(p => [{
        id: result.id, file_name: result.file_name, description: desc,
        file_size: file.size, file_type: file.type,
        uploaded_at: new Date().toISOString()
      }, ...p]);
      setDesc("");
    } catch(e) { alert("Upload failed: " + e.message); }
    setUploading(false);
  }

  async function download(art) {
    try {
      const { url } = await api(`/api/artifacts/download/${art.id}`);
      window.open(url, "_blank");
    } catch(e) { alert("Download failed: " + e.message); }
  }

  async function remove(id) {
    if (!confirm("Delete this file?")) return;
    await api(`/api/artifacts/${id}`, { method:"DELETE" });
    setArtifacts(p => p.filter(a => a.id !== id));
  }

  const fileIcon = t => t?.includes("pdf")?"📄":t?.includes("image")?"🖼️":t?.includes("excel")||t?.includes("sheet")?"📊":"📎";

  return (
    <div className="ovl" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="mod" style={{maxWidth:560}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"1.2rem"}}>
          <div>
            <div className="modtitle" style={{marginBottom:".15rem"}}>📎 Documents</div>
            <div style={{fontSize:".73rem",color:"rgba(232,224,208,.38)"}}>{holding.name}</div>
          </div>
          <button className="delbtn" style={{fontSize:"1rem"}} onClick={onClose}>✕</button>
        </div>

        {/* Upload zone */}
        <div
          onDragOver={e=>{e.preventDefault();setDragOver(true);}}
          onDragLeave={()=>setDragOver(false)}
          onDrop={e=>{e.preventDefault();setDragOver(false);upload(e.dataTransfer.files[0]);}}
          onClick={()=>fileRef.current?.click()}
          style={{border:`2px dashed ${dragOver?"rgba(201,168,76,.6)":"rgba(255,255,255,.12)"}`,borderRadius:10,padding:"1.4rem",textAlign:"center",cursor:"pointer",transition:"all .2s",background:dragOver?"rgba(201,168,76,.05)":"transparent",marginBottom:"1rem"}}
        >
          <div style={{fontSize:"1.6rem",marginBottom:".4rem"}}>☁</div>
          <div style={{fontSize:".8rem",color:"rgba(232,224,208,.5)"}}>Drag & drop or click to upload</div>
          <div style={{fontSize:".68rem",color:"rgba(232,224,208,.28)",marginTop:".25rem"}}>PDF, images, Excel, Word — up to 15 MB</div>
          <input ref={fileRef} type="file" style={{display:"none"}} onChange={e=>upload(e.target.files[0])}/>
        </div>
        <div className="frow" style={{marginBottom:"1rem"}}>
          <FG label="Description (optional)"><input className="fi" placeholder="e.g. Q3 contract note, FD receipt" value={desc} onChange={e=>setDesc(e.target.value)}/></FG>
        </div>
        {uploading&&<div style={{textAlign:"center",padding:".8rem",fontSize:".78rem",color:"#c9a84c"}}>Uploading…</div>}

        {/* File list */}
        {artifacts.length===0
          ? <div className="empty" style={{padding:"1.5rem"}}>No documents attached yet</div>
          : <div style={{display:"flex",flexDirection:"column",gap:".5rem",maxHeight:280,overflowY:"auto"}}>
              {artifacts.map(a=>(
                <div key={a.id} style={{display:"flex",alignItems:"center",gap:".7rem",padding:".75rem .9rem",background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.07)",borderRadius:8}}>
                  <div style={{fontSize:"1.2rem",flexShrink:0}}>{fileIcon(a.file_type)}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:".82rem",color:"#e8e0d0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.file_name}</div>
                    <div style={{fontSize:".67rem",color:"rgba(232,224,208,.35)",marginTop:2}}>{a.description?`${a.description} · `:""}{fmtSize(a.file_size||0)} · {ago(a.uploaded_at)}</div>
                  </div>
                  <button className="btn-o" style={{padding:".26rem .6rem",fontSize:".65rem"}} onClick={()=>download(a)}>↓ View</button>
                  <button className="delbtn" onClick={()=>remove(a.id)}>✕</button>
                </div>
              ))}
            </div>
        }
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   MAIN APP
══════════════════════════════════════════════ */
export default function App() {
  const [user,      setUser]      = useState(null);
  const [authErr,   setAuthErr]   = useState("");
  const [authLoading, setAuthLoading] = useState(true);

  const [members,  setMembers]  = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [goals,    setGoals]    = useState([]);
  const [alerts,   setAlerts]   = useState([]);
  const [loaded,   setLoaded]   = useState(false);

  const [syncSt,   setSyncSt]   = useState("idle");
  const [priceRefreshing, setPriceRefreshing] = useState(false);
  const [lastPriceRefresh, setLastPriceRefresh] = useState(null);
  const [priceCount, setPriceCount] = useState(0);

  const [tab,            setTab]            = useState("overview");
  const [selMember,      setSelMember]      = useState("all");
  const [filterType,     setFilterType]     = useState("ALL");
  const [modal,          setModal]          = useState(null);
  const [form,           setForm]           = useState(BF);
  const [editHolding,    setEditHolding]    = useState(null);
  const [newMember,      setNewMember]      = useState({name:"",relation:""});
  const [goalForm,       setGoalForm]       = useState(BG);
  const [alertForm,      setAlertForm]      = useState(BA);
  const [csvPreview,     setCsvPreview]     = useState([]);
  const [pdfState,       setPdfState]       = useState({loading:false,summary:""});
  const [artifactHolding,setArtifactHolding]= useState(null);
  const [txnHolding,     setTxnHolding]     = useState(null);
  const [txnForm,        setTxnForm]        = useState(BT);
  const [globalTxnModal, setGlobalTxnModal] = useState(false);
  const [txnFilterMember, setTxnFilterMember] = useState("all");
  const [txnFilterType,   setTxnFilterType]   = useState("ALL");
  const [mfSearch,       setMfSearch]       = useState("");
  const [mfResults,      setMfResults]      = useState([]);
  const [mfSearching,    setMfSearching]    = useState(false);
  const [mfNav,          setMfNav]          = useState(null); // {nav, date, fund_house, scheme_category}
  const [stockInfo,      setStockInfo]      = useState(null); // {name, price, exchange, found}
  const [stockLooking,   setStockLooking]   = useState(false);
  const [usdInrRate,     setUsdInrRate]     = useState(83.2);
  const [usdInrLoading,  setUsdInrLoading]  = useState(false);
  const [etfSearch,      setEtfSearch]      = useState("");
  const [etfResults,     setEtfResults]     = useState([]);
  const [etfSearching,   setEtfSearching]   = useState(false);
  const [etfInfo,        setEtfInfo]        = useState(null);
  const mfSearchTimer  = useRef();
  const stockLookTimer = useRef();
  const etfSearchTimer = useRef();
  const [aiMessages,     setAiMessages]     = useState([]); // {role, content, ts}
  const [aiInput,        setAiInput]        = useState("");
  const [aiLoading,      setAiLoading]      = useState(false);
  const aiBottomRef = useRef();

  const csvRef   = useRef();
  const saveTimer = useRef(null);
  const txnSaving = useRef(false);

  // ── Auth listener ──
  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{
      setUser(session?.user||null); setAuthLoading(false);
    });
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_,session)=>{
      setUser(session?.user||null); setAuthLoading(false);
    });
    return ()=>subscription.unsubscribe();
  },[]);

  // ── Load data when signed in ──
  useEffect(()=>{
    if(!user)return;
    (async()=>{
      try{
        const [portfolio, hlds] = await Promise.all([
          api("/api/portfolio"),
          api("/api/holdings"),
        ]);
        if(portfolio){
          setMembers(portfolio.members||[]);
          setGoals(portfolio.goals||[]);
          setAlerts(portfolio.alerts||[]);
        } else {
          // First time loading — seed with sample data and save to DB
          setMembers(SEED.members);
          setGoals(SEED.goals);
          setAlerts(SEED.alerts);
          api("/api/portfolio", {
            method: "POST",
            body: JSON.stringify({ members: SEED.members, goals: SEED.goals, alerts: SEED.alerts })
          }).catch(() => {});
        }
        setHoldings(hlds||[]);
        // Compute last price refresh time from holdings
        const fetched = hlds.filter(h=>h.price_fetched_at).map(h=>new Date(h.price_fetched_at));
        if(fetched.length) setLastPriceRefresh(new Date(Math.max(...fetched)));
      } catch(e){ console.error("Load error",e); }
      setLoaded(true);
    })();
  },[user]);

  // ── Persist portfolio config (debounced) ──
  const savePortfolio = useCallback((m,g,a)=>{
    setSyncSt("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async()=>{
      try{
        await api("/api/portfolio",{method:"POST",body:JSON.stringify({members:m,goals:g,alerts:a})});
        setSyncSt("saved");
      }catch{ setSyncSt("error"); }
    },1000);
  },[]);

  useEffect(()=>{ if(loaded&&user) savePortfolio(members,goals,alerts); },[members,goals,alerts,loaded,user,savePortfolio]);

  // ── Real-time price refresh ──
  async function refreshPrices(){
    if(priceRefreshing) return;
    setPriceRefreshing(true);
    try{
      const result = await api("/api/prices/refresh",{method:"POST"});
      // Reload holdings with fresh prices
      const hlds = await api("/api/holdings");
      setHoldings(hlds||[]);
      setLastPriceRefresh(new Date());
      setPriceCount(result.updated||0);
    }catch(e){ alert("Price refresh failed: "+e.message); }
    setPriceRefreshing(false);
  }

  // ── CRUD ──
  async function saveHolding(){
    const h={
      ...form,
      id: editHolding?.id||uid(),
      principal:      +form.principal||null,
      interest_rate:  +form.interest_rate||null,
      purchase_value: +form.purchase_value||null,
      current_value:  +form.current_value||null,
      usd_inr_rate:   +form.usd_inr_rate||83.2,
    };
    try{
      if(editHolding){
        await api(`/api/holdings/${h.id}`,{method:"PUT",body:JSON.stringify(h)});
      } else {
        await api("/api/holdings",{method:"POST",body:JSON.stringify(h)});
      }
      const hlds = await api("/api/holdings");
      setHoldings(hlds||[]);
      setModal(null); setForm(BF); setEditHolding(null);
      // For stock/MF holdings — auto-open Add Transaction so user records first buy immediately
      if(!editHolding && ["IN_STOCK","IN_ETF","US_STOCK","MF"].includes(h.type)){
        const newH = hlds.find(x=>x.id===h.id);
        if(newH){ setTxnForm({...BT,holding_id:newH.id}); setGlobalTxnModal(true); }
      }
    }catch(e){ alert("Save failed: "+e.message); }
  }

  async function addTransaction(){
    if(!txnForm.holding_id){ alert("Select a holding"); return; }
    if(!txnForm.units||!txnForm.price||!txnForm.txn_date){ alert("Fill in units, price, and date"); return; }
    if(txnSaving.current) return;
    txnSaving.current = true;
    try{
      await api("/api/transactions",{method:"POST",body:JSON.stringify({
        holding_id: txnForm.holding_id,
        txn_type:   txnForm.txn_type,
        units:      +txnForm.units,
        price:      +txnForm.price,
        price_usd:  txnForm.price_usd ? +txnForm.price_usd : undefined,
        txn_date:   txnForm.txn_date,
        notes:      txnForm.notes||"",
      })});
      const hlds = await api("/api/holdings");
      setHoldings(hlds||[]);
      if(txnHolding) setTxnHolding(hlds.find(h=>h.id===txnHolding.id)||null);
      setTxnForm(BT);
      setGlobalTxnModal(false);
    }catch(e){ alert("Failed: "+e.message); }
    finally{ txnSaving.current = false; }
  }

  async function reloadHoldings(holdingId){
    const hlds = await api("/api/holdings");
    setHoldings(hlds||[]);
    const anchor = holdingId || txnHolding?.id;
    if(anchor) setTxnHolding(hlds.find(h=>h.id===anchor)||null);
  }

  async function deleteTransaction(txnId, holdingId){
    if(!confirm("Delete this transaction?"))return;
    await api(`/api/transactions/${txnId}`,{method:"DELETE"});
    const hlds = await api("/api/holdings");
    setHoldings(hlds||[]);
    if(txnHolding) setTxnHolding(hlds.find(h=>h.id===holdingId)||null);
  }

  async function deleteHolding(id){
    if(!confirm("Delete this holding?"))return;
    await api(`/api/holdings/${id}`,{method:"DELETE"});
    setHoldings(p=>p.filter(x=>x.id!==id));
  }

  function editH(h){ setEditHolding(h); setForm({...BF,...h,
    interest_rate:h.interest_rate||"", usd_inr_rate:h.usd_inr_rate||83.2}); setModal("holding"); }

  function addMember(){if(!newMember.name)return;setMembers(p=>[...p,{id:uid(),...newMember}]);setNewMember({name:"",relation:""});setModal(null);}
  function addGoal(){setGoals(p=>[...p,{id:uid(),...goalForm,targetAmount:+goalForm.targetAmount}]);setGoalForm(BG);setModal(null);}
  function addAlert(){setAlerts(p=>[...p,{id:uid(),...alertForm,threshold:+alertForm.threshold}]);setAlertForm(BA);setModal(null);}

  // ── MF Search ────────────────────────────────────────────────────
  function handleMfSearch(val){
    setMfSearch(val);
    setMfResults([]);
    setMfNav(null);
    clearTimeout(mfSearchTimer.current);
    if(val.length < 2){ setMfSearching(false); return; }
    setMfSearching(true);
    mfSearchTimer.current = setTimeout(async()=>{
      try{
        const results = await api(`/api/mf/search?q=${encodeURIComponent(val)}`);
        setMfResults(results||[]);
      }catch{ setMfResults([]); }
      setMfSearching(false);
    }, 400);
  }

  async function selectMfFund(fund){
    setMfSearch(fund.name);
    setMfResults([]);
    setForm(f=>({...f, name:fund.name, scheme_code:fund.scheme_code}));
    // Fetch current NAV and fund details
    try{
      const info = await api(`/api/mf/nav/${fund.scheme_code}`);
      setMfNav(info);
    }catch{ setMfNav(null); }
  }

  // ── Stock ticker lookup ──────────────────────────────────────────
  function handleTickerChange(ticker, market){
    setStockInfo(null);
    setForm(f=>({...f, ticker:ticker.toUpperCase()}));
    clearTimeout(stockLookTimer.current);
    if(ticker.length < 1){ setStockLooking(false); return; }
    setStockLooking(true);
    stockLookTimer.current = setTimeout(async()=>{
      try{
        const info = await api(`/api/stock/info?ticker=${encodeURIComponent(ticker)}&market=${market}`);
        setStockInfo(info);
        if(info.found && info.name){
          setForm(f=>({...f, name: f.name && f.name !== ticker.toUpperCase() ? f.name : info.name}));
        }
      }catch{ setStockInfo({found:false}); }
      setStockLooking(false);
    }, 600);
  }

  // ── Fetch live USD/INR rate ──────────────────────────────────────
  async function fetchUsdInr(){
    setUsdInrLoading(true);
    try{
      const data = await api("/api/forex/usdinr");
      const rate = data.rate || 83.2;
      setUsdInrRate(rate);
      setForm(f=>({...f, usd_inr_rate: rate.toFixed(2)}));
    }catch{ /* keep existing rate */ }
    setUsdInrLoading(false);
  }

  // ── ETF Search ───────────────────────────────────────────────────
  function handleEtfSearch(val){
    setEtfSearch(val);
    setEtfResults([]);
    setEtfInfo(null);
    clearTimeout(etfSearchTimer.current);
    if(val.length < 2){ setEtfSearching(false); return; }
    setEtfSearching(true);
    etfSearchTimer.current = setTimeout(async()=>{
      try{
        const results = await api(`/api/etf/search?q=${encodeURIComponent(val)}`);
        setEtfResults(results||[]);
      }catch{ setEtfResults([]); }
      setEtfSearching(false);
    }, 400);
  }

  async function selectEtf(etf){
    setEtfSearch(etf.name);
    setEtfResults([]);
    setForm(f=>({...f, name: etf.name, ticker: etf.ticker}));
    // Fetch current price
    try{
      const info = await api(`/api/stock/info?ticker=${encodeURIComponent(etf.ticker)}&market=IN`);
      setEtfInfo(info);
    }catch{ setEtfInfo(null); }
  }
  function buildPortfolioContext(){
    const allCurCtx  = holdings.reduce((s,h)=>s+getVal(h),0);
    const allInvCtx  = holdings.reduce((s,h)=>s+getInv(h),0);
    const allGainCtx = allCurCtx - allInvCtx;
    const allPctCtx  = allInvCtx>0 ? (allGainCtx/allInvCtx)*100 : 0;

    const memberLines = members.map(m=>{
      const hs = holdings.filter(h=>h.member_id===m.id);
      const cur = hs.reduce((s,h)=>s+getVal(h),0);
      const inv = hs.reduce((s,h)=>s+getInv(h),0);
      return `  ${m.name} (${m.relation}): current=${fmtCr(cur)}, invested=${fmtCr(inv)}, return=${inv>0?((cur-inv)/inv*100).toFixed(1):0}%`;
    }).join("\n");

    const holdingLines = holdings.map(h=>{
      const cur=getVal(h), inv=getInv(h), g=cur-inv;
      const xr=getXIRR(h);
      const mn=members.find(m=>m.id===h.member_id)?.name||"";
      const txns=h.transactions||[];
      const txnSummary = txns.length>0
        ? `  transactions(${txns.length}): buys=${txns.filter(t=>t.txn_type==="BUY").length}, sells=${txns.filter(t=>t.txn_type==="SELL").length}, net_units=${h.net_units?.toFixed(4)||"?"}, avg_cost=₹${h.avg_cost?.toFixed(2)||"?"}`
        : "";
      return `  [${AT[h.type]?.label}] ${h.name} (${mn}): current=${fmtCr(cur)}, invested=${fmtCr(inv)}, gain=${g>=0?"+":""}${fmtCr(g)}, return=${inv>0?(g/inv*100).toFixed(1):0}%${xr!=null?`, xirr=${xr.toFixed(1)}%`:""}${h.ticker?`, ticker=${h.ticker}`:""}${h.scheme_code?`, scheme=${h.scheme_code}`:""}${txnSummary}`;
    }).join("\n");

    const allocationLines = Object.entries(AT).map(([t,a])=>{
      const val=holdings.filter(h=>h.type===t).reduce((s,h)=>s+getVal(h),0);
      if(val===0) return null;
      return `  ${a.label}: ${fmtCr(val)} (${allCurCtx>0?(val/allCurCtx*100).toFixed(1):0}%)`;
    }).filter(Boolean).join("\n");

    const goalLines = goals.map(g=>{
      const prog=Math.min((allCurCtx/g.targetAmount)*100,100);
      const yLeft=((Math.max(0,new Date(g.targetDate)-new Date()))/(864e5*365.25)).toFixed(1);
      return `  ${g.name}: target=${fmtCr(g.targetAmount)}, by ${g.targetDate}, funded=${prog.toFixed(0)}%, years_left=${yLeft}`;
    }).join("\n");

    const alertLines = trigAlerts.map(a=>`  ⚠ ${a.label}`).join("\n");

    return `WEALTHLENS FAMILY PORTFOLIO — ${new Date().toLocaleDateString("en-IN")}

SUMMARY:
  Total value: ${fmtCr(allCurCtx)}
  Total invested: ${fmtCr(allInvCtx)}
  Total gain: ${allGainCtx>=0?"+":""}${fmtCr(allGainCtx)} (${allPctCtx.toFixed(2)}%)
  Holdings count: ${holdings.length}

MEMBERS:
${memberLines}

ASSET ALLOCATION:
${allocationLines}

HOLDINGS (all):
${holdingLines}

FINANCIAL GOALS:
${goalLines||"  None set"}

TRIGGERED ALERTS:
${alertLines||"  None"}`;
  }

  // ── Ask AI ────────────────────────────────────────────────────────
  async function askAI(){
    const q = aiInput.trim();
    if(!q || aiLoading) return;
    setAiInput("");
    const userMsg = {role:"user", content:q, ts:new Date()};
    setAiMessages(p=>[...p, userMsg]);
    setAiLoading(true);
    setTimeout(()=>aiBottomRef.current?.scrollIntoView({behavior:"smooth"}),50);

    const portfolioCtx = buildPortfolioContext();
    // Build conversation history for multi-turn context
    const history = [...aiMessages, userMsg].map(m=>({role:m.role, content:m.content}));

    try{
      const data = await api("/api/ai/chat", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: `You are a private wealth advisor assistant for an Indian family portfolio management app called WealthLens. You have access to the family's complete, real portfolio data below. Answer questions about their portfolio directly and specifically — use actual numbers, names, and holdings from the data. Be concise and conversational. Use ₹ for values, Indian number formatting (Cr, L). Do not give generic financial advice — always refer to their specific holdings and numbers.\n\n${portfolioCtx}`,
          messages: history,
        })
      });
      const reply = data.content?.find(c=>c.type==="text")?.text || "Sorry, I couldn't process that.";
      setAiMessages(p=>[...p, {role:"assistant", content:reply, ts:new Date()}]);
    }catch(e){
      setAiMessages(p=>[...p, {role:"assistant", content:"Something went wrong: "+e.message, ts:new Date()}]);
    }
    setAiLoading(false);
    setTimeout(()=>aiBottomRef.current?.scrollIntoView({behavior:"smooth"}),50);
  }

  // ── CSV import ──
  function handleCSV(file){
    Papa.parse(file,{header:true,skipEmptyLines:true,complete:({data})=>{
      const rows=data.map((r,i)=>({
        id:uid(), member_id:members.find(m=>m.name===r.Member)?.id||members[0]?.id||"",
        type:(r.Type||"IN_STOCK").toUpperCase(), name:r.Name||`Asset ${i+1}`,
        ticker:r.Ticker||"", scheme_code:r.SchemeCode||"",
        units:+r.Units||0, purchase_price:+r.PurchasePrice||0, current_price:+r.CurrentPrice||0,
        purchase_nav:+r.PurchaseNAV||0, current_nav:+r.CurrentNAV||0,
        principal:+r.Principal||0, interest_rate:+r.InterestRate||0,
        start_date:r.StartDate||"", maturity_date:r.MaturityDate||"",
        purchase_value:+r.PurchaseValue||0, current_value:+r.CurrentValue||0,
        usd_inr_rate:+r.USDINRRate||83.2,
      }));
      setCsvPreview(rows); setModal("csv");
    }});
  }

  async function importCSV(){
    for(const h of csvPreview){
      await api("/api/holdings",{method:"POST",body:JSON.stringify(h)}).catch(()=>{});
    }
    const hlds=await api("/api/holdings");
    setHoldings(hlds||[]);
    setCsvPreview([]); setModal(null);
  }

  // ── PDF report ──
  async function generatePDF(){
    setPdfState({loading:true,summary:""}); setModal("pdf");
    const allInv=holdings.reduce((s,h)=>s+getInv(h),0);
    const allCur=holdings.reduce((s,h)=>s+getVal(h),0);
    const byTA=Object.keys(AT).map(t=>{const v=holdings.filter(h=>h.type===t).reduce((s,h)=>s+getVal(h),0);return{...AT[t],t,v,pct:allCur>0?(v/allCur)*100:0};}).filter(x=>x.v>0);
    const mSum=members.map(m=>{const hs=holdings.filter(h=>h.member_id===m.id);const c=hs.reduce((s,h)=>s+getVal(h),0),i=hs.reduce((s,h)=>s+getInv(h),0);return{...m,cur:c,inv:i,pct:i>0?((c-i)/i)*100:0};});
    const ctx=`Portfolio: ${fmtCr(allCur)} | Invested: ${fmtCr(allInv)} | Gain: ${fmtCr(allCur-allInv)} (${allCur>0?((allCur-allInv)/allInv*100).toFixed(1):0}%)\nMembers: ${mSum.map(m=>`${m.name}: ${fmtCr(m.cur)} (${m.pct.toFixed(1)}%)`).join("; ")}\nAllocation: ${byTA.map(x=>`${x.label}: ${fmtCr(x.v)} (${x.pct.toFixed(1)}%)`).join(", ")}\nGoals: ${goals.map(g=>`${g.name}: target ${fmtCr(g.targetAmount)} by ${g.targetDate}`).join("; ")}`;
    try{
      const data = await api("/api/ai/chat", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 900,
          system: "You are a private wealth advisor. Write exactly 4 short paragraphs reviewing this Indian family portfolio: (1) overall health, (2) allocation quality, (3) goal progress, (4) recommendations. Use INR values. Plain text only.",
          messages: [{role:"user", content:ctx}]
        })
      });
      setPdfState({loading:false, summary:data.content?.find(c=>c.type==="text")?.text||""});
    }catch(e){ setPdfState({loading:false, summary:"AI summary unavailable: "+e.message}); }
  }

  // ── Derived data ──
  const allCur=holdings.reduce((s,h)=>s+getVal(h),0);
  const visH=holdings.filter(h=>selMember==="all"||h.member_id===selMember).filter(h=>filterType==="ALL"||h.type===filterType);
  const totCur=visH.reduce((s,h)=>s+getVal(h),0);
  const totInv=visH.reduce((s,h)=>s+getInv(h),0);
  const totGain=totCur-totInv, totPct=totInv>0?(totGain/totInv)*100:0;
  const byType=Object.keys(AT).map(t=>{const hs=visH.filter(h=>h.type===t);const v=hs.reduce((s,h)=>s+getVal(h),0),i=hs.reduce((s,h)=>s+getInv(h),0);return{t,v,i,count:hs.length,pct:totCur>0?(v/totCur)*100:0};}).filter(x=>x.v>0);
  const mSum=members.map(m=>{const hs=holdings.filter(h=>h.member_id===m.id);const c=hs.reduce((s,h)=>s+getVal(h),0),i=hs.reduce((s,h)=>s+getInv(h),0);return{...m,cur:c,inv:i,gain:c-i,pct:i>0?((c-i)/i)*100:0};});
  const trigAlerts=alerts.filter(a=>{
    if(!a.active)return false;
    if(a.type==="ALLOCATION_DRIFT"||a.type==="CONCENTRATION"){const v=holdings.filter(h=>h.type===a.assetType).reduce((s,h)=>s+getVal(h),0);const p=allCur>0?(v/allCur)*100:0;return a.type==="CONCENTRATION"?p<a.threshold:p>a.threshold;}
    if(a.type==="RETURN_TARGET")return totPct<a.threshold;
    return false;
  });

  const syncColor=syncSt==="saved"?"#4caf9a":syncSt==="saving"?"#c9a84c":syncSt==="error"?"#e07c5a":"rgba(232,224,208,.3)";

  // ── Early returns ──
  if(authLoading) return <><style>{GF}</style><style>{CSS}</style><div style={{minHeight:"100vh",background:"#070d1a",display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{width:34,height:34,border:"2px solid rgba(201,168,76,.2)",borderTopColor:"#c9a84c",borderRadius:"50%",animation:"spin 1s linear infinite"}}/><style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style></div></>;
  if(!user) return <><style>{GF}</style><style>{CSS}</style><LoginScreen error={authErr}/></>;

  return (
    <><style>{GF}</style><style>{CSS}</style>
    <div className="app">

      {/* HEADER */}
      <header className="hdr">
        <div className="logo">Wealth<span>Lens</span> <span style={{fontSize:".6rem",letterSpacing:".1em",color:"rgba(201,168,76,.5)",verticalAlign:"middle"}}>PRO</span></div>
        <div className="hdr-r">
          {trigAlerts.length>0&&<div className="alert-pill" onClick={()=>setTab("alerts")}>⚠ {trigAlerts.length} alert{trigAlerts.length>1?"s":""}</div>}
          {/* Sync dot */}
          <div style={{display:"flex",alignItems:"center",gap:".32rem",padding:".26rem .6rem",borderRadius:4,background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.07)"}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:syncColor,transition:"all .3s"}}/>
            <span style={{fontSize:".63rem",color:syncColor,fontFamily:"'DM Mono',monospace"}}>{syncSt==="saving"?"Saving…":syncSt==="error"?"Error":"Saved"}</span>
          </div>
          {/* Price refresh */}
          <button className="btn-o" onClick={refreshPrices} disabled={priceRefreshing} title="Fetch live prices from Yahoo Finance & MFAPI">
            {priceRefreshing?"⟳ Fetching…":"⟳ Live Prices"}
          </button>
          {lastPriceRefresh&&<span style={{fontSize:".62rem",color:"rgba(232,224,208,.28)",fontFamily:"'DM Mono',monospace",whiteSpace:"nowrap"}}>{ago(lastPriceRefresh)}</span>}
          <button className="btn-o" onClick={()=>csvRef.current?.click()}>⇑ CSV</button>
          <input ref={csvRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>{if(e.target.files[0]){handleCSV(e.target.files[0]);e.target.value="";}}}/>
          <button className="btn-g" onClick={generatePDF}>⤓ PDF</button>
          <button className="btn-o" onClick={()=>{setForm(BF);setEditHolding(null);setModal("holding");}}>+ Holding</button>
          <button className="btn-p" onClick={()=>{setTxnForm(BT);setGlobalTxnModal(true);}}>+ Transaction</button>
          {/* User */}
          <div style={{display:"flex",alignItems:"center",gap:".4rem",paddingLeft:".4rem",borderLeft:"1px solid rgba(255,255,255,.07)"}}>
            {user.user_metadata?.avatar_url
              ?<img src={user.user_metadata.avatar_url} alt="" style={{width:26,height:26,borderRadius:"50%",border:"1px solid rgba(201,168,76,.3)"}}/>
              :<div style={{width:26,height:26,borderRadius:"50%",background:"rgba(201,168,76,.2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:".72rem",color:"#c9a84c",fontWeight:600}}>{user.email?.[0]?.toUpperCase()||"?"}</div>
            }
            <button className="btn-o" style={{padding:".26rem .6rem",fontSize:".62rem",opacity:.6}} onClick={signOut}>Sign out</button>
          </div>
        </div>
      </header>

      <main className="main">
        {priceCount>0&&<div style={{display:"flex",alignItems:"center",gap:".5rem",marginBottom:"1rem",padding:".5rem .9rem",background:"rgba(76,175,154,.07)",border:"1px solid rgba(76,175,154,.2)",borderRadius:7,fontSize:".75rem",color:"#4caf9a"}}>✓ Updated {priceCount} prices from live market data</div>}

        {/* Member selector */}
        <div className="mbar">
          <span className="mlbl">View</span>
          {[{id:"all",name:"Family Portfolio"},...members].map(m=>(
            <div key={m.id} className={`mchip${selMember===m.id?" act":""}`} onClick={()=>setSelMember(m.id)}>{m.name}</div>
          ))}
        </div>

        {/* Tabs */}
        <div className="tabs">
          {["overview","holdings","goals","alerts","members","ask"].map(t=>(
            <div key={t} className={`tab${tab===t?" act":""}`} onClick={()=>setTab(t)}>
              {t==="alerts"&&trigAlerts.length>0?<span>{t} <span className="tbadge">{trigAlerts.length}</span></span>
               :t==="ask"?<span style={{display:"flex",alignItems:"center",gap:".35rem"}}>✦ Advisor</span>
               :t[0].toUpperCase()+t.slice(1)}
            </div>
          ))}
        </div>

        {/* ── OVERVIEW ── */}
        {tab==="overview"&&(<>
          <div className="mg">
            {[{label:"Portfolio Value",val:fmtCr(totCur),sub:`${visH.length} holdings`},{label:"Amount Invested",val:fmtCr(totInv)},{label:"Total Gains",val:(totGain>=0?"+":"")+fmtCr(totGain),sub:fmtPct(totPct),c:totGain>=0?"gain":"loss"},{label:"Return",val:fmtPct(totPct),c:totPct>=0?"gain":"loss",sub:"P&L %"}].map(m=>(
              <div key={m.label} className="mc"><div className="mclbl">{m.label}</div><div className={`mcval${m.c?" "+m.c:""}`}>{m.val}</div>{m.sub&&<div className={`mcsub${m.c?" "+m.c:""}`}>{m.sub}</div>}</div>
            ))}
          </div>
          <div className="sg">
            <div className="card"><div className="ctitle">Asset Allocation</div>
              {byType.length===0&&<div className="empty">No holdings</div>}
              {byType.map(row=>{const a=AT[row.t],g=row.v-row.i;return(<div key={row.t} className="arow"><div className="aicon">{a.icon}</div><div className="ainfo"><div className="aname">{a.label}</div><div className="abg"><div className="afill" style={{width:`${row.pct}%`,background:a.color}}/></div></div><div className="argt"><div className="aval">{fmt(row.v)}</div><div className={`apct${g>=0?" gain":" loss"}`}>{row.pct.toFixed(1)}% · {fmtPct(row.i>0?(g/row.i)*100:0)}</div></div></div>);})}
            </div>
            <div className="card"><div className="ctitle">Member Breakdown</div>
              {mSum.map(m=>(<div key={m.id} className="msrow"><div className="av">{m.name[0]}</div><div><div style={{fontSize:".88rem",color:"#e8e0d0"}}>{m.name}</div><div style={{fontSize:".68rem",color:"rgba(232,224,208,.33)",textTransform:"uppercase",letterSpacing:".05em"}}>{m.relation}</div></div><div style={{marginLeft:"auto",textAlign:"right"}}><div style={{fontFamily:"'DM Mono',monospace",fontSize:".85rem",color:"#e8e0d0"}}>{fmt(m.cur)}</div><div className={m.gain>=0?"gain":"loss"} style={{fontSize:".7rem"}}>{fmtPct(m.pct)}</div></div></div>))}
            </div>
          </div>
          <div className="card"><div className="ctitle">Category Distribution</div><DonutChart data={byType} total={totCur}/></div>
        </>)}

        {/* ── HOLDINGS ── */}
        {tab==="holdings"&&(<div className="card">
          <div className="tbar">
            <div className={`fchip${filterType==="ALL"?" act":""}`} onClick={()=>setFilterType("ALL")}>All</div>
            {Object.entries(AT).map(([k,v])=>(<div key={k} className={`fchip${filterType===k?" act":""}`} onClick={()=>setFilterType(k)}>{v.icon} {v.label}</div>))}
          </div>
          {visH.length===0?<div className="empty">No holdings — add one or import CSV</div>:(
            <div style={{overflowX:"auto"}}>
              <table className="ht">
                <thead><tr>
                  <th>Asset</th><th>Ticker / Code</th><th>Type</th><th>Member</th>
                  <th className="r">Units</th><th className="r">Avg Price</th>
                  <th className="r">Cur. Price</th>
                  <th className="r">Invested</th><th className="r">Current Value</th>
                  <th className="r">Gain</th><th className="r">Return</th><th className="r">XIRR</th>
                  <th className="r">Price source</th><th/>
                </tr></thead>
                <tbody>
                  {visH.map(h=>{
                    const cur=getVal(h),inv=getInv(h),g=cur-inv,p=inv>0?(g/inv)*100:0;
                    const xr=getXIRR(h);const a=AT[h.type];
                    const mn=members.find(m=>m.id===h.member_id)?.name||"";
                    const isLive=!!h.price_fetched_at;
                    const units   = h.net_units ?? h.units ?? null;
                    const avgCost = h.avg_cost  ?? h.purchase_price ?? h.purchase_nav ?? null;
                    const fx      = h.usd_inr_rate || 83.2;
                    const isUS    = h.type === "US_STOCK";

                    // Avg price display
                    const avgDisplay = avgCost
                      ? isUS
                        ? <><div style={{fontFamily:"'DM Mono',monospace",fontSize:".75rem",color:"rgba(232,224,208,.7)"}}>₹{avgCost.toLocaleString("en-IN",{maximumFractionDigits:0})}</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:".65rem",color:"rgba(232,224,208,.35)"}}>${(avgCost/fx).toFixed(2)}</div></>
                        : h.type==="MF"
                          ? <span style={{fontFamily:"'DM Mono',monospace",fontSize:".75rem",color:"rgba(232,224,208,.7)"}}>₹{Number(avgCost).toFixed(4)}</span>
                          : <span style={{fontFamily:"'DM Mono',monospace",fontSize:".75rem",color:"rgba(232,224,208,.7)"}}>₹{Number(avgCost).toLocaleString("en-IN",{maximumFractionDigits:2})}</span>
                      : <span style={{color:"rgba(232,224,208,.25)"}}>—</span>;

                    // Current price per unit display
                    const cpUsd = isUS ? h.current_price : null;
                    const cpInr = isUS
                      ? (h.current_price ? h.current_price * fx : null)
                      : (h.type==="MF" ? (h.current_nav||h.purchase_nav||null) : (h.current_price||h.purchase_price||null));
                    const curPriceDisplay = (cpUsd||cpInr)
                      ? isUS
                        ? cpUsd
                          ? <><div style={{fontFamily:"'DM Mono',monospace",fontSize:".75rem",color:"#e8e0d0"}}>${cpUsd.toFixed(2)}</div><div style={{fontFamily:"'DM Mono',monospace",fontSize:".65rem",color:"rgba(232,224,208,.45)"}}>₹{(cpUsd*fx).toLocaleString("en-IN",{maximumFractionDigits:0})}</div></>
                          : <span style={{color:"rgba(232,224,208,.25)"}}>—</span>
                        : h.type==="MF"
                          ? <span style={{fontFamily:"'DM Mono',monospace",fontSize:".75rem",color:"#e8e0d0"}}>₹{Number(cpInr).toFixed(4)}</span>
                          : cpInr ? <span style={{fontFamily:"'DM Mono',monospace",fontSize:".75rem",color:"#e8e0d0"}}>₹{Number(cpInr).toLocaleString("en-IN",{maximumFractionDigits:2})}</span>
                          : <span style={{color:"rgba(232,224,208,.25)"}}>—</span>
                      : <span style={{color:"rgba(232,224,208,.25)"}}>—</span>;

                    return(
                      <tr key={h.id}>
                        <td>
                          <div className="hn">{h.name}</div>
                          <div className="hm">{mn}</div>
                        </td>
                        <td>
                          {(h.ticker||h.scheme_code)
                            ? <span style={{fontFamily:"'DM Mono',monospace",fontSize:".73rem",color:"#c9a84c",background:"rgba(201,168,76,.08)",padding:"2px 7px",borderRadius:3,border:"1px solid rgba(201,168,76,.2)"}}>
                                {h.ticker||`SC:${h.scheme_code}`}
                              </span>
                            : <span style={{fontSize:".7rem",color:"rgba(232,224,208,.2)"}}>—</span>
                          }
                        </td>
                        <td><span className="tbadge2" style={{background:a.color+"22",color:a.color}}>{a.icon} {a.label}</span></td>
                        <td className="dim">{mn}</td>
                        <td className="r">
                          {units!=null
                            ? <span style={{fontFamily:"'DM Mono',monospace",fontSize:".75rem",color:"rgba(232,224,208,.7)"}}>{Number(units).toLocaleString("en-IN",{maximumFractionDigits:4})}</span>
                            : <span style={{color:"rgba(232,224,208,.25)"}}>—</span>}
                        </td>
                        <td className="r">{avgDisplay}</td>
                        <td className="r">{curPriceDisplay}</td>
                        <td className="r mono dim">{fmt(inv)}</td>
                        <td className="r mono" style={{fontWeight:500}}>{fmt(cur)}</td>
                        <td className={`r mono${g>=0?" gain":" loss"}`}>{g>=0?"+":""}{fmt(g)}</td>
                        <td className={`r mono${p>=0?" gain":" loss"}`}>{fmtPct(p)}</td>
                        <td className="r mono" style={{color:xr!=null&&xr>12?"#4caf9a":xr!=null?"#e07c5a":"rgba(232,224,208,.28)"}}>{xr!=null?xr.toFixed(1)+"%":"—"}</td>
                        <td className="r">
                          {isLive
                            ?<span style={{fontSize:".62rem",background:"rgba(76,175,154,.12)",color:"#4caf9a",padding:"2px 6px",borderRadius:3,border:"1px solid rgba(76,175,154,.25)"}}>● Live · {ago(h.price_fetched_at)}</span>
                            :(h.type==="FD"||h.type==="PPF"||h.type==="EPF")
                              ?<span style={{fontSize:".62rem",color:"rgba(232,224,208,.3)"}}>Auto-calc</span>
                              :h.type==="US_STOCK"
                                ?<span title="Add ticker and click Live Prices" style={{fontSize:".62rem",color:"rgba(224,124,90,.7)",cursor:"help"}}>⚠ Add ticker for live</span>
                                :<span style={{fontSize:".62rem",color:"rgba(232,224,208,.28)"}}>Manual</span>
                          }
                        </td>
                        <td>
                          <div style={{display:"flex",gap:3}}>
                            <button className="delbtn" title="View transactions" onClick={()=>{setTxnForm({...BT,holding_id:h.id});setTxnHolding(h);}} style={{color:(h.transactions||[]).length>0?"#a084ca":"rgba(232,224,208,.28)"}}>
                              📋{(h.transactions||[]).length>0?` ${(h.transactions||[]).length}`:""}
                            </button>
                            <button className="delbtn" title="Attach documents" onClick={()=>setArtifactHolding(h)} style={{color:(h.artifacts||[]).length>0?"#c9a84c":"rgba(232,224,208,.28)"}}>
                              📎{(h.artifacts||[]).length>0?` ${(h.artifacts||[]).length}`:""}
                            </button>
                            <button className="delbtn" style={{color:"rgba(90,156,224,.5)"}} onClick={()=>editH(h)}>✎</button>
                            <button className="delbtn" onClick={()=>deleteHolding(h.id)}>✕</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {/* Totals footer row */}
                {visH.length>0&&(()=>{
                  const totI=visH.reduce((s,h)=>s+getInv(h),0);
                  const totC=visH.reduce((s,h)=>s+getVal(h),0);
                  const totG=totC-totI;
                  const totP=totI>0?(totG/totI)*100:0;
                  return(
                  <tfoot>
                    <tr style={{borderTop:"2px solid rgba(201,168,76,.2)"}}>
                      <td colSpan={6} style={{padding:".75rem .65rem",fontSize:".7rem",letterSpacing:".08em",textTransform:"uppercase",color:"rgba(232,224,208,.32)",fontWeight:600}}>Total · {visH.length} holding{visH.length!==1?"s":""}</td>
                      <td className="r mono" style={{padding:".75rem .65rem",fontWeight:600,color:"rgba(232,224,208,.55)",fontSize:".83rem"}}>{fmt(totI)}</td>
                      <td className="r mono" style={{padding:".75rem .65rem",fontWeight:700,color:"#c9a84c",fontSize:".88rem"}}>{fmt(totC)}</td>
                      <td className={`r mono${totG>=0?" gain":" loss"}`} style={{padding:".75rem .65rem",fontWeight:600,fontSize:".83rem"}}>{totG>=0?"+":""}{fmt(totG)}</td>
                      <td className={`r mono${totP>=0?" gain":" loss"}`} style={{padding:".75rem .65rem",fontWeight:600,fontSize:".83rem"}}>{fmtPct(totP)}</td>
                      <td colSpan={3} style={{padding:".75rem .65rem"}}/>
                    </tr>
                  </tfoot>);
                })()}
              </table>
            </div>
          )}
          <div style={{marginTop:"1rem",padding:".75rem 1rem",background:"rgba(255,255,255,.02)",borderRadius:8,fontSize:".72rem",color:"rgba(232,224,208,.35)",lineHeight:1.6}}>
            <strong style={{color:"rgba(232,224,208,.55)"}}>Live prices:</strong> Add NSE ticker (e.g. <code style={{color:"#c9a84c"}}>RELIANCE</code>) or AMFI scheme code (e.g. <code style={{color:"#c9a84c"}}>119551</code>) when adding a holding, then click <strong style={{color:"rgba(232,224,208,.55)"}}>⟳ Live Prices</strong> to auto-fetch. 📎 button attaches contract notes, statements, or receipts to any holding.
          </div>
        </div>)}

        {/* ── GOALS ── */}
        {tab==="goals"&&(<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1.2rem"}}><div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.1rem",color:"#e8e0d0"}}>Financial Goals</div><button className="btn-sm" onClick={()=>{setGoalForm(BG);setModal("goal");}}>+ New Goal</button></div>
          {goals.length===0&&<div className="card empty">Set your first financial milestone</div>}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:"1rem"}}>
            {goals.map(g=>{const prog=Math.min((allCur/g.targetAmount)*100,100);const rem=Math.max(0,g.targetAmount-allCur);const yLeft=((Math.max(0,new Date(g.targetDate)-new Date()))/(864e5*365.25)).toFixed(1);return(<div key={g.id} className="card" style={{borderTop:`3px solid ${g.color}`,position:"relative"}}><button className="delbtn" style={{position:"absolute",top:10,right:10}} onClick={()=>setGoals(p=>p.filter(x=>x.id!==g.id))}>✕</button><div style={{display:"flex",alignItems:"center",gap:".55rem",marginBottom:".9rem"}}><div style={{width:9,height:9,borderRadius:"50%",background:g.color}}/><span style={{fontSize:".63rem",letterSpacing:".1em",textTransform:"uppercase",color:"rgba(232,224,208,.33)"}}>{g.category}</span></div><div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.2rem",color:"#e8e0d0",marginBottom:".25rem"}}>{g.name}</div>{g.notes&&<div style={{fontSize:".73rem",color:"rgba(232,224,208,.32)",marginBottom:".9rem"}}>{g.notes}</div>}<div style={{display:"flex",justifyContent:"space-between",marginBottom:".45rem"}}><span style={{fontFamily:"'DM Mono',monospace",fontSize:"1.05rem",color:g.color}}>{fmtCr(allCur)}</span><span style={{fontFamily:"'DM Mono',monospace",fontSize:".82rem",color:"rgba(232,224,208,.38)"}}>of {fmtCr(g.targetAmount)}</span></div><div className="gbbg"><div className="gbfill" style={{width:`${prog}%`,background:g.color}}/></div><div style={{display:"flex",justifyContent:"space-between",marginTop:".55rem",fontSize:".7rem"}}><span style={{color:"rgba(232,224,208,.38)"}}>Remaining <span style={{color:"#e8e0d0",fontFamily:"'DM Mono',monospace"}}>{fmtCr(rem)}</span></span><span style={{color:"rgba(232,224,208,.38)"}}>{yLeft}y · {prog.toFixed(0)}%</span></div></div>);})}
          </div>
        </>)}

        {/* ── ALERTS ── */}
        {tab==="alerts"&&(<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1.2rem"}}><div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.1rem",color:"#e8e0d0"}}>Rebalancing Alerts</div><button className="btn-sm" onClick={()=>{setAlertForm(BA);setModal("alert");}}>+ New Alert</button></div>
          {trigAlerts.length>0&&(<div className="card" style={{marginBottom:"1.2rem",borderColor:"rgba(224,124,90,.3)"}}><div style={{fontSize:".68rem",letterSpacing:".1em",textTransform:"uppercase",color:"#e07c5a",marginBottom:".7rem"}}>⚠ Triggered Now</div>{trigAlerts.map(a=>(<div key={a.id} style={{display:"flex",alignItems:"center",gap:".7rem",padding:".7rem",background:"rgba(224,124,90,.07)",borderRadius:"6px",marginBottom:".45rem",border:"1px solid rgba(224,124,90,.2)"}}><span>⚠️</span><div style={{flex:1,fontSize:".82rem",color:"#e07c5a"}}>{a.label}</div></div>))}</div>)}
          <div className="card">{alerts.map(a=>{const trig=!!trigAlerts.find(t=>t.id===a.id);return(<div key={a.id} style={{display:"flex",alignItems:"center",gap:".7rem",padding:".7rem",borderRadius:"6px",marginBottom:".45rem",background:trig?"rgba(224,124,90,.04)":"rgba(255,255,255,.02)",border:`1px solid ${trig?"rgba(224,124,90,.2)":"rgba(255,255,255,.06)"}`}}><div style={{width:7,height:7,borderRadius:"50%",background:trig?"#e07c5a":a.active?"#4caf9a":"rgba(255,255,255,.18)",flexShrink:0}}/><div style={{flex:1}}><div style={{fontSize:".82rem",color:trig?"#e07c5a":"rgba(232,224,208,.78)"}}>{a.label}</div><div style={{fontSize:".68rem",color:"rgba(232,224,208,.28)",marginTop:2}}>{a.type==="CONCENTRATION"?"Below ":"Above "}{a.threshold}%</div></div><button onClick={()=>setAlerts(p=>p.map(x=>x.id===a.id?{...x,active:!x.active}:x))} style={{background:"none",border:"1px solid rgba(255,255,255,.1)",borderRadius:4,padding:"2px 9px",fontSize:".68rem",cursor:"pointer",color:a.active?"#4caf9a":"rgba(232,224,208,.28)"}}>{a.active?"ON":"OFF"}</button><button className="delbtn" onClick={()=>setAlerts(p=>p.filter(x=>x.id!==a.id))}>✕</button></div>);})}</div>
        </>)}

        {/* ── MEMBERS ── */}
        {tab==="members"&&(<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1.2rem"}}><div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.1rem",color:"#e8e0d0"}}>Family Members</div><button className="btn-sm" onClick={()=>{setNewMember({name:"",relation:""});setModal("member");}}>+ Add Member</button></div>
          {mSum.map(m=>{const hs=holdings.filter(h=>h.member_id===m.id);const byT=Object.keys(AT).map(t=>({t,v:hs.filter(h=>h.type===t).reduce((s,h)=>s+getVal(h),0)})).filter(x=>x.v>0);return(<div key={m.id} className="card" style={{marginBottom:"1rem"}}><div style={{display:"flex",alignItems:"center",gap:".82rem",marginBottom:".95rem"}}><div className="av" style={{width:42,height:42,fontSize:"1rem"}}>{m.name[0]}</div><div><div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.2rem",color:"#e8e0d0"}}>{m.name}</div><div style={{fontSize:".68rem",color:"rgba(232,224,208,.33)",textTransform:"uppercase",letterSpacing:".08em"}}>{m.relation}</div></div><div style={{marginLeft:"auto",textAlign:"right"}}><div style={{fontFamily:"'DM Mono',monospace",fontSize:"1rem",color:"#c9a84c"}}>{fmt(m.cur)}</div><div className={m.gain>=0?"gain":"loss"} style={{fontSize:".73rem"}}>{fmtPct(m.pct)}</div></div></div><div style={{display:"flex",gap:".45rem",flexWrap:"wrap"}}>{byT.map(({t,v})=>{const a=AT[t];return(<div key={t} style={{background:a.color+"18",border:`1px solid ${a.color}44`,borderRadius:5,padding:".38rem .7rem",fontSize:".73rem",color:a.color}}>{a.icon} {a.label}: {fmt(v)}</div>);})}</div></div>);})}
        </>)}

        {/* ── ASK AI ── */}
        {tab==="ask"&&(
          <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 280px)",minHeight:500}}>
            {/* Header */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"1rem"}}>
              <div>
                <div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.1rem",color:"#e8e0d0"}}>✦ Advisor</div>
                <div style={{fontSize:".72rem",color:"rgba(232,224,208,.35)",marginTop:".2rem"}}>Ask anything about your holdings, returns, goals, or allocation</div>
              </div>
              {aiMessages.length>0&&<button className="btn-sm" onClick={()=>setAiMessages([])}>Clear chat</button>}
            </div>

            {/* Suggested questions — shown when chat is empty */}
            {aiMessages.length===0&&(
              <div style={{marginBottom:"1.2rem"}}>
                <div style={{fontSize:".68rem",letterSpacing:".1em",textTransform:"uppercase",color:"rgba(232,224,208,.28)",marginBottom:".65rem"}}>Suggested questions</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:".5rem"}}>
                  {[
                    "What is my total portfolio value today?",
                    "Which holding has the best XIRR?",
                    "How much have I invested in mutual funds?",
                    "What is Priya's total portfolio worth?",
                    "Which holdings are at a loss?",
                    "How far am I from my retirement goal?",
                    "What percentage of my portfolio is in equity?",
                    "Which is my largest single holding?",
                  ].map(q=>(
                    <button key={q} onClick={()=>{setAiInput(q);}}
                      style={{background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.1)",color:"rgba(232,224,208,.55)",padding:".38rem .8rem",borderRadius:20,cursor:"pointer",fontSize:".74rem",fontFamily:"'DM Sans',sans-serif",transition:"all .2s",textAlign:"left"}}
                      onMouseEnter={e=>{e.target.style.background="rgba(201,168,76,.1)";e.target.style.color="#c9a84c";e.target.style.borderColor="rgba(201,168,76,.3)";}}
                      onMouseLeave={e=>{e.target.style.background="rgba(255,255,255,.04)";e.target.style.color="rgba(232,224,208,.55)";e.target.style.borderColor="rgba(255,255,255,.1)";}}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Chat messages */}
            <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:".85rem",paddingRight:".25rem",marginBottom:"1rem"}}>
              {aiMessages.map((m,i)=>(
                <div key={i} style={{display:"flex",flexDirection:"column",alignItems:m.role==="user"?"flex-end":"flex-start"}}>
                  {/* Role label */}
                  <div style={{fontSize:".62rem",color:"rgba(232,224,208,.28)",marginBottom:".3rem",letterSpacing:".06em",textTransform:"uppercase"}}>
                    {m.role==="user"?"You":"✦ Advisor"}
                  </div>
                  {/* Bubble */}
                  <div style={{
                    maxWidth:"80%",
                    padding:".75rem 1rem",
                    borderRadius: m.role==="user"?"12px 12px 2px 12px":"12px 12px 12px 2px",
                    background: m.role==="user"?"rgba(201,168,76,.14)":"rgba(255,255,255,.04)",
                    border: m.role==="user"?"1px solid rgba(201,168,76,.3)":"1px solid rgba(255,255,255,.08)",
                    fontSize:".82rem",
                    lineHeight:1.65,
                    color: m.role==="user"?"#e8e0d0":"rgba(232,224,208,.85)",
                    whiteSpace:"pre-wrap",
                    fontFamily:"'DM Sans',sans-serif",
                  }}>
                    {m.content}
                  </div>
                </div>
              ))}
              {/* Typing indicator */}
              {aiLoading&&(
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-start"}}>
                  <div style={{fontSize:".62rem",color:"rgba(232,224,208,.28)",marginBottom:".3rem",letterSpacing:".06em",textTransform:"uppercase"}}>✦ Advisor</div>
                  <div style={{padding:".75rem 1rem",borderRadius:"12px 12px 12px 2px",background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",display:"flex",gap:".35rem",alignItems:"center"}}>
                    {[0,1,2].map(i=>(
                      <div key={i} style={{width:6,height:6,borderRadius:"50%",background:"rgba(201,168,76,.5)",animation:`bounce 1.2s ${i*0.2}s infinite`}}/>
                    ))}
                  </div>
                </div>
              )}
              <div ref={aiBottomRef}/>
            </div>

            {/* Input bar */}
            <div style={{display:"flex",gap:".6rem",alignItems:"flex-end"}}>
              <textarea
                className="fi"
                rows={2}
                placeholder="Ask anything about your portfolio… e.g. 'Which MF has the best return?' or 'How much has Arjun invested?'"
                value={aiInput}
                onChange={e=>setAiInput(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();askAI();}}}
                style={{flex:1,resize:"none",lineHeight:1.5,fontSize:".82rem",padding:".65rem .9rem"}}
              />
              <button className="btns" onClick={askAI} disabled={!aiInput.trim()||aiLoading}
                style={{padding:".65rem 1.2rem",whiteSpace:"nowrap",alignSelf:"stretch"}}>
                {aiLoading?"…":"Send ↵"}
              </button>
            </div>
            <div style={{fontSize:".65rem",color:"rgba(232,224,208,.22)",marginTop:".4rem",textAlign:"center"}}>
              Press Enter to send · Shift+Enter for new line · Conversation context is maintained across messages
            </div>
            <style>{`@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-5px)}}`}</style>
          </div>
        )}
      </main>
    </div>

    {/* Artifact panel */}
    {artifactHolding&&<ArtifactPanel holding={artifactHolding} onClose={()=>setArtifactHolding(null)}/>}

    {/* MODALS */}
    {modal==="holding"&&(
      <Overlay onClose={()=>{setModal(null);setEditHolding(null);setForm(BF);setMfSearch("");setMfResults([]);setMfNav(null);setStockInfo(null);setEtfSearch("");setEtfResults([]);setEtfInfo(null);}}>
        <div className="modtitle">{editHolding?"Edit":"Add"} Holding</div>
        <div style={{fontSize:".75rem",color:"rgba(232,224,208,.38)",marginBottom:"1rem",lineHeight:1.6}}>
          {editHolding?"Update instrument details below.":"Register the instrument. Transactions (buy/sell) are added separately via the + Transaction button."}
        </div>
        <div className="frow">
          <FG label="Member"><select className="fi fs" value={form.member_id} onChange={e=>setForm(f=>({...f,member_id:e.target.value}))}><option value="">Select</option>{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></FG>
          <FG label="Asset Type"><select className="fi fs" value={form.type} onChange={e=>{setForm(f=>({...f,type:e.target.value}));setStockInfo(null);if(e.target.value==="US_STOCK")fetchUsdInr();}}>{Object.entries(AT).map(([k,v])=><option key={k} value={k}>{v.icon} {v.label}</option>)}</select></FG>
        </div>
        <FG label="Name"><input className="fi" placeholder="e.g. Reliance Industries" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/></FG>
        {form.type==="IN_STOCK"&&(
          <div style={{marginBottom:".85rem"}}>
            <label className="flbl">NSE Ticker (for live prices)</label>
            <div style={{position:"relative"}}>
              <input className="fi" placeholder="e.g. RELIANCE, HDFCBANK, TCS"
                value={form.ticker||""}
                onChange={e=>handleTickerChange(e.target.value,"IN")}
              />
              {stockLooking&&<div style={{position:"absolute",right:".7rem",top:"50%",transform:"translateY(-50%)",fontSize:".7rem",color:"rgba(232,224,208,.4)"}}>Looking up…</div>}
            </div>
            {stockInfo&&stockInfo.found&&(
              <div style={{marginTop:".5rem",padding:".6rem .85rem",background:"rgba(224,124,90,.07)",border:"1px solid rgba(224,124,90,.22)",borderRadius:7,fontSize:".75rem",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{color:"#e07c5a",fontWeight:500}}>{stockInfo.name}</div>
                  <div style={{color:"rgba(232,224,208,.38)",fontSize:".67rem"}}>{stockInfo.exchange} · {form.ticker}.NS</div>
                </div>
                {stockInfo.price&&<div style={{fontFamily:"'DM Mono',monospace",color:"#c9a84c",fontSize:".9rem"}}>₹{stockInfo.price.toLocaleString("en-IN",{maximumFractionDigits:2})}</div>}
              </div>
            )}
            {stockInfo&&!stockInfo.found&&form.ticker&&!stockLooking&&(
              <div style={{marginTop:".5rem",fontSize:".72rem",color:"rgba(224,124,90,.6)"}}>⚠ Ticker not found on NSE — check spelling</div>
            )}
          </div>
        )}

        {form.type==="IN_ETF"&&(
          <div style={{marginBottom:".85rem"}}>
            <label className="flbl">Search Indian ETF</label>
            <div style={{position:"relative"}}>
              <input className="fi"
                placeholder="Type ETF name e.g. Nifty BeES, Gold, Midcap…"
                value={etfSearch}
                onChange={e=>{
                  handleEtfSearch(e.target.value);
                  setForm(f=>({...f, name:e.target.value, ticker:""}));
                  setEtfInfo(null);
                }}
                autoComplete="off"
              />
              {etfSearching&&<div style={{position:"absolute",right:".7rem",top:"50%",transform:"translateY(-50%)",fontSize:".7rem",color:"rgba(232,224,208,.4)"}}>Searching…</div>}
            </div>
            {/* Dropdown results */}
            {etfResults.length>0&&(
              <div style={{background:"#0c1526",border:"1px solid rgba(240,160,80,.2)",borderRadius:"0 0 8px 8px",maxHeight:220,overflowY:"auto",marginTop:"-1px"}}>
                {etfResults.map(e=>(
                  <div key={e.ticker}
                    onClick={()=>selectEtf(e)}
                    style={{padding:".6rem .85rem",cursor:"pointer",borderBottom:"1px solid rgba(255,255,255,.05)",fontSize:".8rem",lineHeight:1.4}}
                    onMouseEnter={x=>x.currentTarget.style.background="rgba(240,160,80,.08)"}
                    onMouseLeave={x=>x.currentTarget.style.background="transparent"}>
                    <div style={{color:"#e8e0d0",marginBottom:".15rem"}}>{e.name}</div>
                    <div style={{fontSize:".67rem",color:"rgba(232,224,208,.35)",fontFamily:"'DM Mono',monospace"}}>{e.ticker} · {e.exchange}</div>
                  </div>
                ))}
              </div>
            )}
            {/* No results message */}
            {!etfSearching&&etfSearch.length>=2&&etfResults.length===0&&(
              <div style={{marginTop:".5rem",fontSize:".72rem",color:"rgba(232,224,208,.35)"}}>
                No ETFs found — try a shorter search term or enter ticker directly below
              </div>
            )}
            {/* Selected ETF info card */}
            {form.ticker&&etfInfo&&etfInfo.found&&(
              <div style={{marginTop:".6rem",padding:".7rem .9rem",background:"rgba(240,160,80,.07)",border:"1px solid rgba(240,160,80,.25)",borderRadius:7,fontSize:".75rem",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{color:"#f0a050",fontWeight:500}}>{etfInfo.name||form.name}</div>
                  <div style={{color:"rgba(232,224,208,.38)",fontSize:".67rem"}}>{etfInfo.exchange} · {form.ticker}.NS · ETF</div>
                </div>
                {etfInfo.price&&<div style={{textAlign:"right"}}><div style={{fontFamily:"'DM Mono',monospace",color:"#c9a84c",fontSize:".9rem"}}>₹{etfInfo.price.toLocaleString("en-IN",{maximumFractionDigits:2})}</div><div style={{fontSize:".65rem",color:"rgba(232,224,208,.35)"}}>Current price</div></div>}
              </div>
            )}
            {/* Manual ticker fallback */}
            {!form.ticker&&(
              <div style={{marginTop:".5rem",display:"flex",alignItems:"center",gap:".5rem",fontSize:".7rem",color:"rgba(232,224,208,.3)"}}>
                Or enter ticker directly:
                <input className="fi" style={{width:140,padding:".3rem .6rem",fontSize:".72rem",display:"inline"}}
                  placeholder="e.g. NIFTYBEES"
                  onChange={e=>{setForm(f=>({...f,ticker:e.target.value.toUpperCase()}));}}/>
              </div>
            )}
          </div>
        )}
        {form.type==="US_STOCK"&&(
          <div style={{marginBottom:".85rem"}}>
            <div className="frow">
              <div>
                <label className="flbl">US Ticker</label>
                <div style={{position:"relative"}}>
                  <input className="fi" placeholder="e.g. AAPL, NVDA, MSFT"
                    value={form.ticker||""}
                    onChange={e=>handleTickerChange(e.target.value,"US")}
                  />
                  {stockLooking&&<div style={{position:"absolute",right:".7rem",top:"50%",transform:"translateY(-50%)",fontSize:".7rem",color:"rgba(232,224,208,.4)"}}>Looking up…</div>}
                </div>
              </div>
              <div>
                <label className="flbl">USD/INR Rate</label>
                <div style={{position:"relative"}}>
                  <input type="number" className="fi" value={form.usd_inr_rate}
                    onChange={e=>setForm(f=>({...f,usd_inr_rate:e.target.value}))}/>
                  <button onClick={fetchUsdInr} disabled={usdInrLoading}
                    style={{position:"absolute",right:".4rem",top:"50%",transform:"translateY(-50%)",background:"rgba(201,168,76,.15)",border:"1px solid rgba(201,168,76,.3)",color:"#c9a84c",borderRadius:4,padding:"2px 7px",cursor:"pointer",fontSize:".62rem",fontFamily:"'DM Sans',sans-serif"}}>
                    {usdInrLoading?"…":"⟳ Live"}
                  </button>
                </div>
                <div style={{fontSize:".65rem",color:"rgba(232,224,208,.3)",marginTop:".2rem"}}>
                  1 USD = ₹{(+form.usd_inr_rate||83.2).toFixed(2)}
                </div>
              </div>
            </div>
            {stockInfo&&stockInfo.found&&(
              <div style={{marginTop:".5rem",padding:".6rem .85rem",background:"rgba(90,156,224,.07)",border:"1px solid rgba(90,156,224,.22)",borderRadius:7,fontSize:".75rem",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{color:"#5a9ce0",fontWeight:500}}>{stockInfo.name}</div>
                  <div style={{color:"rgba(232,224,208,.38)",fontSize:".67rem"}}>{stockInfo.exchange} · {stockInfo.currency}</div>
                </div>
                {stockInfo.price&&(
                  <div style={{textAlign:"right"}}>
                    <div style={{fontFamily:"'DM Mono',monospace",color:"#c9a84c",fontSize:".9rem"}}>${stockInfo.price.toLocaleString("en-US",{maximumFractionDigits:2})}</div>
                    <div style={{fontFamily:"'DM Mono',monospace",color:"rgba(232,224,208,.45)",fontSize:".72rem"}}>₹{(stockInfo.price*(+form.usd_inr_rate||83.2)).toLocaleString("en-IN",{maximumFractionDigits:0})}</div>
                  </div>
                )}
              </div>
            )}
            {stockInfo&&!stockInfo.found&&form.ticker&&!stockLooking&&(
              <div style={{marginTop:".5rem",fontSize:".72rem",color:"rgba(224,124,90,.6)"}}>⚠ Ticker not found — check spelling</div>
            )}
          </div>
        )}
        {form.type==="MF"&&(
          <div style={{marginBottom:".85rem"}}>
            <label className="flbl">Search Mutual Fund</label>
            <div style={{position:"relative"}}>
              <input
                className="fi"
                placeholder="Type fund name e.g. Mirae Asset Large Cap..."
                value={mfSearch}
                onChange={e=>{
                  handleMfSearch(e.target.value);
                  setForm(f=>({...f,name:e.target.value,scheme_code:""}));
                  setMfNav(null);
                }}
                autoComplete="off"
              />
              {mfSearching&&<div style={{position:"absolute",right:".7rem",top:"50%",transform:"translateY(-50%)",fontSize:".7rem",color:"rgba(232,224,208,.4)"}}>Searching…</div>}
            </div>
            {/* Search results dropdown */}
            {mfResults.length>0&&(
              <div style={{background:"#0c1526",border:"1px solid rgba(201,168,76,.2)",borderRadius:"0 0 8px 8px",maxHeight:220,overflowY:"auto",marginTop:"-1px"}}>
                {mfResults.map(f=>(
                  <div key={f.scheme_code}
                    onClick={()=>selectMfFund(f)}
                    style={{padding:".6rem .85rem",cursor:"pointer",borderBottom:"1px solid rgba(255,255,255,.05)",fontSize:".8rem",color:"rgba(232,224,208,.75)",lineHeight:1.4}}
                    onMouseEnter={e=>e.currentTarget.style.background="rgba(201,168,76,.08)"}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div style={{color:"#e8e0d0",marginBottom:".15rem"}}>{f.name}</div>
                    <div style={{fontSize:".67rem",color:"rgba(232,224,208,.35)",fontFamily:"'DM Mono',monospace"}}>Code: {f.scheme_code}</div>
                  </div>
                ))}
              </div>
            )}
            {/* Selected fund info card */}
            {form.scheme_code&&mfNav&&(
              <div style={{marginTop:".6rem",padding:".7rem .9rem",background:"rgba(160,132,202,.08)",border:"1px solid rgba(160,132,202,.25)",borderRadius:7,fontSize:".75rem"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:".35rem"}}>
                  <div>
                    <div style={{color:"#a084ca",fontWeight:500,marginBottom:".2rem"}}>{form.name}</div>
                    <div style={{color:"rgba(232,224,208,.4)",fontSize:".68rem"}}>{mfNav.fund_house}</div>
                    {mfNav.scheme_category&&<div style={{color:"rgba(232,224,208,.35)",fontSize:".65rem"}}>{mfNav.scheme_category}</div>}
                  </div>
                  <div style={{textAlign:"right",flexShrink:0,marginLeft:"1rem"}}>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:"1rem",color:"#c9a84c"}}>₹{mfNav.nav?.toFixed(4)}</div>
                    <div style={{fontSize:".65rem",color:"rgba(232,224,208,.35)"}}>Current NAV · {mfNav.date}</div>
                    <div style={{fontSize:".65rem",fontFamily:"'DM Mono',monospace",color:"rgba(232,224,208,.3)",marginTop:".15rem"}}>Code: {form.scheme_code}</div>
                  </div>
                </div>
                <div style={{fontSize:".68rem",color:"#4caf9a"}}>✓ Live NAV will be fetched automatically on refresh</div>
              </div>
            )}
            {/* Manual scheme code fallback */}
            {!form.scheme_code&&!mfSearching&&mfSearch.length===0&&(
              <div style={{marginTop:".5rem",fontSize:".7rem",color:"rgba(232,224,208,.28)"}}>
                Or enter scheme code directly:&nbsp;
                <input className="fi" style={{display:"inline",width:"auto",padding:".3rem .6rem",fontSize:".72rem"}}
                  placeholder="e.g. 119551"
                  onChange={e=>setForm(f=>({...f,scheme_code:e.target.value}))}/>
              </div>
            )}
          </div>
        )}
        {form.type==="FD"&&<div className="frow"><FG label="Principal ₹"><input type="number" className="fi" value={form.principal||""} onChange={e=>setForm(f=>({...f,principal:e.target.value}))}/></FG><FG label="Rate % p.a."><input type="number" className="fi" value={form.interest_rate||""} onChange={e=>setForm(f=>({...f,interest_rate:e.target.value}))}/></FG><FG label="Maturity Date"><input type="date" className="fi" value={form.maturity_date||""} onChange={e=>setForm(f=>({...f,maturity_date:e.target.value}))}/></FG></div>}
        {(form.type==="PPF"||form.type==="EPF")&&<FG label={`Current Corpus ₹ (auto-grows at ${form.type==="PPF"?PPF_R:EPF_R}% p.a.)`}><input type="number" className="fi" value={form.principal||""} onChange={e=>setForm(f=>({...f,principal:e.target.value}))}/></FG>}
        {form.type==="REAL_ESTATE"&&<div className="frow"><FG label="Purchase Value ₹"><input type="number" className="fi" value={form.purchase_value||""} onChange={e=>setForm(f=>({...f,purchase_value:e.target.value}))}/></FG><FG label="Current Value ₹"><input type="number" className="fi" value={form.current_value||""} onChange={e=>setForm(f=>({...f,current_value:e.target.value}))}/></FG></div>}
        <FG label="Start Date"><input type="date" className="fi" value={form.start_date||""} onChange={e=>setForm(f=>({...f,start_date:e.target.value}))}/></FG>
        {["IN_STOCK","IN_ETF","US_STOCK","MF"].includes(form.type)&&!editHolding&&(
          <div style={{fontSize:".72rem",color:"#4caf9a",padding:".55rem .8rem",background:"rgba(76,175,154,.07)",border:"1px solid rgba(76,175,154,.2)",borderRadius:6,marginTop:".25rem"}}>
            ✓ After saving, "+ Transaction" will open automatically to record your first buy.
          </div>
        )}
        <MA><button className="btnc" onClick={()=>{setModal(null);setEditHolding(null);setForm(BF);setMfSearch("");setMfResults([]);setMfNav(null);setStockInfo(null);setEtfSearch("");setEtfResults([]);setEtfInfo(null);}}>Cancel</button><button className="btns" onClick={saveHolding} disabled={!form.name||!form.member_id}>{editHolding?"Save Changes":"Add Holding"}</button></MA>
      </Overlay>
    )}

    {/* Global Add Transaction modal */}
    {globalTxnModal&&(()=>{
      const selHolding = holdings.find(h=>h.id===txnForm.holding_id);
      const isUS = selHolding?.type==="US_STOCK";
      const fxRate = +(selHolding?.usd_inr_rate||usdInrRate||83.2);
      const priceUsd = isUS ? +txnForm.price_usd||0 : 0;
      const totalUsd = isUS ? priceUsd * +txnForm.units : 0;
      const totalInr = isUS ? totalUsd * fxRate : +txnForm.price * +txnForm.units;
      // Filter holdings by selected member + type
      const filteredHoldings = holdings
        .filter(h=>["IN_STOCK","IN_ETF","US_STOCK","MF"].includes(h.type))
        .filter(h=>txnFilterMember==="all"||h.member_id===txnFilterMember)
        .filter(h=>txnFilterType==="ALL"||h.type===txnFilterType);
      return (
      <Overlay onClose={()=>setGlobalTxnModal(false)}>
        <div className="modtitle">Add Transaction</div>

        {/* Filter row */}
        <div style={{display:"flex",gap:".6rem",marginBottom:"1rem",padding:".75rem",background:"rgba(255,255,255,.02)",border:"1px solid rgba(255,255,255,.06)",borderRadius:8}}>
          <div style={{flex:1}}>
            <div style={{fontSize:".63rem",letterSpacing:".08em",textTransform:"uppercase",color:"rgba(232,224,208,.35)",marginBottom:".35rem"}}>Member</div>
            <select className="fi fs" style={{marginBottom:0}} value={txnFilterMember} onChange={e=>{setTxnFilterMember(e.target.value);setTxnForm(p=>({...p,holding_id:"",price:"",price_usd:""}));}}>
              <option value="all">All Members</option>
              {members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:".63rem",letterSpacing:".08em",textTransform:"uppercase",color:"rgba(232,224,208,.35)",marginBottom:".35rem"}}>Asset Type</div>
            <select className="fi fs" style={{marginBottom:0}} value={txnFilterType} onChange={e=>{setTxnFilterType(e.target.value);setTxnForm(p=>({...p,holding_id:"",price:"",price_usd:""}));}}>
              <option value="ALL">All Types</option>
              {["IN_STOCK","IN_ETF","MF","US_STOCK"].map(t=><option key={t} value={t}>{AT[t].icon} {AT[t].label}</option>)}
            </select>
          </div>
        </div>

        <FG label={`Holding ${filteredHoldings.length>0?`(${filteredHoldings.length} shown)`:""}`}>
          <select className="fi fs" value={txnForm.holding_id} onChange={e=>{
            const h=holdings.find(x=>x.id===e.target.value);
            setTxnForm(p=>({...p,holding_id:e.target.value,price:"",price_usd:""}));
            if(h?.type==="US_STOCK") fetchUsdInr();
          }}>
            <option value="">Select holding…</option>
            {filteredHoldings.map(h=>{
              const mn=members.find(m=>m.id===h.member_id)?.name||"";
              const a=AT[h.type];
              return <option key={h.id} value={h.id}>{a.icon} {h.name}{mn?` · ${mn}`:""}</option>;
            })}
          </select>
        </FG>
        <div className="frow">
          <FG label="Type">
            <select className="fi fs" value={txnForm.txn_type} onChange={e=>setTxnForm(p=>({...p,txn_type:e.target.value}))}>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </FG>
          <FG label="Units"><input type="number" className="fi" placeholder="e.g. 50" value={txnForm.units} onChange={e=>setTxnForm(p=>({...p,units:e.target.value}))}/></FG>
          {isUS ? (
            <FG label="Price $ per unit (USD)">
              <input type="number" className="fi" placeholder="e.g. 189.50" value={txnForm.price_usd||""} onChange={e=>{
                const usd = e.target.value;
                const inr = usd ? (+usd * fxRate).toFixed(2) : "";
                setTxnForm(p=>({...p, price_usd: usd, price: inr}));
              }}/>
            </FG>
          ) : (
            <FG label={selHolding?.type==="MF"?"NAV ₹ per unit":"Price ₹ per unit"}>
              <input type="number" className="fi" placeholder="e.g. 2450" value={txnForm.price} onChange={e=>setTxnForm(p=>({...p,price:e.target.value}))}/>
            </FG>
          )}
        </div>
        {/* USD/INR info row for US stocks */}
        {isUS&&(
          <div style={{display:"flex",alignItems:"center",gap:".75rem",marginBottom:".85rem",padding:".6rem .85rem",background:"rgba(90,156,224,.06)",border:"1px solid rgba(90,156,224,.2)",borderRadius:7}}>
            <div style={{flex:1}}>
              <div style={{fontSize:".68rem",color:"rgba(232,224,208,.38)",marginBottom:".25rem"}}>Exchange Rate</div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:".85rem",color:"#5a9ce0"}}>1 USD = ₹{fxRate.toFixed(2)}</div>
            </div>
            {txnForm.price_usd&&(
              <div style={{flex:1}}>
                <div style={{fontSize:".68rem",color:"rgba(232,224,208,.38)",marginBottom:".25rem"}}>Price in INR</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:".85rem",color:"#c9a84c"}}>₹{(+txnForm.price_usd*fxRate).toLocaleString("en-IN",{maximumFractionDigits:2})}</div>
              </div>
            )}
            <button onClick={fetchUsdInr} disabled={usdInrLoading}
              style={{background:"rgba(90,156,224,.15)",border:"1px solid rgba(90,156,224,.3)",color:"#5a9ce0",borderRadius:4,padding:".3rem .7rem",cursor:"pointer",fontSize:".68rem",fontFamily:"'DM Sans',sans-serif",flexShrink:0}}>
              {usdInrLoading?"…":"⟳ Refresh Rate"}
            </button>
          </div>
        )}
        <div className="frow">
          <FG label="Date"><input type="date" className="fi" value={txnForm.txn_date} onChange={e=>setTxnForm(p=>({...p,txn_date:e.target.value}))}/></FG>
          <FG label="Notes (optional)"><input className="fi" placeholder="e.g. SIP, bonus, tax harvesting" value={txnForm.notes} onChange={e=>setTxnForm(p=>({...p,notes:e.target.value}))}/></FG>
        </div>
        {/* Total value summary */}
        {txnForm.holding_id&&txnForm.units&&txnForm.price&&(
          <div style={{padding:".65rem .9rem",background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.07)",borderRadius:7,marginBottom:".5rem",display:"flex",gap:"1.5rem",flexWrap:"wrap"}}>
            {isUS&&totalUsd>0&&(
              <div>
                <div style={{fontSize:".62rem",letterSpacing:".08em",textTransform:"uppercase",color:"rgba(232,224,208,.3)",marginBottom:".2rem"}}>Total (USD)</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:".9rem",color:"#5a9ce0"}}>${totalUsd.toLocaleString("en-US",{maximumFractionDigits:2})}</div>
              </div>
            )}
            <div>
              <div style={{fontSize:".62rem",letterSpacing:".08em",textTransform:"uppercase",color:"rgba(232,224,208,.3)",marginBottom:".2rem"}}>Total (INR)</div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:".9rem",color:"#c9a84c"}}>₹{totalInr.toLocaleString("en-IN",{maximumFractionDigits:0})}</div>
            </div>
            {isUS&&(
              <div>
                <div style={{fontSize:".62rem",letterSpacing:".08em",textTransform:"uppercase",color:"rgba(232,224,208,.3)",marginBottom:".2rem"}}>Rate used</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:".85rem",color:"rgba(232,224,208,.45)"}}>₹{fxRate.toFixed(2)}</div>
              </div>
            )}
          </div>
        )}
        <MA>
          <button className="btnc" onClick={()=>setGlobalTxnModal(false)}>Cancel</button>
          <button className="btns" onClick={addTransaction} disabled={!txnForm.holding_id||!txnForm.units||!txnForm.price||!txnForm.txn_date}>Save Transaction</button>
        </MA>
      </Overlay>
      );
    })()}

    {/* Inline transaction history panel (opened from 📋 button on holding row) */}
    {txnHolding&&<TransactionPanel holding={txnHolding} txnForm={txnForm} setTxnForm={setTxnForm} onAddTxn={addTransaction} onReload={reloadHoldings} onDeleteTxn={deleteTransaction} onClose={()=>setTxnHolding(null)} onFetchFx={fetchUsdInr} fxRate={usdInrRate} fxLoading={usdInrLoading}/>}
    {modal==="member"&&(<Overlay onClose={()=>setModal(null)} narrow><div className="modtitle">Add Family Member</div><FG label="Full Name"><input className="fi" value={newMember.name} onChange={e=>setNewMember(p=>({...p,name:e.target.value}))}/></FG><FG label="Relation"><select className="fi fs" value={newMember.relation} onChange={e=>setNewMember(p=>({...p,relation:e.target.value}))}><option value="">Select</option>{["Self","Spouse","Son","Daughter","Father","Mother","Sibling"].map(r=><option key={r} value={r}>{r}</option>)}</select></FG><MA><button className="btnc" onClick={()=>setModal(null)}>Cancel</button><button className="btns" onClick={addMember}>Add</button></MA></Overlay>)}
    {modal==="goal"&&(<Overlay onClose={()=>setModal(null)}><div className="modtitle">Add Financial Goal</div><FG label="Goal Name"><input className="fi" value={goalForm.name} onChange={e=>setGoalForm(p=>({...p,name:e.target.value}))}/></FG><div className="frow"><FG label="Target Amount ₹"><input type="number" className="fi" value={goalForm.targetAmount} onChange={e=>setGoalForm(p=>({...p,targetAmount:e.target.value}))}/></FG><FG label="Target Date"><input type="date" className="fi" value={goalForm.targetDate} onChange={e=>setGoalForm(p=>({...p,targetDate:e.target.value}))}/></FG></div><div className="frow"><FG label="Category"><select className="fi fs" value={goalForm.category} onChange={e=>setGoalForm(p=>({...p,category:e.target.value}))}>{["Retirement","Education","Real Estate","Emergency Fund","Wedding","Travel","Business"].map(c=><option key={c} value={c}>{c}</option>)}</select></FG><FG label="Colour"><input type="color" className="fi" value={goalForm.color} onChange={e=>setGoalForm(p=>({...p,color:e.target.value}))} style={{height:40,padding:"4px 8px",cursor:"pointer"}}/></FG></div><FG label="Notes"><input className="fi" value={goalForm.notes} onChange={e=>setGoalForm(p=>({...p,notes:e.target.value}))}/></FG><MA><button className="btnc" onClick={()=>setModal(null)}>Cancel</button><button className="btns" onClick={addGoal} disabled={!goalForm.name||!goalForm.targetAmount}>Add Goal</button></MA></Overlay>)}
    {modal==="alert"&&(<Overlay onClose={()=>setModal(null)} narrow><div className="modtitle">New Alert Rule</div><FG label="Alert Type"><select className="fi fs" value={alertForm.type} onChange={e=>setAlertForm(p=>({...p,type:e.target.value}))}><option value="ALLOCATION_DRIFT">Over-weight</option><option value="CONCENTRATION">Under-weight</option><option value="RETURN_TARGET">Return below target</option></select></FG>{alertForm.type!=="RETURN_TARGET"&&<FG label="Asset Class"><select className="fi fs" value={alertForm.assetType} onChange={e=>setAlertForm(p=>({...p,assetType:e.target.value}))}>{Object.entries(AT).map(([k,v])=><option key={k} value={k}>{v.icon} {v.label}</option>)}</select></FG>}<FG label={alertForm.type==="RETURN_TARGET"?"Target Return %":"Threshold %"}><input type="number" className="fi" value={alertForm.threshold} onChange={e=>setAlertForm(p=>({...p,threshold:e.target.value}))}/></FG><FG label="Description"><input className="fi" value={alertForm.label} onChange={e=>setAlertForm(p=>({...p,label:e.target.value}))}/></FG><MA><button className="btnc" onClick={()=>setModal(null)}>Cancel</button><button className="btns" onClick={addAlert} disabled={!alertForm.threshold||!alertForm.label}>Add Alert</button></MA></Overlay>)}
    {modal==="csv"&&(<Overlay onClose={()=>setModal(null)} wide><div className="modtitle">Preview — {csvPreview.length} Holdings</div><div style={{overflowX:"auto",maxHeight:300,overflowY:"auto"}}><table className="ht" style={{fontSize:".73rem"}}><thead><tr><th>Name</th><th>Type</th><th>Ticker/Code</th><th>Member</th><th className="r">Invested</th></tr></thead><tbody>{csvPreview.map((h,i)=>{const inv=getInv(h);return<tr key={i}><td>{h.name}</td><td><span className="tbadge2" style={{background:AT[h.type]?.color+"22",color:AT[h.type]?.color}}>{AT[h.type]?.icon} {AT[h.type]?.label||h.type}</span></td><td className="mono dim">{h.ticker||h.scheme_code||"—"}</td><td className="dim">{members.find(m=>m.id===h.member_id)?.name||"—"}</td><td className="r mono dim">{fmt(inv)}</td></tr>;})}</tbody></table></div><MA><button className="btnc" onClick={()=>setModal(null)}>Cancel</button><button className="btns" onClick={importCSV}>Import All</button></MA></Overlay>)}
    {modal==="pdf"&&(<Overlay onClose={()=>setModal(null)}><div className="modtitle">Portfolio Report</div>{pdfState.loading?(<div style={{textAlign:"center",padding:"2.5rem 0"}}><div style={{width:34,height:34,border:"2px solid rgba(201,168,76,.2)",borderTopColor:"#c9a84c",borderRadius:"50%",animation:"spin 1s linear infinite",margin:"0 auto 1rem"}}/><div style={{fontSize:".8rem",color:"rgba(232,224,208,.38)"}}>Generating AI commentary…</div><style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style></div>):(<><div style={{fontSize:".68rem",letterSpacing:".1em",textTransform:"uppercase",color:"#c9a84c",marginBottom:".7rem"}}>AI Advisor Commentary</div><div style={{background:"rgba(201,168,76,.05)",border:"1px solid rgba(201,168,76,.14)",borderRadius:8,padding:"1rem 1.2rem",fontSize:".8rem",lineHeight:1.72,color:"rgba(232,224,208,.7)",maxHeight:260,overflowY:"auto",whiteSpace:"pre-wrap"}}>{pdfState.summary}</div></>)}<MA><button className="btnc" onClick={()=>setModal(null)}>Close</button></MA></Overlay>)}
    </>
  );
}

function DonutChart({data,total}){
  const S=180,cx=90,cy=90,r=72,ir=44;let angle=-90;
  const slices=data.map(d=>{const sweep=(d.v/total)*360,startA=angle;angle+=sweep;return{...d,startA,endA:angle};});
  const pt=(a,rad)=>({x:cx+rad*Math.cos(a*Math.PI/180),y:cy+rad*Math.sin(a*Math.PI/180)});
  const arc=(sa,ea,or,ir2)=>{if(Math.abs(ea-sa)>=359.99)ea=sa+359.99;const s=pt(sa,or),e=pt(ea,or),si=pt(sa,ir2),ei=pt(ea,ir2),l=ea-sa>180?1:0;return`M${s.x},${s.y}A${or},${or},0,${l},1,${e.x},${e.y}L${ei.x},${ei.y}A${ir2},${ir2},0,${l},0,${si.x},${si.y}Z`;};
  const fmtV=v=>v>=1e7?`₹${(v/1e7).toFixed(2)}Cr`:v>=1e5?`₹${(v/1e5).toFixed(2)}L`:`₹${Math.round(v).toLocaleString("en-IN")}`;
  return(
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:"2.5rem",flexWrap:"wrap",padding:".5rem 0"}}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
        {slices.map(s=><path key={s.t} d={arc(s.startA,s.endA,r,ir)} fill={AT[s.t].color} opacity={0.85}/>)}
        <text x={cx} y={cy-6} textAnchor="middle" fill="#e8e0d0" fontSize="11" fontFamily="DM Mono">{total>=1e7?(total/1e7).toFixed(1)+"Cr":total>=1e5?(total/1e5).toFixed(1)+"L":"₹"+Math.round(total)}</text>
        <text x={cx} y={cy+10} textAnchor="middle" fill="rgba(232,224,208,.33)" fontSize="8.5" fontFamily="DM Sans">TOTAL</text>
      </svg>
      <div style={{display:"flex",flexDirection:"column",gap:".6rem"}}>
        {slices.map(s=>(
          <div key={s.t} style={{display:"flex",alignItems:"center",gap:".55rem"}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:AT[s.t].color,flexShrink:0}}/>
            <span style={{color:"rgba(232,224,208,.55)",fontSize:".76rem",minWidth:94}}>{AT[s.t].label}</span>
            <span style={{fontFamily:"'DM Mono',monospace",fontSize:".73rem",color:"#e8e0d0",minWidth:72,textAlign:"right"}}>{fmtV(s.v)}</span>
            <span style={{fontFamily:"'DM Mono',monospace",fontSize:".7rem",color:"rgba(232,224,208,.4)",minWidth:40,textAlign:"right"}}>{s.pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
function Overlay({onClose,children,narrow,wide}){return<div className="ovl" onClick={e=>e.target===e.currentTarget&&onClose()}><div className="mod" style={{maxWidth:narrow?380:wide?700:540}}>{children}</div></div>;}
function FG({label,children}){return<div className="fg"><label className="flbl">{label}</label>{children}</div>;}
function MA({children}){return<div className="ma">{children}</div>;}

const CSS=`
*{box-sizing:border-box;margin:0;padding:0}body{background:#070d1a}
.app{min-height:100vh;background:#070d1a;background-image:radial-gradient(ellipse at 20% 10%,rgba(201,168,76,.06) 0%,transparent 50%),radial-gradient(ellipse at 80% 80%,rgba(90,156,224,.05) 0%,transparent 50%);font-family:'DM Sans',sans-serif;color:#e8e0d0}
.hdr{border-bottom:1px solid rgba(201,168,76,.14);padding:0 1.75rem;display:flex;align-items:center;justify-content:space-between;height:62px;background:rgba(7,13,26,.97);backdrop-filter:blur(12px);position:sticky;top:0;z-index:100;gap:.5rem}
.logo{font-family:'Cormorant Garamond',serif;font-size:1.45rem;font-weight:500;letter-spacing:.04em;color:#e8e0d0;flex-shrink:0}.logo span{color:#c9a84c}
.hdr-r{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.btn-o{background:none;border:1px solid rgba(201,168,76,.3);color:#c9a84c;padding:.3rem .7rem;border-radius:4px;cursor:pointer;font-size:.68rem;letter-spacing:.06em;transition:all .2s;white-space:nowrap;font-family:'DM Sans',sans-serif}.btn-o:hover{background:rgba(201,168,76,.1)}.btn-o:disabled{opacity:.45;cursor:not-allowed}
.btn-g{background:rgba(201,168,76,.11);border:1px solid rgba(201,168,76,.42);color:#c9a84c;padding:.32rem .78rem;border-radius:4px;cursor:pointer;font-size:.68rem;white-space:nowrap;transition:all .2s;font-family:'DM Sans',sans-serif}.btn-g:hover{background:rgba(201,168,76,.2)}
.btn-p{background:rgba(201,168,76,.17);border:1px solid rgba(201,168,76,.52);color:#c9a84c;padding:.34rem .9rem;border-radius:5px;cursor:pointer;font-size:.73rem;font-weight:500;white-space:nowrap;transition:all .2s;font-family:'DM Sans',sans-serif}.btn-p:hover{background:rgba(201,168,76,.27)}
.alert-pill{background:rgba(224,124,90,.14);border:1px solid rgba(224,124,90,.38);color:#e07c5a;padding:.28rem .65rem;border-radius:4px;font-size:.68rem;cursor:pointer;white-space:nowrap}
.main{max-width:1400px;margin:0 auto;padding:1.75rem 2rem}
.mbar{display:flex;align-items:center;gap:.6rem;margin-bottom:1.6rem;flex-wrap:wrap}
.mlbl{font-size:.67rem;letter-spacing:.1em;color:rgba(232,224,208,.32);text-transform:uppercase;margin-right:.18rem}
.mchip{padding:.35rem .85rem;border-radius:20px;cursor:pointer;font-size:.76rem;font-weight:500;border:1px solid transparent;transition:all .2s;background:rgba(255,255,255,.04);color:rgba(232,224,208,.52)}.mchip.act{background:rgba(201,168,76,.14);border-color:rgba(201,168,76,.48);color:#c9a84c}.mchip:hover:not(.act){background:rgba(255,255,255,.07);color:#e8e0d0}
.tabs{display:flex;margin-bottom:1.6rem;border-bottom:1px solid rgba(255,255,255,.07)}
.tab{padding:.62rem 1.35rem;cursor:pointer;font-size:.81rem;color:rgba(232,224,208,.38);border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .2s;white-space:nowrap;text-transform:capitalize}.tab.act{color:#c9a84c;border-bottom-color:#c9a84c}.tab:hover:not(.act){color:rgba(232,224,208,.68)}
.tbadge{display:inline-block;background:#e07c5a;color:#fff;border-radius:10px;padding:1px 6px;font-size:.58rem;margin-left:4px;vertical-align:middle}
.mg{display:grid;grid-template-columns:repeat(4,1fr);gap:.95rem;margin-bottom:1.6rem}@media(max-width:900px){.mg{grid-template-columns:repeat(2,1fr)}}
.mc{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:1.3rem;position:relative;overflow:hidden}.mc::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(201,168,76,.32),transparent)}
.mclbl{font-size:.66rem;letter-spacing:.12em;text-transform:uppercase;color:rgba(232,224,208,.36);margin-bottom:.45rem}.mcval{font-family:'Cormorant Garamond',serif;font-size:1.6rem;font-weight:500;line-height:1}.mcsub{font-size:.7rem;margin-top:.38rem}
.gain{color:#4caf9a}.loss{color:#e07c5a}
.sg{display:grid;grid-template-columns:1fr 1.4fr;gap:1.4rem;margin-bottom:1.4rem}@media(max-width:1000px){.sg{grid-template-columns:1fr}}
.card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:1.4rem}
.ctitle{font-family:'Cormorant Garamond',serif;font-size:1.08rem;color:#e8e0d0;margin-bottom:1.1rem}
.arow{display:flex;align-items:center;gap:.65rem;margin-bottom:.9rem}.aicon{font-size:.95rem;width:24px;text-align:center}.ainfo{flex:1}.aname{font-size:.78rem;color:rgba(232,224,208,.78)}.abg{height:3px;background:rgba(255,255,255,.07);border-radius:2px;margin-top:4px}.afill{height:100%;border-radius:2px;transition:width .8s ease}.argt{text-align:right;min-width:88px}.aval{font-size:.78rem;font-family:'DM Mono',monospace;color:#e8e0d0}.apct{font-size:.66rem}
.msrow{display:flex;align-items:center;gap:.7rem;padding:.75rem 0;border-bottom:1px solid rgba(255,255,255,.05)}.msrow:last-child{border-bottom:none}
.av{width:33px;height:33px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:600;flex-shrink:0;background:rgba(201,168,76,.14);color:#c9a84c;border:1px solid rgba(201,168,76,.28)}
.tbar{display:flex;gap:.55rem;margin-bottom:1.1rem;flex-wrap:wrap}
.fchip{padding:.3rem .78rem;border-radius:20px;cursor:pointer;font-size:.71rem;border:1px solid transparent;transition:all .2s;background:rgba(255,255,255,.04);color:rgba(232,224,208,.43)}.fchip.act{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.14);color:#e8e0d0}
.ht{width:100%;border-collapse:collapse}.ht th{font-size:.61rem;letter-spacing:.09em;text-transform:uppercase;color:rgba(232,224,208,.26);text-align:left;padding:0 .65rem .65rem;border-bottom:1px solid rgba(255,255,255,.06)}.ht th.r{text-align:right}.ht td{padding:.78rem .65rem;font-size:.79rem;border-bottom:1px solid rgba(255,255,255,.04)}.ht tr:hover td{background:rgba(255,255,255,.02)}
.hn{color:#e8e0d0;font-weight:500}.hm{font-size:.66rem;color:rgba(232,224,208,.3);margin-top:2px}
.tbadge2{padding:.16rem .48rem;border-radius:3px;font-size:.61rem;letter-spacing:.04em;font-weight:500;white-space:nowrap}
.mono{font-family:'DM Mono',monospace}.dim{color:rgba(232,224,208,.42)}.r{text-align:right}
.delbtn{background:none;border:none;cursor:pointer;color:rgba(224,124,90,.32);font-size:.76rem;padding:.2rem .42rem;transition:all .2s;border-radius:4px}.delbtn:hover{color:#e07c5a;background:rgba(224,124,90,.09)}
.btn-sm{background:none;border:1px dashed rgba(201,168,76,.28);color:rgba(201,168,76,.6);padding:.36rem .85rem;border-radius:6px;cursor:pointer;font-size:.73rem;transition:all .2s;font-family:'DM Sans',sans-serif}.btn-sm:hover{border-color:rgba(201,168,76,.55);color:#c9a84c}
.gbbg{height:4px;background:rgba(255,255,255,.07);border-radius:3px;overflow:hidden}.gbfill{height:100%;border-radius:3px;transition:width .8s ease}
.empty{text-align:center;padding:2.8rem;color:rgba(232,224,208,.2);font-family:'Cormorant Garamond',serif;font-size:1rem}
.ovl{position:fixed;inset:0;background:rgba(0,0,0,.78);backdrop-filter:blur(5px);z-index:200;display:flex;align-items:center;justify-content:center;padding:1rem}
.mod{background:#0c1526;border:1px solid rgba(201,168,76,.2);border-radius:15px;padding:1.85rem;width:100%;max-height:92vh;overflow-y:auto}
.modtitle{font-family:'Cormorant Garamond',serif;font-size:1.38rem;color:#e8e0d0;margin-bottom:1.3rem}
.frow{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.85rem;margin-bottom:.05rem}
.fg{display:flex;flex-direction:column;gap:.35rem;margin-bottom:.85rem}
.flbl{font-size:.65rem;letter-spacing:.08em;text-transform:uppercase;color:rgba(232,224,208,.36)}
.fi{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#e8e0d0;padding:.55rem .8rem;border-radius:6px;font-size:.81rem;font-family:'DM Sans',sans-serif;outline:none;transition:border-color .2s;width:100%}.fi:focus{border-color:rgba(201,168,76,.48)}
.fs{appearance:none;cursor:pointer}.fs option{background:#0c1526}
.ma{display:flex;gap:.65rem;justify-content:flex-end;margin-top:1.3rem}
.btnc{background:none;border:1px solid rgba(255,255,255,.1);color:rgba(232,224,208,.42);padding:.55rem 1.05rem;border-radius:6px;cursor:pointer;font-size:.79rem;transition:all .2s;font-family:'DM Sans',sans-serif}.btnc:hover{border-color:rgba(255,255,255,.2);color:#e8e0d0}
.btns{background:rgba(201,168,76,.14);border:1px solid rgba(201,168,76,.48);color:#c9a84c;padding:.55rem 1.25rem;border-radius:6px;cursor:pointer;font-size:.79rem;font-weight:500;transition:all .2s;font-family:'DM Sans',sans-serif}.btns:hover{background:rgba(201,168,76,.24)}.btns:disabled{opacity:.38;cursor:not-allowed}
.login-wrap{min-height:100vh;background:#070d1a;background-image:radial-gradient(ellipse at 30% 20%,rgba(201,168,76,.07) 0%,transparent 55%);display:flex;align-items:center;justify-content:center;padding:1rem}
.login-card{background:rgba(255,255,255,.03);border:1px solid rgba(201,168,76,.18);border-radius:16px;padding:2.5rem 2rem;width:100%;max-width:380px;text-align:center}
.google-btn{display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);color:#e8e0d0;padding:.75rem 1.5rem;border-radius:8px;cursor:pointer;font-size:.88rem;font-family:'DM Sans',sans-serif;font-weight:500;transition:all .2s;width:100%}.google-btn:hover{background:rgba(255,255,255,.12)}.google-btn:disabled{opacity:.45;cursor:not-allowed}
::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(201,168,76,.17);border-radius:3px}
`;
