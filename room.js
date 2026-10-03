/* ============================================================
   חדר צפייה לאליאס: מודול משותף ל־Alias ול־18Alias
   ------------------------------------------------------------
   הטלפון שמנהל את המשחק פותח חדר ומציג קוד ו־QR.
   כל מי שסורק רואה בזמן אמת: ניקוד, תור, מסביר ומנחש, טיימר
   ומילים שכבר נוחשו. המילה הנוכחית לעולם לא נשלחת לצופים.

   המשחק עצמו ממשיך לעבוד בלי אינטרנט. החדר הוא תוספת בלבד:
   ספריית Firebase נטענת רק כשפותחים חדר או נכנסים לצפייה.
   ============================================================ */
(function(){
"use strict";

/* ---- הגדרות Firebase: להדביק כאן את firebaseConfig מהקונסולה ----
   Project settings → General → Your apps → Web app → SDK setup (Config)
   כל עוד זה null, כפתור החדר לא מוצג והמשחק עובד בדיוק כמו קודם. */
const FIREBASE_CONFIG = null;

const FB_VER = "10.12.2";
const QR_LIB = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // בלי O/0, I/1, L
const CODE_LEN = 4;

const qs = new URLSearchParams(location.search);
const viewCode = (qs.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
// מצב פיתוח: מסנכרן בין לשוניות באותו דפדפן, בלי Firebase. נדלק עם ?roomdev
if(qs.has("roomdev")) try{ sessionStorage.setItem("alias-roomdev", "1"); }catch(e){}
const DEV = (() => { try{ return sessionStorage.getItem("alias-roomdev") === "1"; }catch(e){ return false; } })();

let G = null;        // מה שהמשחק מסר ב־attach
let net = null;      // חיבור פעיל (Firebase או מקומי)
let netP = null;
let room = null;     // {code, viewers}
let lastSent = "";
let panelOpen = false, panelMsg = "", qrSvg = "";

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const lsGet = k => { try{ return localStorage.getItem(k); }catch(e){ return null; } };
const lsSet = (k, v) => { try{ v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); }catch(e){} };
const enabled = () => !!FIREBASE_CONFIG || DEV;

/* ============================================================
   חיבורים: Firebase Realtime Database, או מקומי לבדיקות
   ============================================================ */
async function firebaseNet(){
  const base = `https://www.gstatic.com/firebasejs/${FB_VER}/`;
  const [A, D, U] = await Promise.all([
    import(base + "firebase-app.js"), import(base + "firebase-database.js"), import(base + "firebase-auth.js")]);
  const app = A.initializeApp(FIREBASE_CONFIG, "alias-room");
  const auth = U.getAuth(app);
  const uid = (await U.signInAnonymously(auth)).user.uid;
  const db = D.getDatabase(app);
  const R = (g, c, p) => D.ref(db, `rooms/${g}/${c}` + (p ? "/" + p : ""));
  const subs = [];
  const watch = (r, fn) => subs.push(D.onValue(r, s => fn(s.val())));
  // סימון "מחובר" שמתאפס לבד כשהטלפון המארח מתנתק
  function keepOnline(g, c){
    watch(D.ref(db, ".info/connected"), on => {
      if(!on) return;
      D.onDisconnect(R(g, c, "online")).set(false);
      D.set(R(g, c, "online"), true).catch(() => {});
    });
  }
  return {
    async claim(g, c){
      const owner = (await D.get(R(g, c, "host"))).val();
      if(owner && owner !== uid) return false;
      if(!owner){
        try{ await D.set(R(g, c, "host"), uid); }catch(e){ return false; }
        await D.set(R(g, c, "created"), D.serverTimestamp());
      }
      keepOnline(g, c);
      return true;
    },
    publish(g, c, state){ return D.set(R(g, c, "state"), state); },
    async close(g, c){ subs.splice(0).forEach(u => u()); await D.remove(R(g, c)); },
    viewers(g, c, fn){ watch(R(g, c, "viewers"), v => fn(v ? Object.keys(v).length : 0)); },
    join(g, c, fn){
      const me = R(g, c, "viewers/" + uid);
      watch(D.ref(db, ".info/connected"), on => {
        if(!on) return;
        D.onDisconnect(me).remove();
        D.set(me, true).catch(() => {});
      });
      watch(R(g, c, "host"), h => { host = h; fn("host", h); });
      watch(R(g, c, "online"), v => fn("online", v));
      watch(R(g, c, "state"), v => fn("state", v));
    }
  };
}

function localNet(){
  // לשוניות באותו דפדפן מדברות דרך localStorage. לבדיקות בלבד.
  const K = (g, c) => `alias-roomdev:${g}:${c}`;
  const read = (g, c) => { try{ return JSON.parse(lsGet(K(g, c))) || null; }catch(e){ return null; } };
  return {
    async claim(g, c){ const r = read(g, c); if(!r) lsSet(K(g, c), JSON.stringify({host:"me", online:true})); return true; },
    async publish(g, c, state){ const r = read(g, c) || {host:"me"}; r.state = state; r.online = true; lsSet(K(g, c), JSON.stringify(r)); },
    async close(g, c){ lsSet(K(g, c), null); },
    viewers(){},
    join(g, c, fn){
      const push = () => { const r = read(g, c); fn("host", r ? r.host : null); fn("online", r ? r.online : null); fn("state", r ? r.state : null); };
      window.addEventListener("storage", e => { if(e.key === K(g, c)) push(); });
      push();
    }
  };
}

function getNet(){
  if(!netP) netP = (FIREBASE_CONFIG ? firebaseNet() : Promise.resolve(localNet()))
    .then(n => (net = n))
    .catch(e => { netP = null; throw e; });
  return netP;
}

/* ============================================================
   צד המארח
   ============================================================ */
const roomKey = () => G.key + "-room";
const viewUrl = code => location.origin + location.pathname + "?room=" + code + (FIREBASE_CONFIG ? "" : "&roomdev");
const newCode = () => Array.from({length: CODE_LEN}, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");

// תמונת מצב של המשחק בשביל הצופים. בלי המילה הנוכחית!
function snapshot(){
  const {S, T} = G.get();
  const set = S.settings, cur = S.pairs[S.turn];
  const out = {
    v: 1, screen: S.screen, round: S.round, turn: S.turn, target: set.target,
    winner: S.winner == null ? -1 : S.winner,
    pairs: S.pairs.map((p, i) => ({n: G.pairName(p, i), a: G.playerName(p, 0), b: G.playerName(p, 1), s: p.score, k: G.isKidPair(p) ? 1 : 0}))
  };
  if(cur){
    out.ex = G.playerName(cur, cur.next);
    out.gu = G.playerName(cur, 1 - cur.next);
    out.deck = G.isKidPair(cur) ? "🧸 כרטיסי תמונות" : "📝 רמה: " + (G.levelNames[set.difficulty] || "");
  }
  if(T && ["turn", "lastword", "summary"].includes(S.screen)){
    out.t = {
      secs: Math.max(0, Math.ceil(T.left / 1000)), total: Math.round(T.total / 1000), paused: T.paused ? 1 : 0,
      words: T.words.map(w => ({w: w.w, e: w.e || "", ok: w.ok ? 1 : 0}))
    };
    if(S.screen === "summary"){
      out.t.pts = G.turnPoints();
      if(T.lastPair != null && T.lastPair >= 0) out.t.lw = {w: T.card.w, e: T.card.e || "", p: T.lastPair};
    }
  }
  return out;
}

function publish(){
  if(!room || !net || !G) return;
  let snap;
  try{ snap = JSON.stringify(snapshot()); }catch(e){ return; }
  if(snap === lastSent) return;
  lastSent = snap;
  net.publish(G.game, room.code, JSON.parse(snap)).catch(() => { lastSent = ""; });
}

async function startRoom(code){
  const n = await getNet();
  for(let tries = 0; tries < 6; tries++){
    const c = code || newCode();
    if(await n.claim(G.game, c)){
      room = {code: c, viewers: 0};
      lsSet(roomKey(), c);
      n.viewers(G.game, c, k => { if(room && room.code === c){ room.viewers = k; refreshUI(); } });
      lastSent = ""; publish(); refreshUI();
      return;
    }
    if(code){ lsSet(roomKey(), null); return; } // החדר השמור כבר לא שלנו
  }
  throw new Error("no-code");
}

async function endRoom(){
  if(!room) return;
  const c = room.code;
  room = null; lsSet(roomKey(), null); qrSvg = "";
  try{ await net.close(G.game, c); }catch(e){}
  closePanel(); refreshUI();
}

/* ---------- QR ---------- */
function loadScript(src){
  return new Promise((ok, bad) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
}
async function makeQR(text){
  if(!window.qrcode) await loadScript(QR_LIB);
  const q = window.qrcode(0, "M"); q.addData(text); q.make();
  return q.createSvgTag({cellSize: 6, margin: 2, scalable: true});
}

/* ---------- חלון החדר ---------- */
let $ov = null;
function closePanel(){ panelOpen = false; if($ov){ $ov.remove(); $ov = null; } }
function drawPanel(){
  if(!panelOpen) return;
  if(!$ov){
    $ov = document.createElement("div");
    $ov.className = "overlay room-ov";
    $ov.addEventListener("click", onPanelClick);
    document.body.appendChild($ov);
  }
  let body;
  if(room){
    const url = viewUrl(room.code);
    body = `<div class="room-qr">${qrSvg || `<span class="room-wait">טוען קוד…</span>`}</div>
      <div class="room-code" dir="ltr">${room.code}</div>
      <p class="room-sub">${room.viewers ? `👀 ${room.viewers} ${room.viewers === 1 ? "צופה מחובר/ת" : "צופים מחוברים"}` : "סורקים עם המצלמה, או נכנסים ללינק"}</p>
      <button class="btn" data-rp="share">${navigator.share ? "שיתוף הלינק" : "העתקת הלינק"}</button>
      <button class="btn plain" data-rp="close">חזרה למשחק</button>
      <button class="link room-end" data-rp="end">סגירת החדר</button>`;
    if(!qrSvg) makeQR(url).then(s => { qrSvg = s; drawPanel(); }).catch(() => { qrSvg = `<span class="room-wait">לא הצלחנו להציג QR, אפשר לשתף את הלינק</span>`; drawPanel(); });
  } else {
    body = `<p class="room-sub">${panelMsg || "פותחים חדר…"}</p>
      ${panelMsg ? `<button class="btn" data-rp="retry">נסו שוב</button>` : ""}
      <button class="btn plain" data-rp="close">חזרה למשחק</button>`;
  }
  $ov.innerHTML = `<div class="box">
    <h2 class="display">📡 חדר צפייה</h2>
    <p class="room-lead">כל מי שנכנס רואה את הניקוד, התור והטיימר בזמן אמת. המילה עצמה נשארת רק אצלכם.</p>
    ${body}</div>`;
}
async function openPanel(){
  panelOpen = true; panelMsg = ""; drawPanel();
  if(room) return;
  try{ await startRoom(); }
  catch(e){ panelMsg = navigator.onLine === false ? "צריך חיבור לאינטרנט כדי לפתוח חדר" : "לא הצלחנו לפתוח חדר כרגע"; }
  drawPanel();
}
async function onPanelClick(e){
  const b = e.target.closest("[data-rp]");
  if(!b){ if(e.target === $ov) closePanel(); return; }
  const a = b.dataset.rp;
  if(a === "close") closePanel();
  if(a === "retry") openPanel();
  if(a === "end" && confirm("לסגור את החדר? הצופים יתנתקו.")) endRoom();
  if(a === "share" && room){
    const url = viewUrl(room.code);
    if(navigator.share){ try{ await navigator.share({title: document.title, text: "צפייה במשחק בזמן אמת", url}); }catch(err){} }
    else { try{ await navigator.clipboard.writeText(url); b.textContent = "הועתק ✓"; }catch(err){ prompt("הלינק לחדר:", url); } }
  }
}

/* ---------- כפתור החדר בתוך המשחק ---------- */
function buttonHTML(){
  if(!enabled() || !G) return "";
  const label = room ? `📡 חדר <b dir="ltr">${room.code}</b>${room.viewers ? ` · 👀 ${room.viewers}` : ""}` : "📡 פתיחת חדר צפייה";
  return `<button class="room-btn ${room ? "on" : ""}" data-room="open">${label}</button>`;
}
function refreshUI(){
  document.querySelectorAll('[data-room="open"]').forEach(b => { b.outerHTML = buttonHTML(); });
  drawPanel();
}
document.addEventListener("click", e => { if(e.target.closest('[data-room="open"]')) openPanel(); });

/* ============================================================
   צד הצופה
   ============================================================ */
let V = {state: undefined, host: undefined, online: null};
function pairBoard(st, hi){
  return `<div class="board-title"><span>ניקוד</span><span>יעד: ${st.target}</span></div>
  <ol class="board">${(st.pairs || []).map((p, i) => `<li class="${i === hi ? "now" : ""}">
    <div class="who"><b>${esc(p.n)}</b><small>${esc(p.a)} ו${esc(p.b)}</small></div>
    <span class="pts">${p.s}</span></li>`).join("")}</ol>`;
}
function wordList(words){
  return words.length ? `<ul class="rv-words">${words.map(w => `<li class="${w.ok ? "" : "no"}"><span class="mark">${w.ok ? "✓" : "✕"}</span><span>${w.e ? w.e + " " : ""}${esc(w.w)}</span></li>`).join("")}</ul>` : "";
}
function viewerBody(st){
  const pairs = st.pairs || [], cur = pairs[st.turn] || {n: ""}, t = st.t;
  const words = t ? (t.words || []) : [];
  switch(st.screen){
    case "handoff": return `<div class="center">
      <div class="round">סבב ${st.round}</div>
      <h1 class="display turn-of">התור של ${esc(cur.n)}</h1>
      <div class="roles"><div class="role"><small>מסביר/ה</small><b>${esc(st.ex)}</b></div><div class="role"><small>מנחש/ת</small><b>${esc(st.gu)}</b></div></div>
      <div class="deck-tag">${esc(st.deck || "")}</div>
      <p class="room-sub">מתכוננים להתחיל את התור…</p>${pairBoard(st, st.turn)}</div>`;
    case "turn": {
      const ok = words.filter(w => w.ok).length, pct = t ? Math.max(0, t.secs / t.total * 100) : 0;
      const cls = !t ? "" : t.secs <= 5 ? "danger" : t.secs <= 15 ? "warn" : "";
      return `<div class="round" style="text-align:center">סבב ${st.round} · התור של ${esc(cur.n)}</div>
      <div class="turn-top"><span class="secs">${t ? t.secs : ""}</span><div class="timer ${cls}"><i style="width:${pct}%"></i></div></div>
      <div class="turn-meta"><span>${esc(st.ex)} מסביר/ה ל${esc(st.gu)}</span><span>✅ ${ok} &nbsp; ⏭ ${words.length - ok}</span></div>
      <div class="rv-hidden">${t && t.paused ? "⏸<b>התור מושהה</b>" : "🤫<b>המילה מוסתרת</b><small>רק המסביר/ה רואה אותה</small>"}</div>
      ${wordList(words.slice().reverse())}${pairBoard(st, st.turn)}`;
    }
    case "lastword": return `<div class="center">
      <h1 class="display turn-of">הזמן נגמר!</h1>
      <p style="margin:0 0 14px">המילה האחרונה פתוחה לכולם. מי ינחש ראשון?</p>
      ${wordList(words)}${pairBoard(st, st.turn)}</div>`;
    case "summary": return `<h2>סיכום התור של ${esc(cur.n)}</h2>
      ${words.length ? wordList(words) : `<p class="empty">לא נענו מילים בתור הזה</p>`}
      ${t && t.lw ? `<div class="lw-row">המילה האחרונה (${t.lw.e ? t.lw.e + " " : ""}${esc(t.lw.w)}): +1 ל${esc((pairs[t.lw.p] || {}).n)}</div>` : ""}
      ${t ? `<div class="total"><span>נקודות בתור:</span><b>${t.pts > 0 ? "+" : ""}${t.pts}</b></div>` : ""}
      ${pairBoard(st, st.turn)}`;
    case "winner": {
      const w = pairs[st.winner] || {n: "", s: 0};
      const sorted = pairs.map((x, k) => [x, k]).sort((a, b) => b[0].s - a[0].s);
      return `<div class="center"><div class="trophy" aria-hidden="true">🏆</div>
      <h1 class="display turn-of">${esc(w.n)} ניצחו!</h1>
      <p style="margin:-8px 0 18px;color:var(--muted)">${esc(w.a)} ו${esc(w.b)}, ${w.s} נקודות</p>
      <ol class="board">${sorted.map(([x, k], n) => `<li class="${k === st.winner ? "now" : ""}"><span>${["🥇","🥈","🥉"][n] || "🎈"}</span>
        <div class="who"><b>${esc(x.n)}</b></div><span class="pts">${x.s}</span></li>`).join("")}</ol></div>`;
    }
    default: return `<div class="center"><div class="rv-hidden">🎲<b>מתכוננים למשחק</b><small>המשחק יופיע כאן ברגע שיתחיל</small></div>
      ${pairs.length ? pairBoard(st, -1) : ""}</div>`;
  }
}
function viewerRender(){
  const $app = G.app;
  let inner;
  if(V.host === null) inner = `<div class="center" style="justify-content:center;flex:1">
      <div class="rv-hidden">🚪<b>החדר ${esc(viewCode)} סגור</b><small>אולי הקוד לא נכון, או שהמשחק הסתיים</small></div></div>`;
  else if(!V.state) inner = `<div class="center"><div class="rv-hidden">📡<b>מתחברים לחדר…</b></div></div>`;
  else inner = viewerBody(V.state);
  $app.innerHTML = `<div class="screen">
    <div class="room-bar"><span>📡 צופים בחדר <b dir="ltr">${esc(viewCode)}</b></span>${!V.host ? "" : V.online === false ? `<span class="room-off">הטלפון המארח לא מחובר</span>` : `<span class="room-live">● שידור חי</span>`}</div>
    <div class="scroll">${inner}</div>
    <div class="footer"><a class="link" href="${location.pathname}">לשחק בטלפון הזה</a></div>
  </div>`;
}
async function startViewer(){
  viewerRender();
  // שומרים את המסך דולק בזמן צפייה
  const keep = async () => { try{ if("wakeLock" in navigator && !document.hidden) await navigator.wakeLock.request("screen"); }catch(e){} };
  keep(); document.addEventListener("visibilitychange", keep);
  try{
    const n = await getNet();
    n.join(G.game, viewCode, (k, v) => { V[k] = v; viewerRender(); });
  }catch(e){
    G.app.innerHTML = `<div class="screen"><div class="scroll center" style="justify-content:center">
      <div class="rv-hidden">📡<b>לא הצלחנו להתחבר לחדר</b><small>כדאי לבדוק את החיבור לאינטרנט</small></div></div>
      <div class="footer"><button class="btn" onclick="location.reload()">נסו שוב</button></div></div>`;
  }
}

/* ---------- עיצוב ---------- */
const css = document.createElement("style");
css.textContent = `
.room-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;margin:0 0 16px;padding:11px 14px;border:2px dashed var(--muted);border-radius:16px;background:none;color:var(--text);font-size:16px}
.room-btn.on{border-style:solid;border-color:var(--mint);background:var(--surface)}
.room-btn b{letter-spacing:.12em}
.room-ov .box{gap:12px}
.room-lead{margin:-6px 0 4px;opacity:.85;font-size:15px}
.room-qr{background:#fff;border-radius:18px;padding:10px;width:min(240px,62vw);aspect-ratio:1;margin:0 auto;display:grid;place-items:center}
.room-qr svg{width:100%;height:100%;display:block}
.room-wait{color:#1B2250;font-size:15px}
.room-code{font-family:"Secular One",Arial,sans-serif;font-size:44px;letter-spacing:.2em;line-height:1;color:#fff}
.room-sub{margin:0;color:var(--muted);font-size:15px}
.room-ov .room-sub{color:#fff;opacity:.85}
.room-end{color:#fff;opacity:.75}
.room-bar{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 18px;background:var(--surface);font-size:15px;border-bottom:2px solid var(--soft)}
.room-bar b{letter-spacing:.12em}
.room-live{color:var(--mint);font-weight:500}
.room-off{color:var(--tomato);font-weight:500}
.rv-hidden{width:100%;background:var(--surface);border:3px dashed var(--soft);border-radius:22px;padding:22px 16px;margin:16px 0;text-align:center;font-size:44px;line-height:1.2}
.rv-hidden b{display:block;font-size:24px;font-family:"Secular One",Arial,sans-serif;font-weight:400;margin-top:6px}
.rv-hidden small{display:block;font-size:15px;color:var(--muted);margin-top:4px}
.rv-words{list-style:none;padding:0;margin:0 0 14px;width:100%;display:flex;flex-wrap:wrap;gap:8px}
.rv-words li{display:flex;align-items:center;gap:8px;background:var(--surface);border-radius:999px;padding:6px 12px 6px 8px;font-size:17px}
.rv-words .mark{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:13px;color:#fff;background:var(--mint)}
.rv-words li.no{color:var(--muted)}
.rv-words li.no .mark{background:var(--tomato)}
`;
document.head.appendChild(css);

/* ============================================================
   ממשק למשחק
   ============================================================ */
window.AliasRoom = {
  // game: "alias" / "alias18"; key: מפתח השמירה של המשחק; app: האלמנט הראשי
  attach(opts){
    G = opts;
    const saved = lsGet(roomKey());
    if(!viewCode && saved && enabled()) startRoom(saved).catch(() => {});
  },
  isViewer: () => !!viewCode && enabled(),
  startViewer,
  publish,
  button: buttonHTML
};
})();
