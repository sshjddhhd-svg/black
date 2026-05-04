"use strict";
const express      = require("express");
const session      = require("express-session");
const fs           = require("fs-extra");
const path         = require("path");
const http         = require("http");
const { execSync, spawn } = require("child_process");

let _savedPort = 4000;
try { _savedPort = JSON.parse(fs.readFileSync(path.join(__dirname, "panel-config.json"), "utf8")).port || 4000; } catch(_) {}
const PORT         = parseInt(process.env.PANEL_PORT || process.env.PORT || _savedPort);
const PASSWORD     = process.env.PANEL_PASSWORD || "djamel0191tlm";
const ROOT         = path.join(__dirname, "..");
const ACCOUNT_FILE = path.join(ROOT, "account.txt");
const CONFIG_FILE  = path.join(ROOT, "config.json");
const STARTED_AT   = Date.now();

let botProcess = null;
let botRunning = false;
let botLogs    = [];

// ─── Live Log Interceptor ────────────────────────────────────────────────────
// يلتقط كل stdout/stderr من العملية ويحفظها في ذاكرة Ring Buffer
// يعمل على Railway وReplit وأي بيئة أخرى
const LOG_RING_SIZE = 600;
const _logRing = [];

function _stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;]*[mGKHF]/g, "")  // ANSI colors
    .replace(/\x1b\][^\x07]*\x07/g, "")     // OSC
    .replace(/\r/g, "")
    .replace(/<[^>]{0,200}>/g, "");          // HTML tags
}

function _pushLogLine(raw) {
  const clean = _stripAnsi(String(raw));
  const lines = clean.split("\n");
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    if (_logRing.length >= LOG_RING_SIZE) _logRing.shift();
    _logRing.push(t);
  }
}

// Wrap stdout
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function(chunk, encoding, cb) {
  try { _pushLogLine(chunk); } catch(_) {}
  return _origStdoutWrite(chunk, encoding, cb);
};

// Wrap stderr
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function(chunk, encoding, cb) {
  try { _pushLogLine(chunk); } catch(_) {}
  return _origStderrWrite(chunk, encoding, cb);
};
// ─────────────────────────────────────────────────────────────────────────────

// ─── Notification Ring (errors / warnings) ────────────────────────────────────
const NOTIF_MAX   = 80;
const _notifRing  = [];   // { id, ts, level:'error'|'warn'|'info', msg }
let   _notifSeq   = 0;
const _notifSSE   = new Set();

function _pushNotif(level, msg) {
  const n = { id: ++_notifSeq, ts: Date.now(), level, msg: String(msg).substring(0, 280) };
  if (_notifRing.length >= NOTIF_MAX) _notifRing.shift();
  _notifRing.push(n);
  for (const res of _notifSSE) {
    try { res.write(`data: ${JSON.stringify(n)}\n\n`); } catch(_) { _notifSSE.delete(res); }
  }
}

// Hook into log push to auto-detect errors
const _origPushForNotif = _pushLogLine;
global._plfn = function(raw) {
  _origPushForNotif(raw);
  const s = String(raw);
  if (/❌|ERROR|error\b/.test(s))    _pushNotif('error', s.replace(/\x1b\[[0-9;]*m/g,'').trim().substring(0,200));
  else if (/⚠️|WARN/.test(s))        _pushNotif('warn',  s.replace(/\x1b\[[0-9;]*m/g,'').trim().substring(0,200));
};
// replace pushLogLine reference in stdout/stderr wraps — they already captured it by value so just expose
global._panelPushNotif = _pushNotif;

// ─── Per-Thread Message Feed ──────────────────────────────────────────────────
const _msgFeed    = {};   // threadID -> [{ts,senderID,body}]
const MSG_FEED_SZ = 50;
const _feedSSE    = {};   // threadID -> Set<res>

function _trackMsg(threadID, senderID, body) {
  const tid = String(threadID);
  if (!_msgFeed[tid]) _msgFeed[tid] = [];
  const e = { ts: Date.now(), senderID: String(senderID||'?'), body: String(body||'').substring(0,300) };
  _msgFeed[tid].push(e);
  if (_msgFeed[tid].length > MSG_FEED_SZ) _msgFeed[tid].shift();
  if (_feedSSE[tid]) {
    for (const res of _feedSSE[tid]) {
      try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch(_) { _feedSSE[tid].delete(res); }
    }
  }
}
global._panelTrackMsg = _trackMsg;

// ─── Auto-hook FCA API once bot is running ─────────────────────────────────
setInterval(() => {
  const api = global.GoatBot?.fcaApi;
  if (!api || api.__ph) return;
  api.__ph = true;
  // Wrap sendMessage → track outgoing
  if (typeof api.sendMessage === 'function') {
    const _os = api.sendMessage.bind(api);
    api.sendMessage = function(msg, tid, cb, mid) {
      try {
        const body = typeof msg === 'string' ? msg : (msg?.body || '[media]');
        _trackMsg(String(tid || '?'), 'BOT', body);
      } catch(_) {}
      return _os(msg, tid, cb, mid);
    };
  }
  // Log success
  try { process.stdout.write('[PANEL] ✅ FCA API hooked for message feed\n'); } catch(_) {}
}, 4000);

// ─── Log-line parser: extract incoming messages from stdout ───────────────
// Bot events log objects with senderID/threadID/body — capture them
(function _patchStdForMsgFeed() {
  const _orig = process.stdout.write.bind(process.stdout);
  let _ctx = {};
  process.stdout.write = function(chunk, enc, cb) {
    try {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Try to extract full JSON event objects with message data
      const jm = s.match(/\{[^{}]{20,2000}\}/g);
      if (jm) {
        for (const raw of jm) {
          try {
            const o = JSON.parse(raw);
            if (o.threadID && o.senderID && (o.body !== undefined)) {
              _trackMsg(String(o.threadID), String(o.senderID), String(o.body || '[media]'));
            }
          } catch(_) {}
        }
      }
      // Also try multi-line context parsing
      const tid = s.match(/"threadID"\s*:\s*"(\d{10,})"/)?.[1] || s.match(/threadID[:\s=]+(\d{10,})/)?.[1];
      const sid = s.match(/"senderID"\s*:\s*"(\d{10,})"/)?.[1] || s.match(/senderID[:\s=]+(\d{10,})/)?.[1];
      const bod = s.match(/"body"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
      if (tid) _ctx.tid = tid;
      if (sid) _ctx.sid = sid;
      if (bod !== undefined) _ctx.bod = bod;
      if (_ctx.tid && _ctx.sid && _ctx.bod !== undefined) {
        _trackMsg(_ctx.tid, _ctx.sid, _ctx.bod);
        _ctx = {};
      }
      // Reset context after 3 seconds of inactivity (done via flag)
    } catch(_) {}
    return _orig(chunk, enc, cb);
  };
})();
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(session({
  secret: process.env.SESSION_SECRET || "wv3-panel-secret-2024",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12 * 60 * 60 * 1000 }
}));

function auth(req, res, next) {
  if (req.session.loggedIn) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
  return res.redirect("/login");
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch (_) { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function restartBot() {
  try {
    if (global.GoatBot?.reLoginBot && typeof global.GoatBot.reLoginBot === "function") {
      setTimeout(() => { try { global.GoatBot.reLoginBot(); } catch(_) {} }, 500);
    } else {
      setTimeout(() => process.exit(0), 800);
    }
  } catch (_) { setTimeout(() => process.exit(0), 800); }
}

function getUptime() {
  const s   = Math.floor((Date.now() - STARTED_AT) / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function readLastLogs(n = 200) {
  const result = [];

  // ① Ring buffer (live process stdout/stderr) — المصدر الأساسي
  if (_logRing.length > 0) {
    const from = Math.max(0, _logRing.length - n);
    for (let i = from; i < _logRing.length; i++) result.push(_logRing[i]);
  }

  // ② /tmp/logs files (Replit file-based logs) — مصدر احتياطي
  if (result.length === 0) {
    try {
      const logDir = "/tmp/logs";
      if (fs.existsSync(logDir)) {
        const files = fs.readdirSync(logDir)
          .filter(f => f.endsWith(".log"))
          .map(f => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        if (files.length) {
          const content = fs.readFileSync(path.join(logDir, files[0].f), "utf8");
          const lines = content
            .replace(/<[^>]+>/g, "")
            .replace(/\x1b\[[0-9;]*[mGKHF]/g, "")
            .replace(/\r/g, "")
            .split("\n").filter(l => l.trim());
          lines.slice(-n).forEach(l => result.push(l));
        }
      }
    } catch (_) {}
  }

  return result.length ? result : ["⏳ في انتظار السجلات..."];
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colorLog(line) {
  if (line.includes("❌") || line.includes("ERROR") || line.includes("error")) return `<span class="log-error">${htmlEscape(line)}</span>`;
  if (line.includes("⚠️") || line.includes("WARN") || line.includes("warn")) return `<span class="log-warn">${htmlEscape(line)}</span>`;
  if (line.includes("✅") || line.includes("Login successful") || line.includes("SUCCESS")) return `<span class="log-ok">${htmlEscape(line)}</span>`;
  if (line.includes("📌") || line.includes("ADMINBOT")) return `<span class="log-info">${htmlEscape(line)}</span>`;
  return `<span class="log-dim">${htmlEscape(line)}</span>`;
}

// ─── Layout ───────────────────────────────────────────────────────────────────
function layout(title, body, activeTab = "") {
  const tabs = [
    ["status",   "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6", "الرئيسية"],
    ["cookies",  "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z", "الكوكيز"],
    ["config",   "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z", "الإعدادات"],
    ["commands", "M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z", "الأوامر"],
    ["accounts", "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z", "الحسابات"],
    ["logs",     "M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z", "السجلات"],
    ["groups",   "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z", "الغروبات"],
    ["send",     "M12 19l9 2-9-18-9 18 9-2zm0 0v-8", "إرسال رسالة"],
    ["devhub",   "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z", "مركز التطوير"],
    ["devhub/guide", "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253", "دليل المطور"],
  ];

  const nav = tabs.map(([id, icon, label]) => `
    <a href="/${id}" class="nav-item ${activeTab === id ? "active" : ""}" onclick="closeSidebar()">
      <span class="nav-icon-wrap">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${icon}"/></svg>
      </span>
      <span class="nav-label">${label}</span>
      ${activeTab === id ? '<span class="nav-pip"></span>' : ""}
    </a>`).join("");

  const isBotOnline = !!global.GoatBot?.fcaApi;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>WHITE V3 — ${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#07090f;
  --bg2:#0c1120;
  --bg3:#101726;
  --bg4:#16202e;
  --bg5:#1c2a3a;
  --border:rgba(255,255,255,.07);
  --border2:rgba(255,255,255,.12);
  --accent:#3b82f6;
  --accent2:#60a5fa;
  --accent3:#93c5fd;
  --accent-glow:rgba(59,130,246,.2);
  --green:#10b981;
  --green-bg:rgba(16,185,129,.1);
  --yellow:#f59e0b;
  --yellow-bg:rgba(245,158,11,.1);
  --red:#ef4444;
  --red-bg:rgba(239,68,68,.1);
  --text:#f0f4f8;
  --text2:#8fa3b8;
  --text3:#4a6278;
  --purple:#8b5cf6;
  --cyan:#06b6d4;
  --sidebar-w:268px;
  --topbar-h:60px;
  --radius-lg:18px;
  --radius-md:12px;
  --radius-sm:8px;
  --shadow-lg:0 24px 48px rgba(0,0,0,.5),0 8px 16px rgba(0,0,0,.3);
  --shadow-md:0 8px 24px rgba(0,0,0,.4);
  --shadow-sm:0 2px 8px rgba(0,0,0,.3);
}

html{scroll-behavior:smooth}
body{
  background:var(--bg);color:var(--text);font-family:'Cairo',sans-serif;
  min-height:100vh;overflow-x:hidden;
  background-image:
    radial-gradient(ellipse 60% 40% at 80% -10%, rgba(59,130,246,.06) 0%, transparent 60%),
    radial-gradient(ellipse 40% 30% at 10% 90%, rgba(139,92,246,.04) 0%, transparent 50%);
}

/* ════════════════════════════════════
   TOPBAR
════════════════════════════════════ */
.topbar{
  position:fixed;top:0;left:0;right:0;height:var(--topbar-h);
  background:rgba(7,9,15,.85);backdrop-filter:blur(20px) saturate(1.5);
  -webkit-backdrop-filter:blur(20px) saturate(1.5);
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;
  padding:0 20px;z-index:300;
}
.topbar-right{display:flex;align-items:center;gap:12px}
.topbar-left{display:flex;align-items:center;gap:10px}
.topbar-brand{display:flex;align-items:center;gap:10px;text-decoration:none}
.topbar-logo{
  width:36px;height:36px;
  background:linear-gradient(135deg,#3b82f6,#8b5cf6);
  border-radius:10px;display:flex;align-items:center;justify-content:center;
  font-size:1rem;box-shadow:0 4px 12px rgba(59,130,246,.35);flex-shrink:0;
}
.topbar-name{
  font-size:.95rem;font-weight:800;
  background:linear-gradient(90deg,#60a5fa,#a78bfa);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  letter-spacing:.3px;
}
.topbar-page{font-size:.78rem;color:var(--text3);font-weight:500}
.topbar-divider{width:1px;height:20px;background:var(--border);margin:0 2px}

.menu-btn{
  width:38px;height:38px;border-radius:10px;border:1px solid var(--border);
  background:var(--bg3);cursor:pointer;display:flex;align-items:center;justify-content:center;
  color:var(--text2);transition:all .2s;flex-shrink:0;
}
.menu-btn:hover{background:var(--bg4);color:var(--text);border-color:var(--border2)}
.menu-btn.active{background:rgba(59,130,246,.15);border-color:rgba(59,130,246,.4);color:var(--accent2)}
.menu-btn svg{width:18px;height:18px}

.topbar-dot{
  width:8px;height:8px;border-radius:50%;flex-shrink:0;
  background:${isBotOnline ? "var(--green)" : "var(--red)"};
  box-shadow:0 0 10px ${isBotOnline ? "rgba(16,185,129,.6)" : "rgba(239,68,68,.6)"};
  animation:pulse 2s infinite;
}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.7;transform:scale(.85)}}

/* ════════════════════════════════════
   SIDEBAR OVERLAY BACKDROP
════════════════════════════════════ */
.sb-backdrop{
  position:fixed;inset:0;z-index:390;
  background:rgba(0,0,0,.65);
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  opacity:0;pointer-events:none;
  transition:opacity .3s cubic-bezier(.4,0,.2,1);
}
.sb-backdrop.show{opacity:1;pointer-events:all}

/* ════════════════════════════════════
   SIDEBAR  — always overlay, never pushes content
════════════════════════════════════ */
.sidebar{
  position:fixed;top:0;right:0;bottom:0;
  width:var(--sidebar-w);
  background:rgba(10,15,25,.97);
  backdrop-filter:blur(30px) saturate(1.8);
  -webkit-backdrop-filter:blur(30px) saturate(1.8);
  border-left:1px solid var(--border);
  display:flex;flex-direction:column;
  z-index:400;
  transform:translateX(100%);
  transition:transform .35s cubic-bezier(.4,0,.2,1);
  box-shadow:var(--shadow-lg);
  overflow:hidden;
}
.sidebar.open{transform:translateX(0)}

.sidebar-head{
  padding:20px 18px 16px;
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;
  flex-shrink:0;
}
.sb-brand{display:flex;align-items:center;gap:11px}
.sb-logo{
  width:42px;height:42px;
  background:linear-gradient(135deg,#3b82f6,#8b5cf6);
  border-radius:12px;display:flex;align-items:center;justify-content:center;
  font-size:1.2rem;box-shadow:0 6px 18px rgba(59,130,246,.4);flex-shrink:0;
}
.sb-title{font-size:1.05rem;font-weight:800;color:var(--text);letter-spacing:.3px}
.sb-ver{font-size:.68rem;color:var(--text3);margin-top:1px;font-weight:500}
.sb-close{
  width:32px;height:32px;border-radius:8px;border:1px solid var(--border);
  background:var(--bg4);cursor:pointer;display:flex;align-items:center;justify-content:center;
  color:var(--text3);transition:all .2s;flex-shrink:0;
}
.sb-close:hover{background:var(--red-bg);border-color:rgba(239,68,68,.3);color:var(--red)}

.sb-status{
  margin:14px 18px 0;
  display:flex;align-items:center;gap:8px;
  padding:9px 13px;
  background:${isBotOnline ? "rgba(16,185,129,.08)" : "rgba(239,68,68,.08)"};
  border:1px solid ${isBotOnline ? "rgba(16,185,129,.2)" : "rgba(239,68,68,.2)"};
  border-radius:10px;
}
.sb-status-dot{
  width:8px;height:8px;border-radius:50%;flex-shrink:0;
  background:${isBotOnline ? "var(--green)" : "var(--red)"};
  box-shadow:0 0 8px ${isBotOnline ? "rgba(16,185,129,.6)" : "rgba(239,68,68,.6)"};
  animation:pulse 2s infinite;
}
.sb-status-txt{font-size:.8rem;font-weight:600;color:${isBotOnline ? "var(--green)" : "var(--red)"};}

.sb-section-lbl{
  padding:18px 18px 6px;
  font-size:.62rem;color:var(--text3);text-transform:uppercase;letter-spacing:1.4px;font-weight:700;
  flex-shrink:0;
}

.sb-nav{flex:1;overflow-y:auto;padding:4px 10px;overscroll-behavior:contain}
.sb-nav::-webkit-scrollbar{width:0}

.nav-item{
  display:flex;align-items:center;gap:10px;
  padding:10px 12px;margin-bottom:2px;
  border-radius:var(--radius-sm);
  color:var(--text2);text-decoration:none;font-size:.88rem;font-weight:500;
  transition:all .2s cubic-bezier(.4,0,.2,1);cursor:pointer;position:relative;
  overflow:hidden;
}
.nav-item::before{
  content:'';position:absolute;inset:0;border-radius:var(--radius-sm);
  background:linear-gradient(90deg,rgba(59,130,246,.12),rgba(59,130,246,.03));
  opacity:0;transition:opacity .2s;
}
.nav-item:hover{color:var(--text);background:var(--bg4)}
.nav-item:hover::before{opacity:.5}
.nav-item.active{color:var(--accent2);background:rgba(59,130,246,.1);font-weight:600}
.nav-item.active::before{opacity:1}
.nav-icon-wrap{
  width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;
  background:var(--bg5);flex-shrink:0;transition:all .2s;
}
.nav-item:hover .nav-icon-wrap{background:var(--bg4)}
.nav-item.active .nav-icon-wrap{background:rgba(59,130,246,.2);box-shadow:0 0 12px rgba(59,130,246,.2)}
.nav-item svg{opacity:.7;transition:opacity .2s}
.nav-item.active svg,.nav-item:hover svg{opacity:1}
.nav-label{flex:1;white-space:nowrap}
.nav-pip{
  width:6px;height:6px;border-radius:50%;
  background:var(--accent);box-shadow:0 0 8px var(--accent);flex-shrink:0;
}

.sb-footer{
  padding:14px 10px;border-top:1px solid var(--border);flex-shrink:0;
}
.sb-logout{
  display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius-sm);
  color:var(--text3);text-decoration:none;font-size:.86rem;font-weight:500;
  transition:all .2s;
}
.sb-logout:hover{background:var(--red-bg);color:var(--red)}
.sb-logout .nav-icon-wrap{background:var(--bg5)}
.sb-logout:hover .nav-icon-wrap{background:rgba(239,68,68,.15)}

/* ════════════════════════════════════
   MAIN CONTENT — always full width
════════════════════════════════════ */
.main{
  padding:calc(var(--topbar-h) + 24px) 28px 40px;
  min-height:100vh;max-width:1200px;margin:0 auto;
}

/* ════════════════════════════════════
   PAGE HEADER
════════════════════════════════════ */
.page-header{margin-bottom:28px}
.page-title{font-size:1.45rem;font-weight:800;color:var(--text);letter-spacing:-.3px}
.page-sub{font-size:.84rem;color:var(--text3);margin-top:5px;font-weight:400}

/* ════════════════════════════════════
   CARDS
════════════════════════════════════ */
.card{
  background:var(--bg2);
  border:1px solid var(--border);
  border-radius:var(--radius-lg);
  padding:22px;margin-bottom:18px;
  transition:border-color .25s,box-shadow .25s;
  position:relative;overflow:hidden;
}
.card::before{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.06),transparent);
}
.card:hover{border-color:var(--border2)}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;gap:10px}
.card-title{font-size:.93rem;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px}

/* ════════════════════════════════════
   STATS
════════════════════════════════════ */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:22px}
.stat{
  background:var(--bg2);border:1px solid var(--border);
  border-radius:var(--radius-md);padding:18px;
  position:relative;overflow:hidden;transition:all .25s;
}
.stat:hover{border-color:var(--border2);transform:translateY(-2px);box-shadow:var(--shadow-md)}
.stat-glow{
  position:absolute;top:-20px;right:-20px;width:70px;height:70px;
  border-radius:50%;opacity:.15;filter:blur(18px);pointer-events:none;
}
.stat-icon{font-size:1.3rem;margin-bottom:10px}
.stat-val{font-size:1.65rem;font-weight:900;color:var(--text);line-height:1;letter-spacing:-.5px}
.stat-lbl{font-size:.72rem;color:var(--text3);margin-top:6px;font-weight:500}
.stat-blue .stat-glow{background:#3b82f6}
.stat-green .stat-glow{background:#10b981}
.stat-purple .stat-glow{background:#8b5cf6}
.stat-cyan .stat-glow{background:#06b6d4}

/* ════════════════════════════════════
   BADGES
════════════════════════════════════ */
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:.76rem;font-weight:700}
.badge-green{background:var(--green-bg);color:var(--green);border:1px solid rgba(16,185,129,.25)}
.badge-red{background:var(--red-bg);color:var(--red);border:1px solid rgba(239,68,68,.25)}
.badge-yellow{background:var(--yellow-bg);color:var(--yellow);border:1px solid rgba(245,158,11,.25)}
.badge-blue{background:rgba(59,130,246,.1);color:var(--accent2);border:1px solid rgba(59,130,246,.25)}

/* ════════════════════════════════════
   TABLE
════════════════════════════════════ */
.table{width:100%;border-collapse:collapse}
.table th{color:var(--text3);font-size:.74rem;text-transform:uppercase;letter-spacing:.6px;padding:10px 14px;text-align:right;border-bottom:1px solid var(--border);font-weight:700}
.table td{padding:12px 14px;border-bottom:1px solid var(--border);font-size:.87rem;color:var(--text);line-height:1.5}
.table tr:last-child td{border-bottom:none}
.table tr:hover td{background:rgba(255,255,255,.02)}
.table td:first-child,.table th:first-child{text-align:right}

/* ════════════════════════════════════
   FORMS
════════════════════════════════════ */
.form-group{margin-bottom:16px}
.form-label{display:block;font-size:.8rem;color:var(--text2);margin-bottom:7px;font-weight:600;letter-spacing:.2px}
.form-control{
  width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);
  border-radius:var(--radius-sm);padding:10px 13px;font-size:.87rem;font-family:'Cairo',sans-serif;
  transition:all .2s;outline:none;line-height:1.5;
}
.form-control:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow),0 0 0 1px var(--accent)}
.form-control::placeholder{color:var(--text3)}
textarea.form-control{resize:vertical;line-height:1.6}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}

/* ════════════════════════════════════
   BUTTONS
════════════════════════════════════ */
.btn{
  display:inline-flex;align-items:center;gap:6px;
  padding:9px 18px;border-radius:var(--radius-sm);
  font-size:.85rem;font-weight:700;font-family:'Cairo',sans-serif;
  cursor:pointer;border:none;transition:all .2s cubic-bezier(.4,0,.2,1);
  text-decoration:none;white-space:nowrap;letter-spacing:.1px;
}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:#2563eb;transform:translateY(-1px);box-shadow:0 4px 16px rgba(59,130,246,.45)}
.btn-success{background:var(--green);color:#fff}
.btn-success:hover{background:#059669;transform:translateY(-1px);box-shadow:0 4px 16px rgba(16,185,129,.4)}
.btn-danger{background:var(--red);color:#fff}
.btn-danger:hover{background:#dc2626;transform:translateY(-1px);box-shadow:0 4px 16px rgba(239,68,68,.4)}
.btn-outline{background:transparent;color:var(--text2);border:1px solid var(--border)}
.btn-outline:hover{background:var(--bg4);color:var(--text);border-color:var(--border2)}
.btn-sm{padding:6px 13px;font-size:.79rem}
.btn-icon{width:34px;height:34px;padding:0;justify-content:center;border-radius:var(--radius-sm)}
.btn-purple{background:var(--purple);color:#fff}
.btn-purple:hover{background:#7c3aed;transform:translateY(-1px);box-shadow:0 4px 16px rgba(139,92,246,.4)}
.btn-yellow{background:var(--yellow);color:#000}
.btn-yellow:hover{background:#d97706;transform:translateY(-1px)}
.btn-row{display:flex;gap:9px;flex-wrap:wrap;margin-top:16px}

/* ════════════════════════════════════
   LOGS
════════════════════════════════════ */
.log-box{
  background:#030712;border:1px solid var(--border);border-radius:var(--radius-md);
  padding:16px;font-family:'Courier New',monospace;font-size:.76rem;
  max-height:520px;overflow-y:auto;white-space:pre-wrap;line-height:1.75;
}
.log-box::-webkit-scrollbar{width:5px}
.log-box::-webkit-scrollbar-track{background:transparent}
.log-box::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:3px}
.log-error{color:#f87171}
.log-warn{color:#fbbf24}
.log-ok{color:#34d399}
.log-info{color:#60a5fa}
.log-dim{color:#4a6278}

/* ════════════════════════════════════
   BOT CONTROLS
════════════════════════════════════ */
.control-panel{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.control-btn{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:10px;padding:22px 16px;border-radius:var(--radius-md);border:1px solid var(--border);
  cursor:pointer;transition:all .25s cubic-bezier(.4,0,.2,1);text-decoration:none;
  font-family:'Cairo',sans-serif;background:var(--bg3);color:var(--text2);
  font-size:.86rem;font-weight:600;position:relative;overflow:hidden;
}
.control-btn::after{
  content:'';position:absolute;inset:0;opacity:0;
  background:radial-gradient(circle at center,rgba(255,255,255,.06),transparent 70%);
  transition:opacity .2s;
}
.control-btn:hover::after{opacity:1}
.control-btn:hover{transform:translateY(-3px)}
.control-btn .icon{font-size:1.8rem;line-height:1}
.control-btn.green{border-color:rgba(16,185,129,.25);color:var(--green)}
.control-btn.green:hover{background:rgba(16,185,129,.08);box-shadow:0 8px 24px rgba(16,185,129,.15)}
.control-btn.red{border-color:rgba(239,68,68,.25);color:var(--red)}
.control-btn.red:hover{background:rgba(239,68,68,.08);box-shadow:0 8px 24px rgba(239,68,68,.15)}
.control-btn.yellow{border-color:rgba(245,158,11,.25);color:var(--yellow)}
.control-btn.yellow:hover{background:rgba(245,158,11,.08);box-shadow:0 8px 24px rgba(245,158,11,.15)}
.control-btn.blue{border-color:rgba(59,130,246,.25);color:var(--accent2)}
.control-btn.blue:hover{background:rgba(59,130,246,.08);box-shadow:0 8px 24px rgba(59,130,246,.15)}

/* ════════════════════════════════════
   TOAST
════════════════════════════════════ */
#toast-container{
  position:fixed;bottom:28px;left:24px;z-index:9999;
  display:flex;flex-direction:column;gap:9px;pointer-events:none;
}
.toast-msg{
  padding:12px 18px;border-radius:12px;font-size:.84rem;font-weight:600;
  display:flex;align-items:center;gap:10px;
  animation:toastIn .35s cubic-bezier(.34,1.56,.64,1);
  box-shadow:0 12px 32px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.3);
  pointer-events:all;max-width:320px;
}
.toast-success{background:linear-gradient(135deg,#052e1c,#065f46);border:1px solid rgba(16,185,129,.25);color:#6ee7b7}
.toast-error{background:linear-gradient(135deg,#3b0a0a,#7f1d1d);border:1px solid rgba(239,68,68,.25);color:#fca5a5}
.toast-info{background:linear-gradient(135deg,#0a1630,#1e3a8a);border:1px solid rgba(59,130,246,.25);color:#93c5fd}
@keyframes toastIn{from{opacity:0;transform:translateY(16px) scale(.9)}to{opacity:1;transform:translateY(0) scale(1)}}

/* ════════════════════════════════════
   DIVIDER / TOGGLE
════════════════════════════════════ */
.divider{border:none;border-top:1px solid var(--border);margin:20px 0}
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:13px 0;border-bottom:1px solid var(--border)}
.toggle-row:last-child{border-bottom:none}
.toggle-info{font-size:.88rem;color:var(--text);font-weight:500}
.toggle-sub{font-size:.74rem;color:var(--text3);margin-top:3px}
.toggle{position:relative;display:inline-block;width:46px;height:26px;flex-shrink:0}
.toggle input{display:none}
.slider{
  position:absolute;cursor:pointer;inset:0;
  background:rgba(255,255,255,.1);border-radius:26px;transition:.3s;
  border:1px solid var(--border);
}
.slider:before{
  position:absolute;content:"";height:20px;width:20px;left:2px;bottom:2px;
  background:#fff;border-radius:50%;transition:.3s;box-shadow:0 2px 4px rgba(0,0,0,.3);
}
input:checked+.slider{background:var(--accent);border-color:var(--accent)}
input:checked+.slider:before{transform:translateX(20px)}

/* ════════════════════════════════════
   CODE
════════════════════════════════════ */
code{
  background:rgba(59,130,246,.12);color:var(--accent3);
  padding:2px 7px;border-radius:5px;font-size:.81rem;
  font-family:'Courier New',monospace;border:1px solid rgba(59,130,246,.15);
}

/* ════════════════════════════════════
   GRADIENT TEXT / UTILS
════════════════════════════════════ */
.gradient-text{background:linear-gradient(90deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}

/* ════════════════════════════════════
   MOBILE BOTTOM NAV
════════════════════════════════════ */
.mobile-nav{
  display:none;position:fixed;bottom:0;left:0;right:0;
  height:calc(60px + env(safe-area-inset-bottom,0px));
  background:rgba(10,15,25,.92);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border-top:1px solid var(--border);
  flex-direction:row;align-items:flex-start;justify-content:space-around;
  z-index:200;padding:8px 0 env(safe-area-inset-bottom,0px);
}
.mob-nav-item{
  display:flex;flex-direction:column;align-items:center;gap:3px;
  text-decoration:none;color:var(--text3);font-size:.58rem;font-weight:700;
  flex:1;padding:4px 0;transition:color .2s;position:relative;letter-spacing:.2px;
}
.mob-nav-item.active{color:var(--accent2)}
.mob-nav-item.active::after{
  content:'';position:absolute;top:-8px;left:30%;right:30%;height:2px;
  background:linear-gradient(90deg,var(--accent),var(--purple));
  border-radius:0 0 4px 4px;
}
.mob-nav-item svg{width:21px;height:21px;transition:transform .2s}
.mob-nav-item.active svg{transform:scale(1.1)}

/* ════════════════════════════════════
   RESPONSIVE
════════════════════════════════════ */
@media(max-width:768px){
  .main{padding:calc(var(--topbar-h) + 16px) 14px calc(80px + env(safe-area-inset-bottom,0px))}
  .mobile-nav{display:flex}
  .stats-grid{grid-template-columns:repeat(2,1fr);gap:10px}
  .control-panel{grid-template-columns:repeat(2,1fr)}
  .two-col{grid-template-columns:1fr !important}
  .page-title{font-size:1.2rem}
  .card{padding:16px;margin-bottom:14px}
  .btn-row{gap:8px}
  .btn{padding:8px 14px;font-size:.82rem}
  .form-grid{grid-template-columns:1fr}
  #toast-container{left:12px;right:12px;bottom:calc(72px + env(safe-area-inset-bottom,0px))}
  .toast-msg{max-width:100%}
  .log-box{max-height:65vh;font-size:.72rem}
  .table{font-size:.82rem}
  .table th,.table td{padding:8px 10px}
}
@media(max-width:480px){
  .stats-grid{grid-template-columns:repeat(2,1fr)}
  .control-panel{grid-template-columns:repeat(2,1fr)}
}
</style>
</head>
<body>

<!-- Sidebar Backdrop -->
<div class="sb-backdrop" id="sbBackdrop" onclick="closeSidebar()"></div>

<!-- Top Bar -->
<header class="topbar">
  <div class="topbar-right">
    <button class="menu-btn" id="menuBtn" onclick="toggleSidebar()" aria-label="القائمة" title="القائمة">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <a class="topbar-brand" href="/status">
      <div class="topbar-logo">⚪</div>
      <span class="topbar-name">WHITE V3</span>
    </a>
  </div>
  <div class="topbar-left" style="gap:8px">
    <span class="topbar-page" style="display:none" id="pageLabel">${title}</span>
    <!-- Notification Bell -->
    <div style="position:relative">
      <button class="menu-btn" id="notifBtn" onclick="toggleNotifPanel()" title="الإشعارات" aria-label="الإشعارات">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
      </button>
      <span id="notifBadge" style="display:none;position:absolute;top:-3px;left:-3px;min-width:16px;height:16px;border-radius:8px;background:var(--red);color:#fff;font-size:.58rem;font-weight:800;align-items:center;justify-content:center;line-height:1;border:2px solid var(--bg);padding:0 3px">0</span>
    </div>
    <div class="topbar-dot" title="${isBotOnline ? "البوت متصل" : "البوت غير متصل"}"></div>
  </div>

<!-- Notification Panel -->
<div id="notifPanel" style="position:fixed;top:68px;left:16px;width:360px;max-width:calc(100vw - 32px);z-index:9500;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);overflow:hidden;max-height:480px;flex-direction:column;display:none">
  <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
    <span style="font-size:.88rem;font-weight:700;color:var(--text)">🔔 الإشعارات</span>
    <div style="display:flex;gap:8px;align-items:center">
      <button onclick="clearNotifs()" style="font-size:.72rem;color:var(--text3);background:var(--bg4);border:1px solid var(--border);border-radius:6px;padding:3px 9px;cursor:pointer;font-family:'Cairo',sans-serif;transition:all .2s" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text3)'">مسح الكل</button>
      <button onclick="toggleNotifPanel()" style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:1rem;line-height:1;padding:2px">✕</button>
    </div>
  </div>
  <div id="notifList" style="overflow-y:auto;flex:1;padding:8px"></div>
  <div id="notifEmpty" style="padding:32px;text-align:center;color:var(--text3);font-size:.85rem">لا توجد إشعارات</div>
</div>
</header>

<!-- Sidebar -->
<aside class="sidebar" id="mainSidebar">
  <div class="sidebar-head">
    <div class="sb-brand">
      <div class="sb-logo">⚪</div>
      <div>
        <div class="sb-title gradient-text">WHITE V3</div>
        <div class="sb-ver">Panel Control</div>
      </div>
    </div>
    <button class="sb-close" onclick="closeSidebar()" aria-label="إغلاق">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  </div>
  <div class="sb-status">
    <div class="sb-status-dot"></div>
    <span class="sb-status-txt">${isBotOnline ? "البوت متصل ✓" : "البوت غير متصل"}</span>
  </div>
  <div class="sb-section-lbl">التنقل</div>
  <nav class="sb-nav">
    ${nav}
  </nav>
  <div class="sb-footer">
    <a class="sb-logout" href="/logout">
      <span class="nav-icon-wrap">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="17" height="17"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
      </span>
      <span class="nav-label">تسجيل الخروج</span>
    </a>
  </div>
</aside>

<!-- Mobile Bottom Navigation -->
<nav class="mobile-nav">
  <a href="/status" class="mob-nav-item ${activeTab==='status'?'active':''}">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
    الرئيسية
  </a>
  <a href="/commands" class="mob-nav-item ${activeTab==='commands'?'active':''}">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
    الأوامر
  </a>
  <a href="/config" class="mob-nav-item ${activeTab==='config'?'active':''}">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
    إعدادات
  </a>
  <a href="/cookies" class="mob-nav-item ${activeTab==='cookies'?'active':''}">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
    كوكيز
  </a>
  <a href="/devhub" class="mob-nav-item ${activeTab==='devhub'?'active':''}">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
    ديف هاب
  </a>
</nav>

<main class="main">
  <div id="toast-container"></div>
  ${body}
</main>

<script>
function showToast(msg, type='success'){
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast-msg toast-' + type;
  t.innerHTML = msg;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity='0';t.style.transform='translateY(8px)';
    t.style.transition='opacity .3s,transform .3s';
    setTimeout(()=>t.remove(),300);
  }, 3800);
}
async function api(url, data, method='POST'){
  try{
    const r = await fetch(url, {
      method,
      headers:{'Content-Type':'application/json'},
      body: method!=='GET' ? JSON.stringify(data) : undefined
    });
    return await r.json();
  } catch(e){ return {error:e.message}; }
}

const _sidebar  = document.getElementById('mainSidebar');
const _backdrop = document.getElementById('sbBackdrop');
const _menuBtn  = document.getElementById('menuBtn');

function openSidebar(){
  _sidebar.classList.add('open');
  _backdrop.classList.add('show');
  _menuBtn.classList.add('active');
  document.body.style.overflow = 'hidden';
}
function closeSidebar(){
  _sidebar.classList.remove('open');
  _backdrop.classList.remove('show');
  _menuBtn.classList.remove('active');
  document.body.style.overflow = '';
}
function toggleSidebar(){
  _sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
}

// Close on Escape
document.addEventListener('keydown', e => { if(e.key==='Escape') closeSidebar(); });
// Close on resize to prevent stuck state
window.addEventListener('resize', () => { if(window.innerWidth > 900) closeSidebar(); });

// Show page label on mobile topbar
(function(){
  const lbl = document.getElementById('pageLabel');
  if(lbl && window.innerWidth < 500) lbl.style.display='';
})();

// ── Notification System ─────────────────────────────────────────
let _notifPanelOpen = false;
let _notifSeen      = parseInt(localStorage.getItem('wv3_ns') || '0');
let _notifData      = [];

// Ensure panel is hidden on load (belt-and-suspenders)
(function(){ const p=document.getElementById('notifPanel'); if(p) p.style.display='none'; })();

function toggleNotifPanel(){
  _notifPanelOpen = !_notifPanelOpen;
  const p = document.getElementById('notifPanel');
  p.style.display = _notifPanelOpen ? 'flex' : 'none';
  if(_notifPanelOpen){
    _notifSeen = _notifData.length ? _notifData[_notifData.length-1].id : _notifSeen;
    try{ localStorage.setItem('wv3_ns', _notifSeen); }catch(_){}
    renderNotifs();
    hideBadge();
  }
}
function hideBadge(){
  const b = document.getElementById('notifBadge');
  if(b){ b.style.display='none'; b.textContent='0'; }
}
function renderNotifs(){
  const list  = document.getElementById('notifList');
  const empty = document.getElementById('notifEmpty');
  if(!_notifData.length){ list.innerHTML=''; empty.style.display=''; return; }
  empty.style.display='none';
  const icons = {error:'❌',warn:'⚠️',info:'ℹ️'};
  const cols  = {error:'var(--red)',warn:'var(--yellow)',info:'var(--accent2)'};
  list.innerHTML = [..._notifData].reverse().slice(0,40).map(n => {
    const t = new Date(n.ts).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    return \`<div style="padding:9px 10px;border-radius:8px;margin-bottom:6px;background:var(--bg3);border:1px solid var(--border);border-right:3px solid \${cols[n.level]||cols.info}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">
        <span style="font-size:.72rem;color:\${cols[n.level]||cols.info};font-weight:700">\${icons[n.level]||'ℹ️'} \${n.level.toUpperCase()}</span>
        <span style="font-size:.65rem;color:var(--text3);white-space:nowrap">\${t}</span>
      </div>
      <div style="font-size:.76rem;color:var(--text2);margin-top:4px;line-height:1.5;word-break:break-all">\${escN(n.msg)}</div>
    </div>\`;
  }).join('');
}
function escN(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
async function clearNotifs(){
  await fetch('/api/notifications/clear',{method:'POST'});
  _notifData = [];
  renderNotifs();
  hideBadge();
  _notifSeen = _notifSeq||0;
  try{ localStorage.setItem('wv3_ns',_notifSeen); }catch(_){}
}
async function _pollNotifs(){
  try{
    const r = await fetch('/api/notifications');
    if(!r.ok) return;
    const d = await r.json();
    _notifData = d.items||[];
    const unseen = _notifData.filter(n=>n.id > _notifSeen).length;
    const b = document.getElementById('notifBadge');
    if(b){
      if(unseen > 0){ b.textContent = unseen>99?'99+':unseen; b.style.display='flex'; }
      else { b.style.display='none'; }
    }
    if(_notifPanelOpen) renderNotifs();
  }catch(_){}
}
_pollNotifs();
setInterval(_pollNotifs, 12000);

// Close notif panel on outside click
document.addEventListener('click', e=>{
  if(_notifPanelOpen && !document.getElementById('notifPanel').contains(e.target) && !document.getElementById('notifBtn').contains(e.target)){
    _notifPanelOpen = false;
    document.getElementById('notifPanel').style.display='none';
  }
});
</script>
</body>
</html>`;
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.redirect(req.session.loggedIn ? "/status" : "/login"));

app.get("/login", (req, res) => {
  if (req.session.loggedIn) return res.redirect("/status");
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WHITE V3 — تسجيل الدخول</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  background:#070b14;display:flex;align-items:center;justify-content:center;
  min-height:100vh;font-family:'Cairo',sans-serif;
  background-image:radial-gradient(ellipse at 20% 20%, rgba(59,130,246,.08) 0%, transparent 50%),
                   radial-gradient(ellipse at 80% 80%, rgba(139,92,246,.08) 0%, transparent 50%);
}
.login-wrap{text-align:center}
.logo{
  width:70px;height:70px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);
  border-radius:20px;display:flex;align-items:center;justify-content:center;
  font-size:2rem;margin:0 auto 20px;box-shadow:0 10px 30px rgba(59,130,246,.4);
  animation:float 3s ease-in-out infinite;
}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
.title{font-size:1.8rem;font-weight:800;color:#f1f5f9;margin-bottom:4px}
.sub{font-size:.88rem;color:#64748b;margin-bottom:32px}
.box{
  background:#0d1321;border:1px solid #1e2d45;border-radius:16px;
  padding:36px;width:380px;box-shadow:0 20px 60px rgba(0,0,0,.5);
  animation:slideUp .4s ease;
}
@keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.form-group{margin-bottom:18px;text-align:right}
label{display:block;font-size:.82rem;color:#94a3b8;margin-bottom:6px;font-weight:600}
.field{position:relative}
.field-icon{position:absolute;right:12px;top:50%;transform:translateY(-50%);color:#475569;font-size:1rem}
input{
  width:100%;background:#111827;border:1px solid #1e2d45;color:#f1f5f9;
  border-radius:10px;padding:11px 40px 11px 14px;font-size:.9rem;font-family:'Cairo',sans-serif;
  outline:none;transition:all .2s;
}
input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.2)}
.btn{
  width:100%;padding:12px;background:linear-gradient(135deg,#3b82f6,#6366f1);
  color:#fff;border:none;border-radius:10px;font-size:.95rem;font-weight:700;
  font-family:'Cairo',sans-serif;cursor:pointer;transition:all .2s;margin-top:6px;
}
.btn:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(59,130,246,.4)}
.err{color:#f87171;font-size:.83rem;margin-top:14px;padding:10px;background:rgba(239,68,68,.1);border-radius:8px;border:1px solid rgba(239,68,68,.2)}
</style>
</head>
<body>
<div class="login-wrap">
  <div class="logo">⚪</div>
  <div class="title">WHITE V3 Panel</div>
  <div class="sub">لوحة تحكم البوت</div>
  <div class="box">
    <form method="POST" action="/login">
      <div class="form-group">
        <label>كلمة المرور</label>
        <div class="field">
          <span class="field-icon">🔑</span>
          <input type="password" name="password" placeholder="أدخل كلمة المرور" autofocus required/>
        </div>
      </div>
      <button type="submit" class="btn">دخول</button>
      ${req.query.err ? `<div class="err">❌ كلمة المرور غير صحيحة</div>` : ""}
    </form>
  </div>
</div>
</body></html>`);
});

app.post("/login", (req, res) => {
  if (req.body.password === PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect("/status");
  }
  res.redirect("/login?err=1");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ─── STATUS ───────────────────────────────────────────────────────────────────
app.get("/status", auth, (req, res) => {
  const cfg     = readConfig();
  const online  = !!global.GoatBot?.fcaApi;
  const cmds    = global.GoatBot?.commands?.size || 0;
  const threads = global.db?.allThreadData?.length || 0;
  const users   = global.db?.allUserData?.length || 0;
  const memMB   = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const botID   = global.botID || global.GoatBot?.botID || "—";
  const prefix  = cfg.prefix || "/";
  const lang    = cfg.language || "en";
  const version = global.GoatBot?.version || "1.5.35";
  const nick    = cfg.nickNameBot || "WHITE V3";

  const rows = [
    ["معرف البوت", `<code>${botID}</code>`],
    ["الاسم المستعار", htmlEscape(nick)],
    ["البادئة", `<code>${htmlEscape(prefix)}</code>`],
    ["اللغة", lang],
    ["المنطقة الزمنية", cfg.timeZone || "—"],
    ["الإصدار", `<code>${version}</code>`],
    ["الخفاء الذكي", cfg.stealth?.enable !== false ? `<span class="badge badge-green">✅ فعال</span>` : `<span class="badge badge-yellow">معطل</span>`],
    ["مكافحة السبام", cfg.antispam?.enable !== false ? `<span class="badge badge-green">✅ فعال</span>` : `<span class="badge badge-red">معطل</span>`],
    ["تشفير E2EE", cfg.e2ee?.enable !== false ? `<span class="badge badge-green">✅ فعال</span>` : `<span class="badge badge-yellow">معطل</span>`],
    ["تدوير الحسابات", cfg.accountRotation?.enable ? `<span class="badge badge-green">✅ فعال</span>` : `<span class="badge badge-yellow">معطل</span>`],
    ["حماية الغرف", cfg.antiflood?.enable !== false ? `<span class="badge badge-green">✅ فعال</span>` : `<span class="badge badge-red">معطل</span>`],
    ["مضاد الانتحال", cfg.antiImpersonation?.enable !== false ? `<span class="badge badge-green">✅ فعال</span>` : `<span class="badge badge-red">معطل</span>`],
  ].map(([k, v]) => `<tr><td style="color:var(--text3);width:180px">${k}</td><td>${v}</td></tr>`).join("");

  const admins = (cfg.adminBot || []).map(id =>
    `<span class="badge badge-blue" style="margin:3px">${id}</span>`
  ).join(" ");

  const body = `
<div class="page-header">
  <div class="page-title">📊 لوحة التحكم</div>
  <div class="page-sub">مرحباً بك في لوحة تحكم WHITE V3</div>
</div>

<div class="stats-grid">
  <div class="stat stat-blue">
    <div class="stat-glow"></div>
    <div class="stat-icon">💬</div>
    <div class="stat-val">${cmds}</div>
    <div class="stat-lbl">أوامر مُحمَّلة</div>
  </div>
  <div class="stat stat-green">
    <div class="stat-glow"></div>
    <div class="stat-icon">👥</div>
    <div class="stat-val">${threads}</div>
    <div class="stat-lbl">غرف نشطة</div>
  </div>
  <div class="stat stat-purple">
    <div class="stat-glow"></div>
    <div class="stat-icon">👤</div>
    <div class="stat-val">${users}</div>
    <div class="stat-lbl">مستخدمون</div>
  </div>
  <div class="stat stat-cyan">
    <div class="stat-glow"></div>
    <div class="stat-icon">⏱️</div>
    <div class="stat-val" id="stat-uptime" style="font-size:1rem">${getUptime()}</div>
    <div class="stat-lbl">وقت التشغيل</div>
  </div>
  <div class="stat" style="background:var(--bg2);border:1px solid var(--border)">
    <div class="stat-glow" style="background:#f59e0b"></div>
    <div class="stat-icon">💾</div>
    <div class="stat-val" id="stat-mem" style="font-size:1.3rem">${memMB}</div>
    <div class="stat-lbl">RAM (MB)</div>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-title">🎮 التحكم بالبوت</div>
    <span class="badge ${online ? "badge-green" : "badge-red"}">${online ? "🟢 متصل" : "🔴 غير متصل"}</span>
  </div>
  <div class="control-panel">
    <a class="control-btn green" onclick="botControl('restart')">
      <div class="icon">🔄</div>
      <span>إعادة التشغيل</span>
    </a>
    <a class="control-btn red" onclick="botControl('stop')">
      <div class="icon">⛔</div>
      <span>إيقاف البوت</span>
    </a>
    <a class="control-btn blue" onclick="botControl('reload')">
      <div class="icon">♻️</div>
      <span>إعادة تحميل الأوامر</span>
    </a>
    <a class="control-btn yellow" href="/logs">
      <div class="icon">📋</div>
      <span>عرض السجلات</span>
    </a>
  </div>
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px" class="two-col">
  <div class="card">
    <div class="card-header"><div class="card-title">ℹ️ معلومات البوت</div></div>
    <table class="table">${rows}</table>
  </div>
  <div class="card">
    <div class="card-header"><div class="card-title">👑 المشرفون</div></div>
    <div style="line-height:2">${admins || '<span style="color:var(--text3)">لا يوجد مشرفون</span>'}</div>
    <hr class="divider"/>
    <div class="card-title" style="margin-bottom:10px">⭐ السوبر أدمن</div>
    <div style="line-height:2">
      ${(cfg.superAdminBot || []).map(id => `<span class="badge" style="background:rgba(139,92,246,.1);color:#c4b5fd;border:1px solid rgba(139,92,246,.3);margin:3px">${id}</span>`).join(" ") || '<span style="color:var(--text3)">لا يوجد</span>'}
    </div>
  </div>
</div>

<script>
async function botControl(action){
  const labels={restart:'إعادة التشغيل',stop:'إيقاف البوت',reload:'إعادة تحميل الأوامر'};
  const r = await api('/api/bot/control', {action});
  r.ok ? showToast('✅ تم: ' + labels[action], 'success') : showToast('❌ ' + (r.error||'فشل'), 'error');
  if(action !== 'reload') setTimeout(() => location.reload(), 2500);
}

// Auto-refresh status every 15s
setInterval(async () => {
  try {
    const r = await fetch('/api/status');
    if(!r.ok) return;
    const d = await r.json();
    document.querySelectorAll('.status-dot').forEach(el => {
      el.style.background = d.online ? 'var(--green)' : 'var(--red)';
      el.style.boxShadow = d.online ? '0 0 8px var(--green)' : '0 0 8px var(--red)';
    });
    if(d.uptime && document.getElementById('stat-uptime'))
      document.getElementById('stat-uptime').textContent = d.uptime;
    if(d.memMB != null && document.getElementById('stat-mem'))
      document.getElementById('stat-mem').textContent = d.memMB;
  } catch(_){}
}, 15000);
</script>`;
  res.send(layout("الرئيسية", body, "status"));
});

// ─── BOT CONTROL API ──────────────────────────────────────────────────────────
app.post("/api/bot/control", auth, (req, res) => {
  try {
    const { action } = req.body;
    if (action === "stop") {
      process.exit(0);
    } else if (action === "restart") {
      setTimeout(() => process.exit(0), 500);
      res.json({ ok: true });
    } else if (action === "reload") {
      try {
        if (global.GoatBot?.envCommands) {
          const cmdsDir = path.join(ROOT, "scripts/cmds");
          const files = fs.readdirSync(cmdsDir).filter(f => f.endsWith(".js"));
          let count = 0;
          for (const f of files) {
            try {
              const fp = path.join(cmdsDir, f);
              delete require.cache[require.resolve(fp)];
              count++;
            } catch (_) {}
          }
          res.json({ ok: true, reloaded: count });
        } else {
          res.json({ ok: true, note: "Reload triggered" });
        }
      } catch (e) { res.json({ ok: true }); }
    } else {
      res.json({ error: "Unknown action" });
    }
  } catch (e) { res.json({ error: e.message }); }
});

// ─── COOKIES ──────────────────────────────────────────────────────────────────
app.get("/cookies", auth, (req, res) => {
  let current = "";
  let cookieInfo = { c_user: "—", user_valid: false, count: 0 };
  try {
    const raw = fs.readFileSync(ACCOUNT_FILE, "utf8").trim();
    const parsed = JSON.parse(raw);
    current = JSON.stringify(parsed, null, 2);
    if (Array.isArray(parsed)) {
      const cu = parsed.find(c => c.key === "c_user");
      const xs = parsed.find(c => c.key === "xs");
      cookieInfo = { c_user: cu?.value || "—", user_valid: !!(cu && xs), count: parsed.length };
    }
  } catch (_) { current = ""; }

  const body = `
<div class="page-header">
  <div class="page-title">🍪 إدارة الكوكيز</div>
  <div class="page-sub">كوكيز جلسة فيسبوك — تحديثها يُعيد اتصال البوت فوراً</div>
</div>

<!-- Current Status -->
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px">
  <div style="background:var(--bg2);border:1px solid ${cookieInfo.user_valid?"rgba(16,185,129,.4)":"rgba(239,68,68,.4)"};border-radius:12px;padding:16px;text-align:center">
    <div style="font-size:1.6rem">${cookieInfo.user_valid ? "✅" : "❌"}</div>
    <div style="font-size:.78rem;color:var(--text3);margin-top:4px">حالة الكوكيز</div>
    <div style="font-size:.82rem;font-weight:700;color:${cookieInfo.user_valid?"var(--green)":"var(--red)"};margin-top:2px">${cookieInfo.user_valid?"صالحة":"غير صالحة"}</div>
  </div>
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center">
    <div style="font-size:1.6rem">👤</div>
    <div style="font-size:.78rem;color:var(--text3);margin-top:4px">c_user</div>
    <div style="font-size:.78rem;font-weight:700;color:var(--accent2);margin-top:2px;word-break:break-all">${htmlEscape(cookieInfo.c_user)}</div>
  </div>
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center">
    <div style="font-size:1.6rem">🔑</div>
    <div style="font-size:.78rem;color:var(--text3);margin-top:4px">عدد الكوكيز</div>
    <div style="font-size:1.4rem;font-weight:700;color:var(--text);margin-top:2px">${cookieInfo.count}</div>
  </div>
</div>

<!-- Paste Area -->
<div class="card">
  <div class="card-header">
    <div class="card-title">📋 الصق كوكيز جديدة</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-outline btn-sm" onclick="formatJson()">✨ تنسيق</button>
      <button class="btn btn-outline btn-sm" onclick="clearField()">🗑️</button>
    </div>
  </div>
  <div id="cookieValidHint" style="margin-bottom:10px;font-size:.82rem;font-weight:600;height:20px"></div>
  <textarea id="cookieText" class="form-control" rows="10" placeholder='الصق هنا الـ appstate (JSON) — يقبل الصيغتين: مصفوفة كوكيز [ {...}, {...} ] أو كوكيز نصية' style="font-family:'Courier New',monospace;font-size:.74rem;border-color:var(--border);transition:border-color .3s" oninput="validateCookieInput(this)">${htmlEscape(current)}</textarea>
  <div class="btn-row">
    <button class="btn btn-primary" onclick="saveCookies()">💾 حفظ وإعادة الاتصال</button>
    <button class="btn btn-outline" onclick="pasteFromClipboard()">📋 لصق من الحافظة</button>
  </div>
</div>

<!-- Upload File -->
<div class="card">
  <div class="card-header"><div class="card-title">📁 رفع ملف كوكيز</div></div>
  <div style="border:2px dashed var(--border);border-radius:10px;padding:24px;text-align:center;cursor:pointer;transition:all .2s" id="dropZone"
    ondragover="event.preventDefault();this.style.borderColor='var(--accent)'"
    ondragleave="this.style.borderColor='var(--border)'"
    ondrop="handleDrop(event)">
    <div style="font-size:2rem;margin-bottom:8px">📂</div>
    <div style="font-size:.85rem;color:var(--text2)">اسحب وأفلت ملف <code>account.txt</code> أو <code>.json</code></div>
    <div style="font-size:.78rem;color:var(--text3);margin-top:4px">أو</div>
    <label style="cursor:pointer">
      <input type="file" id="fileInput" accept=".txt,.json" style="display:none" onchange="uploadFile()"/>
      <span class="btn btn-outline btn-sm" style="margin-top:8px;display:inline-flex">📂 اختر ملفاً</span>
    </label>
  </div>
  <div id="uploadHint" style="margin-top:8px;font-size:.82rem;height:20px"></div>
</div>

<script>
function validateCookieInput(el){
  const hint=document.getElementById('cookieValidHint');
  const val=el.value.trim();
  if(!val){hint.innerHTML='';el.style.borderColor='var(--border)';return}
  try{
    const p=JSON.parse(val);
    const isArr=Array.isArray(p);
    const hasCuser=isArr&&p.find(c=>c.key==='c_user');
    const hasXs=isArr&&p.find(c=>c.key==='xs');
    if(isArr&&hasCuser&&hasXs){
      hint.innerHTML='<span style="color:var(--green)">✅ كوكيز صالحة — c_user: '+hasCuser.value+'</span>';
      el.style.borderColor='rgba(16,185,129,.6)';
    } else if(isArr){
      hint.innerHTML='<span style="color:var(--yellow)">⚠️ مصفوفة JSON ولكن قد تكون ناقصة (لا c_user أو xs)</span>';
      el.style.borderColor='rgba(245,158,11,.6)';
    } else {
      hint.innerHTML='<span style="color:var(--yellow)">⚠️ JSON صحيح لكن ليس مصفوفة كوكيز</span>';
      el.style.borderColor='rgba(245,158,11,.6)';
    }
  } catch(e){
    hint.innerHTML='<span style="color:var(--red)">❌ ليس JSON صحيحاً: '+e.message.substring(0,50)+'</span>';
    el.style.borderColor='rgba(239,68,68,.6)';
  }
}
async function saveCookies(){
  const val = document.getElementById('cookieText').value.trim();
  if(!val) return showToast('❌ الحقل فارغ', 'error');
  try{ JSON.parse(val) } catch(e){ showToast('❌ JSON غير صحيح: '+e.message,'error'); return }
  const r = await api('/api/cookies',{appstate:val});
  if(r.ok){
    showToast('✅ تم الحفظ! جارٍ إعادة الاتصال...','success');
    if(r.reconnecting) setTimeout(()=>location.reload(),4500);
  } else { showToast('❌ '+r.error,'error'); }
}
function formatJson(){
  const el = document.getElementById('cookieText');
  try{ el.value = JSON.stringify(JSON.parse(el.value), null, 2); validateCookieInput(el); showToast('✅ تم التنسيق','success') }
  catch(e){ showToast('❌ JSON غير صحيح','error') }
}
function clearField(){ const el=document.getElementById('cookieText'); el.value=''; el.style.borderColor='var(--border)'; document.getElementById('cookieValidHint').innerHTML=''; }
async function pasteFromClipboard(){
  try{
    const txt=await navigator.clipboard.readText();
    const el=document.getElementById('cookieText');
    el.value=txt; validateCookieInput(el); showToast('✅ تم اللصق','success');
  }catch(e){ showToast('❌ لا يمكن الوصول للحافظة — الصق يدوياً','error'); }
}
function handleDrop(e){
  e.preventDefault();
  document.getElementById('dropZone').style.borderColor='var(--border)';
  const file=e.dataTransfer.files[0];
  if(!file) return;
  readFile(file);
}
function uploadFile(){
  const f=document.getElementById('fileInput').files[0];
  if(f) readFile(f);
}
function readFile(file){
  const hint=document.getElementById('uploadHint');
  hint.innerHTML='<span style="color:var(--text3)">⏳ جارٍ القراءة...</span>';
  const r=new FileReader();
  r.onload=async function(e){
    const txt=e.target.result;
    try{
      JSON.parse(txt);
      document.getElementById('cookieText').value=txt;
      validateCookieInput(document.getElementById('cookieText'));
      hint.innerHTML='<span style="color:var(--green)">✅ تم تحميل الملف — اضغط حفظ لتطبيقه</span>';
      showToast('✅ تم تحميل الملف — اضغط حفظ','success');
    }catch(ex){ hint.innerHTML='<span style="color:var(--red)">❌ الملف ليس JSON صحيحاً</span>'; showToast('❌ الملف ليس JSON','error'); }
  };
  r.readAsText(file);
}
</script>`;
  res.send(layout("الكوكيز", body, "cookies"));
});

app.post("/api/cookies", auth, (req, res) => {
  try {
    const raw = req.body.appstate;
    if (!raw) return res.json({ error: "لا يوجد appstate" });
    JSON.parse(raw);
    fs.writeFileSync(ACCOUNT_FILE, raw);
    const cfg = readConfig();
    if (req.body.botName !== undefined) cfg.botName = req.body.botName;
    if (req.body.nickname !== undefined) cfg.nickname = req.body.nickname;
    if (req.body.account !== undefined) cfg.account = req.body.account;
    if (req.body.selectedAccount !== undefined) cfg.selectedAccount = req.body.selectedAccount;
    if (req.body.activeIndex !== undefined) cfg.activeIndex = req.body.activeIndex;
    saveConfig(cfg);
    // Try hot-reload: call reLoginBot if available, else restart process
    let reconnecting = false;
    if (global.GoatBot?.reLoginBot && typeof global.GoatBot.reLoginBot === "function") {
      reconnecting = true;
      setTimeout(() => { try { global.GoatBot.reLoginBot(); } catch(_) {} }, 600);
    } else {
      reconnecting = false;
      setTimeout(() => process.exit(0), 800);
    }
    res.json({ ok: true, reconnecting });
  } catch (e) { res.json({ error: e.message }); }
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────
app.get("/config", auth, (req, res) => {
  const cfg = readConfig();

  const toggles = [
    ["stealth", "enable", "🕵️ الخفاء الذكي", "محاكاة سلوك بشري لتجنب الحظر"],
    ["antispam", "enable", "🛡️ مكافحة السبام", "حظر المستخدمين الذين يرسلون رسائل متكررة"],
    ["antiflood", "enable", "🌊 مكافحة الفلود", "حذف الرسائل المتطابقة المتكررة"],
    ["antiImpersonation", "enable", "🎭 مكافحة الانتحال", "كشف من يتظاهر بأنه مشرف"],
    ["reactUnsend", "enable", "💬 حذف الرسائل بالتفاعل", "حذف رسالة عند التفاعل بإيموجي محدد"],
    ["autoRefreshFbstate", null, "🔄 تحديث كوكيز تلقائي", "تجديد كوكيز فيسبوك دورياً"],
    ["autoRestartWhenListenMqttError", null, "🔁 إعادة التشغيل عند خطأ MQTT", "استئناف الاستماع تلقائياً عند حدوث خطأ"],
  ];

  const toggleHtml = toggles.map(([key, sub, label, desc]) => {
    const val = sub ? cfg[key]?.[sub] !== false : cfg[key] !== false;
    const inputId = `toggle_${key}_${sub || "root"}`;
    return `
<div class="toggle-row">
  <div>
    <div class="toggle-info">${label}</div>
    <div class="toggle-sub">${desc}</div>
  </div>
  <label class="toggle">
    <input type="checkbox" id="${inputId}" ${val ? "checked" : ""} onchange="saveToggle('${key}','${sub || ""}',this.checked)"/>
    <span class="slider"></span>
  </label>
</div>`;
  }).join("");

  const body = `
<div class="page-header">
  <div class="page-title">⚙️ إعدادات البوت</div>
  <div class="page-sub">تعديل إعدادات البوت العامة</div>
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px" class="two-col">
<div>
<div class="card">
  <div class="card-header"><div class="card-title">🔧 الإعدادات الأساسية</div></div>
  <div class="form-grid">
    <div class="form-group">
      <label class="form-label">بادئة الأوامر</label>
      <input type="text" id="prefix" class="form-control" value="${htmlEscape(cfg.prefix || "/")}"/>
    </div>
    <div class="form-group">
      <label class="form-label">اللغة (ISO 639-1)</label>
      <input type="text" id="language" class="form-control" value="${htmlEscape(cfg.language || "en")}"/>
    </div>
    <div class="form-group">
      <label class="form-label">اسم البوت</label>
      <input type="text" id="nickNameBot" class="form-control" value="${htmlEscape(cfg.nickNameBot || "")}"/>
    </div>
    <div class="form-group">
      <label class="form-label">المنطقة الزمنية</label>
      <select id="timeZone" class="form-control">
        ${[
          ["Africa/Algiers",        "🇩🇿 الجزائر — تلمسان / وهران / الجزائر العاصمة"],
          ["Africa/Cairo",          "🇪🇬 مصر — القاهرة"],
          ["Africa/Tripoli",        "🇱🇾 ليبيا — طرابلس"],
          ["Asia/Riyadh",           "🇸🇦 السعودية — الرياض"],
          ["Africa/Khartoum",       "🇸🇩 السودان — الخرطوم"],
          ["Europe/Madrid",         "🇪🇸 إسبانيا — مدريد"],
          ["Africa/Tunis",          "🇹🇳 تونس"],
          ["Africa/Casablanca",     "🇲🇦 المغرب — الدار البيضاء"],
          ["Asia/Dubai",            "🇦🇪 الإمارات — دبي"],
          ["Asia/Baghdad",          "🇮🇶 العراق — بغداد"],
          ["UTC",                   "🌐 UTC — التوقيت العالمي"],
        ].map(([val, lbl]) =>
          `<option value="${val}" ${(cfg.timeZone || "Africa/Algiers") === val ? "selected" : ""}>${lbl}</option>`
        ).join("")}
      </select>
    </div>
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" onclick="saveGeneral()">💾 حفظ الإعدادات</button>
  </div>
</div>

<div class="card">
  <div class="card-header"><div class="card-title">🛡️ إعدادات مكافحة السبام</div></div>
  <div class="form-grid">
    <div class="form-group">
      <label class="form-label">الحد الأقصى للرسائل</label>
      <input type="number" id="antispamMax" class="form-control" value="${cfg.antispam?.maxMessages || 6}"/>
    </div>
    <div class="form-group">
      <label class="form-label">النافذة الزمنية (ثانية)</label>
      <input type="number" id="antispamWindow" class="form-control" value="${cfg.antispam?.timeWindowSeconds || 8}"/>
    </div>
    <div class="form-group">
      <label class="form-label">الإجراء عند السبام</label>
      <select id="antispamAction" class="form-control">
        <option value="kick" ${cfg.antispam?.action === "kick" ? "selected" : ""}>🚫 طرد</option>
        <option value="warn" ${cfg.antispam?.action === "warn" ? "selected" : ""}>⚠️ تحذير فقط</option>
        <option value="mute" ${cfg.antispam?.action === "mute" ? "selected" : ""}>🔇 كتم</option>
      </select>
    </div>
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" onclick="saveAntispam()">💾 حفظ</button>
  </div>
</div>

<div class="card">
  <div class="card-header"><div class="card-title">👑 مُعرِّفات المشرفين</div></div>
  <div class="form-group">
    <label class="form-label">المشرفون (واحد في كل سطر)</label>
    <textarea id="adminBot" class="form-control" rows="5" style="font-family:monospace">${htmlEscape((cfg.adminBot || []).join("\n"))}</textarea>
  </div>
  <div class="form-group">
    <label class="form-label">سوبر أدمن (واحد في كل سطر)</label>
    <textarea id="superAdminBot" class="form-control" rows="3" style="font-family:monospace">${htmlEscape((cfg.superAdminBot || []).join("\n"))}</textarea>
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" onclick="saveAdmins()">💾 حفظ</button>
  </div>
</div>
</div>

<div>
<div class="card">
  <div class="card-header"><div class="card-title">⚡ تشغيل / إيقاف الميزات</div></div>
  ${toggleHtml}
</div>
</div>
</div>

<script>
async function saveGeneral(){
  const r = await api('/api/config', {
    prefix: document.getElementById('prefix').value.trim(),
    language: document.getElementById('language').value.trim(),
    nickNameBot: document.getElementById('nickNameBot').value.trim(),
    timeZone: document.getElementById('timeZone').value.trim()
  });
  r.ok ? showToast('✅ تم حفظ الإعدادات العامة!','success') : showToast('❌ '+r.error,'error');
}
async function saveAntispam(){
  const r = await api('/api/config', {
    antispam: {
      maxMessages: parseInt(document.getElementById('antispamMax').value)||6,
      timeWindowSeconds: parseInt(document.getElementById('antispamWindow').value)||8,
      action: document.getElementById('antispamAction').value,
      enable: true, warnBeforeAction: true
    }
  });
  r.ok ? showToast('✅ تم حفظ إعدادات مكافحة السبام!','success') : showToast('❌ '+r.error,'error');
}
async function saveAdmins(){
  const admins = document.getElementById('adminBot').value.split('\\n').map(s=>s.trim()).filter(Boolean);
  const supers = document.getElementById('superAdminBot').value.split('\\n').map(s=>s.trim()).filter(Boolean);
  const r = await api('/api/config', {adminBot: admins, superAdminBot: supers});
  r.ok ? showToast('✅ تم حفظ المشرفين!','success') : showToast('❌ '+r.error,'error');
}
async function saveToggle(key, sub, val){
  const data = {};
  if(sub) { data[key] = {}; data[key][sub] = val; }
  else { data[key] = val; }
  const r = await api('/api/config', data);
  r.ok ? showToast('✅ تم التحديث!','success') : showToast('❌ '+r.error,'error');
}
</script>`;
  res.send(layout("الإعدادات", body, "config"));
});

app.post("/api/config", auth, (req, res) => {
  try {
    const cfg = readConfig();
    const d = req.body;
    const merge = (target, src) => {
      if (typeof src === "object" && !Array.isArray(src)) {
        if (!target || typeof target !== "object") target = {};
        for (const k of Object.keys(src)) target[k] = src[k];
        return target;
      }
      return src;
    };
    const keys = ["prefix","language","nickNameBot","timeZone","autoRefreshFbstate","autoRestartWhenListenMqttError"];
    for (const k of keys) if (d[k] !== undefined) cfg[k] = d[k];
    if (Array.isArray(d.adminBot)) cfg.adminBot = d.adminBot;
    if (Array.isArray(d.superAdminBot)) cfg.superAdminBot = d.superAdminBot;
    const nested = ["antispam","antiflood","stealth","reactUnsend","antiImpersonation","accountRotation","serverUptime","restartListenMqtt"];
    for (const k of nested) if (d[k] !== undefined) cfg[k] = merge(cfg[k] || {}, d[k]);
    saveConfig(cfg);
    if (global.GoatBot?.config) {
      for (const k of Object.keys(cfg)) {
        global.GoatBot.config[k] = cfg[k];
      }
    }
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});

// ─── ACCOUNTS ─────────────────────────────────────────────────────────────────
app.get("/accounts", auth, (req, res) => {
  const cfg      = readConfig();
  const rotation = cfg.accountRotation || {};
  const accounts = rotation.accounts || [];

  const accountCards = accounts.map((acc, i) => {
    const isActive = rotation.currentIndex === i;
    const isRestricted = (rotation.restrictedIndexes || []).includes(i);
    return `
<div style="background:var(--bg3);border:2px solid ${isActive?"rgba(16,185,129,.5)":isRestricted?"rgba(239,68,68,.3)":"var(--border)"};border-radius:12px;padding:16px;position:relative">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
    <div style="display:flex;align-items:center;gap:8px">
      <div style="width:32px;height:32px;border-radius:8px;background:${isActive?"linear-gradient(135deg,#10b981,#059669)":isRestricted?"linear-gradient(135deg,#ef4444,#dc2626)":"linear-gradient(135deg,#3b82f6,#6366f1)"};display:flex;align-items:center;justify-content:center;font-size:.9rem;font-weight:800;color:#fff">${i}</div>
      <div>
        <input type="text" id="label_${i}" class="form-control" value="${htmlEscape(acc.label || `حساب ${i}`)}" style="font-weight:700;font-size:.88rem;padding:4px 8px;width:160px"/>
      </div>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      ${isActive?'<span class="badge badge-green">▶ نشط حالياً</span>':""}
      ${isRestricted?'<span class="badge badge-red">🚫 محظور</span>':""}
    </div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px" class="acc-grid">
    <div>
      <label class="form-label" style="font-size:.75rem">📧 البريد الإلكتروني</label>
      <input type="email" id="email_${i}" class="form-control" value="${htmlEscape(acc.email || "")}" placeholder="email@facebook.com" style="font-size:.83rem"/>
    </div>
    <div>
      <label class="form-label" style="font-size:.75rem">🔑 كلمة المرور</label>
      <div style="position:relative">
        <input type="password" id="pass_${i}" class="form-control" value="${htmlEscape(acc.password || "")}" placeholder="••••••••" style="font-size:.83rem;padding-left:36px"/>
        <button onclick="togglePassVis(${i})" style="position:absolute;left:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text3);font-size:.85rem">👁️</button>
      </div>
    </div>
    <div>
      <label class="form-label" style="font-size:.75rem">🔐 رمز 2FA (اختياري)</label>
      <input type="text" id="tfa_${i}" class="form-control" value="${htmlEscape(acc["2FASecret"] || "")}" placeholder="JBSWY3DPEHPK3PXP" style="font-size:.83rem"/>
    </div>
    <div style="display:flex;align-items:flex-end;gap:8px">
      <button class="btn btn-primary btn-sm" onclick="saveAccount(${i})" style="flex:1">💾 حفظ</button>
      ${!isActive?`<button class="btn btn-success btn-sm" onclick="switchAccount(${i})">▶ تفعيل</button>`:""}
    </div>
  </div>
</div>`;
  }).join("");

  const body = `
<div class="page-header">
  <div class="page-title">👤 نظام الحسابات</div>
  <div class="page-sub">إدارة حسابات فيسبوك والتدوير التلقائي</div>
</div>

<!-- Status Bar -->
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px">
  <div style="background:var(--bg2);border:1px solid ${rotation.enable?"rgba(16,185,129,.4)":"rgba(239,68,68,.35)"};border-radius:12px;padding:14px;text-align:center">
    <div style="font-size:1.5rem">${rotation.enable?"🔄":"⏸️"}</div>
    <div style="font-size:.75rem;color:var(--text3);margin-top:4px">التدوير التلقائي</div>
    <div style="font-size:.82rem;font-weight:700;color:${rotation.enable?"var(--green)":"var(--red)"};">${rotation.enable?"مفعّل":"معطّل"}</div>
  </div>
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center">
    <div style="font-size:1.5rem">👤</div>
    <div style="font-size:.75rem;color:var(--text3);margin-top:4px">الحساب النشط</div>
    <div style="font-size:.82rem;font-weight:700;color:var(--accent2)">#${rotation.currentIndex??0} — ${htmlEscape(accounts[rotation.currentIndex??0]?.label||"—")}</div>
  </div>
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center">
    <div style="font-size:1.5rem">🔢</div>
    <div style="font-size:.75rem;color:var(--text3);margin-top:4px">إجمالي الحسابات</div>
    <div style="font-size:1.4rem;font-weight:700;color:var(--text)">${accounts.length}</div>
  </div>
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center">
    <div style="font-size:1.5rem">⏱️</div>
    <div style="font-size:.75rem;color:var(--text3);margin-top:4px">فترة التبديل</div>
    <div style="font-size:.82rem;font-weight:700;color:var(--text)">${rotation.rotationCooldownMinutes||3} دقيقة</div>
  </div>
</div>

<!-- Controls -->
<div class="card">
  <div class="card-header">
    <div class="card-title">⚙️ التحكم في التدوير</div>
    <span class="badge ${rotation.enable?"badge-green":"badge-red"}">${rotation.enable?"✅ مفعّل":"❌ معطل"}</span>
  </div>
  <div class="btn-row">
    <button class="btn btn-success" onclick="toggleRotator(true)">✅ تفعيل التدوير</button>
    <button class="btn btn-danger" onclick="toggleRotator(false)">⏸️ إيقاف التدوير</button>
    <button class="btn btn-outline" onclick="clearRestricted()">🔓 إزالة الحظر من الكل</button>
    <button class="btn btn-outline" onclick="addNewAccount()">➕ إضافة حساب</button>
  </div>
  ${(rotation.restrictedIndexes||[]).length?`
  <div style="margin-top:12px;padding:10px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);border-radius:8px;font-size:.82rem;color:var(--red)">
    🚫 حسابات محظورة: <strong>${(rotation.restrictedIndexes||[]).join(", ")}</strong>
  </div>`:""}
</div>

<!-- Account Cards -->
<div class="card">
  <div class="card-header">
    <div class="card-title">📱 الحسابات المضافة</div>
    <span class="badge badge-blue">${accounts.length} حساب</span>
  </div>
  ${accounts.length ? `
  <div style="display:grid;gap:14px">${accountCards}</div>
  ` : `
  <div style="text-align:center;padding:30px;color:var(--text3)">
    <div style="font-size:2.5rem;margin-bottom:10px">👤</div>
    <div style="font-size:.88rem">لا توجد حسابات احتياطية — اضغط "إضافة حساب"</div>
  </div>`}
</div>

<!-- Panel Password -->
<div class="card">
  <div class="card-header"><div class="card-title">🔑 كلمة مرور اللوحة</div></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:500px" class="two-col-pw">
    <div class="form-group" style="margin:0">
      <label class="form-label">كلمة المرور الجديدة</label>
      <input type="password" id="newPanelPass" class="form-control" placeholder="••••••••"/>
    </div>
    <div class="form-group" style="margin:0">
      <label class="form-label">تأكيد كلمة المرور</label>
      <input type="password" id="confirmPanelPass" class="form-control" placeholder="••••••••"/>
    </div>
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" onclick="changePanelPass()">🔒 تغيير كلمة المرور</button>
  </div>
  <p style="color:var(--text3);font-size:.77rem;margin-top:10px">⚠️ أضف <code>PANEL_PASSWORD</code> في Railway للتطبيق الدائم</p>
</div>

<style>
@media(max-width:480px){
  .acc-grid{grid-template-columns:1fr !important}
  .two-col-pw{grid-template-columns:1fr !important}
}
</style>
<script>
async function saveAccount(i){
  const r = await api('/api/accounts/save', {
    index:i,
    label: document.getElementById('label_'+i)?.value||'حساب '+i,
    email: document.getElementById('email_'+i).value,
    password: document.getElementById('pass_'+i).value,
    '2FASecret': document.getElementById('tfa_'+i).value
  });
  r.ok ? showToast('✅ تم حفظ الحساب #'+i,'success') : showToast('❌ '+r.error,'error');
}
async function switchAccount(i){
  const r = await api('/api/accounts/switch',{index:i});
  r.ok ? (showToast('✅ تم التبديل للحساب #'+i,'success'), setTimeout(()=>location.reload(),1400)) : showToast('❌ '+(r.error||'فشل'),'error');
}
async function addNewAccount(){
  const r = await api('/api/accounts/add',{});
  r.ok ? (showToast('✅ تم إضافة حساب جديد','success'), setTimeout(()=>location.reload(),1200)) : showToast('❌ '+(r.error||'فشل'),'error');
}
function togglePassVis(i){
  const el=document.getElementById('pass_'+i);
  el.type=el.type==='password'?'text':'password';
}
async function toggleRotator(enable){
  const r = await api('/api/accounts/toggle',{enable});
  r.ok ? (showToast(enable?'✅ تم تفعيل التدوير':'⏸️ تم إيقاف التدوير', enable?'success':'info'), setTimeout(()=>location.reload(),1200)) : showToast('❌ '+r.error,'error');
}
async function clearRestricted(){
  const r = await api('/api/accounts/clearRestricted',{});
  r.ok ? (showToast('✅ تم إزالة القيود عن الكل','success'), setTimeout(()=>location.reload(),1200)) : showToast('❌ '+r.error,'error');
}
function changePanelPass(){
  const p1 = document.getElementById('newPanelPass').value;
  const p2 = document.getElementById('confirmPanelPass').value;
  if(!p1) return showToast('❌ أدخل كلمة مرور','error');
  if(p1 !== p2) return showToast('❌ كلمتا المرور لا تتطابقان','error');
  if(p1.length < 6) return showToast('❌ كلمة المرور قصيرة (6 أحرف على الأقل)','error');
  showToast('⚠️ أضف PANEL_PASSWORD='+p1+' في متغيرات Railway','info');
}
</script>`;
  res.send(layout("الحسابات", body, "accounts"));
});

app.post("/api/accounts/save", auth, (req, res) => {
  try {
    const { index, email, password } = req.body;
    const tfa = req.body["2FASecret"] || "";
    const cfg = readConfig();
    if (!cfg.accountRotation) cfg.accountRotation = { accounts: [] };
    while (cfg.accountRotation.accounts.length <= index) cfg.accountRotation.accounts.push({});
    const acc = cfg.accountRotation.accounts[index];
    acc.email = email; acc.password = password; acc["2FASecret"] = tfa;
    saveConfig(cfg);
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});

app.post("/api/accounts/toggle", auth, (req, res) => {
  try {
    const cfg = readConfig();
    cfg.accountRotation = cfg.accountRotation || {};
    cfg.accountRotation.enable = !!req.body.enable;
    saveConfig(cfg);
    if (global.GoatBot?.config?.accountRotation)
      global.GoatBot.config.accountRotation.enable = cfg.accountRotation.enable;
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});

app.post("/api/accounts/clearRestricted", auth, (req, res) => {
  try {
    const cfg = readConfig();
    if (cfg.accountRotation) cfg.accountRotation.restrictedIndexes = [];
    saveConfig(cfg);
    if (global.GoatBot?.config?.accountRotation)
      global.GoatBot.config.accountRotation.restrictedIndexes = [];
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});

app.post("/api/accounts/add", auth, (req, res) => {
  try {
    const cfg = readConfig();
    if (!cfg.accountRotation) cfg.accountRotation = { accounts: [], enable: false };
    const count = cfg.accountRotation.accounts.length;
    cfg.accountRotation.accounts.push({ label: `حساب ${count}`, email: "", password: "", "2FASecret": "" });
    saveConfig(cfg);
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});

app.post("/api/accounts/switch", auth, (req, res) => {
  try {
    const idx = parseInt(req.body.index);
    const cfg = readConfig();
    if (!cfg.accountRotation) return res.json({ error: "لا يوجد إعداد تدوير" });
    if (isNaN(idx) || idx < 0 || idx >= (cfg.accountRotation.accounts || []).length)
      return res.json({ error: "رقم الحساب غير صحيح" });
    cfg.accountRotation.currentIndex = idx;
    saveConfig(cfg);
    if (global.GoatBot?.config?.accountRotation)
      global.GoatBot.config.accountRotation.currentIndex = idx;
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});

// ─── COMMANDS PAGE ──────────────────────────────────────────────────────────────
function parseCommandConfigs() {
  const cmdsDir = path.join(ROOT, "scripts", "cmds");
  const results = [];
  try {
    const files = fs.readdirSync(cmdsDir).filter(f => f.endsWith(".js"));
    for (const f of files) {
      try {
        const code = fs.readFileSync(path.join(cmdsDir, f), "utf8");
        const nameM  = code.match(/name\s*:\s*["'`]([^"'`]+)["'`]/);
        const roleM  = code.match(/role\s*:\s*(\d)/);
        const cdM    = code.match(/countDown\s*:\s*(\d+)/);
        const catM   = code.match(/category\s*:\s*["'`]([^"'`]+)["'`]/);
        const aliasM = code.match(/aliases\s*:\s*\[([^\]]*)\]/);
        const descM  = code.match(/description\s*[\s\S]{0,5}?en\s*:\s*["'`]([^"'`]{0,120})/);
        if (nameM) results.push({
          file: f,
          name: nameM[1],
          role: roleM ? parseInt(roleM[1]) : 0,
          countDown: cdM ? parseInt(cdM[1]) : 5,
          category: catM ? catM[1] : "عام",
          aliases: aliasM ? aliasM[1].replace(/["'`\s]/g,"").split(",").filter(Boolean) : [],
          desc: descM ? descM[1].substring(0,80) : ""
        });
      } catch(_) {}
    }
  } catch(_) {}
  return results;
}

app.get("/api/commands", auth, (req, res) => {
  res.json({ ok: true, commands: parseCommandConfigs() });
});

app.post("/api/commands/update", auth, (req, res) => {
  try {
    const { file, field, value } = req.body;
    if (!file || !field) return res.json({ error: "file و field مطلوبان" });
    const allowed = ["role","countDown","name","aliases"];
    if (!allowed.includes(field)) return res.json({ error: "الحقل غير مسموح بتعديله: " + field });
    const filePath = path.join(ROOT, "scripts", "cmds", path.basename(file));
    if (!fs.existsSync(filePath)) return res.json({ error: "الملف غير موجود" });
    let code = fs.readFileSync(filePath, "utf8");
    if (field === "role") {
      const roleVal = parseInt(value);
      if (isNaN(roleVal) || roleVal < 0 || roleVal > 3) return res.json({ error: "role يجب أن يكون 0-3" });
      code = code.replace(/(\brole\s*:\s*)(\d)/, `$1${roleVal}`);
    } else if (field === "countDown") {
      const cdVal = parseInt(value);
      if (isNaN(cdVal) || cdVal < 0) return res.json({ error: "countDown يجب أن يكون رقماً موجباً" });
      code = code.replace(/(\bcountDown\s*:\s*)(\d+)/, `$1${cdVal}`);
    } else if (field === "name") {
      const newName = String(value).replace(/[^a-zA-Z0-9_\-]/g,"");
      if (!newName) return res.json({ error: "اسم غير صالح" });
      code = code.replace(/(\bname\s*:\s*["'`])([^"'`]+)(["'`])/, `$1${newName}$3`);
    }
    fs.writeFileSync(filePath, code, "utf8");
    // hot-reload if bot supports it
    if (global.GoatBot?.commands) {
      try {
        delete require.cache[require.resolve(filePath)];
        const mod = require(filePath);
        const cfg = mod.config || mod.module?.exports?.config;
        if (cfg?.name) {
          global.GoatBot.commands.delete(cfg.name);
          global.GoatBot.commands.set(cfg.name, mod);
        }
      } catch(_) {}
    }
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});

app.get("/commands", auth, (req, res) => {
  const cmds = parseCommandConfigs();
  const cats = [...new Set(cmds.map(c => c.category))].sort();

  const roleLabel   = r => ["عام","مشرف","مشرف بوت","أدمن"][r] ?? String(r);
  const roleEmoji   = r => ["👤","👮","🛡️","👑"][r] ?? "🔑";
  const roleBg      = r => ["rgba(96,165,250,.12)","rgba(16,185,129,.12)","rgba(245,158,11,.12)","rgba(239,68,68,.12)"][r] ?? "var(--bg3)";
  const roleBorder  = r => ["rgba(96,165,250,.35)","rgba(16,185,129,.35)","rgba(245,158,11,.35)","rgba(239,68,68,.35)"][r] ?? "var(--border)";
  const roleColor   = r => ["#60a5fa","#6ee7b7","#fbbf24","#f87171"][r] ?? "var(--text2)";

  const byRole = [0,1,2,3].map(r => cmds.filter(c => c.role === r).length);

  const cmdsJson = JSON.stringify(cmds.map(cmd => ({
    name: cmd.name, file: cmd.file, role: cmd.role,
    countDown: cmd.countDown, aliases: cmd.aliases, desc: cmd.desc, category: cmd.category
  })));

  const catPills = cats.map(c =>
    `<button class="cat-pill" data-cat="${htmlEscape(c)}" onclick="setCat(this)">${htmlEscape(c)}</button>`
  ).join("");

  const cards = cmds.map((cmd, i) => `
<div class="cmd-card" tabindex="0"
  data-name="${htmlEscape(cmd.name)}"
  data-cat="${htmlEscape(cmd.category)}"
  data-role="${cmd.role}"
  data-i="${i}">
  <div class="cmd-card-top">
    <span class="cmd-name">${htmlEscape(cmd.name)}</span>
    <span class="cmd-role-badge" style="background:${roleBg(cmd.role)};color:${roleColor(cmd.role)};border-color:${roleBorder(cmd.role)}">${roleEmoji(cmd.role)}</span>
  </div>
  <div class="cmd-card-meta">
    <span class="cmd-cat">${htmlEscape(cmd.category)}</span>
    <span class="cmd-cd">⏱ ${cmd.countDown}s</span>
  </div>
  ${cmd.aliases.length ? `<div class="cmd-aliases">${cmd.aliases.slice(0,3).map(a=>`<code>${htmlEscape(a)}</code>`).join("")}</div>` : ""}
</div>`).join("");

  const body = `
<style>
/* ── Commands page ─────────────────────── */
.cmd-toolbar{
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  background:var(--bg2);border:1px solid var(--border);
  border-radius:var(--radius-md);padding:12px 14px;margin-bottom:14px;
}
.cmd-search{
  flex:1;min-width:160px;background:var(--bg3);border:1px solid var(--border);
  color:var(--text);border-radius:8px;padding:9px 13px;
  font-size:.85rem;font-family:'Cairo',sans-serif;outline:none;transition:all .2s;
}
.cmd-search:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
.cmd-search::placeholder{color:var(--text3)}
.cmd-select{
  background:var(--bg3);border:1px solid var(--border);color:var(--text);
  border-radius:8px;padding:9px 12px;font-size:.82rem;font-family:'Cairo',sans-serif;
  outline:none;cursor:pointer;transition:all .2s;
}
.cmd-select:focus{border-color:var(--accent)}
.cmd-stat-row{
  display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px;
}
.cmd-stat{
  background:var(--bg2);border:1px solid var(--border);border-radius:10px;
  padding:12px 14px;text-align:center;
}
.cmd-stat-val{font-size:1.3rem;font-weight:800;line-height:1}
.cmd-stat-lbl{font-size:.68rem;color:var(--text3);margin-top:4px;font-weight:500}
.cat-pills{
  display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;
}
.cat-pill{
  padding:5px 13px;border-radius:20px;border:1px solid var(--border);
  background:var(--bg3);color:var(--text2);font-family:'Cairo',sans-serif;
  font-size:.76rem;font-weight:600;cursor:pointer;transition:all .2s;white-space:nowrap;
}
.cat-pill:hover{background:var(--bg4);color:var(--text)}
.cat-pill.active{background:rgba(59,130,246,.15);border-color:rgba(59,130,246,.45);color:var(--accent2)}
.cat-pill-all{background:rgba(59,130,246,.1);border-color:rgba(59,130,246,.3);color:var(--accent2)}
.cmd-count-bar{
  font-size:.75rem;color:var(--text3);margin-bottom:10px;font-weight:500;
}
.cmd-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(170px,1fr));
  gap:9px;
}
.cmd-card{
  background:var(--bg2);border-radius:10px;padding:12px 13px;
  cursor:pointer;transition:all .22s cubic-bezier(.4,0,.2,1);
  user-select:none;outline:none;border:1px solid var(--border);
  display:flex;flex-direction:column;gap:7px;
}
.cmd-card:hover,.cmd-card:focus{
  border-color:rgba(59,130,246,.5);
  box-shadow:0 4px 20px rgba(59,130,246,.12);
  transform:translateY(-2px);
}
.cmd-card:active{transform:translateY(0);box-shadow:none}
.cmd-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:6px}
.cmd-name{
  font-weight:700;font-size:.86rem;color:var(--text);
  word-break:break-all;line-height:1.35;flex:1;
}
.cmd-role-badge{
  flex-shrink:0;font-size:.75rem;width:26px;height:26px;border-radius:7px;
  display:flex;align-items:center;justify-content:center;
  border:1px solid;margin-top:1px;
}
.cmd-card-meta{display:flex;align-items:center;justify-content:space-between;gap:4px}
.cmd-cat{
  font-size:.67rem;color:var(--text3);background:var(--bg4);
  padding:2px 8px;border-radius:5px;max-width:70%;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cmd-cd{font-size:.67rem;color:var(--text3);white-space:nowrap}
.cmd-aliases{display:flex;flex-wrap:wrap;gap:4px}
.cmd-aliases code{font-size:.63rem;background:rgba(59,130,246,.1);color:var(--accent3);padding:1px 6px;border-radius:4px;border:none}
.cmd-empty{
  grid-column:1/-1;text-align:center;padding:48px 20px;
  color:var(--text3);font-size:.9rem;
}
/* ── Modal ─────────────────────────────── */
.cmd-modal-backdrop{
  display:none;position:fixed;inset:0;z-index:9000;
  background:rgba(0,0,0,.72);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  align-items:center;justify-content:center;padding:20px;
}
.cmd-modal-backdrop.open{display:flex}
.cmd-modal{
  background:var(--bg2);border:1px solid var(--border);
  border-radius:20px;width:100%;max-width:480px;max-height:90vh;
  overflow-y:auto;box-shadow:0 32px 64px rgba(0,0,0,.6),0 8px 16px rgba(0,0,0,.4);
  transform:scale(.94) translateY(12px);opacity:0;
  transition:transform .28s cubic-bezier(.34,1.56,.64,1),opacity .22s ease;
  position:relative;
}
.cmd-modal-backdrop.open .cmd-modal{transform:scale(1) translateY(0);opacity:1}
.cmd-modal::-webkit-scrollbar{width:4px}
.cmd-modal::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}
.cmd-modal-head{
  padding:20px 20px 0;
  display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
  position:sticky;top:0;background:var(--bg2);z-index:1;
  border-radius:20px 20px 0 0;padding-bottom:14px;
  border-bottom:1px solid var(--border);
}
.cmd-modal-title-wrap{flex:1;min-width:0}
.cmd-modal-sub{font-size:.7rem;color:var(--text3);font-weight:500;margin-bottom:3px}
.cmd-modal-title{font-size:1.15rem;font-weight:800;color:var(--accent2);word-break:break-all}
.cmd-modal-file{font-size:.68rem;color:var(--text3);margin-top:3px;font-family:'Courier New',monospace}
.cmd-modal-close{
  width:34px;height:34px;border-radius:9px;border:1px solid var(--border);
  background:var(--bg4);cursor:pointer;display:flex;align-items:center;justify-content:center;
  color:var(--text2);transition:all .2s;flex-shrink:0;margin-top:2px;
}
.cmd-modal-close:hover{background:var(--red-bg);border-color:rgba(239,68,68,.35);color:var(--red)}
.cmd-modal-body{padding:18px 20px 22px}
.modal-section{margin-bottom:18px}
.modal-section-lbl{
  font-size:.72rem;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;
  font-weight:700;margin-bottom:8px;
}
.role-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.role-btn{
  padding:10px 8px;border-radius:10px;font-family:'Cairo',sans-serif;
  font-size:.8rem;font-weight:700;cursor:pointer;transition:all .2s;
  display:flex;align-items:center;justify-content:center;gap:5px;
  border:1px solid var(--border);background:var(--bg3);color:var(--text2);
}
.role-btn:hover{border-color:var(--border2);background:var(--bg4);color:var(--text)}
.role-btn.active-0{background:rgba(96,165,250,.15)!important;border-color:rgba(96,165,250,.5)!important;color:#60a5fa!important}
.role-btn.active-1{background:rgba(16,185,129,.15)!important;border-color:rgba(16,185,129,.5)!important;color:#6ee7b7!important}
.role-btn.active-2{background:rgba(245,158,11,.15)!important;border-color:rgba(245,158,11,.5)!important;color:#fbbf24!important}
.role-btn.active-3{background:rgba(239,68,68,.15)!important;border-color:rgba(239,68,68,.5)!important;color:#f87171!important}
.cd-row{display:flex;align-items:center;gap:10px}
.cd-range{flex:1;accent-color:var(--accent);height:5px;cursor:pointer}
.cd-input{
  width:70px;background:var(--bg3);border:1px solid var(--border);color:var(--text);
  border-radius:8px;padding:7px 8px;font-size:.9rem;font-family:'Cairo',sans-serif;
  text-align:center;outline:none;transition:all .2s;
}
.cd-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
.cd-display{font-size:.8rem;color:var(--accent2);font-weight:700;margin-top:5px}
.info-box{
  background:var(--bg3);border:1px solid var(--border);border-radius:8px;
  padding:10px 12px;font-size:.78rem;color:var(--text2);line-height:1.6;
}
.info-box code{font-size:.74rem}
.modal-actions{display:flex;gap:8px;padding:0 20px 20px}
.modal-actions .btn{flex:1;justify-content:center}
.modal-saving{
  text-align:center;padding:0 20px 14px;font-size:.82rem;font-weight:600;min-height:22px;
}
@media(max-width:600px){
  .cmd-stat-row{grid-template-columns:repeat(2,1fr)}
  .cmd-grid{grid-template-columns:repeat(2,1fr);gap:8px}
  .cmd-modal-backdrop{padding:0;align-items:flex-end}
  .cmd-modal{max-width:100%;border-radius:20px 20px 0 0;transform:translateY(40px);max-height:92vh}
  .cmd-modal-backdrop.open .cmd-modal{transform:translateY(0)}
  .role-grid{grid-template-columns:1fr 1fr}
}
@media(max-width:360px){
  .cmd-grid{grid-template-columns:1fr}
}
</style>

<div class="page-header">
  <div class="page-title">⚡ إدارة الأوامر</div>
  <div class="page-sub">${cmds.length} أمر محمّل — اضغط على أي أمر لتعديله</div>
</div>

<!-- Stats -->
<div class="cmd-stat-row">
  <div class="cmd-stat">
    <div class="cmd-stat-val" style="color:var(--accent2)">${cmds.length}</div>
    <div class="cmd-stat-lbl">إجمالي الأوامر</div>
  </div>
  <div class="cmd-stat">
    <div class="cmd-stat-val" style="color:#60a5fa">${byRole[0]}</div>
    <div class="cmd-stat-lbl">👤 عام</div>
  </div>
  <div class="cmd-stat">
    <div class="cmd-stat-val" style="color:#fbbf24">${byRole[1]+byRole[2]}</div>
    <div class="cmd-stat-lbl">🛡️ مشرف</div>
  </div>
  <div class="cmd-stat">
    <div class="cmd-stat-val" style="color:#f87171">${byRole[3]}</div>
    <div class="cmd-stat-lbl">👑 أدمن</div>
  </div>
</div>

<!-- Toolbar -->
<div class="cmd-toolbar">
  <input type="text" class="cmd-search" id="cmdSearch" placeholder="🔍 ابحث عن أمر..." oninput="filterCmds()"/>
  <select class="cmd-select" id="roleFilter" onchange="filterCmds()">
    <option value="">🔑 كل الصلاحيات</option>
    <option value="0">👤 عام</option>
    <option value="1">👮 مشرف المجموعة</option>
    <option value="2">🛡️ مشرف البوت</option>
    <option value="3">👑 أدمن البوت</option>
  </select>
</div>

<!-- Category pills -->
<div class="cat-pills">
  <button class="cat-pill cat-pill-all active" data-cat="" onclick="setCat(this)">🗂 الكل</button>
  ${catPills}
</div>

<div class="cmd-count-bar" id="cmdCount">يعرض <strong>${cmds.length}</strong> أمر</div>

<!-- Grid -->
<div id="cmdGrid" class="cmd-grid">
  ${cards}
</div>

<!-- Edit Modal -->
<div class="cmd-modal-backdrop" id="cmdModal" onclick="onBackdropClick(event)">
  <div class="cmd-modal" id="cmdModalBox" onclick="event.stopPropagation()">
    <div class="cmd-modal-head">
      <div class="cmd-modal-title-wrap">
        <div class="cmd-modal-sub">تعديل الأمر</div>
        <div class="cmd-modal-title" id="mTitle">—</div>
        <div class="cmd-modal-file" id="mFile">—</div>
      </div>
      <button class="cmd-modal-close" onclick="closeModal()" aria-label="إغلاق">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="cmd-modal-body">
      <input type="hidden" id="mFileVal"/>
      <input type="hidden" id="mRoleVal" value="0"/>

      <!-- Role -->
      <div class="modal-section">
        <div class="modal-section-lbl">مستوى الصلاحية</div>
        <div class="role-grid">
          <button class="role-btn" data-role="0" onclick="pickRole(0)">👤 عام</button>
          <button class="role-btn" data-role="1" onclick="pickRole(1)">👮 مشرف</button>
          <button class="role-btn" data-role="2" onclick="pickRole(2)">🛡️ مشرف بوت</button>
          <button class="role-btn" data-role="3" onclick="pickRole(3)">👑 أدمن</button>
        </div>
      </div>

      <!-- Cooldown -->
      <div class="modal-section">
        <div class="modal-section-lbl">وقت الانتظار بين الاستخدامات</div>
        <div class="cd-row">
          <input type="range" class="cd-range" id="mCdRange" min="0" max="300" step="1"
            oninput="syncCd(this.value,'range')"/>
          <input type="number" class="cd-input" id="mCdNum" min="0" max="3600"
            oninput="syncCd(this.value,'num')"/>
        </div>
        <div class="cd-display" id="mCdDisplay">0 ثانية</div>
      </div>

      <!-- Name -->
      <div class="modal-section">
        <div class="modal-section-lbl">اسم الأمر <span style="font-weight:400;font-size:.7rem;color:var(--text3);text-transform:none">(اتركه كما هو لعدم التغيير)</span></div>
        <input type="text" class="form-control" id="mNameInput" placeholder="اسم الأمر — بدون مسافات"
          style="font-family:'Courier New',monospace;font-size:.88rem"/>
      </div>

      <!-- Info (aliases + desc) -->
      <div class="modal-section" id="mInfoSection" style="display:none">
        <div class="info-box" id="mInfoBox"></div>
      </div>
    </div>

    <div class="modal-actions">
      <button class="btn btn-primary" onclick="saveCmd()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        حفظ التعديلات
      </button>
      <button class="btn btn-outline" onclick="closeModal()">إلغاء</button>
    </div>
    <div class="modal-saving" id="mStatus"></div>
  </div>
</div>

<script>
const _CMDS = ${cmdsJson};
let _activeCat = '';

// ── Event delegation for cards ──────────────
document.getElementById('cmdGrid').addEventListener('click', e => {
  const card = e.target.closest('.cmd-card');
  if(card) openCmd(parseInt(card.dataset.i));
});
document.getElementById('cmdGrid').addEventListener('keydown', e => {
  if(e.key==='Enter'||e.key===' '){
    const card = e.target.closest('.cmd-card');
    if(card){ e.preventDefault(); openCmd(parseInt(card.dataset.i)); }
  }
});

// ── Filter ──────────────────────────────────
function setCat(btn){
  document.querySelectorAll('.cat-pill').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  _activeCat = btn.dataset.cat;
  filterCmds();
}
function filterCmds(){
  const q    = document.getElementById('cmdSearch').value.toLowerCase().trim();
  const role = document.getElementById('roleFilter').value;
  const cards = document.querySelectorAll('.cmd-card');
  let vis = 0;
  cards.forEach(c => {
    const nameMatch = !q || c.dataset.name.toLowerCase().includes(q);
    const catMatch  = !_activeCat || c.dataset.cat === _activeCat;
    const roleMatch = !role || c.dataset.role === role;
    const show = nameMatch && catMatch && roleMatch;
    c.style.display = show ? '' : 'none';
    if(show) vis++;
  });
  const el = document.getElementById('cmdCount');
  el.innerHTML = 'يعرض <strong>' + vis + '</strong> أمر' + (vis === 0 ? ' — لا توجد نتائج' : '');
  // Show/hide empty state
  let empty = document.getElementById('cmdEmpty');
  if(vis === 0){
    if(!empty){
      empty = document.createElement('div');
      empty.id = 'cmdEmpty';
      empty.className = 'cmd-empty';
      empty.textContent = '😕 لا توجد أوامر تطابق البحث';
      document.getElementById('cmdGrid').appendChild(empty);
    }
  } else {
    if(empty) empty.remove();
  }
}

// ── Modal open ──────────────────────────────
function openCmd(i){
  const cmd = _CMDS[i];
  if(!cmd) return;
  document.getElementById('mTitle').textContent   = cmd.name;
  document.getElementById('mFile').textContent    = cmd.file;
  document.getElementById('mFileVal').value       = cmd.file;
  document.getElementById('mNameInput').value     = cmd.name;
  document.getElementById('mStatus').innerHTML    = '';
  const cd = cmd.countDown || 0;
  document.getElementById('mCdRange').value       = Math.min(300, cd);
  document.getElementById('mCdNum').value         = cd;
  document.getElementById('mCdDisplay').textContent = cd + ' ثانية';
  pickRole(cmd.role || 0);
  // Info box
  const parts = [];
  if(cmd.aliases && cmd.aliases.length)
    parts.push('📎 الأسماء المختصرة: ' + cmd.aliases.map(a=>'<code>'+a+'</code>').join(' '));
  if(cmd.desc)
    parts.push('📄 ' + cmd.desc);
  const infoSection = document.getElementById('mInfoSection');
  if(parts.length){
    document.getElementById('mInfoBox').innerHTML = parts.join('<br/>');
    infoSection.style.display = '';
  } else {
    infoSection.style.display = 'none';
  }
  // Open
  const backdrop = document.getElementById('cmdModal');
  backdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(()=>{ document.getElementById('mNameInput').focus(); }, 280);
}

function onBackdropClick(e){ if(e.target===e.currentTarget) closeModal(); }
function closeModal(){
  const backdrop = document.getElementById('cmdModal');
  backdrop.classList.remove('open');
  document.body.style.overflow = '';
}

// Close modal on Escape (sidebar close handled separately in layout)
document.addEventListener('keydown', e=>{
  if(e.key==='Escape' && document.getElementById('cmdModal').classList.contains('open')){
    e.stopImmediatePropagation();
    closeModal();
  }
});

// ── Role picker ─────────────────────────────
function pickRole(r){
  document.getElementById('mRoleVal').value = r;
  document.querySelectorAll('.role-btn').forEach(b=>{
    b.className = 'role-btn';
    if(parseInt(b.dataset.role) === r) b.classList.add('active-'+r);
  });
}

// ── Cooldown sync ────────────────────────────
function syncCd(val, from){
  const n = Math.max(0, parseInt(val)||0);
  if(from==='range'){
    document.getElementById('mCdNum').value = n;
  } else {
    document.getElementById('mCdRange').value = Math.min(300, n);
  }
  document.getElementById('mCdDisplay').textContent = n + ' ثانية';
}

// ── Save ─────────────────────────────────────
async function saveCmd(){
  const file     = document.getElementById('mFileVal').value;
  const role     = document.getElementById('mRoleVal').value;
  const cd       = document.getElementById('mCdNum').value;
  const origName = document.getElementById('mTitle').textContent;
  const newName  = document.getElementById('mNameInput').value.trim();
  const st       = document.getElementById('mStatus');
  st.innerHTML   = '<span style="color:var(--text3)">⏳ جارٍ الحفظ...</span>';

  const updates = [
    { file, field:'role', value:role },
    { file, field:'countDown', value:cd }
  ];
  if(newName && newName !== origName)
    updates.push({ file, field:'name', value:newName });

  let allOk = true;
  for(const u of updates){
    const r = await api('/api/commands/update', u);
    if(!r.ok){
      st.innerHTML = '<span style="color:var(--red)">❌ ' + (r.error||'فشل') + '</span>';
      allOk = false;
      break;
    }
  }
  if(allOk){
    st.innerHTML = '<span style="color:var(--green)">✅ تم الحفظ بنجاح!</span>';
    showToast('✅ تم تحديث الأمر: ' + origName, 'success');
    // Update card data attribute
    const finalName = (newName && newName !== origName) ? newName : origName;
    const card = document.querySelector('.cmd-card[data-name="'+CSS.escape(origName)+'"]');
    if(card){
      card.dataset.role = role;
      if(finalName !== origName) card.dataset.name = finalName;
      const nameEl = card.querySelector('.cmd-name');
      if(nameEl) nameEl.textContent = finalName;
    }
    setTimeout(closeModal, 1200);
  }
}
</script>`;
  res.send(layout("الأوامر", body, "commands"));
});

// ─── LOGS JSON API ─────────────────────────────────────────────────────────────
app.get("/api/logs/json", auth, (req, res) => {
  const since = parseInt(req.query.since || "0");
  const lines = readLastLogs(200);
  res.json({ lines, time: Date.now(), total: _logRing.length, since });
});

// ─── LOGS SSE (Server-Sent Events) — بث مباشر ────────────────────────────────
// يبثّ السجلات الجديدة فور ظهورها بدون حاجة لـ polling
const _sseClients = new Set();

app.get("/api/logs/stream", auth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // إرسال آخر 200 سطر عند الاتصال
  const initial = readLastLogs(200);
  res.write(`data: ${JSON.stringify({ type: "init", lines: initial })}\n\n`);

  const client = { res, lastIdx: _logRing.length };
  _sseClients.add(client);

  const hb = setInterval(() => {
    try { res.write(": ping\n\n"); } catch(_) {}
  }, 20000);

  req.on("close", () => {
    clearInterval(hb);
    _sseClients.delete(client);
  });
});

// داخلي: ضخ السجلات الجديدة لكل العملاء المتصلين
function _broadcastNewLogs() {
  if (_sseClients.size === 0) return;
  for (const client of _sseClients) {
    const newLines = _logRing.slice(client.lastIdx);
    if (!newLines.length) continue;
    client.lastIdx = _logRing.length;
    try {
      client.res.write(`data: ${JSON.stringify({ type: "append", lines: newLines })}\n\n`);
    } catch(_) { _sseClients.delete(client); }
  }
}

// Hook إلى _pushLogLine لإخطار العملاء بالسجلات الجديدة فور ظهورها
const _origPushLogLine = _pushLogLine;
// إعادة تعريف _pushLogLine مع broadcast
{
  const _original = _pushLogLine;
  Object.defineProperty(global, "__wv3BroadcastLogs__", {
    value: _broadcastNewLogs, writable: true, configurable: true
  });
}
// استبدال write لإضافة broadcast
const __origStdout2 = process.stdout.write;
process.stdout.write = function(chunk, enc, cb) {
  const r = __origStdout2.call(process.stdout, chunk, enc, cb);
  setImmediate(() => { try { _broadcastNewLogs(); } catch(_) {} });
  return r;
};
const __origStderr2 = process.stderr.write;
process.stderr.write = function(chunk, enc, cb) {
  const r = __origStderr2.call(process.stderr, chunk, enc, cb);
  setImmediate(() => { try { _broadcastNewLogs(); } catch(_) {} });
  return r;
};

// ─── LOGS ─────────────────────────────────────────────────────────────────────
app.get("/logs", auth, (req, res) => {
  const lines = readLastLogs(200);

  const body = `
<div class="page-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
  <div>
    <div class="page-title">📋 سجلات النظام</div>
    <div class="page-sub" id="logCount">آخر ${lines.length} سطر — <span id="liveStatus" style="color:var(--green)">🟢 تحديث حي</span></div>
  </div>
  <div class="btn-row" style="margin:0;flex-wrap:wrap">
    <button class="btn btn-outline btn-sm" onclick="fetchLogsManual()">🔄 تحديث</button>
    <button class="btn btn-outline btn-sm" onclick="scrollBottom()">⬇️ الأسفل</button>
    <button class="btn btn-sm" id="autoRefBtn" onclick="toggleAutoRefresh()" style="background:rgba(16,185,129,.15);color:var(--green);border:1px solid rgba(16,185,129,.3)">⏹️ إيقاف التلقائي</button>
    <button class="btn btn-outline btn-sm" onclick="clearSearch()">🗑️ مسح الفلتر</button>
  </div>
</div>

<div class="card" style="padding:0;overflow:hidden">
  <div style="display:flex;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center">
    <button class="btn btn-outline btn-sm" onclick="setFilter('')">الكل</button>
    <button class="btn btn-sm" style="background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3)" onclick="setFilter('ERROR')">❌ أخطاء</button>
    <button class="btn btn-sm" style="background:rgba(245,158,11,.15);color:var(--yellow);border:1px solid rgba(245,158,11,.3)" onclick="setFilter('WARN')">⚠️ تحذيرات</button>
    <button class="btn btn-sm" style="background:rgba(16,185,129,.15);color:var(--green);border:1px solid rgba(16,185,129,.3)" onclick="setFilter('✅')">✅ نجاح</button>
    <button class="btn btn-sm" style="background:rgba(59,130,246,.15);color:var(--accent2);border:1px solid rgba(59,130,246,.3)" onclick="setFilter('LOGIN')">🔑 دخول</button>
    <div style="flex:1;min-width:120px">
      <input type="text" class="form-control" style="width:100%" placeholder="🔍 بحث..." oninput="searchLogs(this.value)" id="searchInput"/>
    </div>
  </div>
  <div class="log-box" id="logBox" style="border:none;border-radius:0;max-height:calc(100vh - 280px)"></div>
</div>

<script>
let allLines = ${JSON.stringify(lines)};
let currentFilter = '';
let currentSearch = '';
let autoScrollEnabled = true;
let isLive = false;
let _sse = null;
let _fallbackInterval = null;

function escHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function colorClass(line){
  if(line.includes('❌')||line.includes('ERROR')||line.includes('error')) return 'log-error';
  if(line.includes('⚠️')||line.includes('WARN')||line.includes('warn'))   return 'log-warn';
  if(line.includes('✅')||line.includes('SUCCESS')||line.includes('Login successful')) return 'log-ok';
  if(line.includes('📌')||line.includes('ADMINBOT'))  return 'log-info';
  return 'log-dim';
}

function renderLines(ls){
  const box = document.getElementById('logBox');
  const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.innerHTML = ls.map(line =>
    '<span class="'+colorClass(line)+'">'+escHtml(line)+'</span>'
  ).join('\\n');
  if(wasAtBottom || autoScrollEnabled) scrollBottom();
}

function appendLines(newLines){
  const box = document.getElementById('logBox');
  const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  const filtered = newLines.filter(l => {
    if(currentFilter && !l.includes(currentFilter)) return false;
    if(currentSearch && !l.toLowerCase().includes(currentSearch.toLowerCase())) return false;
    // Add to allLines too
    allLines.push(l);
    if(allLines.length > 600) allLines.shift();
    return true;
  });
  if(!filtered.length) return;
  const frag = filtered.map(l =>
    '<span class="'+colorClass(l)+'">'+escHtml(l)+'</span>'
  ).join('\\n');
  box.innerHTML += (box.innerHTML ? '\\n' : '') + frag;
  if(wasAtBottom) scrollBottom();
  updateCount();
}

function applyFilters(){
  let ls = allLines;
  if(currentFilter) ls = ls.filter(l=>l.includes(currentFilter));
  if(currentSearch) ls = ls.filter(l=>l.toLowerCase().includes(currentSearch.toLowerCase()));
  renderLines(ls);
  updateCount();
}

function updateCount(){
  document.getElementById('logCount').innerHTML =
    'إجمالي '+allLines.length+' سطر — <span id="liveStatus" style="color:'+(isLive?'var(--green)':'var(--yellow)')+'">'+
    (isLive ? '🟢 بث مباشر' : '🟡 polling')+'</span>';
}

function setFilter(f){ currentFilter=f; applyFilters(); }
function searchLogs(q){ currentSearch=q; applyFilters(); }
function clearSearch(){ currentFilter=''; currentSearch=''; document.getElementById('searchInput').value=''; applyFilters(); }
function scrollBottom(){ const b=document.getElementById('logBox'); b.scrollTop=b.scrollHeight; }

// ── SSE الاتصال المباشر ──────────────────────────────────────────────────────
function connectSSE(){
  if(_sse){ _sse.close(); _sse=null; }
  try {
    _sse = new EventSource('/api/logs/stream');
    _sse.onopen = () => {
      isLive = true;
      if(_fallbackInterval){ clearInterval(_fallbackInterval); _fallbackInterval=null; }
      updateCount();
    };
    _sse.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if(d.type === 'init'){
          allLines = d.lines || [];
          applyFilters();
        } else if(d.type === 'append' && d.lines && d.lines.length){
          appendLines(d.lines);
        }
      } catch(_) {}
    };
    _sse.onerror = () => {
      isLive = false;
      updateCount();
      _sse.close(); _sse = null;
      // Fallback: polling كل 4 ثوانٍ إذا فشل SSE
      if(!_fallbackInterval) _fallbackInterval = setInterval(fetchLogs, 4000);
      // إعادة المحاولة بعد 8 ثوانٍ
      setTimeout(connectSSE, 8000);
    };
  } catch(err){
    // المتصفح لا يدعم SSE — fallback polling
    if(!_fallbackInterval) _fallbackInterval = setInterval(fetchLogs, 4000);
  }
}

// ── Polling كـ fallback ───────────────────────────────────────────────────────
async function fetchLogs(){
  try{
    const r = await fetch('/api/logs/json');
    if(!r.ok) return;
    const d = await r.json();
    if(d.lines && d.lines.length > 0){ allLines = d.lines; applyFilters(); }
  } catch(e){}
}

async function fetchLogsManual(){ await fetchLogs(); showToast('🔄 تم تحديث السجلات','info'); }

function toggleAutoRefresh(){
  const btn = document.getElementById('autoRefBtn');
  if(_sse || _fallbackInterval){
    if(_sse){ _sse.close(); _sse=null; }
    if(_fallbackInterval){ clearInterval(_fallbackInterval); _fallbackInterval=null; }
    isLive = false;
    btn.textContent='▶️ تشغيل المباشر';
    btn.style.cssText='background:rgba(59,130,246,.15);color:var(--accent2);border:1px solid rgba(59,130,246,.3)';
  } else {
    connectSSE();
    btn.textContent='⏹️ إيقاف المباشر';
    btn.style.cssText='background:rgba(16,185,129,.15);color:var(--green);border:1px solid rgba(16,185,129,.3)';
    showToast('✅ البث المباشر نشط','success');
  }
  updateCount();
}

// بداية تلقائية
applyFilters();
scrollBottom();
connectSSE();
</script>`;
  res.send(layout("السجلات", body, "logs"));
});

// ─── API STATUS (JSON) ─────────────────────────────────────────────────────────
app.get("/api/status", auth, (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    online:    !!global.GoatBot?.fcaApi,
    botID:     global.botID || null,
    commands:  global.GoatBot?.commands?.size || 0,
    threads:   global.db?.allThreadData?.length || 0,
    users:     global.db?.allUserData?.length || 0,
    uptime:    getUptime(),
    panelPort: PORT,
    memMB:     Math.round(mem.rss / 1024 / 1024),
    heapMB:    Math.round(mem.heapUsed / 1024 / 1024),
    nodeVer:   process.version
  });
});

// ─── NOTIFICATIONS API ─────────────────────────────────────────────────────────
app.get("/api/notifications", auth, (req, res) => {
  res.json({ ok: true, items: _notifRing.slice(-60), total: _notifRing.length });
});
app.post("/api/notifications/clear", auth, (req, res) => {
  _notifRing.length = 0;
  res.json({ ok: true });
});
app.get("/api/notifications/stream", auth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  _notifRing.slice(-20).forEach(n => res.write(`data: ${JSON.stringify(n)}\n\n`));
  _notifSSE.add(res);
  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch(_) {} }, 25000);
  req.on("close", () => { clearInterval(hb); _notifSSE.delete(res); });
});

// ─── GROUPS / THREADS API ──────────────────────────────────────────────────────
app.get("/api/groups", auth, (req, res) => {
  const threads = (global.db?.allThreadData || []).map(t => ({
    threadID:    t.threadID,
    name:        t.threadInfo?.threadName || t.threadID,
    memberCount: t.threadInfo?.participantIDs?.length || t.threadInfo?.userInfo?.length || 0,
    isGroup:     t.threadInfo?.isGroup !== false,
    emoji:       t.threadInfo?.emoji || null,
    adminIDs:    (t.threadInfo?.adminIDs || []).map(a => a.id || a),
    msgCount:    (_msgFeed[t.threadID]?.length) || 0,
  }));
  res.json({ ok: true, threads, total: threads.length });
});

app.get("/api/groups/:id/feed", auth, (req, res) => {
  const tid = req.params.id;
  res.json({ ok: true, messages: (_msgFeed[tid] || []).slice(-50), threadID: tid });
});

app.get("/api/groups/:id/feed/stream", auth, (req, res) => {
  const tid = req.params.id;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  (_msgFeed[tid] || []).slice(-20).forEach(m => res.write(`data: ${JSON.stringify(m)}\n\n`));
  if (!_feedSSE[tid]) _feedSSE[tid] = new Set();
  _feedSSE[tid].add(res);
  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch(_) {} }, 25000);
  req.on("close", () => { clearInterval(hb); if (_feedSSE[tid]) _feedSSE[tid].delete(res); });
});

// ─── QUICK SEND API ────────────────────────────────────────────────────────────
app.post("/api/send", auth, (req, res) => {
  try {
    const { threadID, message } = req.body;
    if (!threadID || !message) return res.json({ error: "threadID و message مطلوبان" });
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ error: "البوت غير متصل" });
    api.sendMessage(message, threadID, (err) => {
      if (err) return res.json({ error: err.message || String(err) });
      res.json({ ok: true });
    });
  } catch (e) { res.json({ error: e.message }); }
});

// ─── QUICK SEND PAGE ──────────────────────────────────────────────────────────
app.get("/send", auth, (req, res) => {
  const threadCount = (global.db?.allThreadData || []).length;

  const body = `
<style>
.group-card{background:var(--bg2);border:1.5px solid var(--border);border-radius:14px;padding:14px;cursor:pointer;transition:all .22s cubic-bezier(.4,0,.2,1);position:relative;overflow:hidden}
.group-card:hover{border-color:rgba(99,102,241,.5);background:var(--bg3);transform:translateY(-2px);box-shadow:var(--shadow)}
.group-card.selected{border-color:var(--accent2);background:rgba(99,102,241,.08);box-shadow:0 0 0 3px rgba(99,102,241,.15)}
.group-avatar{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:1.4rem;flex-shrink:0}
.glist{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;max-height:380px;overflow-y:auto;padding-right:4px}
.glist::-webkit-scrollbar{width:4px}.glist::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.feed-bubble{padding:9px 12px;border-radius:10px;margin-bottom:7px;max-width:92%;animation:fadeIn .3s ease;word-break:break-word}
.feed-bubble.incoming{background:var(--bg3);border:1px solid var(--border);border-radius:10px 10px 10px 2px;margin-right:auto}
.feed-bubble.outgoing{background:rgba(99,102,241,.18);border:1px solid rgba(99,102,241,.25);border-radius:10px 10px 2px 10px;margin-left:auto}
.feed-box{max-height:300px;overflow-y:auto;padding:10px;background:var(--bg);border-radius:10px;border:1px solid var(--border)}
.feed-box::-webkit-scrollbar{width:4px}.feed-box::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.tpl-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:600px){
  .glist{grid-template-columns:1fr;max-height:260px}
  .tpl-grid{grid-template-columns:1fr}
  .feed-box{max-height:220px}
  .feed-bubble{max-width:100%}
}
</style>

<div class="page-header">
  <div class="page-title">📨 إرسال رسالة</div>
  <div class="page-sub">اختر غرفة من القائمة ثم أرسل رسالتك مباشرةً عبر البوت</div>
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px" class="two-col">

<!-- RIGHT: Group Picker + Send Form -->
<div style="display:flex;flex-direction:column;gap:16px">

  <!-- Group Search + List -->
  <div class="card" style="padding:0;overflow:hidden">
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div class="card-title">👥 اختر غرفة</div>
      <span class="badge badge-blue" id="gCount">${threadCount} غرفة</span>
    </div>
    <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
      <input type="text" id="groupSearch" class="form-control" placeholder="🔍 ابحث باسم الغرفة أو المعرّف..." oninput="filterGroups(this.value)" style="margin:0"/>
    </div>
    <div style="padding:12px">
      <div class="glist" id="groupList">
        <div style="grid-column:1/-1;text-align:center;padding:30px;color:var(--text3);font-size:.85rem">⏳ جاري تحميل الغرف...</div>
      </div>
    </div>
    <!-- Selected group info bar -->
    <div id="selectedBar" style="display:none;padding:10px 14px;background:rgba(99,102,241,.06);border-top:1px solid rgba(99,102,241,.2);font-size:.8rem;color:var(--accent2)">
      ✅ تم اختيار: <strong id="selectedName">—</strong> <span style="color:var(--text3)" id="selectedID"></span>
    </div>
  </div>

  <!-- Send Form -->
  <div class="card">
    <div class="card-header"><div class="card-title">💬 نص الرسالة</div></div>
    <div class="form-group">
      <textarea id="msgText" class="form-control" rows="4" placeholder="اكتب رسالتك هنا..." style="resize:vertical"></textarea>
    </div>
    <div class="tpl-grid" style="margin-bottom:14px">
      ${[
        ["👋","مرحباً! كيف يمكنني مساعدتك؟"],
        ["🔧","البوت يخضع للصيانة حالياً، سنعود قريباً."],
        ["✅","البوت جاهز ويعمل بشكل طبيعي."],
        ["🚫","سيتوقف البوت مؤقتاً خلال دقائق."],
        ["📢","إعلان مهم من إدارة البوت."],
        ["🎉","شكراً لتفاعلكم! يسعدنا خدمتكم."]
      ].map(([e,t]) => `<button class="btn btn-outline btn-sm" style="text-align:right;justify-content:flex-start;gap:6px" onclick="setTpl(this)" data-tpl="${t}">${e} <span style="font-size:.75rem;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${t.substring(0,30)}...</span></button>`).join("")}
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="sendMsg()" id="sendBtn">📤 إرسال الآن</button>
      <button class="btn btn-outline" onclick="sendAll()" title="إرسال لجميع الغرف المحددة">📡 إرسال للكل</button>
      <button class="btn btn-outline btn-sm" onclick="document.getElementById('msgText').value=''">🗑️</button>
    </div>
  </div>
</div>

<!-- LEFT: Live Feed + Stats -->
<div style="display:flex;flex-direction:column;gap:16px">

  <!-- Feed Card -->
  <div class="card" style="padding:0;overflow:hidden;flex:1">
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
      <div class="card-title" id="feedTitle">💬 البث المباشر</div>
      <div style="display:flex;gap:8px;align-items:center">
        <span id="feedLiveSpan" style="display:none;font-size:.7rem;color:var(--green);font-weight:700;display:flex;align-items:center;gap:4px"><span style="width:7px;height:7px;border-radius:50%;background:var(--green);display:inline-block;animation:pulse 1.2s infinite"></span>مباشر</span>
        <button class="btn btn-outline btn-sm" onclick="clearFeed()">🗑️</button>
      </div>
    </div>
    <div id="feedBox" class="feed-box" style="max-height:360px;border:none;border-radius:0">
      <div id="feedEmpty" style="text-align:center;padding:40px 20px;color:var(--text3);font-size:.85rem">
        <div style="font-size:2.5rem;margin-bottom:10px">💬</div>
        اختر غرفة لعرض آخر الرسائل الواردة هنا
      </div>
    </div>
    <div id="feedPollBar" style="padding:8px 14px;border-top:1px solid var(--border);font-size:.72rem;color:var(--text3);display:none">
      <span id="feedPollStatus">⏳ يتحقق من الرسائل...</span>
    </div>
  </div>

  <!-- Broadcast stats -->
  <div class="card" id="broadcastCard" style="display:none">
    <div class="card-header"><div class="card-title">📡 نتائج الإرسال للكل</div></div>
    <div id="broadcastResults" style="font-size:.82rem;line-height:1.9"></div>
  </div>

  <!-- Quick Thread ID input (manual) -->
  <div class="card">
    <div class="card-header"><div class="card-title">🔑 معرّف يدوي</div></div>
    <div class="form-group" style="margin-bottom:8px">
      <input type="text" id="manualTID" class="form-control" placeholder="أدخل Thread ID مباشرةً..." oninput="onManualTID(this.value)"/>
    </div>
    <div style="font-size:.75rem;color:var(--text3)">للإرسال إلى غرفة غير موجودة في القائمة أعلاه</div>
  </div>
</div>
</div>

<script>
let _groups = [];
let _selID  = '';
let _feedPollT = null;
let _feedSSESrc = null;
const BG_COLORS = ['linear-gradient(135deg,#6366f1,#8b5cf6)','linear-gradient(135deg,#10b981,#059669)','linear-gradient(135deg,#f59e0b,#d97706)','linear-gradient(135deg,#ef4444,#dc2626)','linear-gradient(135deg,#3b82f6,#2563eb)','linear-gradient(135deg,#ec4899,#db2777)'];
function gbg(id){ const h=String(id).split('').reduce((a,c)=>a+c.charCodeAt(0),0); return BG_COLORS[h%BG_COLORS.length]; }

async function loadGroups(){
  const r = await fetch('/api/groups');
  const d = await r.json();
  _groups = d.threads || [];
  document.getElementById('gCount').textContent = _groups.length + ' غرفة';
  renderGroups(_groups);
}

function renderGroups(list){
  const box = document.getElementById('groupList');
  if(!list.length){ box.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:30px;color:var(--text3)">لا توجد غرف متاحة</div>'; return; }
  box.innerHTML = list.map(g=>{
    const emoji = g.emoji || (g.isGroup ? '👥' : '👤');
    const name  = g.name.length>28 ? g.name.substring(0,28)+'…' : g.name;
    const isSel = g.threadID === _selID;
    return \`<div class="group-card\${isSel?' selected':''}" onclick="selectGroup('\${g.threadID}',\`\${escHtmlJS(g.name)}\`)">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="group-avatar" style="background:\${gbg(g.threadID)}">\${emoji}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:.82rem;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${escHtmlJS(name)}</div>
          <div style="font-size:.7rem;color:var(--text3);margin-top:2px">\${g.memberCount?g.memberCount+' عضو':g.threadID}</div>
        </div>
        \${g.msgCount?'<span class="badge badge-blue" style="font-size:.62rem">'+g.msgCount+'</span>':''}
      </div>
    </div>\`;
  }).join('');
}

function escHtmlJS(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function filterGroups(q){
  const s = q.toLowerCase();
  renderGroups(s ? _groups.filter(g=>g.name.toLowerCase().includes(s)||g.threadID.includes(s)) : _groups);
}

function selectGroup(id, name){
  _selID = id;
  document.getElementById('selectedBar').style.display='';
  document.getElementById('selectedName').textContent = name;
  document.getElementById('selectedID').textContent = '('+id+')';
  document.getElementById('manualTID').value = '';
  renderGroups(_groups.filter(g=>{
    const s=document.getElementById('groupSearch').value.toLowerCase();
    return !s || g.name.toLowerCase().includes(s) || g.threadID.includes(s);
  }));
  loadFeed(id, name);
}

function onManualTID(v){ if(v.trim()){ _selID=v.trim(); document.getElementById('selectedBar').style.display=''; document.getElementById('selectedName').textContent='معرّف يدوي'; document.getElementById('selectedID').textContent='('+v.trim()+')'; loadFeed(v.trim(),'غرفة يدوية'); } }

function setTpl(btn){ document.getElementById('msgText').value = btn.dataset.tpl||''; }

async function loadFeed(tid, name){
  stopFeed();
  document.getElementById('feedTitle').textContent = '💬 ' + (name||tid);
  document.getElementById('feedPollBar').style.display='';
  document.getElementById('feedPollStatus').textContent = '⏳ جاري التحميل...';
  const r = await fetch('/api/groups/'+encodeURIComponent(tid)+'/feed');
  const d = await r.json();
  const msgs = d.messages||[];
  renderFeed(msgs);
  document.getElementById('feedLiveSpan').style.display='flex';
  document.getElementById('feedPollStatus').textContent = '🟢 يتحدث كل 8 ثوانٍ';
  // Start polling
  _feedPollT = setInterval(()=>pollFeed(tid), 8000);
}

async function pollFeed(tid){
  const r = await fetch('/api/groups/'+encodeURIComponent(tid)+'/feed');
  const d = await r.json();
  renderFeed(d.messages||[]);
}

function stopFeed(){
  if(_feedPollT){ clearInterval(_feedPollT); _feedPollT=null; }
  if(_feedSSESrc){ _feedSSESrc.close(); _feedSSESrc=null; }
  document.getElementById('feedLiveSpan').style.display='none';
}

function renderFeed(msgs){
  const box = document.getElementById('feedBox');
  const empty = document.getElementById('feedEmpty');
  if(!msgs.length){ empty.style.display=''; box.querySelectorAll('.feed-bubble').forEach(e=>e.remove()); return; }
  empty.style.display='none';
  box.innerHTML = msgs.map(m=>{
    const t  = new Date(m.ts).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'});
    const isMe = String(m.senderID) === String(window._botID||'');
    return \`<div class="feed-bubble \${isMe?'outgoing':'incoming'}">
      <div style="font-size:.65rem;color:var(--text3);margin-bottom:3px">\${isMe?'🤖 البوت':'👤 '+m.senderID} · \${t}</div>
      <div style="font-size:.82rem;color:var(--text2);word-break:break-word">\${escHtmlJS(m.body)}</div>
    </div>\`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function clearFeed(){
  document.getElementById('feedBox').innerHTML='';
  document.getElementById('feedEmpty').style.display='';
}

async function sendMsg(){
  const threadID = _selID || document.getElementById('manualTID').value.trim();
  const message  = document.getElementById('msgText').value.trim();
  if(!threadID) return showToast('❌ اختر غرفة أو أدخل معرّفاً يدوياً','error');
  if(!message)  return showToast('❌ اكتب رسالة أولاً','error');
  const btn = document.getElementById('sendBtn');
  btn.disabled=true; btn.textContent='⏳ جاري الإرسال...';
  const r = await api('/api/send', {threadID, message});
  btn.disabled=false; btn.textContent='📤 إرسال الآن';
  if(r.ok){
    showToast('✅ تم الإرسال بنجاح!','success');
    // add to feed locally
    const box = document.getElementById('feedBox');
    document.getElementById('feedEmpty').style.display='none';
    const t = new Date().toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'});
    box.insertAdjacentHTML('beforeend', \`<div class="feed-bubble outgoing"><div style="font-size:.65rem;color:var(--text3);margin-bottom:3px">🤖 أرسلت · \${t}</div><div style="font-size:.82rem;color:var(--text2)">\${escHtmlJS(message)}</div></div>\`);
    box.scrollTop = box.scrollHeight;
  } else { showToast('❌ '+r.error,'error'); }
}

async function sendAll(){
  const message = document.getElementById('msgText').value.trim();
  if(!message) return showToast('❌ اكتب رسالة أولاً','error');
  if(!_groups.length) return showToast('❌ لا توجد غرف','error');
  if(!confirm('⚠️ سيتم إرسال الرسالة لجميع '+_groups.length+' غرفة. تأكيد؟')) return;
  document.getElementById('broadcastCard').style.display='';
  const res = document.getElementById('broadcastResults');
  res.innerHTML = '⏳ جاري الإرسال...';
  let ok=0, fail=0;
  for(const g of _groups){
    const r = await api('/api/send',{threadID:g.threadID,message});
    if(r.ok) ok++; else fail++;
    res.innerHTML = \`✅ \${ok} نجح &nbsp;|&nbsp; ❌ \${fail} فشل &nbsp;|&nbsp; ⏳ باقي \${_groups.length-ok-fail}\`;
    await new Promise(r=>setTimeout(r,800));
  }
  res.innerHTML += '<br><strong style="color:var(--green)">✅ اكتمل الإرسال</strong>';
  showToast(\`✅ أُرسلت لـ \${ok} غرفة\`,'success');
}

// Load on mount
loadGroups();
setInterval(loadGroups, 30000);
</script>`;
  res.send(layout("إرسال رسالة", body, "send"));
});

// ─── GROUPS PAGE ──────────────────────────────────────────────────────────────
app.get("/groups", auth, (req, res) => {
  const threads  = global.db?.allThreadData || [];
  const total    = threads.length;
  const groups   = threads.filter(t => t.threadInfo?.isGroup !== false).length;
  const directs  = total - groups;

  const body = `
<style>
.gcard{background:var(--bg2);border:1.5px solid var(--border);border-radius:16px;padding:14px;transition:all .22s cubic-bezier(.4,0,.2,1);position:relative;overflow:hidden;display:flex;flex-direction:column;gap:10px}
.gcard:hover{border-color:rgba(99,102,241,.45);transform:translateY(-1px);box-shadow:var(--shadow)}
.gcard.card-open{border-color:var(--accent2);box-shadow:0 0 0 2px rgba(99,102,241,.15)}
.gcard-avatar{width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0}
.gcard-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.gcard-feed{background:var(--bg);border-radius:10px;border:1px solid var(--border);overflow:hidden;margin-top:6px;animation:slideDown .25s ease}
.gcard-feed-msgs{max-height:200px;overflow-y:auto;padding:8px}
.gcard-feed-msgs::-webkit-scrollbar{width:3px}.gcard-feed-msgs::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.gcard-fbub{padding:7px 10px;border-radius:8px;margin-bottom:5px;font-size:.76rem;word-break:break-word;animation:fadeIn .25s ease}
.gcard-fbub.in{background:var(--bg3);border:1px solid var(--border);border-radius:8px 8px 8px 2px}
.gcard-fbub.out{background:rgba(99,102,241,.14);border:1px solid rgba(99,102,241,.2);border-radius:8px 8px 2px 8px;margin-left:auto;max-width:88%}
.gcard-feed-input{display:flex;gap:6px;padding:8px;border-top:1px solid var(--border)}
@keyframes slideDown{from{opacity:0;transform:scaleY(0.8);transform-origin:top}to{opacity:1;transform:scaleY(1)}}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:600px){.gcard-grid{grid-template-columns:1fr}.gcard-feed-msgs{max-height:160px}}
</style>

<div class="page-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
  <div>
    <div class="page-title">👥 الغروبات</div>
    <div class="page-sub">إدارة جميع الغرف التي يشارك فيها البوت</div>
  </div>
  <div class="btn-row" style="margin:0">
    <button class="btn btn-outline btn-sm" onclick="loadGroups()">🔄 تحديث</button>
    <button class="btn btn-outline btn-sm" id="viewToggleBtn" onclick="toggleView()">⊞ شبكة</button>
  </div>
</div>

<!-- Stats Row -->
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:20px">
  <div class="stat stat-blue" style="padding:16px">
    <div class="stat-glow"></div>
    <div class="stat-icon" style="font-size:1.4rem">💬</div>
    <div class="stat-val" id="stTotal" style="font-size:1.6rem">${total}</div>
    <div class="stat-lbl">إجمالي الغرف</div>
  </div>
  <div class="stat stat-green" style="padding:16px">
    <div class="stat-glow"></div>
    <div class="stat-icon" style="font-size:1.4rem">👥</div>
    <div class="stat-val" id="stGroups" style="font-size:1.6rem">${groups}</div>
    <div class="stat-lbl">مجموعات</div>
  </div>
  <div class="stat stat-purple" style="padding:16px">
    <div class="stat-glow"></div>
    <div class="stat-icon" style="font-size:1.4rem">👤</div>
    <div class="stat-val" id="stDirect" style="font-size:1.6rem">${directs}</div>
    <div class="stat-lbl">محادثات خاصة</div>
  </div>
  <div class="stat" style="padding:16px;background:var(--bg2);border:1px solid var(--border)">
    <div class="stat-glow" style="background:#f59e0b"></div>
    <div class="stat-icon" style="font-size:1.4rem">🔴</div>
    <div class="stat-val" id="stLive" style="font-size:1.6rem">0</div>
    <div class="stat-lbl">نشطة الآن</div>
  </div>
</div>

<!-- Filters + Search -->
<div class="card" style="padding:14px 16px;margin-bottom:16px">
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <input type="text" id="gSearch" class="form-control" placeholder="🔍 ابحث باسم الغرفة أو المعرّف..." oninput="filterCards(this.value)" style="margin:0;flex:1;min-width:180px"/>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-outline btn-sm" id="fAll" onclick="setFilter('all')" style="min-width:60px">الكل</button>
      <button class="btn btn-outline btn-sm" id="fGroup" onclick="setFilter('group')">👥 مجموعات</button>
      <button class="btn btn-outline btn-sm" id="fDirect" onclick="setFilter('direct')">👤 خاصة</button>
      <button class="btn btn-outline btn-sm" id="fActive" onclick="setFilter('active')">🔴 نشطة</button>
    </div>
  </div>
</div>

<!-- Cards Grid -->
<div class="gcard-grid" id="cardGrid">
  <div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text3)">⏳ جاري التحميل...</div>
</div>

<!-- Send Modal -->
<div id="sendModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:16px">
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:20px;width:100%;max-width:460px;box-shadow:var(--shadow-lg);overflow:hidden">
    <div style="padding:20px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
      <div style="font-weight:800;font-size:1rem;color:var(--text)" id="modalTitle">📨 إرسال رسالة</div>
      <button onclick="closeSendModal()" style="background:var(--bg4);border:1px solid var(--border);border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--text2);font-size:1rem;display:flex;align-items:center;justify-content:center">✕</button>
    </div>
    <div style="padding:20px 22px">
      <div class="form-group">
        <label class="form-label" style="font-size:.8rem;color:var(--text3)" id="modalSub">إرسال إلى الغرفة</label>
        <textarea id="modalMsg" class="form-control" rows="4" placeholder="اكتب رسالتك هنا..."></textarea>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="doModalSend()">📤 إرسال</button>
        <button class="btn btn-outline" onclick="closeSendModal()">إلغاء</button>
      </div>
    </div>
  </div>
</div>

<script>
let _allG = [];
let _filter = 'all';
let _viewList = false;
let _modalTID = '';
const BGCOLS = ['linear-gradient(135deg,#6366f1,#8b5cf6)','linear-gradient(135deg,#10b981,#059669)','linear-gradient(135deg,#f59e0b,#d97706)','linear-gradient(135deg,#ef4444,#dc2626)','linear-gradient(135deg,#3b82f6,#2563eb)','linear-gradient(135deg,#ec4899,#db2777)','linear-gradient(135deg,#06b6d4,#0891b2)'];
function gbg(id){ const h=String(id).split('').reduce((a,c)=>a+c.charCodeAt(0),0); return BGCOLS[h%BGCOLS.length]; }
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function loadGroups(){
  const r = await fetch('/api/groups');
  const d = await r.json();
  _allG = d.threads||[];
  document.getElementById('stTotal').textContent  = _allG.length;
  document.getElementById('stGroups').textContent = _allG.filter(g=>g.isGroup).length;
  document.getElementById('stDirect').textContent = _allG.filter(g=>!g.isGroup).length;
  document.getElementById('stLive').textContent   = _allG.filter(g=>g.msgCount>0).length;
  applyFilter();
}

function setFilter(f){
  _filter = f;
  ['fAll','fGroup','fDirect','fActive'].forEach(id=>{
    const el=document.getElementById(id);
    el.style.background=''; el.style.color=''; el.style.borderColor='';
  });
  const active = {all:'fAll',group:'fGroup',direct:'fDirect',active:'fActive'}[f];
  const el = document.getElementById(active);
  if(el){ el.style.background='rgba(99,102,241,.15)'; el.style.color='var(--accent2)'; el.style.borderColor='rgba(99,102,241,.4)'; }
  applyFilter();
}

function applyFilter(){
  const q = (document.getElementById('gSearch').value||'').toLowerCase();
  let list = _allG;
  if(_filter==='group')  list = list.filter(g=>g.isGroup);
  if(_filter==='direct') list = list.filter(g=>!g.isGroup);
  if(_filter==='active') list = list.filter(g=>g.msgCount>0);
  if(q) list = list.filter(g=>g.name.toLowerCase().includes(q)||g.threadID.includes(q));
  renderCards(list);
}

function filterCards(q){ applyFilter(); }

// ── Live feed per card ────────────────────────────────────────────────────
const _cardFeedTimers = {};
const _cardFeedOpen   = new Set();

function renderCards(list){
  const grid = document.getElementById('cardGrid');
  if(!list.length){
    grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text3)"><div style="font-size:3rem;margin-bottom:12px">🔍</div>لا توجد غرف مطابقة</div>';
    return;
  }
  grid.innerHTML = list.map(g=>{
    const emoji = g.emoji||(g.isGroup?'👥':'👤');
    const name  = esc(g.name);
    const admins= g.adminIDs?.length?'<span class="badge badge-blue">👑 '+g.adminIDs.length+' مشرف</span>':'';
    const live  = g.msgCount?'<span class="badge badge-green" style="background:rgba(16,185,129,.12);color:var(--green);border:1px solid rgba(16,185,129,.25)">🔴 '+g.msgCount+'</span>':'';
    const type  = g.isGroup?'<span class="badge" style="background:rgba(99,102,241,.1);color:var(--accent2);border:1px solid rgba(99,102,241,.2);font-size:.6rem">مجموعة</span>':'<span class="badge" style="background:rgba(245,158,11,.1);color:var(--yellow);border:1px solid rgba(245,158,11,.2);font-size:.6rem">خاص</span>';
    const isOpen = _cardFeedOpen.has(g.threadID);
    return \`<div class="gcard\${isOpen?' card-open':''}" id="gcard_\${g.threadID}">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <div class="gcard-avatar" style="background:\${gbg(g.threadID)}">\${emoji}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:800;font-size:.85rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${name}">\${name}</div>
          <div style="font-size:.68rem;color:var(--text3);margin-top:2px;font-family:monospace">\${g.threadID}</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:5px">\${type}\${admins}\${live}\${g.memberCount?'<span class="badge badge-blue" style="font-size:.58rem">👤 '+g.memberCount+'</span>':''}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-top:2px">
        <button class="btn btn-outline btn-sm" style="flex:1;font-size:.75rem" onclick="toggleCardFeed('\${g.threadID}','\${name}')" id="feedBtn_\${g.threadID}">
          \${isOpen?'🔼 أخفِ الرسائل':'👁 الرسائل الحية'}
        </button>
        <button class="btn btn-primary btn-sm" onclick="openSendModal('\${g.threadID}','\${name}')">📤</button>
        <button class="btn btn-outline btn-sm" onclick="copyTID('\${g.threadID}')">📋</button>
      </div>
      \${isOpen ? \`<div class="gcard-feed" id="feed_\${g.threadID}">
        <div style="padding:7px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.72rem;font-weight:700;color:var(--accent2)">🔴 مباشر</span>
          <span style="font-size:.65rem;color:var(--text3)" id="feedSt_\${g.threadID}">يتحدث كل 5 ث</span>
        </div>
        <div class="gcard-feed-msgs" id="feedMsgs_\${g.threadID}"><div style="text-align:center;padding:18px;color:var(--text3);font-size:.75rem">⏳ جاري التحميل...</div></div>
        <div class="gcard-feed-input">
          <input type="text" class="form-control" placeholder="ردّ سريع..." id="feedInp_\${g.threadID}" style="margin:0;font-size:.78rem;padding:6px 10px" onkeydown="if(event.key==='Enter')quickReply('\${g.threadID}')"/>
          <button class="btn btn-primary btn-sm" onclick="quickReply('\${g.threadID}')">إرسال</button>
        </div>
      </div>\` : ''}
    </div>\`;
  }).join('');
  // Re-start feed polling for open cards
  for (const tid of _cardFeedOpen) {
    if (!_cardFeedTimers[tid]) startCardFeed(tid);
    else fetchCardFeed(tid);
  }
}

async function fetchCardFeed(tid){
  try {
    const r = await fetch('/api/groups/'+encodeURIComponent(tid)+'/feed');
    const d = await r.json();
    const msgs = d.messages||[];
    const box = document.getElementById('feedMsgs_'+tid);
    if(!box) return;
    if(!msgs.length){ box.innerHTML='<div style="text-align:center;padding:18px;color:var(--text3);font-size:.75rem">لا توجد رسائل بعد</div>'; return; }
    const atBottom = box.scrollTop+box.clientHeight >= box.scrollHeight-10;
    box.innerHTML = msgs.map(m=>{
      const isBot = m.senderID==='BOT'||m.senderID==='bot';
      const t = new Date(m.ts).toLocaleTimeString('ar-DZ',{hour:'2-digit',minute:'2-digit'});
      return \`<div class="gcard-fbub \${isBot?'out':'in'}">
        <div style="font-size:.65rem;color:var(--text3);margin-bottom:3px">\${isBot?'🤖 البوت':'👤 '+m.senderID.slice(-4)} · \${t}</div>
        <div>\${esc(m.body)}</div>
      </div>\`;
    }).join('');
    if(atBottom) box.scrollTop = box.scrollHeight;
    const st = document.getElementById('feedSt_'+tid);
    if(st) st.textContent = '🟢 آخر تحديث: '+ new Date().toLocaleTimeString('ar-DZ',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  } catch(_) {}
}

function startCardFeed(tid){
  fetchCardFeed(tid);
  _cardFeedTimers[tid] = setInterval(()=>fetchCardFeed(tid), 5000);
}

function stopCardFeed(tid){
  clearInterval(_cardFeedTimers[tid]);
  delete _cardFeedTimers[tid];
  _cardFeedOpen.delete(tid);
}

function toggleCardFeed(tid, name){
  if(_cardFeedOpen.has(tid)){
    stopCardFeed(tid);
  } else {
    _cardFeedOpen.add(tid);
  }
  // Re-render to show/hide feed panel inside the card
  applyFilter();
}

async function quickReply(tid){
  const inp = document.getElementById('feedInp_'+tid);
  const msg = inp?.value?.trim();
  if(!msg) return;
  inp.value = '';
  const r = await api('/api/send',{threadID:tid,message:msg});
  r.ok ? showToast('✅ تم الإرسال','success') : showToast('❌ '+r.error,'error');
  setTimeout(()=>fetchCardFeed(tid), 800);
}

function toggleView(){
  _viewList = !_viewList;
  const g = document.getElementById('cardGrid');
  g.style.gridTemplateColumns = _viewList ? '1fr' : 'repeat(auto-fill,minmax(280px,1fr))';
  const btn = document.getElementById('viewToggleBtn');
  if(btn) btn.textContent = _viewList ? '⊟ عمود واحد' : '⊞ شبكة';
}

function copyTID(id){
  navigator.clipboard.writeText(id).then(()=>showToast('📋 تم نسخ المعرّف','success')).catch(()=>showToast('❌ تعذّر النسخ','error'));
}

function openSendModal(tid, name){
  _modalTID = tid;
  document.getElementById('modalTitle').textContent = '📨 إرسال إلى: '+name;
  document.getElementById('modalSub').textContent   = 'Thread ID: '+tid;
  document.getElementById('modalMsg').value = '';
  document.getElementById('sendModal').style.display='flex';
  setTimeout(()=>document.getElementById('modalMsg').focus(),100);
}

function closeSendModal(){
  document.getElementById('sendModal').style.display='none';
}

async function doModalSend(){
  const msg = document.getElementById('modalMsg').value.trim();
  if(!msg) return showToast('❌ اكتب رسالة أولاً','error');
  const r = await api('/api/send',{threadID:_modalTID,message:msg});
  r.ok ? (showToast('✅ تم الإرسال!','success'), closeSendModal()) : showToast('❌ '+r.error,'error');
}

document.getElementById('sendModal').addEventListener('click', e=>{
  if(e.target===document.getElementById('sendModal')) closeSendModal();
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeSendModal(); });

setFilter('all');
loadGroups();
setInterval(loadGroups, 20000);
</script>`;
  res.send(layout("الغروبات", body, "groups"));
});

// ─── HUMAN-LIKE PROTECTION ────────────────────────────────────────────────────
try {
  const humanLike = require("./humanlike.js");
  humanLike.start();
} catch (e) {
  console.warn("[HUMANLIKE] Failed to load:", e.message);
}

// ─── DEV HUB ──────────────────────────────────────────────────────────────────
try {
  require("./devhub.js")(app, auth, layout);
} catch (e) {
  console.warn("[DEVHUB] Failed to load devhub module:", e.message);
}

// ─── START ─────────────────────────────────────────────────────────────────────
module.exports = function startPanel() {
  const server = http.createServer(app);
  server.listen(PORT, "0.0.0.0", () => {
    const logger = global.utils?.log;
    const msg = `🌐 Admin Panel running on port ${PORT}`;
    logger ? logger.info("PANEL", msg) : console.log("[PANEL]", msg);
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      const msg = `Port ${PORT} in use — try setting PANEL_PORT env variable`;
      global.utils?.log ? global.utils.log.warn("PANEL", msg) : console.warn("[PANEL]", msg);
    }
  });
  return server;
};
