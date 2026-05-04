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
    ["send",     "M12 19l9 2-9-18-9 18 9-2zm0 0v-8", "إرسال رسالة"],
    ["devhub",   "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z", "مركز التطوير"],
    ["devhub/guide", "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253", "دليل المطور"],
  ];

  const nav = tabs.map(([id, icon, label]) => `
    <a href="/${id}" class="nav-item ${activeTab === id ? "active" : ""}">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${icon}"/></svg>
      <span>${label}</span>
    </a>`).join("");

  const isBotOnline = !!global.GoatBot?.fcaApi;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WHITE V3 — ${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;800&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#070b14;
  --bg2:#0d1321;
  --bg3:#111827;
  --bg4:#1a2235;
  --border:#1e2d45;
  --border2:#253350;
  --accent:#3b82f6;
  --accent2:#60a5fa;
  --accent-glow:rgba(59,130,246,.25);
  --green:#10b981;
  --green-bg:rgba(16,185,129,.1);
  --yellow:#f59e0b;
  --yellow-bg:rgba(245,158,11,.1);
  --red:#ef4444;
  --red-bg:rgba(239,68,68,.1);
  --text:#f1f5f9;
  --text2:#94a3b8;
  --text3:#64748b;
  --purple:#8b5cf6;
  --cyan:#06b6d4;
  --sidebar:240px;
}
body{background:var(--bg);color:var(--text);font-family:'Cairo',sans-serif;min-height:100vh;overflow-x:hidden}

/* ── SIDEBAR ── */
.sidebar{
  width:var(--sidebar);background:var(--bg2);border-left:1px solid var(--border);
  min-height:100vh;position:fixed;top:0;right:0;display:flex;flex-direction:column;
  padding:0;z-index:100;
  box-shadow:-4px 0 20px rgba(0,0,0,.4);
}
.sidebar-top{padding:24px 18px 20px;border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:10px}
.brand-logo{
  width:40px;height:40px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);
  border-radius:10px;display:flex;align-items:center;justify-content:center;
  font-size:1.2rem;box-shadow:0 4px 15px rgba(59,130,246,.4);
}
.brand-text{font-size:1.05rem;font-weight:800;color:var(--text);letter-spacing:.5px}
.brand-sub{font-size:.72rem;color:var(--text3);margin-top:1px}
.bot-status{
  margin-top:14px;display:flex;align-items:center;gap:8px;
  padding:8px 12px;background:var(--bg3);border-radius:8px;border:1px solid var(--border)
}
.status-dot{
  width:8px;height:8px;border-radius:50%;
  background:${isBotOnline ? "var(--green)" : "var(--red)"};
  box-shadow:0 0 8px ${isBotOnline ? "var(--green)" : "var(--red)"};
  animation:pulse 2s infinite;
}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.status-label{font-size:.8rem;color:var(--text2)}

.nav-section{padding:16px 12px 8px;font-size:.68rem;color:var(--text3);text-transform:uppercase;letter-spacing:1px}
.nav-item{
  display:flex;align-items:center;gap:10px;padding:9px 16px;margin:2px 8px;
  border-radius:8px;color:var(--text2);text-decoration:none;font-size:.88rem;
  transition:all .2s;cursor:pointer;
}
.nav-item:hover{background:var(--bg4);color:var(--text)}
.nav-item.active{background:linear-gradient(90deg,rgba(59,130,246,.2),rgba(59,130,246,.05));color:var(--accent2);border-right:2px solid var(--accent)}
.nav-item svg{flex-shrink:0;opacity:.7}
.nav-item.active svg{opacity:1}

.sidebar-bottom{margin-top:auto;padding:16px 12px;border-top:1px solid var(--border)}
.sidebar-bottom a{display:flex;align-items:center;gap:10px;padding:9px 16px;border-radius:8px;color:var(--red);text-decoration:none;font-size:.88rem;transition:all .2s}
.sidebar-bottom a:hover{background:var(--red-bg)}

/* ── MAIN ── */
.main{margin-right:var(--sidebar);padding:28px 32px;min-height:100vh}
.page-header{margin-bottom:28px}
.page-title{font-size:1.5rem;font-weight:700;color:var(--text)}
.page-sub{font-size:.85rem;color:var(--text3);margin-top:4px}

/* ── CARDS ── */
.card{
  background:var(--bg2);border:1px solid var(--border);border-radius:14px;
  padding:22px;margin-bottom:20px;transition:border-color .2s;
}
.card:hover{border-color:var(--border2)}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.card-title{font-size:.95rem;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px}
.card-title-icon{
  width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:.95rem;
}

/* ── STAT BOXES ── */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:24px}
.stat{
  background:var(--bg2);border:1px solid var(--border);border-radius:12px;
  padding:18px;position:relative;overflow:hidden;transition:all .25s;
}
.stat:hover{border-color:var(--border2);transform:translateY(-2px)}
.stat-glow{
  position:absolute;top:-30px;right:-30px;width:80px;height:80px;
  border-radius:50%;opacity:.12;filter:blur(20px);
}
.stat-icon{font-size:1.4rem;margin-bottom:10px}
.stat-val{font-size:1.7rem;font-weight:800;color:var(--text);line-height:1}
.stat-lbl{font-size:.75rem;color:var(--text3);margin-top:6px}
.stat-blue .stat-glow{background:#3b82f6}
.stat-green .stat-glow{background:#10b981}
.stat-purple .stat-glow{background:#8b5cf6}
.stat-cyan .stat-glow{background:#06b6d4}

/* ── BADGES ── */
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:.78rem;font-weight:600}
.badge-green{background:var(--green-bg);color:var(--green);border:1px solid rgba(16,185,129,.3)}
.badge-red{background:var(--red-bg);color:var(--red);border:1px solid rgba(239,68,68,.3)}
.badge-yellow{background:var(--yellow-bg);color:var(--yellow);border:1px solid rgba(245,158,11,.3)}
.badge-blue{background:rgba(59,130,246,.1);color:var(--accent2);border:1px solid rgba(59,130,246,.3)}

/* ── TABLE ── */
.table{width:100%;border-collapse:collapse}
.table th{color:var(--text3);font-size:.78rem;text-transform:uppercase;letter-spacing:.5px;padding:10px 14px;text-align:right;border-bottom:1px solid var(--border);font-weight:600}
.table td{padding:12px 14px;border-bottom:1px solid var(--border);font-size:.88rem;color:var(--text)}
.table tr:last-child td{border-bottom:none}
.table tr:hover td{background:var(--bg3)}
.table td:first-child,.table th:first-child{text-align:right}

/* ── FORMS ── */
.form-group{margin-bottom:16px}
.form-label{display:block;font-size:.82rem;color:var(--text2);margin-bottom:6px;font-weight:600}
.form-control{
  width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);
  border-radius:8px;padding:9px 12px;font-size:.88rem;font-family:'Cairo',sans-serif;
  transition:all .2s;outline:none;
}
.form-control:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
.form-control::placeholder{color:var(--text3)}
textarea.form-control{resize:vertical;line-height:1.6}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}

/* ── BUTTONS ── */
.btn{
  display:inline-flex;align-items:center;gap:7px;padding:9px 18px;border-radius:8px;
  font-size:.86rem;font-weight:600;font-family:'Cairo',sans-serif;cursor:pointer;
  border:none;transition:all .2s;text-decoration:none;
}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:#2563eb;transform:translateY(-1px);box-shadow:0 4px 12px rgba(59,130,246,.4)}
.btn-success{background:var(--green);color:#fff}
.btn-success:hover{background:#059669;transform:translateY(-1px);box-shadow:0 4px 12px rgba(16,185,129,.4)}
.btn-danger{background:var(--red);color:#fff}
.btn-danger:hover{background:#dc2626;transform:translateY(-1px);box-shadow:0 4px 12px rgba(239,68,68,.4)}
.btn-outline{background:transparent;color:var(--text2);border:1px solid var(--border)}
.btn-outline:hover{background:var(--bg4);color:var(--text)}
.btn-sm{padding:6px 14px;font-size:.8rem}
.btn-icon{width:34px;height:34px;padding:0;justify-content:center;border-radius:8px}
.btn-purple{background:var(--purple);color:#fff}
.btn-purple:hover{background:#7c3aed}
.btn-yellow{background:var(--yellow);color:#000}
.btn-yellow:hover{background:#d97706}
.btn-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}

/* ── LOGS ── */
.log-box{
  background:#030712;border:1px solid var(--border);border-radius:10px;
  padding:16px;font-family:'Courier New',monospace;font-size:.76rem;
  max-height:520px;overflow-y:auto;white-space:pre-wrap;line-height:1.7;
}
.log-box::-webkit-scrollbar{width:6px}
.log-box::-webkit-scrollbar-track{background:transparent}
.log-box::-webkit-scrollbar-thumb{background:#1e2d45;border-radius:3px}
.log-error{color:#f87171}
.log-warn{color:#fbbf24}
.log-ok{color:#34d399}
.log-info{color:#60a5fa}
.log-dim{color:#64748b}

/* ── BOT CONTROLS ── */
.control-panel{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;
}
.control-btn{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:8px;padding:22px;border-radius:12px;border:1px solid var(--border);
  cursor:pointer;transition:all .25s;text-decoration:none;font-family:'Cairo',sans-serif;
  background:var(--bg3);color:var(--text2);font-size:.88rem;font-weight:600;
}
.control-btn:hover{transform:translateY(-3px)}
.control-btn .icon{font-size:1.8rem}
.control-btn.green{border-color:rgba(16,185,129,.3);color:var(--green)}
.control-btn.green:hover{background:var(--green-bg);box-shadow:0 6px 20px rgba(16,185,129,.2)}
.control-btn.red{border-color:rgba(239,68,68,.3);color:var(--red)}
.control-btn.red:hover{background:var(--red-bg);box-shadow:0 6px 20px rgba(239,68,68,.2)}
.control-btn.yellow{border-color:rgba(245,158,11,.3);color:var(--yellow)}
.control-btn.yellow:hover{background:var(--yellow-bg);box-shadow:0 6px 20px rgba(245,158,11,.2)}
.control-btn.blue{border-color:rgba(59,130,246,.3);color:var(--accent2)}
.control-btn.blue:hover{background:rgba(59,130,246,.1);box-shadow:0 6px 20px rgba(59,130,246,.2)}

/* ── TOAST ── */
#toast-container{position:fixed;bottom:24px;left:24px;z-index:9999;display:flex;flex-direction:column;gap:10px}
.toast-msg{
  padding:12px 18px;border-radius:10px;font-size:.85rem;font-weight:600;
  display:flex;align-items:center;gap:10px;min-width:280px;
  animation:toastIn .3s ease;box-shadow:0 8px 24px rgba(0,0,0,.4);
}
.toast-success{background:linear-gradient(135deg,#064e3b,#065f46);border:1px solid rgba(16,185,129,.3);color:#6ee7b7}
.toast-error{background:linear-gradient(135deg,#450a0a,#7f1d1d);border:1px solid rgba(239,68,68,.3);color:#fca5a5}
.toast-info{background:linear-gradient(135deg,#0c1a3d,#1e3a8a);border:1px solid rgba(59,130,246,.3);color:#93c5fd}
@keyframes toastIn{from{opacity:0;transform:translateX(-20px)}to{opacity:1;transform:translateX(0)}}

/* ── DIVIDER ── */
.divider{border:none;border-top:1px solid var(--border);margin:20px 0}

/* ── TOGGLE ── */
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border)}
.toggle-row:last-child{border-bottom:none}
.toggle-info{font-size:.88rem;color:var(--text)}
.toggle-sub{font-size:.76rem;color:var(--text3);margin-top:2px}
.toggle{position:relative;display:inline-block;width:44px;height:24px}
.toggle input{display:none}
.slider{
  position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;
  background:#374151;border-radius:24px;transition:.3s;
}
.slider:before{
  position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;
  background:#fff;border-radius:50%;transition:.3s;
}
input:checked+.slider{background:var(--accent)}
input:checked+.slider:before{transform:translateX(20px)}

/* ── CODE ── */
code{background:var(--bg4);color:#93c5fd;padding:2px 7px;border-radius:5px;font-size:.82rem;font-family:'Courier New',monospace}

/* ── GRADIENT TEXT ── */
.gradient-text{background:linear-gradient(90deg,#3b82f6,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}

/* ── MOBILE TOPBAR ── */
.topbar{
  display:none;position:fixed;top:0;left:0;right:0;height:56px;
  background:var(--bg2);border-bottom:1px solid var(--border);
  align-items:center;justify-content:space-between;padding:0 16px;
  z-index:200;box-shadow:0 2px 12px rgba(0,0,0,.4);
}
.topbar-brand{display:flex;align-items:center;gap:10px}
.topbar-logo{width:34px;height:34px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:1rem}
.topbar-name{font-size:1rem;font-weight:800;background:linear-gradient(90deg,#3b82f6,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.topbar-status{display:flex;align-items:center;gap:6px}
.hamburger{background:none;border:none;cursor:pointer;color:var(--text2);padding:6px;display:flex;flex-direction:column;gap:5px}
.hamburger span{display:block;width:22px;height:2px;background:currentColor;border-radius:2px;transition:.3s}

/* ── SIDEBAR OVERLAY ── */
.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:150;backdrop-filter:blur(2px)}
.sidebar-overlay.active{display:block}

/* ── MOBILE BOTTOM NAV ── */
.mobile-nav{
  display:none;position:fixed;bottom:0;left:0;right:0;height:62px;
  background:var(--bg2);border-top:1px solid var(--border);
  flex-direction:row;align-items:center;justify-content:space-around;
  z-index:200;padding-bottom:env(safe-area-inset-bottom,0px);
  box-shadow:0 -4px 20px rgba(0,0,0,.3);
}
.mob-nav-item{
  display:flex;flex-direction:column;align-items:center;gap:2px;
  text-decoration:none;color:var(--text3);font-size:.62rem;font-weight:600;
  flex:1;padding:8px 0;transition:color .2s;position:relative;
}
.mob-nav-item.active{color:var(--accent2)}
.mob-nav-item.active::before{
  content:'';position:absolute;top:0;left:20%;right:20%;height:2px;
  background:var(--accent);border-radius:0 0 4px 4px;
}
.mob-nav-item svg{width:20px;height:20px}

/* ── RESPONSIVE ── */
@media(max-width:768px){
  .sidebar{
    position:fixed;top:0;right:-260px;width:260px;
    transition:right .3s cubic-bezier(.4,0,.2,1);z-index:160;
  }
  .sidebar.open{right:0}
  .topbar{display:flex}
  .mobile-nav{display:flex}
  .main{margin-right:0;padding:72px 14px 80px}
  .stats-grid{grid-template-columns:repeat(2,1fr);gap:10px}
  .control-panel{grid-template-columns:repeat(2,1fr)}
  .two-col{grid-template-columns:1fr !important}
  .page-title{font-size:1.2rem}
  .card{padding:16px;margin-bottom:14px}
  .btn-row{gap:8px}
  .btn{padding:8px 14px;font-size:.82rem}
  .form-grid{grid-template-columns:1fr}
  #toast-container{left:12px;right:12px;bottom:76px}
  .toast-msg{min-width:unset;width:100%}
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

<!-- Mobile Top Bar -->
<div class="topbar">
  <div class="topbar-brand">
    <div class="topbar-logo">⚪</div>
    <span class="topbar-name">WHITE V3</span>
  </div>
  <div class="topbar-status">
    <div class="status-dot" style="width:8px;height:8px;border-radius:50%;background:${isBotOnline ? "var(--green)" : "var(--red)"};box-shadow:0 0 8px ${isBotOnline ? "var(--green)" : "var(--red)"};animation:pulse 2s infinite"></div>
  </div>
  <button class="hamburger" onclick="toggleSidebar()" aria-label="القائمة">
    <span></span><span></span><span></span>
  </button>
</div>

<!-- Sidebar Overlay (mobile) -->
<div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>

<div class="sidebar" id="mainSidebar">
  <div class="sidebar-top">
    <div class="brand">
      <div class="brand-logo">⚪</div>
      <div>
        <div class="brand-text gradient-text">WHITE V3</div>
        <div class="brand-sub">Panel Control</div>
      </div>
    </div>
    <div class="bot-status">
      <div class="status-dot"></div>
      <div class="status-label">${isBotOnline ? "البوت متصل" : "البوت غير متصل"}</div>
    </div>
  </div>
  <div class="nav-section">القائمة الرئيسية</div>
  ${nav}
  <div class="sidebar-bottom">
    <a href="/logout">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
      تسجيل الخروج
    </a>
  </div>
</div>

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

<div class="main">
  <div id="toast-container"></div>
  ${body}
</div>
<script>
function showToast(msg, type='success'){
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast-msg toast-' + type;
  t.innerHTML = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(()=>t.remove(),300); }, 4000);
}
async function api(url, data, method='POST'){
  try{
    const r = await fetch(url, {
      method,
      headers: {'Content-Type':'application/json'},
      body: method !== 'GET' ? JSON.stringify(data) : undefined
    });
    return await r.json();
  } catch(e){ return {error: e.message}; }
}
function toggleSidebar(){
  const s = document.getElementById('mainSidebar');
  const o = document.getElementById('sidebarOverlay');
  s.classList.toggle('open');
  o.classList.toggle('active');
}
function closeSidebar(){
  document.getElementById('mainSidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('active');
}
document.querySelectorAll('.nav-item').forEach(a => a.addEventListener('click', closeSidebar));
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

  const roleLabel = r => ["👤 عام","👮 مشرف","🛡️ مشرف بوت","👑 أدمن"][r] || String(r);
  const roleLabelFull = r => ["0 — 👤 عام (الجميع)","1 — 👮 مشرف المجموعة فقط","2 — 🛡️ مشرف البوت فقط","3 — 👑 أدمن البوت فقط"][r] || String(r);
  const roleColor = r => ["rgba(96,165,250,.13)","rgba(16,185,129,.13)","rgba(245,158,11,.13)","rgba(239,68,68,.13)"][r] || "var(--bg3)";
  const roleBorder = r => ["rgba(96,165,250,.4)","rgba(16,185,129,.4)","rgba(245,158,11,.4)","rgba(239,68,68,.4)"][r] || "var(--border)";
  const roleTextColor = r => ["#60a5fa","#6ee7b7","#fbbf24","#f87171"][r] || "var(--text2)";

  const catOptions = cats.map(c => `<option value="${htmlEscape(c)}">${htmlEscape(c)}</option>`).join("");

  // Store cmd data in JSON embedded in a script tag — avoids broken onclick quoting
  const cmdsJson = JSON.stringify(cmds.map(cmd => ({
    name: cmd.name, file: cmd.file, role: cmd.role,
    countDown: cmd.countDown, aliases: cmd.aliases, desc: cmd.desc, category: cmd.category
  })));

  const cards = cmds.map((cmd, i) => `
<div class="cmd-card"
  data-name="${htmlEscape(cmd.name)}"
  data-cat="${htmlEscape(cmd.category)}"
  data-role="${cmd.role}"
  data-i="${i}"
  style="background:var(--bg3);border:1px solid ${roleBorder(cmd.role)};border-radius:12px;padding:12px 14px;cursor:pointer;transition:all .2s;user-select:none">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:7px">
    <div style="font-weight:700;font-size:.88rem;color:var(--text);word-break:break-all;line-height:1.3">${htmlEscape(cmd.name)}</div>
    <span style="flex-shrink:0;font-size:.65rem;padding:2px 7px;border-radius:20px;background:${roleColor(cmd.role)};color:${roleTextColor(cmd.role)};border:1px solid ${roleBorder(cmd.role)};white-space:nowrap;margin-top:1px">${roleLabel(cmd.role)}</span>
  </div>
  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px">
    <span style="font-size:.68rem;color:var(--text3);background:var(--bg4);padding:2px 7px;border-radius:6px;max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📂 ${htmlEscape(cmd.category)}</span>
    <span style="font-size:.68rem;color:var(--text3)">⏱️ ${cmd.countDown}s</span>
  </div>
  ${cmd.aliases.length ? `<div style="font-size:.65rem;color:var(--text3);margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cmd.aliases.slice(0,3).map(a=>`<code>${htmlEscape(a)}</code>`).join(" ")}</div>` : ""}
</div>`).join("");

  const body = `
<div class="page-header" style="margin-bottom:16px">
  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
    <div>
      <div class="page-title">⚡ إدارة الأوامر</div>
      <div class="page-sub">${cmds.length} أمر — اضغط على أي أمر لتعديله</div>
    </div>
    <button class="btn btn-outline btn-sm" onclick="toggleSidebar()" style="display:flex;align-items:center;gap:6px">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
      القائمة
    </button>
  </div>
</div>

<!-- Filters -->
<div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:14px">
  <input type="text" id="cmdSearch" class="form-control" placeholder="🔍 ابحث باسم الأمر..." oninput="filterCommands()" style="font-size:.85rem;margin-bottom:8px"/>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <select id="catFilter" class="form-control" onchange="filterCommands()" style="font-size:.78rem">
      <option value="">📂 كل التصنيفات</option>
      ${catOptions}
    </select>
    <select id="roleFilter" class="form-control" onchange="filterCommands()" style="font-size:.78rem">
      <option value="">🔑 كل الصلاحيات</option>
      <option value="0">👤 عام</option>
      <option value="1">👮 مشرف المجموعة</option>
      <option value="2">🛡️ مشرف البوت</option>
      <option value="3">👑 أدمن البوت</option>
    </select>
  </div>
  <div id="cmdCount" style="font-size:.75rem;color:var(--text3);margin-top:8px">يعرض ${cmds.length} أمر</div>
</div>

<!-- Grid -->
<div id="cmdGrid" class="cmd-grid">
  ${cards}
</div>

<!-- Edit Modal -->
<div id="cmdModal" style="display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);align-items:flex-end;justify-content:center;padding:0">
  <div id="cmdModalBox" style="background:var(--bg2);border:1px solid var(--border);border-radius:20px 20px 0 0;padding:20px 18px 28px;width:100%;max-width:520px;max-height:88vh;overflow-y:auto;box-shadow:0 -10px 40px rgba(0,0,0,.6);transform:translateY(100%);transition:transform .3s cubic-bezier(.4,0,.2,1)">
    <!-- Handle -->
    <div style="width:40px;height:4px;background:var(--border2);border-radius:4px;margin:0 auto 18px;cursor:grab"></div>
    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div>
        <div style="font-size:.72rem;color:var(--text3);margin-bottom:2px">تعديل الأمر</div>
        <div style="font-weight:800;font-size:1.1rem;color:var(--accent2)" id="modalCmdName"></div>
      </div>
      <button onclick="closeModal()" style="background:var(--bg4);border:none;border-radius:10px;color:var(--text2);cursor:pointer;width:36px;height:36px;font-size:1.2rem;display:flex;align-items:center;justify-content:center;flex-shrink:0">✕</button>
    </div>
    <input type="hidden" id="modalFile"/>
    <!-- Role -->
    <div style="margin-bottom:14px">
      <label class="form-label" style="margin-bottom:6px">🔑 مستوى الصلاحية</label>
      <div id="roleButtons" style="display:grid;grid-template-columns:1fr 1fr;gap:7px">
        <button class="role-btn" data-role="0" onclick="selectRole(0)" style="padding:10px 6px;border-radius:10px;border:1px solid rgba(96,165,250,.4);background:rgba(96,165,250,.08);color:#60a5fa;font-family:Cairo,sans-serif;font-size:.8rem;cursor:pointer;font-weight:600;transition:all .2s">0 — 👤 عام</button>
        <button class="role-btn" data-role="1" onclick="selectRole(1)" style="padding:10px 6px;border-radius:10px;border:1px solid rgba(16,185,129,.3);background:transparent;color:var(--text2);font-family:Cairo,sans-serif;font-size:.8rem;cursor:pointer;font-weight:600;transition:all .2s">1 — 👮 مشرف</button>
        <button class="role-btn" data-role="2" onclick="selectRole(2)" style="padding:10px 6px;border-radius:10px;border:1px solid rgba(245,158,11,.3);background:transparent;color:var(--text2);font-family:Cairo,sans-serif;font-size:.8rem;cursor:pointer;font-weight:600;transition:all .2s">2 — 🛡️ مشرف بوت</button>
        <button class="role-btn" data-role="3" onclick="selectRole(3)" style="padding:10px 6px;border-radius:10px;border:1px solid rgba(239,68,68,.3);background:transparent;color:var(--text2);font-family:Cairo,sans-serif;font-size:.8rem;cursor:pointer;font-weight:600;transition:all .2s">3 — 👑 أدمن</button>
      </div>
      <input type="hidden" id="modalRole" value="0"/>
    </div>
    <!-- Cooldown -->
    <div style="margin-bottom:14px">
      <label class="form-label" style="margin-bottom:6px">⏱️ وقت الانتظار بين الاستخدامات (ثانية)</label>
      <div style="display:flex;align-items:center;gap:10px">
        <input type="range" id="modalCdRange" min="0" max="300" step="1" style="flex:1;accent-color:var(--accent);height:6px"
          oninput="document.getElementById('modalCd').value=this.value;document.getElementById('cdVal').textContent=this.value+'s'"/>
        <input type="number" id="modalCd" class="form-control" min="0" max="3600" style="width:72px;text-align:center;font-size:.9rem;padding:7px 6px"
          oninput="const v=parseInt(this.value)||0;document.getElementById('modalCdRange').value=Math.min(300,v);document.getElementById('cdVal').textContent=v+'s'"/>
      </div>
      <div style="font-size:.75rem;color:var(--accent2);margin-top:4px;font-weight:700" id="cdVal">0s</div>
    </div>
    <!-- Name -->
    <div style="margin-bottom:14px">
      <label class="form-label" style="margin-bottom:6px">📝 اسم الأمر <span style="font-weight:400;color:var(--text3)">(اتركه لعدم التغيير)</span></label>
      <input type="text" id="modalName" class="form-control" placeholder="اسم الأمر — بدون مسافات" style="font-family:'Courier New',monospace"/>
    </div>
    <!-- Info -->
    <div id="modalAliases" style="font-size:.75rem;color:var(--text3);margin-bottom:6px"></div>
    <div id="modalDesc" style="font-size:.75rem;color:var(--text3);font-style:italic;margin-bottom:14px"></div>
    <!-- Actions -->
    <div style="display:grid;grid-template-columns:1fr auto;gap:8px">
      <button class="btn btn-primary" onclick="saveCmd()" style="width:100%;justify-content:center">💾 حفظ التعديلات</button>
      <button class="btn btn-outline" onclick="closeModal()">إلغاء</button>
    </div>
    <div id="modalStatus" style="margin-top:10px;font-size:.82rem;font-weight:600;min-height:20px;text-align:center"></div>
  </div>
</div>

<style>
/* Commands Grid */
.cmd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;padding-bottom:8px}
.cmd-card:hover{border-color:var(--accent)!important;box-shadow:0 4px 18px rgba(59,130,246,.15)}
@media(max-width:600px){
  .cmd-grid{grid-template-columns:repeat(2,1fr);gap:8px}
}
@media(max-width:360px){
  .cmd-grid{grid-template-columns:1fr}
}
/* Active role button */
.role-btn.active{background:rgba(59,130,246,.18)!important;border-color:rgba(59,130,246,.7)!important;color:#93c5fd!important}
/* Scrollbar in modal */
#cmdModalBox::-webkit-scrollbar{width:4px}
#cmdModalBox::-webkit-scrollbar-track{background:transparent}
#cmdModalBox::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}
</style>

<script>
const _CMDS = ${cmdsJson};

// Build cmd-card click handlers using event delegation (safe from quote issues)
document.getElementById('cmdGrid').addEventListener('click', function(e){
  const card = e.target.closest('.cmd-card');
  if(!card) return;
  const i = parseInt(card.dataset.i);
  const cmd = _CMDS[i];
  if(!cmd) return;
  openCmd(cmd);
});

function openCmd(cmd){
  document.getElementById('modalCmdName').textContent = cmd.name;
  document.getElementById('modalFile').value = cmd.file;
  document.getElementById('modalName').value = cmd.name;
  const cd = cmd.countDown || 0;
  document.getElementById('modalCd').value = cd;
  document.getElementById('modalCdRange').value = Math.min(300, cd);
  document.getElementById('cdVal').textContent = cd + 's';
  document.getElementById('modalAliases').innerHTML = cmd.aliases && cmd.aliases.length
    ? '📎 أسماء مختصرة: ' + cmd.aliases.map(a=>'<code>'+a+'</code>').join(', ')
    : '';
  document.getElementById('modalDesc').textContent = cmd.desc ? '📄 ' + cmd.desc : '';
  document.getElementById('modalStatus').innerHTML = '';
  selectRole(cmd.role || 0);

  const modal = document.getElementById('cmdModal');
  const box = document.getElementById('cmdModalBox');
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  // Animate slide up
  requestAnimationFrame(()=>{ box.style.transform = 'translateY(0)'; });
}

function selectRole(r){
  document.getElementById('modalRole').value = r;
  document.querySelectorAll('.role-btn').forEach(b=>{
    const active = parseInt(b.dataset.role) === r;
    b.classList.toggle('active', active);
  });
}

function closeModal(){
  const box = document.getElementById('cmdModalBox');
  box.style.transform = 'translateY(100%)';
  setTimeout(()=>{
    document.getElementById('cmdModal').style.display = 'none';
    document.body.style.overflow = '';
  }, 280);
}

document.getElementById('cmdModal').addEventListener('click', function(e){
  if(e.target === this) closeModal();
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModal(); });

function filterCommands(){
  const q = document.getElementById('cmdSearch').value.toLowerCase().trim();
  const cat = document.getElementById('catFilter').value;
  const role = document.getElementById('roleFilter').value;
  const cards = document.querySelectorAll('.cmd-card');
  let vis = 0;
  cards.forEach(c => {
    const name = c.dataset.name.toLowerCase();
    const ok = (!q || name.includes(q)) && (!cat || c.dataset.cat === cat) && (!role || c.dataset.role === role);
    c.style.display = ok ? '' : 'none';
    if(ok) vis++;
  });
  document.getElementById('cmdCount').textContent = 'يعرض ' + vis + ' أمر';
}

async function saveCmd(){
  const file = document.getElementById('modalFile').value;
  const role = document.getElementById('modalRole').value;
  const cd = document.getElementById('modalCd').value;
  const nameEl = document.getElementById('modalName');
  const origName = document.getElementById('modalCmdName').textContent;
  const newName = nameEl.value.trim();
  const st = document.getElementById('modalStatus');
  st.innerHTML = '<span style="color:var(--text3)">⏳ جارٍ الحفظ...</span>';

  const updates = [
    { file, field: 'role', value: role },
    { file, field: 'countDown', value: cd }
  ];
  if(newName && newName !== origName) updates.push({ file, field: 'name', value: newName });

  let ok = true;
  for(const u of updates){
    const r = await api('/api/commands/update', u);
    if(!r.ok){ st.innerHTML = '<span style="color:var(--red)">❌ '+r.error+'</span>'; ok = false; break; }
  }
  if(ok){
    st.innerHTML = '<span style="color:var(--green)">✅ تم الحفظ!</span>';
    showToast('✅ تم تحديث الأمر: ' + origName, 'success');
    // Update card UI
    const card = document.querySelector('.cmd-card[data-name="'+CSS.escape(origName)+'"]');
    if(card) card.dataset.role = role;
    setTimeout(closeModal, 1400);
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
  const threads = (global.db?.allThreadData || []).slice(0, 80);
  const opts = threads.map(t =>
    `<option value="${htmlEscape(t.threadID)}">${htmlEscape(t.threadInfo?.threadName || t.threadID)}</option>`
  ).join("");

  const body = `
<div class="page-header">
  <div class="page-title">📨 إرسال رسالة سريعة</div>
  <div class="page-sub">أرسل رسالة مباشرة إلى أي غرفة عبر البوت</div>
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px" class="two-col">
<div>
<div class="card">
  <div class="card-header"><div class="card-title">💬 إرسال رسالة</div></div>
  <div class="form-group">
    <label class="form-label">معرّف الغرفة (Thread ID)</label>
    <input type="text" id="threadID" class="form-control" placeholder="100xxxxxxxxxx" list="threadList"/>
    <datalist id="threadList">${opts}</datalist>
  </div>
  <div class="form-group">
    <label class="form-label">نص الرسالة</label>
    <textarea id="msgText" class="form-control" rows="5" placeholder="اكتب رسالتك هنا..."></textarea>
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" onclick="sendMsg()">📤 إرسال</button>
    <button class="btn btn-outline" onclick="document.getElementById('msgText').value=''">🗑️ مسح</button>
  </div>
</div>

<div class="card">
  <div class="card-header"><div class="card-title">⚡ قوالب سريعة</div></div>
  <div style="display:grid;gap:8px">
    ${[
      ["👋 تحية","مرحباً! كيف يمكنني مساعدتك؟"],
      ["🔧 صيانة","البوت يخضع للصيانة حالياً، سنعود قريباً."],
      ["✅ جاهز","البوت جاهز ويعمل بشكل طبيعي."],
      ["🚫 إيقاف","سيتوقف البوت مؤقتاً خلال دقائق."]
    ].map(([lbl,txt]) => `<button class="btn btn-outline btn-sm" onclick="document.getElementById('msgText').value='${txt}'">${lbl}</button>`).join("")}
  </div>
</div>
</div>

<div>
<div class="card">
  <div class="card-header">
    <div class="card-title">📋 الغرف المتاحة</div>
    <span class="badge badge-blue">${threads.length} غرفة</span>
  </div>
  ${threads.length ? `
  <div style="max-height:400px;overflow-y:auto">
    <table class="table">
      <thead><tr><th>اسم الغرفة</th><th>المعرّف</th><th>إرسال</th></tr></thead>
      <tbody>
        ${threads.map(t => `
        <tr>
          <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${htmlEscape(t.threadInfo?.threadName || "—")}</td>
          <td><code>${t.threadID}</code></td>
          <td><button class="btn btn-primary btn-sm" onclick="setThread('${t.threadID}')">اختر</button></td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>` : `<p style="color:var(--text3);text-align:center;padding:20px">لا توجد غرف — البوت غير متصل</p>`}
</div>
</div>
</div>

<script>
async function sendMsg(){
  const threadID = document.getElementById('threadID').value.trim();
  const message  = document.getElementById('msgText').value.trim();
  if(!threadID) return showToast('❌ أدخل معرّف الغرفة','error');
  if(!message)  return showToast('❌ اكتب رسالة أولاً','error');
  const r = await api('/api/send', {threadID, message});
  r.ok ? showToast('✅ تم الإرسال بنجاح!','success') : showToast('❌ '+r.error,'error');
}
function setThread(id){ document.getElementById('threadID').value=id; showToast('✅ تم اختيار الغرفة','success'); }
</script>`;
  res.send(layout("إرسال رسالة", body, "send"));
});

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
