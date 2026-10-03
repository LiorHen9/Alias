/* ============================================================
   משחק בחדר: מודול משותף ל־Alias ול־18Alias
   ------------------------------------------------------------
   כל זוג משחק מהטלפון שלו. מי שפותח את החדר מגדיר את הזוג שלו,
   וכל השאר מצטרפים בסריקת QR ומגדירים את עצמם. אין צופים:
   כל טלפון בחדר הוא זוג במשחק.

   מהלך התור:
   - התור רץ בטלפון של הזוג שמשחק (כרטיס, טיימר, ניחשו/דלג).
   - בשאר הטלפונים רואים טיימר, ניקוד ומילים שנוחשו. אם המארח
     הפעיל "הזוגות האחרים רואים את המילה" (רק כשאין "מילה אחרונה"),
     רואים גם את המילה עצמה.
   - בסוף התור הזוג הבא בתור מאשר את הסיכום, ויכול לתקן מילים.

   מצב המשחק המשותף נשמר ב־Firebase Realtime Database, תחת
   rooms/<game>/<code>. כל טלפון מבצע את הפעולות של עצמו
   בטרנזקציה, כך שהמשחק לא תלוי בכך שטלפון אחד יישאר דלוק.
   המשחק הרגיל בטלפון אחד לא משתנה וממשיך לעבוד בלי אינטרנט.
   ============================================================ */
(function(){
"use strict";

/* ---- הגדרות Firebase (Project settings → Your apps → Config) ---- */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAwl2XTaeciovpe8fYig5xaDQgM01twLAE",
  authDomain: "alias-7214e.firebaseapp.com",
  databaseURL: "https://alias-7214e-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "alias-7214e",
  storageBucket: "alias-7214e.firebasestorage.app",
  messagingSenderId: "201241835895",
  appId: "1:201241835895:web:f01cb3e40214bc597d8972"
};

const FB_VER = "10.12.2";
const QR_LIB = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
const JSQR_LIB = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"; // לסריקה בדפדפנים בלי BarcodeDetector (אייפון)
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // בלי O/0, I/1, L
const CODE_LEN = 4;
const PLAY_SCREENS = ["handoff", "turn", "lastword", "summary", "approve", "winner"];

const qs = new URLSearchParams(location.search);
const urlCode = (qs.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
// מצב בדיקה: ?roomdev מחליף את Firebase בגיבוי מקומי שמסנכרן בין לשוניות באותו דפדפן
if(qs.has("roomdev")) try{ sessionStorage.setItem("alias-roomdev", "1"); }catch(e){}
const DEV = (() => { try{ return sessionStorage.getItem("alias-roomdev") === "1"; }catch(e){ return false; } })();

/* ---------- עזרים ---------- */
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const lsGet = k => { try{ return localStorage.getItem(k); }catch(e){ return null; } };
const lsSet = (k, v) => { try{ v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); }catch(e){} };
const arr = x => Array.isArray(x) ? x.filter(v => v != null) : x && typeof x === "object" ? Object.keys(x).sort((a, b) => a - b).map(k => x[k]).filter(v => v != null) : [];
const clean = v => v === undefined ? null : JSON.parse(JSON.stringify(v));
const rnd = n => Math.floor(Math.random() * n);

let G = null;          // מה שהמשחק מסר ב־attach
let db = null;         // חיבור לחדר
let code = "";         // קוד החדר
let me = "";           // מזהה הטלפון
let game = null;       // מצב המשחק המשותף
let turnLive = null;   // התור בשידור (מהטלפון שמשחק)
let members = {};      // טלפונים בחדר: uid → {online}
let host = undefined;  // uid של המארח
let T = null;          // התור המקומי, רק בטלפון שמשחק
let ui = {view: "connecting", msg: "", form: null, busy: false};
let lastHTML = "", qrSvg = "", qrFor = "", lastScreenKey = "", confettiFor = "";
let connected = true;
let taken = false;      // המודול מצייר את המסך במקום המשחק

/* ============================================================
   שכבת נתונים: Firebase, או גיבוי מקומי לבדיקות
   ============================================================ */
let fbP = null;
function firebase(){
  if(fbP) return fbP;
  const base = `https://www.gstatic.com/firebasejs/${FB_VER}/`;
  fbP = Promise.all([import(base + "firebase-app.js"), import(base + "firebase-database.js"), import(base + "firebase-auth.js")])
    .then(async ([A, D, U]) => {
      const app = A.initializeApp(FIREBASE_CONFIG, "alias-room");
      const uid = (await U.signInAnonymously(U.getAuth(app))).user.uid;
      return {D, uid, db: D.getDatabase(app)};
    })
    .catch(e => { fbP = null; throw e; });
  return fbP;
}
async function openDB(gameId, c){
  if(DEV) return localDB(gameId, c);
  const {D, uid, db: fdb} = await firebase();
  const base = `rooms/${gameId}/${c}`;
  const R = p => D.ref(fdb, p ? base + "/" + p : base);
  return {
    uid,
    get: async p => (await D.get(R(p))).val(),
    set: (p, v) => D.set(R(p), clean(v)),
    remove: p => D.remove(R(p)),
    async tx(p, fn){
      const res = await D.runTransaction(R(p), cur => { const v = fn(cur); return v === undefined ? undefined : clean(v); }, {applyLocally: true});
      return res.committed;
    },
    on: (p, cb) => D.onValue(R(p), s => cb(s.val())),
    // מסמנים "מחובר" ומאפסים אוטומטית כשהטלפון מתנתק
    presence(p){
      D.onValue(D.ref(fdb, ".info/connected"), s => {
        connected = !!s.val(); if(G && ui.view === "room") render();
        if(!s.val()) return;
        D.onDisconnect(R(p)).set(false);
        D.set(R(p), true).catch(() => {});
      });
    }
  };
}
function localDB(gameId, c){
  const K = `alias-roomdev:${gameId}:${c}`;
  let uid; try{ uid = sessionStorage.getItem("alias-roomdev-uid"); }catch(e){}
  if(!uid){ uid = "u" + Math.random().toString(36).slice(2, 8); try{ sessionStorage.setItem("alias-roomdev-uid", uid); }catch(e){} }
  const load = () => { try{ return JSON.parse(lsGet(K)); }catch(e){ return null; } };
  const at = (tree, p) => { let v = tree; for(const k of (p ? p.split("/") : [])){ if(v == null) return null; v = v[k]; } return v == null ? null : v; };
  const put = (p, v) => {
    const parts = p ? p.split("/") : [];
    let tree = load();
    if(!parts.length) tree = clean(v);
    else {
      tree = tree || {}; let o = tree;
      for(const k of parts.slice(0, -1)){ if(o[k] == null || typeof o[k] !== "object") o[k] = {}; o = o[k]; }
      if(v == null) delete o[parts[parts.length - 1]]; else o[parts[parts.length - 1]] = clean(v);
    }
    lsSet(K, tree == null ? null : JSON.stringify(tree));
    fire();
  };
  const subs = [];
  const fire = () => { const t = load(); subs.forEach(s => { const v = JSON.stringify(at(t, s.p)); if(v !== s.last){ s.last = v; s.cb(JSON.parse(v)); } }); };
  window.addEventListener("storage", e => { if(e.key === K) fire(); });
  return {
    uid,
    get: async p => at(load(), p),
    set: async (p, v) => put(p, v),
    remove: async p => put(p, null),
    async tx(p, fn){ const v = fn(clean(at(load(), p))); if(v === undefined) return false; put(p, v); return true; },
    on(p, cb){ const s = {p, cb, last: undefined}; subs.push(s); setTimeout(fire, 0); return () => subs.splice(subs.indexOf(s), 1); },
    presence(p){ put(p, true); window.addEventListener("pagehide", () => put(p, false)); }
  };
}

/* ============================================================
   מצב המשחק
   ============================================================ */
function norm(g){
  if(!g) return null;
  g.pairs = arr(g.pairs).map(p => Object.assign(p, {players: arr(p.players).map(x => ({name: x.name || "", kid: !!x.kid}))}));
  g.used = g.used || {};
  Object.keys(G.decks).forEach(k => { g.used[k] = arr(g.used[k]); });
  if(g.review){ g.review.words = arr(g.review.words); g.review.drawn = normDrawn(g.review.drawn); if(g.review.lastPair == null) g.review.lastPair = -1; }
  if(g.winner == null) g.winner = -1;
  g.settings = Object.assign(defaultSettings(), g.settings || {});
  return g;
}
const normDrawn = d => { const o = {}; Object.keys(G.decks).forEach(k => { o[k] = arr(d && d[k]); }); return o; };
function defaultSettings(){
  const s = Object.assign({time: 60, target: 30, skipPenalty: true, difficulty: "mixed", lastWord: true, sound: true}, (G.settings && G.settings()) || {});
  return Object.assign(s, {showWord: !!s.showWord});
}
const isKid = p => G.hasKids && p.players.some(x => x.kid);
const pairName = (p, i) => (p.name || "").trim() || (p.players[0].name && p.players[1].name ? `${p.players[0].name} ו${p.players[1].name}` : `זוג ${i + 1}`);
const playerName = (p, j) => (p.players[j].name || "").trim() || (j ? "שחקן/ית ב׳" : "שחקן/ית א׳");
const myIdx = () => game ? game.pairs.findIndex(p => p.uid === me) : -1;
const isHost = () => host === me;
const activeIdx = () => game ? game.turn : -1;
const amActive = () => game && PLAY_SCREENS.includes(game.screen) && myIdx() === game.turn;
const nextIdx = () => game ? (game.turn + 1) % game.pairs.length : -1;
const amApprover = () => game && myIdx() === nextIdx();
const online = uid => !members[uid] || members[uid].online !== false;
const showWordOn = s => !!s.showWord && !s.lastWord;
const ptsOf = (words, s) => { const ok = words.filter(w => w.ok).length; return ok - (s.skipPenalty ? words.length - ok : 0); };

// טרנזקציה על מצב המשחק, עם בדיקה שהמצב עדיין מה שציפינו
async function act(guard, mutate){
  const ok = await db.tx("game", raw => {
    const g = norm(raw);
    if(!g || !guard(g)) return undefined;
    mutate(g);
    return g;
  }).catch(() => false);
  return ok;
}

/* ---------- כרטיסים ---------- */
function deckKey(p, s){
  let k = isKid(p) ? "kids" : s.difficulty;
  if(k === "mixed") k = ["easy", "medium", "hard"][rnd(3)];
  return k;
}
function drawCard(){
  const p = game.pairs[game.turn], k = deckKey(p, game.settings), deck = G.decks[k] || [];
  const mine = T.drawn[k] || (T.drawn[k] = []);
  const used = new Set([...(game.used[k] || []), ...mine]);
  let pool = deck.filter(c => !used.has(c.w));
  if(!pool.length){ const m = new Set(mine); pool = deck.filter(c => !m.has(c.w)); }
  if(!pool.length) pool = deck;
  const c = pool[rnd(pool.length)];
  mine.push(c.w);
  return {w: c.w, e: c.e || "", r: (Math.random() * 6 - 3).toFixed(1)};
}
function cardHTML(c, still){
  const s = still ? " still" : "";
  return c.e
    ? `<div class="card${s}" style="--r:${c.r || 0}deg"><div class="emoji" aria-hidden="true">${c.e}</div><div class="kidword">${esc(c.w)}</div></div>`
    : `<div class="card${s}" style="--r:${c.r || 0}deg"><div class="word">${esc(c.w)}</div></div>`;
}

/* ---------- צליל, רטט, מסך דולק ---------- */
let AC = null, WL = null;
function audio(){ try{ if(!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); if(AC.state === "suspended") AC.resume(); }catch(e){} }
function beep(f, d){
  if(!game || !game.settings.sound || !AC) return;
  try{ const o = AC.createOscillator(), g = AC.createGain(); o.type = "square"; o.frequency.value = f;
    g.gain.setValueAtTime(0.07, AC.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + d);
    o.connect(g); g.connect(AC.destination); o.start(); o.stop(AC.currentTime + d); }catch(e){}
}
const buzz = ms => { try{ navigator.vibrate && navigator.vibrate(ms); }catch(e){} };
async function wake(){ try{ if("wakeLock" in navigator && !WL && !document.hidden){ WL = await navigator.wakeLock.request("screen"); WL.addEventListener("release", () => { WL = null; }); } }catch(e){} }

/* ============================================================
   התור בטלפון של הזוג שמשחק
   ============================================================ */
function pushTurn(){
  if(!T) return;
  db.set("turn", {tid: game.tid, words: T.words, card: T.card, left: Math.max(0, Math.round(T.left)), total: T.total, paused: T.paused ? 1 : 0, drawn: T.drawn}).catch(() => {});
}
function tick(){
  if(!T) return;
  const now = performance.now();
  if(T.paused){ T.last = now; return; }
  T.left -= now - T.last; T.last = now;
  updateTimer();
  const s = Math.ceil(T.left / 1000);
  if(s !== T.sentSec){ T.sentSec = s; pushTurn(); }
  if(s <= 5 && s > 0 && s !== T.lastBeep){ T.lastBeep = s; beep(880, 0.08); }
  if(T.left <= 0){ beep(220, 0.7); buzz([300, 100, 300]); finishTurn(); }
}
function stopT(){ if(T && T.iv) clearInterval(T.iv); T = null; }
function updateTimer(){
  const secs = document.getElementById("secs"), bar = document.getElementById("bar"), tm = document.getElementById("timer");
  if(!secs || !T) return;
  const ts = timerState(T.left, T.total);
  secs.textContent = ts.secs; bar.style.width = ts.pct + "%"; tm.className = "timer " + ts.cls;
}
function timerState(left, total){
  const secs = Math.max(0, Math.ceil(left / 1000)), pct = Math.max(0, left / total * 100);
  return {secs, pct, cls: secs <= 5 ? "danger" : secs <= 15 ? "warn" : ""};
}
// הטלפון שמשחק נטען מחדש באמצע תור: ממשיכים מאותה נקודה, מושהה
function restoreT(){
  if(T || !game || game.screen !== "turn" || !amActive() || !turnLive || turnLive.tid !== game.tid) return;
  T = {words: arr(turnLive.words).map(w => ({w: w.w, e: w.e || "", ok: !!w.ok})), card: turnLive.card, left: turnLive.left, total: turnLive.total,
    drawn: normDrawn(turnLive.drawn), paused: true, restored: true, last: performance.now()};
  T.iv = setInterval(tick, 100);
}
async function finishTurn(byHost){
  const src = byHost ? {words: arr(turnLive && turnLive.words), card: (turnLive && turnLive.card) || {w: ""}, drawn: normDrawn(turnLive && turnLive.drawn)} : T;
  const tid = game.tid;
  if(!byHost) stopT();
  await act(g => g.screen === "turn" && g.tid === tid, g => {
    g.review = {words: src.words.map(w => ({w: w.w, e: w.e || "", ok: w.ok ? 1 : 0})), card: {w: src.card.w, e: src.card.e || ""}, lastPair: -1, drawn: src.drawn};
    g.screen = g.settings.lastWord ? "lastword" : "summary";
  });
  db.remove("turn").catch(() => {});
}

/* ============================================================
   פעולות
   ============================================================ */
const A = {
  // ---- טופס הזוג ----
  kid(el){ const p = ui.form.players[+el.dataset.j]; p.kid = !p.kid; render(); },
  async submitForm(){
    const f = ui.form;
    if(!f.players[0].name.trim() || !f.players[1].name.trim()){ ui.msg = "צריך למלא את השמות של שני השחקנים"; return render(true); }
    lsSet("alias-room-me", JSON.stringify({name: f.name, players: f.players}));
    const pair = {uid: me, name: f.name.trim(), players: f.players.map(x => ({name: x.name.trim(), kid: G.hasKids && !!x.kid})), score: 0, next: 0};
    ui.busy = true; ui.msg = ""; render();
    try{
      if(f.mode === "create") await createRoom(pair);
      else if(f.mode === "edit") await act(g => g.status === "lobby", g => { const i = g.pairs.findIndex(p => p.uid === me); if(i >= 0) g.pairs[i] = Object.assign(g.pairs[i], pair, {score: 0, next: 0}); });
      else await joinRoom(pair);
      if(ui.view === "form") ui.view = "room";
    }catch(e){ ui.msg = netError(e); }
    ui.busy = false; render(true);
  },
  cancelForm(){ if(ui.form.mode === "edit"){ ui.view = "room"; render(); } else home(); },

  // ---- לובי ----
  editPair(){ const p = game.pairs[myIdx()]; ui.form = {mode: "edit", name: p.name, players: p.players.map(x => ({...x}))}; ui.msg = ""; ui.view = "form"; render(); },
  async leave(){
    if(!confirm("לצאת מהחדר?")) return;
    if(game && game.status === "lobby") await act(g => true, g => { g.pairs = g.pairs.filter(p => p.uid !== me); });
    db.remove("members/" + me).catch(() => {});
    home();
  },
  async kick(el){
    const uid = el.dataset.u, p = game.pairs.find(x => x.uid === uid);
    if(!p || !confirm(`להוציא את ${pairName(p, game.pairs.indexOf(p))} מהחדר?`)) return;
    await act(g => g.status === "lobby", g => { g.pairs = g.pairs.filter(x => x.uid !== uid); });
    db.remove("members/" + uid).catch(() => {});
  },
  set(el){ const k = el.dataset.k, v = el.dataset.v; act(g => g.status === "lobby", g => { g.settings[k] = isNaN(+v) ? v : +v; }); },
  toggle(el){ const k = el.dataset.k; act(g => g.status === "lobby", g => { g.settings[k] = !g.settings[k]; if(g.settings.lastWord) g.settings.showWord = false; }); },
  target(el){ act(g => g.status === "lobby", g => { g.settings.target = Math.min(100, Math.max(10, g.settings.target + +el.dataset.v)); }); },
  async share(el){
    const url = joinUrl();
    if(navigator.share){ try{ await navigator.share({title: document.title, text: "הצטרפו למשחק שלנו", url}); }catch(e){} }
    else { try{ await navigator.clipboard.writeText(url); el.textContent = "הועתק ✓"; }catch(e){ prompt("הלינק לחדר:", url); } }
  },
  toggleSettings(){ ui.settingsOpen = !ui.settingsOpen; render(); },
  start(){
    audio();
    act(g => g.status === "lobby" && g.pairs.length >= 2, g => {
      g.status = "play"; g.screen = "handoff"; g.turn = 0; g.round = 1; g.winner = -1; g.tid = (g.tid || 0) + 1;
      g.pairs.forEach(p => { p.score = 0; p.next = 0; });
    });
  },

  // ---- התור ----
  swap(){ act(g => g.screen === "handoff" && g.pairs[g.turn].uid === me, g => { const p = g.pairs[g.turn]; p.next = 1 - p.next; }); },
  async startTurn(){
    if(!amActive() || game.screen !== "handoff") return;
    audio(); wake();
    const ms = game.settings.time * 1000;
    T = {words: [], drawn: normDrawn(), total: ms, left: ms, paused: false, last: performance.now()};
    T.card = drawCard();
    const tid = game.tid;
    pushTurn();
    const ok = await act(g => g.screen === "handoff" && g.tid === tid && g.pairs[g.turn].uid === me, g => { g.screen = "turn"; });
    if(!ok){ stopT(); return; }
    T.last = performance.now();
    T.iv = setInterval(tick, 100);
    render();
  },
  answer(el){
    if(!T || T.paused || T.left <= 0) return;
    T.words.push({w: T.card.w, e: T.card.e, ok: el.dataset.v === "1"});
    T.card = drawCard();
    pushTurn(); render();
  },
  pause(){ if(!T) return; T.paused = true; pushTurn(); render(); },
  resume(){ if(!T) return; audio(); wake(); T.paused = false; T.restored = false; T.last = performance.now(); pushTurn(); render(); },
  endTurn(){ if(T) finishTurn(); },
  hostEndTurn(){ if(confirm("לסיים את התור של הזוג שמשחק? המילים שכבר נענו יישמרו.")) finishTurn(true); },
  lastWord(el){ const v = +el.dataset.v, tid = game.tid; act(g => g.screen === "lastword" && g.tid === tid, g => { g.review.lastPair = v; g.screen = "summary"; }); },
  flip(el){
    const i = +el.dataset.i, tid = game.tid, scr = game.screen;
    act(g => g.screen === scr && g.tid === tid && g.review, g => { const w = g.review.words[i]; if(w) w.ok = w.ok ? 0 : 1; });
  },
  submit(){ const tid = game.tid; act(g => g.screen === "summary" && g.tid === tid, g => { g.screen = "approve"; }); },
  approve(){
    const tid = game.tid;
    act(g => g.screen === "approve" && g.tid === tid && g.review, g => {
      const p = g.pairs[g.turn], r = g.review;
      p.score += ptsOf(r.words.map(w => ({ok: !!w.ok})), g.settings);
      if(r.lastPair >= 0 && g.pairs[r.lastPair]) g.pairs[r.lastPair].score += 1;
      Object.keys(r.drawn).forEach(k => {
        const all = g.used[k].concat(r.drawn[k]);
        g.used[k] = all.length >= (G.decks[k] || []).length ? r.drawn[k] : all;
      });
      p.next = 1 - p.next; g.review = null; g.tid++;
      g.turn++;
      if(g.turn >= g.pairs.length){
        g.turn = 0; g.round++;
        const max = Math.max(...g.pairs.map(x => x.score));
        const leaders = g.pairs.map((x, i) => [x, i]).filter(([x]) => x.score === max);
        if(max >= g.settings.target && leaders.length === 1){ g.winner = leaders[0][1]; g.screen = "winner"; return; }
      }
      g.screen = "handoff";
    });
  },
  rematch(){
    act(g => g.screen === "winner", g => {
      g.screen = "handoff"; g.turn = 0; g.round = 1; g.winner = -1; g.tid++;
      g.pairs.forEach(p => { p.score = 0; p.next = 0; });
    });
  },
  async closeRoom(){
    if(!confirm("לסגור את החדר? כל הטלפונים יתנתקו מהמשחק.")) return;
    await db.remove("").catch(() => {});
    home();
  },
  home(){ home(); },

  // ---- הצטרפות מתוך האפליקציה: סריקה או קוד ----
  async joinCode(){
    const c = ui.code || "";
    if(c.length !== CODE_LEN){ ui.msg = `קוד החדר הוא ${CODE_LEN} תווים`; return render(true); }
    ui.busy = true; ui.msg = ""; ui.tried = c; render();
    try{
      const d = await openDB(G.game, c);
      const g = await d.get("game");
      if(!g) throw new Error(await inOtherGame(c) ? "other" : "nocode");
      if(g.status !== "lobby" && !arr(g.pairs).some(p => p && p.uid === d.uid)) throw new Error("started");
    }catch(e){
      ui.busy = false;
      ui.msg = e && e.message === "other" ? otherGameMsg() : e && e.message === "nocode" ? "לא מצאנו חדר עם הקוד הזה. כדאי לבדוק אותו מול המסך של מי שפתח את החדר." : netError(e);
      return render(true);
    }
    ui.busy = false;
    history.replaceState(null, "", location.pathname + "?room=" + c + (DEV ? "&roomdev" : ""));
    enter(c, true);
  },
  scan(){ ui.msg = ""; ui.view = "scan"; render(true); startScan(); },
  cancelScan(){ stopScan(); ui.view = "join"; render(true); },
  exit(){ if(confirm(isHost() ? "לצאת מהחדר בטלפון הזה? החדר נשאר פתוח, ואפשר לחזור אליו דרך הלינק." : "לצאת מהחדר בטלפון הזה? אפשר לחזור דרך הלינק.")) home(); }
};
// תרגום ממקלדת עברית לאותיות האנגליות שבאותו מקום, כדי שלא צריך להחליף שפה
const HEB_KEYS = {"/":"Q","'":"W","ק":"E","ר":"R","א":"T","ט":"Y","ו":"U","ן":"I","ם":"O","פ":"P","ש":"A","ד":"S","ג":"D","כ":"F","ע":"G","י":"H","ח":"J","ל":"K","ך":"L","ז":"Z","ס":"X","ב":"C","ה":"V","נ":"B","מ":"N","צ":"M"};
const cleanCode = s => String(s || "").replace(/./g, ch => HEB_KEYS[ch] || ch).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);

/* ---------- הפרדה בין המשחקים ----------
   חדרים של Alias ושל 18Alias שמורים בנפרד, ואי אפשר להצטרף לחדר של משחק אחד מתוך השני
   (לא בסריקה, לא בקוד ולא בלינק). בודקים רק כדי להסביר למה החדר לא נמצא. */
const OTHER_GAME = {alias: ["alias18", "אליאס 18+"], alias18: ["alias", "אליאס המשפחתי"]};
const otherGameMsg = () => `זה חדר של ${(OTHER_GAME[G.game] || [, "משחק אחר"])[1]}. אי אפשר להצטרף אליו מכאן, רק מתוך אותו משחק.`;
async function inOtherGame(c){
  const o = OTHER_GAME[G.game];
  if(!o) return false;
  try{ const d = await openDB(o[0], c); return !!(await d.get("game")); }catch(e){ return false; }
}

/* ---------- סריקת QR במצלמה ---------- */
let scanStream = null, scanTimer = 0;
function stopScan(){
  clearTimeout(scanTimer);
  if(scanStream) scanStream.getTracks().forEach(t => t.stop());
  scanStream = null;
}
function scanFail(denied){
  stopScan();
  ui.view = "join";
  ui.msg = denied ? "אין גישה למצלמה. אפשר לאשר גישה בהגדרות הדפדפן, או פשוט להקליד את הקוד שמופיע מתחת ל־QR."
    : "לא הצלחנו לפתוח את המצלמה. אפשר להקליד את הקוד שמופיע מתחת ל־QR.";
  render(true);
}
async function startScan(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return scanFail(false);
  let stream;
  try{ stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: "environment"}}, audio: false}); }
  catch(e){ return scanFail(e && (e.name === "NotAllowedError" || e.name === "SecurityError")); }
  if(ui.view !== "scan"){ stream.getTracks().forEach(t => t.stop()); return; }
  scanStream = stream;
  const v = document.getElementById("room-video");
  if(!v) return stopScan();
  v.srcObject = stream;
  try{ await v.play(); }catch(e){}
  let detect = null;
  if("BarcodeDetector" in window){
    try{
      const fm = await window.BarcodeDetector.getSupportedFormats();
      if(fm.includes("qr_code")){ const bd = new window.BarcodeDetector({formats: ["qr_code"]}); detect = async () => { const r = await bd.detect(v); return r[0] && r[0].rawValue; }; }
    }catch(e){}
  }
  if(!detect){
    try{ if(!window.jsQR) await loadScript(JSQR_LIB); }catch(e){ return scanFail(false); }
    const cv = document.createElement("canvas"), cx = cv.getContext("2d", {willReadFrequently: true});
    detect = async () => {
      const w = v.videoWidth, h = v.videoHeight;
      if(!w || !h) return null;
      const k = Math.min(1, 720 / Math.max(w, h));
      cv.width = Math.round(w * k); cv.height = Math.round(h * k);
      cx.drawImage(v, 0, 0, cv.width, cv.height);
      const r = window.jsQR(cx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, {inversionAttempts: "dontInvert"});
      return r && r.data;
    };
  }
  const loop = async () => {
    if(!scanStream) return;
    let txt = null;
    try{ txt = await detect(); }catch(e){}
    if(!scanStream) return;
    if(txt && scanned(txt)) return;
    scanTimer = setTimeout(loop, 160);
  };
  loop();
}
// מה יצא מהסריקה: לינק לחדר (כמו ב־QR שבלובי) או קוד בלבד
function scanned(txt){
  let c = "", url = null;
  try{ url = new URL(txt); }catch(e){}
  if(url){
    if(url.origin === location.origin && url.searchParams.get("room")){
      // QR של חדר במשחק השני (Alias ↔ 18Alias): אסור להצטרף מכאן
      if(url.pathname.replace(/index\.html$/, "").toLowerCase() !== location.pathname.replace(/index\.html$/, "").toLowerCase()){
        const m = document.getElementById("room-scan-msg");
        if(m) m.textContent = otherGameMsg();
        return false;
      }
      c = cleanCode(url.searchParams.get("room"));
    }
  } else c = cleanCode(txt.trim().length === CODE_LEN ? txt : "");
  if(c.length !== CODE_LEN){
    const m = document.getElementById("room-scan-msg");
    if(m) m.textContent = "זה לא QR של חדר במשחק. סורקים את ה־QR שעל המסך של מי שפתח את החדר.";
    return false;
  }
  stopScan(); buzz(80);
  ui.code = c; ui.view = "join"; render(true);
  A.joinCode();
  return true;
}
window.addEventListener("pagehide", stopScan);
function home(){
  lsSet(G.key + "-room", null);
  location.href = location.pathname;
}
function netError(e){
  if(e && e.message === "started") return "המשחק בחדר הזה כבר התחיל. אפשר להצטרף רק לפני שמתחילים.";
  if(e && e.message === "gone") return "החדר הזה לא קיים או שכבר נסגר";
  return navigator.onLine === false ? "צריך חיבור לאינטרנט כדי לשחק בחדר" : "משהו השתבש בחיבור. נסו שוב.";
}

/* ============================================================
   כניסה לחדר
   ============================================================ */
const joinUrl = () => location.origin + location.pathname + "?room=" + code + (DEV ? "&roomdev" : "");
const newCode = () => Array.from({length: CODE_LEN}, () => ALPHA[rnd(ALPHA.length)]).join("");

async function createRoom(pair){
  for(let i = 0; i < 6; i++){
    const c = newCode();
    const d = await openDB(G.game, c);
    me = d.uid;
    if(await d.get("host")) continue;
    try{ await d.set("host", me); }catch(e){ continue; }
    db = d; code = c; pair.uid = me;
    await db.set("created", Date.now());
    await db.set("members/" + me, {online: true});
    await db.set("game", {v: 2, status: "lobby", screen: "lobby", settings: defaultSettings(), pairs: [pair],
      turn: 0, round: 1, winner: -1, tid: 0, used: {}});
    lsSet(G.key + "-room", code);
    await listen();
    return;
  }
  throw new Error("code");
}
async function joinRoom(pair){
  await db.set("members/" + me, {online: true});
  const ok = await act(g => g.status === "lobby" || g.pairs.some(p => p.uid === me), g => {
    const i = g.pairs.findIndex(p => p.uid === me);
    if(i >= 0) g.pairs[i] = Object.assign(g.pairs[i], pair, {score: g.pairs[i].score, next: g.pairs[i].next});
    else g.pairs.push(pair);
  });
  if(!ok){ db.remove("members/" + me).catch(() => {}); throw new Error("started"); }
  lsSet(G.key + "-room", code);
  db.presence("members/" + me + "/online");
}
// מאזינים לחדר. מחזיר אחרי שהגיע המצב הראשון
function listen(){
  return new Promise(resolve => {
    let first = true;
    db.on("host", v => { host = v; if(v === null && !first) { ui.view = "closed"; stopT(); } render(); });
    db.on("members", v => { members = v || {}; render(); });
    db.on("turn", v => { turnLive = v; if(game && game.screen === "turn" && amActive()){ restoreT(); if(T && !T.restoredRendered){ T.restoredRendered = true; render(); } return; } render(); });
    db.on("game", v => {
      game = norm(v);
      if(!game){ if(!first){ ui.view = "closed"; stopT(); render(); } }
      else onGame();
      if(first){ first = false; resolve(); }
    });
    if(myIdx() >= 0 || ui.form && ui.form.mode === "create") db.presence("members/" + me + "/online");
  });
}
function onGame(){
  if(T && (game.screen !== "turn" || !amActive())) stopT();
  restoreT();
  // התראה כשמגיע התור שלנו או כשצריך לאשר
  const key = game.screen + ":" + game.tid;
  if(key !== lastScreenKey){
    if(lastScreenKey && ((game.screen === "handoff" && amActive()) || (game.screen === "approve" && amApprover()))){ audio(); beep(660, 0.12); buzz([120, 60, 120]); }
    lastScreenKey = key;
  }
  if(ui.view === "room" && myIdx() < 0 && game.status !== "lobby"){ ui.view = "error"; ui.msg = "הזוג שלך כבר לא נמצא בחדר הזה"; }
  if(ui.view === "room" && myIdx() < 0 && game.status === "lobby"){ ui.view = "error"; ui.msg = "המארח הוציא את הזוג שלך מהחדר"; lsSet(G.key + "-room", null); }
  render();
}

// נקרא מהמשחק בזמן העלייה. מחזיר true אם המודול לוקח פיקוד
function boot(){
  const saved = lsGet(G.key + "-room");
  const c = urlCode || saved;
  if(!c) return false;
  taken = true;
  enter(c, !!urlCode);
  return true;
}
// נכנסים לחדר. explicit: הגענו מלינק, מסריקה או מקוד (ולא מחדר ששמור בטלפון)
async function enter(c, explicit){
  code = c; ui.view = "connecting"; ui.msg = ""; render();
  try{
    db = await openDB(G.game, code);
    me = db.uid;
    const g = await db.get("game");
    // חדר ישן שנשאר שמור בטלפון: לא נכנסים אליו אוטומטית
    if(g && !explicit && Date.now() - ((await db.get("created")) || 0) > 12 * 3600e3){ lsSet(G.key + "-room", null); location.href = location.pathname; return; }
    if(!g){ if(!explicit){ lsSet(G.key + "-room", null); location.href = location.pathname; return; } ui.view = "error"; ui.msg = await inOtherGame(code) ? otherGameMsg() : "החדר הזה לא קיים או שכבר נסגר"; return render(); }
    await listen();
    if(myIdx() >= 0){ ui.view = "room"; db.presence("members/" + me + "/online"); lsSet(G.key + "-room", code); }
    else if(game.status !== "lobby"){ ui.view = "error"; ui.msg = netError(new Error("started")); }
    else { ui.form = Object.assign({mode: "join"}, savedPair()); ui.view = "form"; }
    render();
  }catch(e){ ui.view = "error"; ui.msg = netError(e); render(); }
}
// נקרא מכפתור "הצטרפות לחדר" במסך הזוגות
function startJoin(){
  ui.code = ""; ui.tried = ""; ui.msg = ""; ui.busy = false; ui.view = "join"; taken = true;
  history.replaceState(null, "", location.pathname + (DEV ? "?roomdev" : ""));
  render(true);
}
function savedPair(){
  try{ const s = JSON.parse(lsGet("alias-room-me")); if(s && s.players) return {name: s.name || "", players: arr(s.players).map(x => ({name: x.name || "", kid: !!x.kid}))}; }catch(e){}
  return {name: "", players: [{name: "", kid: false}, {name: "", kid: false}]};
}
// נקרא מכפתור במסך הזוגות של המשחק
function startCreate(){
  const p = G.firstPair && G.firstPair();
  const base = savedPair();
  if(p && p.players && p.players.some(x => x.name.trim())) { base.name = p.name || ""; base.players = p.players.map(x => ({name: x.name, kid: !!x.kid})); }
  ui.form = Object.assign({mode: "create"}, base);
  ui.msg = ""; ui.view = "form"; taken = true;
  history.replaceState(null, "", location.pathname);
  render();
}

/* ============================================================
   מסכים
   ============================================================ */
function bar(){
  const p = game && game.pairs[myIdx()];
  return `<div class="room-bar"><span>📡 חדר <b dir="ltr">${esc(code)}</b></span>
    ${!connected ? `<span class="room-off">אין חיבור…</span>` : p ? `<span class="room-me">${esc(pairName(p, myIdx()))}</span>` : ""}
    <button class="room-x" data-r="exit" aria-label="יציאה מהחדר">✕</button></div>`;
}
function board(hi){
  return `<div class="board-title"><span>ניקוד</span><span>יעד: ${game.settings.target}</span></div>
  <ol class="board">${game.pairs.map((p, i) => `<li class="${i === hi ? "now" : ""}">
    <div class="who"><b>${esc(pairName(p, i))}${p.uid === me ? ` <span class="room-tag">אתם</span>` : ""}${online(p.uid) ? "" : ` <span class="room-tag off">לא מחובר</span>`}</b><small>${esc(playerName(p, 0))} ו${esc(playerName(p, 1))}</small></div>
    <span class="pts">${p.score}</span></li>`).join("")}</ol>`;
}
function screen(body, footer){
  return `<div class="screen">${bar()}<div class="scroll">${body}</div>${footer ? `<div class="footer">${footer}</div>` : ""}</div>`;
}
function msgScreen(icon, title, sub, footer){
  return `<div class="screen"><div class="scroll center" style="justify-content:center">
    <div class="rv-hidden">${icon}<b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</div></div>
    <div class="footer">${footer || `<button class="btn plain" data-r="home">חזרה למשחק בטלפון אחד</button>`}</div></div>`;
}

function vForm(){
  const f = ui.form, title = {create: "משחק בחדר", join: `הצטרפות לחדר ${esc(code)}`, edit: "עריכת הזוג שלנו"}[f.mode];
  const lead = {create: "כל זוג משחק מהטלפון שלו. קודם, מי אתם? אחר כך יופיעו QR וקוד, והזוגות האחרים מצטרפים איתם.",
    join: "מי אתם? הזוג שלכם ישחק מהטלפון הזה.", edit: ""}[f.mode];
  return `<div class="screen"><div class="scroll">
    <h2>${title}</h2>${lead ? `<p class="room-lead2">${lead}</p>` : ""}
    <div class="pair">
      <div class="pair-head"><span class="num">👥</span>
        <input type="text" data-ri="name" value="${esc(f.name)}" placeholder="שם הזוג (לא חובה)" maxlength="24"></div>
      ${[0, 1].map(j => `<div class="player">
        <input type="text" data-ri="player" data-j="${j}" value="${esc(f.players[j].name)}" placeholder="${j ? "שחקן/ית 2" : "שחקן/ית 1"}" maxlength="20">
        ${G.hasKids ? `<button class="chip" data-r="kid" data-j="${j}" aria-pressed="${!!f.players[j].kid}">ילד/ה 🧒</button>` : ""}
      </div>`).join("")}
      ${G.hasKids ? `<span class="tag">${f.players.some(x => x.kid) ? "🧸 הזוג הזה יקבל כרטיסי תמונות" : "📝 כרטיסי מילים"}</span>` : ""}
    </div>
    ${ui.msg ? `<div class="notice">${esc(ui.msg)}</div>` : ""}
  </div><div class="footer">
    <button class="btn" data-r="submitForm" ${ui.busy ? "disabled" : ""}>${ui.busy ? "רגע…" : {create: "פתיחת החדר", join: "הצטרפות למשחק", edit: "שמירה"}[f.mode]}</button>
    <button class="link" data-r="cancelForm">ביטול</button>
  </div></div>`;
}

function vJoin(){
  const c = ui.code || "";
  return `<div class="screen"><div class="scroll">
    <h2>הצטרפות לחדר</h2>
    <p class="room-lead2">מי שפתח את החדר רואה אצלו QR וקוד. סורקים את ה־QR, או מקלידים את הקוד.</p>
    <button class="room-btn room-scan" data-r="scan" ${ui.busy ? "disabled" : ""}><span class="ico">📷</span>
      <span><b>סריקת QR</b><small>נפתחת המצלמה של הטלפון</small></span></button>
    <div class="room-or"><span>או</span></div>
    <label class="label" for="room-code-in">קוד החדר</label>
    <input id="room-code-in" class="room-code-in" type="text" data-ri="code" value="${esc(c)}" placeholder="${"•".repeat(CODE_LEN)}"
      maxlength="${CODE_LEN + 4}" dir="ltr" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
    ${ui.msg ? `<div class="notice">${esc(ui.msg)}</div>` : ""}
  </div><div class="footer">
    <button class="btn" data-r="joinCode" ${ui.busy || c.length !== CODE_LEN ? "disabled" : ""}>${ui.busy ? "מחפשים את החדר…" : "הצטרפות"}</button>
    <button class="link" data-r="home">ביטול</button>
  </div></div>`;
}
function vScan(){
  return `<div class="screen"><div class="scroll center">
    <h2>סריקת QR</h2>
    <div class="room-cam"><video id="room-video" playsinline muted autoplay></video><i class="room-cam-frame" aria-hidden="true"></i></div>
    <p class="room-sub" id="room-scan-msg" aria-live="polite">מכוונים את המצלמה ל־QR שעל המסך של מי שפתח את החדר</p>
  </div><div class="footer"><button class="btn plain" data-r="cancelScan">הקלדת קוד במקום</button></div></div>`;
}

function seg(k, opts, val){
  return `<div class="seg">${opts.map(([v, l]) => `<button data-r="set" data-k="${k}" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join("")}</div>`;
}
function sw(k, title, sub){
  const on = !!game.settings[k];
  return `<div class="switch-row"><div>${title}${sub ? `<small>${sub}</small>` : ""}</div>
    <button class="switch" role="switch" aria-checked="${on}" aria-label="${title}" data-r="toggle" data-k="${k}"></button></div>`;
}
function settingsSummary(s){
  const t = {30: "30 שניות", 45: "45 שניות", 60: "דקה", 90: "90 שניות", 120: "2 דקות"}[s.time] || s.time + " שניות";
  const bits = [`⏱ ${t} לתור`, `🎯 יעד ${s.target}`];
  if(game.pairs.some(p => !isKid(p)) && G.levelNames[s.difficulty]) bits.push(`רמה: ${G.levelNames[s.difficulty]}`);
  if(s.lastWord) bits.push("כולל מילה אחרונה");
  if(showWordOn(s)) bits.push("👀 כולם רואים את המילה");
  return bits.join(" · ");
}
function vLobby(){
  const s = game.settings, h = isHost(), n = game.pairs.length;
  if(qrFor !== code){ qrFor = code; makeQR(joinUrl()).then(svg => { qrSvg = svg; render(); }).catch(() => { qrSvg = `<span class="room-wait">לא הצלחנו להציג QR. אפשר לשתף את הלינק.</span>`; render(); }); }
  const pairs = `<ol class="board">${game.pairs.map((p, i) => `<li>
      <div class="who"><b>${esc(pairName(p, i))}${p.uid === me ? ` <span class="room-tag">אתם</span>` : ""}${p.uid === host ? ` <span class="room-tag">מארח</span>` : ""}${online(p.uid) ? "" : ` <span class="room-tag off">לא מחובר</span>`}</b>
        <small>${esc(playerName(p, 0))} ו${esc(playerName(p, 1))}${isKid(p) ? " · 🧸 כרטיסי תמונות" : ""}</small></div>
      ${h && p.uid !== me ? `<button class="del" data-r="kick" data-u="${esc(p.uid)}" aria-label="הוצאה מהחדר">✕</button>` : ""}</li>`).join("")}</ol>`;
  // ההגדרות מופיעות מיד מתחת ל־QR: כרטיס סיכום, ולמארח כפתור שפותח את כל ההגדרות
  const summary = `<button class="room-set ${h ? "" : "ro"}" ${h ? `data-r="toggleSettings" aria-expanded="${!!ui.settingsOpen}"` : "disabled"}>
      <span class="ico">⚙️</span><span><b>הגדרות המשחק</b><small>${settingsSummary(s)}</small></span>${h ? `<span class="room-set-go">${ui.settingsOpen ? "סגירה" : "שינוי"}</span>` : ""}</button>`;
  const settings = h && ui.settingsOpen ? `<div class="room-set-panel">
    <div class="group"><span class="label">זמן לכל תור</span>${seg("time", [[30, "30 ש׳"], [45, "45 ש׳"], [60, "דקה"], [90, "90 ש׳"], [120, "2 דק׳"]], s.time)}</div>
    <div class="group"><span class="label">ניקוד לניצחון</span>
      <div class="stepper"><button data-r="target" data-v="5" aria-label="הגדלה">+</button><output>${s.target}</output><button data-r="target" data-v="-5" aria-label="הקטנה">−</button></div></div>
    ${game.pairs.some(p => !isKid(p)) ? `<div class="group"><span class="label">${G.levelLabel}</span>${seg("difficulty", G.levels, s.difficulty)}
      <p class="hint">${G.levelHints[s.difficulty] || ""}</p></div>` : ""}
    <div class="group">
      ${sw("skipPenalty", "דילוג מוריד נקודה")}
      ${sw("lastWord", "המילה האחרונה", "כשהזמן נגמר, כל מי שבחדר יכול לנחש")}
      ${s.lastWord ? `<p class="hint room-hint">אפשר להציג את המילה לזוגות האחרים רק כשהמילה האחרונה כבויה</p>` : sw("showWord", "הזוגות האחרים רואים את המילה", "כדי לתפוס מי שאומר חלק מהמילה")}
      ${sw("sound", "צלילים")}
    </div>
    <button class="btn plain" data-r="toggleSettings">סיום ההגדרות</button></div>` : "";
  const body = `<div class="center">
      <div class="room-qr">${qrSvg || `<span class="room-wait">טוען קוד…</span>`}</div>
      <div class="room-code" dir="ltr">${esc(code)}</div>
      <p class="room-sub">כל זוג סורק עם הטלפון שלו, או מקליד את הקוד ב״הצטרפות לחדר״</p>
      <button class="btn plain room-share" data-r="share">${navigator.share ? "שיתוף הלינק" : "העתקת הלינק"}</button>
    </div>
    ${summary}${settings}
    <h2 style="margin-top:18px">הזוגות בחדר (${n})</h2>${pairs}`;
  const footer = h
    ? `<button class="btn" data-r="start" ${n < 2 ? "disabled" : ""}>${n < 2 ? "מחכים לזוג נוסף…" : "יאללה, מתחילים!"}</button>
       <button class="link" data-r="editPair">עריכת הזוג שלנו</button><button class="link" data-r="closeRoom">סגירת החדר</button>`
    : `<div class="room-wait-row">⏳ מחכים שהמארח יתחיל את המשחק</div>
       <button class="link" data-r="editPair">עריכת הזוג שלנו</button><button class="link" data-r="leave">יציאה מהחדר</button>`;
  return screen(body, footer);
}

function vHandoff(){
  const i = game.turn, p = game.pairs[i], mine = amActive();
  const max = Math.max(...game.pairs.map(x => x.score)), leaders = game.pairs.filter(x => x.score === max).length;
  let notice = "";
  if(max >= game.settings.target) notice = leaders > 1 && i === 0 ? "שוויון בצמרת! ממשיכים לסבב נוסף" : "מישהו עבר את היעד, זה הסבב האחרון";
  const deck = isKid(p) ? "🧸 כרטיסי תמונות" : `📝 ${G.levelLabel}: ${G.levelNames[game.settings.difficulty] || ""}`;
  const body = `<div class="center">
    <div class="round">סבב ${game.round}</div>
    <h1 class="display turn-of">${mine ? "התור שלכם!" : `התור של ${esc(pairName(p, i))}`}</h1>
    ${notice ? `<div class="notice">${notice}</div>` : ""}
    <div class="roles">
      <div class="role"><small>מסביר/ה</small><b>${esc(playerName(p, p.next))}</b></div>
      ${mine ? `<button class="swap" data-r="swap" aria-label="החלפה בין המסביר למנחש">⇄<small>החלפה</small></button>` : ""}
      <div class="role"><small>מנחש/ת</small><b>${esc(playerName(p, 1 - p.next))}</b></div>
    </div>
    <div class="deck-tag">${deck}</div>${board(i)}</div>`;
  const footer = mine ? `<button class="btn" data-r="startTurn">${esc(playerName(p, p.next))} מחזיק/ה את הטלפון, מוכנים!</button>`
    : `<div class="room-wait-row">⏳ מחכים ש${esc(pairName(p, i))} יתחילו</div>`;
  return screen(body, footer);
}

function vTurnActive(){
  const p = game.pairs[game.turn], ts = timerState(T.left, T.total);
  const ok = T.words.filter(w => w.ok).length;
  return `<div class="screen">${bar()}
    <div class="turn"><div class="turn-top">
      <span class="secs" id="secs">${ts.secs}</span>
      <div class="timer ${ts.cls}" id="timer"><i id="bar" style="width:${ts.pct}%"></i></div>
      <button class="pause" data-r="pause" aria-label="השהיה">⏸</button></div>
      <div class="turn-meta"><span>${esc(playerName(p, p.next))} מסביר/ה</span><span>✅ ${ok} &nbsp; ⏭ ${T.words.length - ok}</span></div></div>
    <div class="stage" id="stage">${cardHTML(T.card)}</div>
    <div class="answer">
      <button class="btn red skip" data-r="answer" data-v="0">דלג</button>
      <button class="btn green ok" data-r="answer" data-v="1">✅ ניחשו!</button></div>
    ${T.paused ? `<div class="overlay"><div class="box">
      <h2 class="display">מושהה</h2>
      ${T.restored ? `<p style="margin:-6px 0 4px">התור נשמר. נשארו ${Math.ceil(T.left / 1000)} שניות</p>` : ""}
      <button class="btn" data-r="resume">המשך</button>
      <button class="btn plain" data-r="endTurn">סיום התור עכשיו</button></div></div>` : ""}
  </div>`;
}
function wordList(words, flip){
  if(!words.length) return `<p class="empty">לא נענו מילים בתור הזה</p>`;
  return flip
    ? `<ul class="words">${words.map((w, i) => `<li><button class="${w.ok ? "" : "no"}" data-r="flip" data-i="${i}" aria-pressed="${!!w.ok}">
        <span class="mark">${w.ok ? "✓" : "✕"}</span><span class="w">${w.e ? w.e + " " : ""}${esc(w.w)}</span></button></li>`).join("")}</ul>`
    : `<ul class="rv-words">${words.map(w => `<li class="${w.ok ? "" : "no"}"><span class="mark">${w.ok ? "✓" : "✕"}</span><span>${w.e ? w.e + " " : ""}${esc(w.w)}</span></li>`).join("")}</ul>`;
}
function vTurnOther(){
  const i = game.turn, p = game.pairs[i], t = turnLive && turnLive.tid === game.tid ? turnLive : null;
  const words = t ? arr(t.words) : [], ok = words.filter(w => w.ok).length;
  const ts = t ? timerState(t.left, t.total) : {secs: "", pct: 100, cls: ""};
  const see = showWordOn(game.settings) && t && t.card;
  const body = `<div class="round" style="text-align:center">סבב ${game.round} · התור של ${esc(pairName(p, i))}</div>
    <div class="turn-top"><span class="secs">${ts.secs}</span><div class="timer ${ts.cls}"><i style="width:${ts.pct}%"></i></div></div>
    <div class="turn-meta"><span>${esc(playerName(p, p.next))} מסביר/ה ל${esc(playerName(p, 1 - p.next))}</span><span>✅ ${ok} &nbsp; ⏭ ${words.length - ok}</span></div>
    ${t && t.paused ? `<div class="rv-hidden">⏸<b>התור מושהה</b></div>`
      : see ? `<div class="stage room-stage">${cardHTML(t.card, true)}</div><p class="room-sub" style="text-align:center">🤫 לא לומר בקול! עוקבים שהמסביר/ה לא אומר/ת חלק מהמילה</p>`
      : `<div class="rv-hidden">🤫<b>המילה מוסתרת</b><small>רק ${esc(pairName(p, i))} רואים אותה</small></div>`}
    ${words.length ? wordList(words.slice().reverse()) : ""}${board(i)}`;
  const footer = isHost() && !online(p.uid) ? `<button class="link" data-r="hostEndTurn">${esc(pairName(p, i))} לא מחוברים? סיום התור במקומם</button>` : "";
  return screen(body, footer);
}
function vLastWord(){
  const mine = amActive(), r = game.review;
  if(mine) return screen(`<div class="center">
      <h1 class="display turn-of">הזמן נגמר!</h1>
      <p style="margin:0 0 10px">המילה האחרונה פתוחה לכולם. מי ניחש ראשון?</p>
      <div class="stage lw-card" style="width:100%;padding:0">${cardHTML(r.card)}</div>
      <div class="pick">${game.pairs.map((p, i) => `<button class="btn plain" data-r="lastWord" data-v="${i}">${esc(pairName(p, i))}</button>`).join("")}
        <button class="link" data-r="lastWord" data-v="-1">אף אחד לא ניחש</button></div></div>`);
  return screen(`<div class="center"><h1 class="display turn-of">הזמן נגמר!</h1>
    <div class="rv-hidden">🗣️<b>המילה האחרונה פתוחה לכולם</b><small>מנחשים בקול! ${esc(pairName(game.pairs[game.turn], game.turn))} יסמנו מי ניחש ראשון</small></div>
    ${board(game.turn)}</div>`);
}
function reviewBlock(flip){
  const r = game.review, pts = ptsOf(r.words.map(w => ({ok: !!w.ok})), game.settings);
  return `${wordList(r.words, flip)}
    ${r.lastPair >= 0 && game.pairs[r.lastPair] ? `<div class="lw-row">המילה האחרונה (${r.card.e ? r.card.e + " " : ""}${esc(r.card.w)}): +1 ל${esc(pairName(game.pairs[r.lastPair], r.lastPair))}</div>` : ""}
    <div class="total"><span>נקודות בתור:</span><b>${pts > 0 ? "+" : ""}${pts}</b></div>`;
}
function vSummary(){
  const i = game.turn, p = game.pairs[i], n = nextIdx(), np = game.pairs[n];
  if(amActive()) return screen(`<h2>סיכום התור שלכם</h2>
      <p class="room-lead2">נלחץ משהו בטעות? אפשר ללחוץ על מילה כדי לתקן. אחר כך ${esc(pairName(np, n))} יאשרו.</p>${reviewBlock(true)}`,
    `<button class="btn" data-r="submit">שליחה לאישור של ${esc(pairName(np, n))}</button>`);
  return screen(`<h2>סיכום התור של ${esc(pairName(p, i))}</h2>${reviewBlock(false)}${board(i)}`,
    `<div class="room-wait-row">⏳ ${esc(pairName(p, i))} בודקים את הסיכום${n === myIdx() ? ", ואז תתבקשו לאשר" : ""}</div>`);
}
function vApprove(){
  const i = game.turn, p = game.pairs[i], n = nextIdx(), np = game.pairs[n];
  if(amApprover()) return screen(`<h2>אישור הסיכום של ${esc(pairName(p, i))}</h2>
      <p class="room-lead2">שומעים משהו לא הוגן? אפשר ללחוץ על מילה כדי לשנות אותה, וכולם יראו את השינוי.</p>${reviewBlock(true)}`,
    `<button class="btn green" data-r="approve">✓ מאשרים</button>`);
  const override = isHost() || (amActive() && !online(np.uid));
  return screen(`<h2>סיכום התור של ${esc(pairName(p, i))}</h2>${reviewBlock(false)}${board(i)}`,
    `<div class="room-wait-row">⏳ מחכים לאישור של ${esc(pairName(np, n))}</div>
     ${override ? `<button class="link" data-r="approve">אישור במקומם</button>` : ""}`);
}
function vWinner(){
  const i = game.winner, p = game.pairs[i] || game.pairs[0];
  const sorted = game.pairs.map((x, k) => [x, k]).sort((a, b) => b[0].score - a[0].score);
  return `<div class="screen">${bar()}<div class="confetti" id="confetti"></div>
    <div class="scroll center"><div class="trophy" aria-hidden="true">🏆</div>
      <h1 class="display turn-of">${i === myIdx() ? "ניצחתם!" : `${esc(pairName(p, i))} ניצחו!`}</h1>
      <p style="margin:-8px 0 18px;color:var(--muted)">${esc(playerName(p, 0))} ו${esc(playerName(p, 1))}, ${p.score} נקודות</p>
      <ol class="board">${sorted.map(([x, k], n) => `<li class="${k === i ? "now" : ""}"><span>${["🥇", "🥈", "🥉"][n] || "🎈"}</span>
        <div class="who"><b>${esc(pairName(x, k))}</b></div><span class="pts">${x.score}</span></li>`).join("")}</ol></div>
    <div class="footer">${isHost()
      ? `<button class="btn" data-r="rematch">משחק חוזר עם אותם זוגות</button><button class="link" data-r="closeRoom">סגירת החדר</button>`
      : `<div class="room-wait-row">המארח יכול להתחיל משחק חוזר</div><button class="link" data-r="home">יציאה מהחדר</button>`}</div></div>`;
}

function view(){
  switch(ui.view){
    case "connecting": return msgScreen("📡", "מתחברים לחדר…", "", " ");
    case "error": return msgScreen("😕", esc(ui.msg), "");
    case "closed": return msgScreen("🚪", "החדר נסגר", "המארח סגר את החדר");
    case "form": return vForm();
    case "join": return vJoin();
    case "scan": return vScan();
  }
  if(!game) return msgScreen("📡", "מתחברים לחדר…", "", " ");
  if(host === null) return msgScreen("🚪", "החדר נסגר", "המארח סגר את החדר");
  switch(game.screen){
    case "handoff": return vHandoff();
    case "turn": return amActive() ? (T ? vTurnActive() : msgScreen("⏳", "טוען את התור…", "", " ")) : vTurnOther();
    case "lastword": return vLastWord();
    case "summary": return vSummary();
    case "approve": return vApprove();
    case "winner": return vWinner();
    default: return vLobby();
  }
}
function render(force){
  if(!G || !G.app) return;
  const html = view();
  if(html === lastHTML && !force) return;
  // לא מוחקים טקסט שהמשתמש באמצע להקליד
  const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.ri ? document.activeElement : null;
  const sel = focused ? [focused.dataset.ri, focused.dataset.j, focused.selectionStart] : null;
  lastHTML = html;
  G.app.innerHTML = html;
  if(sel){ const el = G.app.querySelector(`[data-ri="${sel[0]}"]` + (sel[1] != null ? `[data-j="${sel[1]}"]` : "")); if(el){ el.focus(); try{ el.setSelectionRange(sel[2], sel[2]); }catch(e){} } }
  if(game && game.screen === "winner" && ui.view === "room" && confettiFor !== game.tid + ":" + game.round){ confettiFor = game.tid + ":" + game.round; G.confetti && G.confetti(); }
}

/* ---------- QR ---------- */
function loadScript(src){ return new Promise((ok, bad) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); }); }
async function makeQR(text){
  if(!window.qrcode) await loadScript(QR_LIB);
  const q = window.qrcode(0, "M"); q.addData(text); q.make();
  return q.createSvgTag({cellSize: 6, margin: 2, scalable: true});
}

/* ---------- אירועים ---------- */
function wire(){
  G.app.addEventListener("click", e => {
    const el = e.target.closest("[data-r]");
    if(el && !el.disabled && A[el.dataset.r]) A[el.dataset.r](el);
  });
  G.app.addEventListener("input", e => {
    const el = e.target, k = el.dataset.ri;
    if(!k || !ui.form) return;
    if(k === "name") ui.form.name = el.value;
    if(k === "player") ui.form.players[+el.dataset.j].name = el.value;
  });
  // שדה הקוד: אותיות גדולות, עם תרגום ממקלדת עברית, ונכנסים לבד כשהקוד מלא
  G.app.addEventListener("input", e => {
    const el = e.target;
    if(el.dataset.ri !== "code") return;
    const c = cleanCode(el.value);
    if(el.value !== c) el.value = c;
    ui.code = c;
    // בלי לצייר מחדש בכל הקשה, כדי שהמקלדת לא תקפוץ
    if(ui.msg){ ui.msg = ""; render(); }
    else { const b = G.app.querySelector('[data-r="joinCode"]'); if(b) b.disabled = c.length !== CODE_LEN; }
    if(c.length === CODE_LEN && c !== ui.tried && !ui.busy) A.joinCode();
  });
  G.app.addEventListener("keydown", e => {
    if(e.key === "Enter" && e.target.dataset && e.target.dataset.ri === "code" && !ui.busy){ e.preventDefault(); A.joinCode(); }
  });
  document.addEventListener("visibilitychange", () => {
    if(document.hidden){ if(T && !T.paused){ T.paused = true; pushTurn(); render(); } }
    else if(ui.view === "room") wake();
  });
}

/* ---------- עיצוב ---------- */
const css = document.createElement("style");
css.textContent = `
.room-btn{display:flex;align-items:center;gap:12px;width:100%;margin:0 0 16px;padding:12px 14px;border:2px solid var(--edge);border-radius:16px;background:var(--surface);color:var(--text);font-size:16px;text-align:right}
.room-btn .ico{font-size:26px;flex:none}
.room-btn b{display:block;font-size:17px}
.room-btn small{color:var(--muted);font-size:14px}
.room-btns{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 16px}
.room-btns-title{grid-column:1/-1;font-family:"Secular One",Arial,sans-serif;font-size:18px}
.room-btns-title small{font-family:Rubik,Arial,sans-serif;font-size:14px;color:var(--muted);margin-inline-start:6px}
.room-btns .room-btn{margin:0;padding:12px;gap:6px;flex-direction:column;align-items:flex-start}
.room-btns .room-btn .ico{font-size:22px}
.room-btns .room-btn b{font-size:16px}
.room-btns .room-btn small{display:block;font-size:13px}
.room-scan{margin:0}
.room-or{display:flex;align-items:center;gap:10px;color:var(--muted);margin:18px 0 12px;font-size:15px}
.room-or:before,.room-or:after{content:"";flex:1;height:2px;background:var(--soft)}
.room-code-in{display:block;width:100%;box-sizing:border-box;font-family:"Secular One",Arial,sans-serif;font-size:36px;letter-spacing:.3em;text-align:center;text-transform:uppercase;padding:10px 12px 10px calc(12px + .3em);margin-top:6px;border:3px solid var(--edge);border-radius:16px;background:var(--surface);color:var(--text)}
.room-code-in::placeholder{color:var(--soft)}
.room-cam{position:relative;width:min(320px,80vw);aspect-ratio:1;border-radius:22px;overflow:hidden;background:#111;margin:6px auto 14px;border:3px solid var(--edge)}
.room-cam video{width:100%;height:100%;object-fit:cover;display:block}
.room-cam-frame{position:absolute;inset:16%;border:4px solid #fff;border-radius:18px;box-shadow:0 0 0 999px rgba(0,0,0,.35)}
.room-lead2{margin:-4px 0 14px;color:var(--muted);font-size:15px}
.room-qr{background:#fff;border-radius:18px;padding:10px;width:min(220px,58vw);aspect-ratio:1;margin:0 auto;display:grid;place-items:center;border:3px solid var(--edge)}
.room-qr svg{width:100%;height:100%;display:block}
.room-wait{color:#1B2250;font-size:15px}
.room-code{font-family:"Secular One",Arial,sans-serif;font-size:40px;letter-spacing:.2em;line-height:1;margin:12px 0 4px}
.room-sub{margin:0;color:var(--muted);font-size:15px}
.room-share{margin-top:12px;font-size:18px;padding:10px 16px}
.room-set{display:flex;align-items:center;gap:12px;width:100%;margin:18px 0 0;padding:12px 14px;border:2px solid var(--edge);border-radius:16px;background:var(--surface);color:var(--text);text-align:right;font-size:16px}
.room-set.ro{border-color:var(--soft)}
.room-set .ico{font-size:24px;flex:none}
.room-set b{display:block;font-size:17px}
.room-set small{display:block;color:var(--muted);font-size:14px}
.room-set > span:nth-child(2){flex:1;min-width:0}
.room-set-go{flex:none;font-weight:500;text-decoration:underline}
.room-set-panel{background:var(--surface);border-radius:0 0 16px 16px;margin:-6px 0 0;padding:18px 14px 14px;border:2px solid var(--edge);border-top:0}
.room-set-panel .seg button,.room-set-panel .stepper button,.room-set-panel .switch-row{background:var(--bg)}
.room-hint{background:var(--surface);border-radius:14px;padding:10px 14px;margin:0 0 10px!important}
.room-bar{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 18px;background:var(--surface);font-size:15px;border-bottom:2px solid var(--soft)}
.room-bar b{letter-spacing:.12em}
.room-x{flex:none;background:none;border:0;color:var(--muted);font-size:18px;padding:0 0 0 2px}
.room-me{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%}
.room-off{color:var(--tomato);font-weight:500}
.room-tag{display:inline-block;font-family:Rubik,Arial,sans-serif;font-size:12px;font-weight:500;background:var(--soft);border-radius:999px;padding:1px 8px;vertical-align:middle}
.room-tag.off{background:var(--tomato);color:#fff}
.room-wait-row{text-align:center;color:var(--muted);background:var(--surface);border-radius:14px;padding:12px}
.room-stage{padding:10px 0 4px;flex:none}
.card.still{animation:none}
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
  /* opts: game ("alias"/"alias18"), key (מפתח השמירה), app (האלמנט הראשי), decks,
     hasKids, levels, levelNames, levelHints, levelLabel, settings() (ברירות מחדל),
     firstPair() (הזוג הראשון במסך הזוגות), confetti() */
  attach(opts){ G = opts; wire(); },
  boot,
  active: () => taken,
  button(){
    return `<div class="room-btns">
      <div class="room-btns-title">📡 משחק בחדר <small>כל זוג משחק מהטלפון שלו</small></div>
      <button class="room-btn" data-room="create"><span class="ico">➕</span><span><b>פתיחת חדר</b><small>מקבלים QR וקוד</small></span></button>
      <button class="room-btn" data-room="join"><span class="ico">📷</span><span><b>הצטרפות לחדר</b><small>סריקה או קוד</small></span></button>
    </div>`;
  }
};
document.addEventListener("click", e => {
  if(!G) return;
  if(e.target.closest('[data-room="create"]')) startCreate();
  else if(e.target.closest('[data-room="join"]')) startJoin();
});
})();
