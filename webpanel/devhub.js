"use strict";
const fs      = require("fs-extra");
const path    = require("path");
const multer  = require("multer");
const os      = require("os");
const { execSync, spawnSync } = require("child_process");

const ROOT      = path.join(__dirname, "..");
const CFG_FILE  = path.join(__dirname, "devhub-config.json");
const VER_FILE  = path.join(__dirname, "devhub-versions.json");
const PANEL_CFG = path.join(__dirname, "panel-config.json");

// ─── Config ───────────────────────────────────────────────────────────────────
function loadCfg() {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
    return {
      githubTokenEnc: "", baseRepo: "WHITE-V3", baseOwner: "castrolmocro",
      railwayApiToken: "", railwayWebhook: "", railwayServiceId: "", railwayEnvironmentId: "",
      maxUpdateRepos: 5, chatHistory: [], claudeHistory: [],
      ...raw
    };
  } catch (_) {
    return { githubTokenEnc: "", baseRepo: "WHITE-V3", baseOwner: "castrolmocro",
      railwayApiToken: "", railwayWebhook: "", railwayServiceId: "", railwayEnvironmentId: "",
      maxUpdateRepos: 5, chatHistory: [], claudeHistory: [] };
  }
}
function saveCfg(c) {
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2)); } catch(_) {}
}
function encTok(t) { return Buffer.from(String(t), "utf8").toString("base64"); }
function decTok(t) { try { return Buffer.from(String(t), "base64").toString("utf8"); } catch(_) { return ""; } }
function loadToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const enc = loadCfg().githubTokenEnc || "";
  if (!enc) return "";
  return decTok(enc);
}
function loadVersions() { try { return JSON.parse(fs.readFileSync(VER_FILE, "utf8")); } catch(_) { return []; } }
function saveVersions(v) { try { fs.writeFileSync(VER_FILE, JSON.stringify(v, null, 2)); } catch(_) {} }

// ─── Bot File Scanner ─────────────────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", ".local", "assets"]);
const SCAN_EXTS = new Set([".js", ".json", ".md", ".txt", ".yaml", ".yml", ".sh", ".env"]);
function listAllBotFiles() {
  const result = [];
  function scan(dir, depth = 0) {
    if (depth > 4) return;
    const full = path.join(ROOT, dir);
    try {
      for (const item of fs.readdirSync(full, { withFileTypes: true })) {
        const rel = dir ? `${dir}/${item.name}` : item.name;
        if (item.isDirectory() && !SKIP_DIRS.has(item.name)) scan(rel, depth + 1);
        else if (!item.isDirectory() && SCAN_EXTS.has(path.extname(item.name).toLowerCase())) result.push(rel);
      }
    } catch(_) {}
  }
  scan("");
  return [...new Set(result)].slice(0, 300);
}
function readBotFile(relPath) {
  try { return fs.readFileSync(path.join(ROOT, relPath), "utf8").slice(0, 20000); }
  catch(e) { return `خطأ في قراءة الملف: ${e.message}`; }
}
function writeBotFile(relPath, content) {
  const full = path.join(ROOT, relPath);
  fs.ensureDirSync(path.dirname(full));
  fs.writeFileSync(full, content, "utf8");
}
function getBotStats() {
  const s = { cmds: 0, events: 0, prefix: "/", version: "—", name: "WHITE BOT" };
  try { s.cmds = fs.readdirSync(path.join(ROOT, "scripts/cmds")).filter(f => f.endsWith(".js")).length; } catch(_) {}
  try { s.events = fs.readdirSync(path.join(ROOT, "scripts/events")).filter(f => f.endsWith(".js")).length; } catch(_) {}
  try { const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")); s.prefix = cfg.prefix || "/"; s.name = cfg.nickNameBot || "WHITE BOT"; } catch(_) {}
  try { s.version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "—"; } catch(_) {}
  return s;
}
function buildAutoContext() {
  const parts = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    parts.push(`=== إعدادات البوت ===\nالبريفيكس: ${cfg.prefix||"/"}\nاللغة: ${cfg.language||"en"}\nاسم البوت: ${cfg.nickNameBot||"—"}\nSuperAdmin: ${(cfg.superAdminBot||[]).join(", ")}`);
  } catch(_) {}
  try {
    const cmds = fs.readdirSync(path.join(ROOT, "scripts/cmds")).filter(f => f.endsWith(".js"));
    parts.push(`=== الأوامر (${cmds.length}) ===\n${cmds.join(", ")}`);
  } catch(_) {}
  try {
    const evs = fs.readdirSync(path.join(ROOT, "scripts/events")).filter(f => f.endsWith(".js"));
    parts.push(`=== الأحداث (${evs.length}) ===\n${evs.join(", ")}`);
  } catch(_) {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    parts.push(`=== المشروع ===\n${pkg.name} v${pkg.version}`);
  } catch(_) {}
  return parts.join("\n\n");
}

// ─── AI ───────────────────────────────────────────────────────────────────────
const AI_ENDPOINTS = [
  { url: "https://text.pollinations.ai/openai", model: "openai", label: "OpenAI (Pollinations)" },
  { url: "https://text.pollinations.ai/openai", model: "mistral", label: "Mistral (Pollinations)" },
  { url: "https://text.pollinations.ai/openai", model: "openai-fast", label: "OpenAI Fast" },
  { url: "https://text.pollinations.ai/openai", model: "llama", label: "LLaMA" },
  { url: "https://text.pollinations.ai/openai", model: "deepseek", label: "DeepSeek" }
];
async function callAI(preferModel, messages, timeout = 35000) {
  const preferred = AI_ENDPOINTS.find(e => e.model === preferModel) || AI_ENDPOINTS[0];
  const order = [preferred, ...AI_ENDPOINTS.filter(e => e.model !== preferModel)];
  let lastErr = "خطأ غير معروف";
  for (const ep of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(ep.url, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json", "User-Agent": "WHITE-V3-DevHub/1.0" },
          body: JSON.stringify({ model: ep.model, messages, stream: false, seed: Math.floor(Math.random()*99999) })
        });
        clearTimeout(timer);
        if (!res.ok) { lastErr = `HTTP ${res.status} من ${ep.label}`; await delay(1000); continue; }
        const data = await res.json();
        const reply = data?.choices?.[0]?.message?.content;
        if (reply?.trim()) return { ok: true, reply: reply.trim(), model: ep.label };
        lastErr = `رد فارغ من ${ep.label}`;
      } catch(e) {
        clearTimeout(timer);
        lastErr = e.name === "AbortError" ? `انتهت مهلة الاتصال بـ ${ep.label}` : e.message;
      }
      await delay(800);
    }
  }
  throw new Error(`فشل الاتصال بجميع نماذج الذكاء الاصطناعي.\nالسبب: ${lastErr}\n\nتحقق من اتصال الإنترنت وأعد المحاولة.`);
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Agents ───────────────────────────────────────────────────────────────────
const AGENTS = {
  analyst: {
    name: "المحلل", model: "llama", icon: "🔍", color: "#60a5fa",
    prompt: `أنت محلل خبير في بوتات فيسبوك Messenger بـ Node.js (GoatBot/WhiteBot).
- أجب دائماً بالعربية
- حلّل الطلب وحدد المشكلة والحل المناسب
- كن موجزاً ومباشراً
- اذكر الملفات المطلوب تعديلها
- لا تكتب كوداً في هذه المرحلة`
  },
  implementer: {
    name: "المطور", model: "mistral", icon: "💻", color: "#c4b5fd",
    prompt: `أنت مطور Node.js متخصص في بوتات GoatBot.
- أجب بالعربية
- اكتب الكود الكامل داخل \`\`\`javascript بلوك
- استخدم module.exports = { config:{...}, onStart: async({...})=>{} }
- الكود يجب أن يعمل مباشرة دون تعديل`
  },
  reviewer: {
    name: "المراجع", model: "openai", icon: "✅", color: "#6ee7b7",
    prompt: `أنت مراجع كود لبوتات GoatBot فيسبوك.
- أجب بالعربية في 3-5 أسطر
- حكم نهائي: ✅ يعمل أو ❌ يحتاج تعديل مع السبب
- اذكر أي مشاكل محتملة
- لا تكرر الكود`
  }
};

async function runPipeline(userMsg, fileContexts, history, autoCtx) {
  const ctxStr = [
    autoCtx ? `=== معلومات البوت ===\n${autoCtx}` : "",
    ...(fileContexts||[]).map(f => `--- ${f.path} ---\n${f.content}`)
  ].filter(Boolean).join("\n\n");

  const baseHistory = [...(history||[]).slice(-6), { role:"user", content: userMsg + (ctxStr ? `\n\n${ctxStr}` : "") }];
  const steps = [];

  // Step 1: Analyst
  const aResult = await callAI(AGENTS.analyst.model, [{ role:"system", content: AGENTS.analyst.prompt }, ...baseHistory]);
  steps.push({ agent:"analyst", name:AGENTS.analyst.name, icon:AGENTS.analyst.icon, color:AGENTS.analyst.color, reply:aResult.reply, model:aResult.model });

  // Step 2: Implementer
  const iResult = await callAI(AGENTS.implementer.model, [
    { role:"system", content: AGENTS.implementer.prompt },
    ...baseHistory,
    { role:"assistant", content:`[التحليل]: ${aResult.reply}` },
    { role:"user", content:"بناءً على التحليل، اكتب الكود الكامل." }
  ]);
  steps.push({ agent:"implementer", name:AGENTS.implementer.name, icon:AGENTS.implementer.icon, color:AGENTS.implementer.color, reply:iResult.reply, model:iResult.model });

  // Step 3: Reviewer
  const rResult = await callAI(AGENTS.reviewer.model, [
    { role:"system", content: AGENTS.reviewer.prompt },
    { role:"user", content:`الطلب: ${userMsg}\nالتحليل: ${aResult.reply}\nالكود: ${iResult.reply}\nهل هو صحيح؟` }
  ]);
  steps.push({ agent:"reviewer", name:AGENTS.reviewer.name, icon:AGENTS.reviewer.icon, color:AGENTS.reviewer.color, reply:rResult.reply, model:rResult.model });

  return steps;
}

// ─── GitHub API ────────────────────────────────────────────────────────────────
async function ghApi(token, method, endpoint, body) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "WHITE-V3-Panel"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `GitHub API خطأ ${res.status}`);
  return data;
}
async function ghGetRepos(token) {
  const [owned, collab] = await Promise.allSettled([
    ghApi(token, "GET", "/user/repos?per_page=100&sort=updated&type=owner&affiliation=owner"),
    ghApi(token, "GET", "/user/repos?per_page=100&sort=updated&type=member&affiliation=organization_member")
  ]);
  const all = [];
  if (owned.status === "fulfilled") all.push(...(Array.isArray(owned.value) ? owned.value : []));
  if (collab.status === "fulfilled") all.push(...(Array.isArray(collab.value) ? collab.value : []));
  return [...new Map(all.map(r => [r.id, r])).values()];
}
async function ghGetUser(token) { return ghApi(token, "GET", "/user"); }
async function ghCreateRepo(token, name, isPrivate = true) {
  return ghApi(token, "POST", "/user/repos", { name, private: isPrivate, auto_init: true, description: `WHITE V3 تحديث — ${new Date().toISOString().split("T")[0]}` });
}

// ─── Git Push (via subprocess) ─────────────────────────────────────────────────
const SKIP_COPY = new Set(["node_modules", ".git", ".cache", ".local"]);
const SKIP_EXT  = new Set([".log", ".sqlite", ".db"]);
function nodeCopyAll(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (SKIP_COPY.has(path.basename(src))) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) nodeCopyAll(path.join(src, f), path.join(dst, f));
  } else {
    if (SKIP_EXT.has(path.extname(src))) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}
function gitPush(token, owner, repo, branch, commitMsg) {
  const tmpDir = path.join(os.tmpdir(), `wv3-${Date.now()}`);
  const remote  = `https://${token}@github.com/${owner}/${repo}.git`;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    nodeCopyAll(ROOT, tmpDir);
    const run = (cmd) => execSync(cmd, { stdio: "pipe", cwd: tmpDir });
    run(`git init`);
    run(`git config user.email "whitepanel@local.bot"`);
    run(`git config user.name "WHITE V3 Panel"`);
    run(`git config http.postBuffer 524288000`);
    run(`git add -A`);
    try { run(`git commit -m "${commitMsg.replace(/"/g, "'")}"`); } catch(_) {}
    run(`git remote add origin "${remote}"`);
    run(`git push origin HEAD:${branch} --force`);
    return { ok: true };
  } catch(e) {
    return { ok: false, error: (e.stderr?.toString() || e.message).slice(0, 500) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
  }
}

// ─── Railway ──────────────────────────────────────────────────────────────────
async function railwayGql(token, query, vars = {}) {
  const res = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ query, variables: vars })
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.message || "Railway GraphQL خطأ");
  return data.data;
}
async function railwayGetProjects(token) {
  const d = await railwayGql(token, `query { me { projects { edges { node { id name environments { edges { node { id name } } } services { edges { node { id name } } } } } } } }`);
  return d?.me?.projects?.edges?.map(e => e.node) || [];
}
async function railwayTriggerDeploy(token, serviceId, environmentId) {
  return railwayGql(token,
    `mutation($serviceId:String!,$environmentId:String!){serviceInstanceRedeploy(serviceId:$serviceId,environmentId:$environmentId)}`,
    { serviceId, environmentId }
  );
}

// ─── HTML Helpers ─────────────────────────────────────────────────────────────
function he(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

// ═════════════════════════════════════════════════════════════════════════════
// ══ MOUNT ROUTES ════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════
module.exports = function mountDevHub(app, auth, layout) {

  // ── Main DevHub Page ──────────────────────────────────────────────────────
  app.get("/devhub", auth, (req, res) => {
    const cfg    = loadCfg();
    const stats  = getBotStats();
    const files  = listAllBotFiles();
    const hasToken = !!loadToken();
    const versions = loadVersions().slice(-8).reverse();

    // Group files by dir for the file selector
    const byDir = {};
    for (const f of files) {
      const dir = f.includes("/") ? f.split("/").slice(0,-1).join("/") : "root";
      (byDir[dir] = byDir[dir] || []).push(f);
    }
    const fileOpts = Object.entries(byDir).map(([dir, fs_]) =>
      `<optgroup label="${he(dir)}">${fs_.map(f=>`<option value="${he(f)}">${he(f.split("/").pop())}</option>`).join("")}</optgroup>`
    ).join("");

    const verRows = versions.length
      ? versions.map(v => `<tr>
          <td><code style="color:#60a5fa;font-size:.8rem">${he(v.branch||v.repo||"—")}</code></td>
          <td style="color:var(--text2);font-size:.8rem">${he(v.date||"")}</td>
          <td><span class="badge ${v.status==="success"?"badge-green":v.status==="failed"?"badge-red":"badge-yellow"}">${he(v.status||"—")}</span></td>
          <td>${v.repoUrl?`<a href="${he(v.repoUrl)}" target="_blank" class="btn btn-outline btn-sm" style="font-size:.75rem">🔗 فتح</a>`:""}</td>
        </tr>`).join("")
      : `<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:20px">لا يوجد سجل بعد</td></tr>`;

    const body = `
<style>
/* ═══════════════ DEVHUB STYLES ═══════════════ */
.dh-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px;background:var(--bg2);padding:10px;border-radius:12px;border:1px solid var(--border)}
.dh-tab{padding:8px 16px;border-radius:8px;font-size:.83rem;font-weight:600;cursor:pointer;border:none;background:transparent;color:var(--text3);transition:all .2s;font-family:'Cairo',sans-serif;display:flex;align-items:center;gap:6px;white-space:nowrap}
.dh-tab:hover{background:var(--bg4);color:var(--text)}
.dh-tab.active{background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;box-shadow:0 4px 12px rgba(59,130,246,.4)}
.dh-panel{display:none}.dh-panel.active{display:block}

.agent-card{background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px}
.agent-hdr{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-weight:700;font-size:.9rem}
.agent-dot{width:10px;height:10px;border-radius:50%;animation:pulse 2s infinite}

.msg-box{background:#020812;border:1px solid var(--border);border-radius:10px;padding:14px;min-height:200px;max-height:420px;overflow-y:auto;font-size:.83rem;line-height:1.75}
.msg-box::-webkit-scrollbar{width:5px}
.msg-box::-webkit-scrollbar-thumb{background:#1e2d45;border-radius:3px}
.msg-me{background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.2);border-radius:10px;padding:10px 14px;margin-bottom:10px;color:var(--text)}
.msg-agent{background:var(--bg4);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:10px}
.msg-agent-hdr{font-size:.75rem;font-weight:700;margin-bottom:6px}
.msg-thinking{background:var(--bg3);border:1px dashed var(--border);border-radius:10px;padding:10px 14px;margin-bottom:10px;color:var(--text3);font-size:.82rem;animation:pulse 1.5s infinite}

.input-row{display:flex;gap:8px;margin-top:10px;align-items:flex-end}
.input-row textarea{flex:1;min-height:52px;max-height:150px;resize:vertical}
.input-row .btn{flex-shrink:0;height:52px;padding:0 20px}

.token-status{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:8px;font-size:.83rem;font-weight:600;margin-bottom:14px}
.token-ok{background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);color:#6ee7b7}
.token-no{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#f87171}

.repo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-top:12px}
.repo-item{background:var(--bg3);border:2px solid var(--border);border-radius:10px;padding:12px;cursor:pointer;transition:all .2s}
.repo-item:hover{border-color:var(--accent);background:rgba(59,130,246,.05)}
.repo-item.selected{border-color:#3b82f6;background:rgba(59,130,246,.1)}
.repo-item .repo-name{font-weight:700;font-size:.88rem;color:var(--text);margin-bottom:4px}
.repo-item .repo-meta{font-size:.72rem;color:var(--text3);display:flex;gap:8px;flex-wrap:wrap}
.repo-item .repo-private{font-size:.68rem;padding:2px 6px;border-radius:10px;background:rgba(245,158,11,.15);color:#fbbf24}
.repo-item .repo-public{font-size:.68rem;padding:2px 6px;border-radius:10px;background:rgba(16,185,129,.15);color:#6ee7b7}

.step-card{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;position:relative}
.step-card.done{border-color:rgba(16,185,129,.4)}
.step-card.active{border-color:rgba(59,130,246,.5);animation:borderPulse 1.5s infinite}
.step-card.error{border-color:rgba(239,68,68,.4)}
.step-num{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.78rem;font-weight:700;flex-shrink:0}
.step-num.done{background:rgba(16,185,129,.2);color:#6ee7b7}
.step-num.active{background:rgba(59,130,246,.2);color:#60a5fa}
.step-num.pending{background:var(--bg4);color:var(--text3)}

.info-box{background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.2);border-radius:10px;padding:14px;margin-bottom:14px}
.info-box.warn{background:rgba(245,158,11,.06);border-color:rgba(245,158,11,.2)}
.info-box.success{background:rgba(16,185,129,.06);border-color:rgba(16,185,129,.2)}
.info-box h4{font-size:.85rem;font-weight:700;margin-bottom:8px}
.info-box ul{padding-right:16px;font-size:.82rem;color:var(--text2);line-height:2}

.guide-step{display:flex;gap:12px;padding:12px;background:var(--bg3);border-radius:10px;margin-bottom:8px;align-items:flex-start}
.guide-step-num{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#6366f1);display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;color:#fff;flex-shrink:0;margin-top:2px}
.guide-step-text{font-size:.83rem;color:var(--text2);line-height:1.8}
.guide-step-text strong{color:var(--text)}
.guide-step-text code{background:var(--bg4);color:#93c5fd;padding:1px 6px;border-radius:4px;font-size:.78rem}

@keyframes borderPulse{0%,100%{box-shadow:0 0 0 0 rgba(59,130,246,.3)}50%{box-shadow:0 0 0 4px rgba(59,130,246,.1)}}

.prog-bar-outer{height:6px;background:var(--bg4);border-radius:3px;overflow:hidden;margin-top:8px}
.prog-bar-inner{height:100%;background:linear-gradient(90deg,#3b82f6,#6366f1);border-radius:3px;transition:width .5s ease}

pre.code-block{background:#010409;border:1px solid #1e2d45;border-radius:8px;padding:12px;font-size:.73rem;overflow-x:auto;white-space:pre-wrap;color:#c9d1d9;margin:8px 0;font-family:'Courier New',monospace}
.copy-btn{font-size:.72rem;padding:4px 10px;margin-bottom:6px}

@media(max-width:768px){
  .dh-tab{padding:7px 12px;font-size:.78rem}
  .dh-tab span.tab-label{display:none}
  .repo-grid{grid-template-columns:1fr 1fr}
  .input-row{flex-direction:column}
  .input-row .btn{height:44px;width:100%}
  .msg-box{max-height:55vh}
}
</style>

<!-- DevHub Header -->
<div class="page-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px">
  <div>
    <div class="page-title">🛠️ مركز التطوير</div>
    <div class="page-sub">وكلاء ذكاء اصطناعي • GitHub • Railway • نشر آمن</div>
  </div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <span class="badge ${hasToken ? "badge-green" : "badge-red"}">${hasToken ? "✅ GitHub مُتصل" : "⚠️ لا يوجد Token"}</span>
    <span class="badge badge-blue">v${he(stats.version)}</span>
    <span class="badge badge-blue">${stats.cmds} أمر</span>
  </div>
</div>

<!-- Stats -->
<div class="stats-grid" style="margin-bottom:20px">
  <div class="stat stat-blue"><div class="stat-glow"></div><div class="stat-icon">🤖</div><div class="stat-val">${stats.cmds}</div><div class="stat-lbl">أمر مُحمَّل</div></div>
  <div class="stat stat-green"><div class="stat-glow"></div><div class="stat-icon">⚡</div><div class="stat-val">${stats.events}</div><div class="stat-lbl">حدث مُحمَّل</div></div>
  <div class="stat stat-purple"><div class="stat-glow"></div><div class="stat-icon">📁</div><div class="stat-val">${files.length}</div><div class="stat-lbl">ملف في البوت</div></div>
  <div class="stat stat-cyan"><div class="stat-glow"></div><div class="stat-icon">🔗</div><div class="stat-val">${hasToken ? "✅" : "❌"}</div><div class="stat-lbl">GitHub</div></div>
</div>

<!-- Tabs -->
<div class="dh-tabs" role="tablist">
  <button class="dh-tab active" onclick="showTab('agents',this)">🤖 <span class="tab-label">الوكلاء الذكية</span></button>
  <button class="dh-tab" onclick="showTab('chat',this)">💬 <span class="tab-label">محادثة حرة</span></button>
  <button class="dh-tab" onclick="showTab('github',this)">🔗 <span class="tab-label">GitHub</span></button>
  <button class="dh-tab" onclick="showTab('railway',this)">🚂 <span class="tab-label">Railway</span></button>
  <button class="dh-tab" onclick="showTab('files',this)">📁 <span class="tab-label">الملفات</span></button>
  <button class="dh-tab" onclick="showTab('safe-deploy',this)">🛡️ <span class="tab-label">النشر الآمن</span></button>
  <button class="dh-tab" onclick="showTab('guide',this)">📖 <span class="tab-label">دليل المطور</span></button>
</div>

<!-- ═══════════════ TAB: AGENTS ═══════════════ -->
<div id="tab-agents" class="dh-panel active">
  <div class="info-box" style="margin-bottom:16px">
    <h4>🤖 كيف تعمل الوكلاء الثلاثة؟</h4>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:150px;padding:10px;background:rgba(96,165,250,.08);border-radius:8px;font-size:.8rem">
        <div style="color:#60a5fa;font-weight:700;margin-bottom:4px">🔍 المحلل</div>
        <div style="color:var(--text2)">يفهم طلبك ويحدد ما يجب تعديله وأي ملفات تحتاج تغيير</div>
      </div>
      <div style="flex:1;min-width:150px;padding:10px;background:rgba(196,181,253,.08);border-radius:8px;font-size:.8rem">
        <div style="color:#c4b5fd;font-weight:700;margin-bottom:4px">💻 المطور</div>
        <div style="color:var(--text2)">يكتب الكود المطلوب استناداً لتحليل المحلل</div>
      </div>
      <div style="flex:1;min-width:150px;padding:10px;background:rgba(110,231,183,.08);border-radius:8px;font-size:.8rem">
        <div style="color:#6ee7b7;font-weight:700;margin-bottom:4px">✅ المراجع</div>
        <div style="color:var(--text2)">يراجع الكود ويتأكد من صحته قبل التطبيق</div>
      </div>
    </div>
  </div>

  <!-- Context Toggle -->
  <div class="card" style="padding:14px;margin-bottom:14px">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div style="flex:1">
        <div style="font-size:.85rem;font-weight:700;margin-bottom:4px">📎 السياق التلقائي للبوت</div>
        <div style="font-size:.77rem;color:var(--text3)">يعطي الوكلاء معلومات عن بوتك (الأوامر، الإعدادات) لردود أكثر دقة</div>
      </div>
      <label class="toggle"><input type="checkbox" id="autoCtxToggle" checked/><span class="slider"></span></label>
    </div>
    <div style="margin-top:10px;font-size:.78rem;font-weight:600;color:var(--text3);margin-bottom:6px">📂 أضف ملفات للسياق (اختياري — اختر حتى 4 ملفات):</div>
    <select id="fileSelect" class="form-control" multiple style="height:90px;font-size:.8rem">
      ${fileOpts}
    </select>
    <div class="btn-row" style="margin-top:8px;gap:6px">
      <button class="btn btn-outline btn-sm" onclick="previewFile()">👁️ معاينة</button>
      <button class="btn btn-outline btn-sm" onclick="clearSel()">✕ مسح</button>
    </div>
    <div id="filePreviewArea" style="display:none;margin-top:8px">
      <pre id="filePreview" class="code-block" style="max-height:150px;overflow-y:auto"></pre>
    </div>
  </div>

  <!-- Chat Box -->
  <div class="card" style="padding:16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div style="font-weight:700">محادثة مع الوكلاء</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" onclick="quickAction('أضف أمر جديد للبوت')">➕ أمر جديد</button>
        <button class="btn btn-outline btn-sm" onclick="quickAction('راجع كود الأمر الأخير وأصلح الأخطاء')">🔍 مراجعة</button>
        <button class="btn btn-outline btn-sm" onclick="quickAction('اشرح لي كيف يعمل نظام الأحداث في GoatBot')">📚 شرح</button>
        <button class="btn btn-danger btn-sm" onclick="clearChat('agents')">🗑️</button>
      </div>
    </div>
    <div id="chatBox" class="msg-box"></div>
    <div id="agentStatus" style="font-size:.78rem;color:var(--text3);min-height:18px;margin-top:6px;text-align:center"></div>
    <div class="input-row">
      <textarea id="chatInput" class="form-control" placeholder="مثال: أضف أمر /time يُظهر الوقت الحالي..." rows="2" onkeydown="if(event.ctrlKey&&event.key==='Enter')sendToAgents()"></textarea>
      <button class="btn btn-primary" id="agentSendBtn" onclick="sendToAgents()">
        <span id="agentBtnTxt">إرسال</span>
      </button>
    </div>
    <div style="font-size:.72rem;color:var(--text3);margin-top:6px;text-align:center">Ctrl+Enter للإرسال</div>
  </div>

  <!-- Apply Code to File -->
  <div class="card" style="padding:14px">
    <div class="card-title" style="margin-bottom:10px">🔧 تطبيق الكود على ملف</div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">اختر الملف</label>
        <select id="applyFile" class="form-control" style="font-size:.82rem">
          ${files.map(f=>`<option value="${he(f)}">${he(f)}</option>`).join("")}
        </select>
      </div>
      <div class="form-group" style="display:flex;flex-direction:column;justify-content:flex-end">
        <button class="btn btn-primary" onclick="applyLastCode()">✅ تطبيق آخر كود على الملف</button>
      </div>
    </div>
    <div id="applyStatus" style="margin-top:8px;font-size:.82rem"></div>
  </div>
</div>

<!-- ═══════════════ TAB: FREE CHAT ═══════════════ -->
<div id="tab-chat" class="dh-panel">
  <div class="card" style="padding:16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div style="font-weight:700">💬 محادثة حرة مع الذكاء الاصطناعي</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <select id="freeModel" class="form-control" style="width:auto;font-size:.8rem;padding:5px 10px">
          <option value="openai">🔵 OpenAI</option>
          <option value="mistral">🟣 Mistral</option>
          <option value="llama">🦙 LLaMA</option>
          <option value="deepseek">🐋 DeepSeek</option>
        </select>
        <button class="btn btn-danger btn-sm" onclick="clearChat('chat')">🗑️</button>
      </div>
    </div>
    <div id="chatBoxFree" class="msg-box" style="min-height:300px"></div>
    <div id="freeStatus" style="font-size:.78rem;color:var(--text3);min-height:18px;margin-top:6px;text-align:center"></div>
    <div class="input-row">
      <textarea id="freeInput" class="form-control" placeholder="اسأل أي سؤال..." rows="2" onkeydown="if(event.ctrlKey&&event.key==='Enter')sendFree()"></textarea>
      <button class="btn btn-primary" onclick="sendFree()">إرسال</button>
    </div>
  </div>
</div>

<!-- ═══════════════ TAB: GITHUB ═══════════════ -->
<div id="tab-github" class="dh-panel">

  <!-- Token Section -->
  <div class="card" style="padding:16px">
    <div class="card-title" style="margin-bottom:14px">🔑 توكن GitHub</div>

    <div id="tokenStatusDiv" class="token-status ${hasToken ? "token-ok" : "token-no"}">
      ${hasToken
        ? `<span>✅</span> التوكن محفوظ ومتصل — حسابك: <span id="ghUserDisplay">جارٍ التحقق...</span>`
        : `<span>❌</span> لا يوجد توكن — أضفه أدناه لربط حسابك بـ GitHub`}
    </div>

    <!-- How to get token guide -->
    <details style="margin-bottom:14px">
      <summary style="cursor:pointer;font-size:.83rem;font-weight:700;color:var(--accent2);padding:8px 0">📖 كيف أحصل على توكن GitHub؟ (اضغط هنا)</summary>
      <div style="margin-top:10px;padding:14px;background:var(--bg3);border-radius:10px;border:1px solid var(--border)">
        <div class="guide-step">
          <div class="guide-step-num">1</div>
          <div class="guide-step-text">افتح موقع <strong>GitHub.com</strong> وادخل على حسابك</div>
        </div>
        <div class="guide-step">
          <div class="guide-step-num">2</div>
          <div class="guide-step-text">اضغط على صورة حسابك في الزاوية العلوية اليمنى ← <strong>Settings</strong></div>
        </div>
        <div class="guide-step">
          <div class="guide-step-num">3</div>
          <div class="guide-step-text">انزل للأسفل وادخل على <strong>Developer settings</strong> (في أسفل القائمة الجانبية)</div>
        </div>
        <div class="guide-step">
          <div class="guide-step-num">4</div>
          <div class="guide-step-text">اختر <strong>Personal access tokens</strong> ← <strong>Tokens (classic)</strong></div>
        </div>
        <div class="guide-step">
          <div class="guide-step-num">5</div>
          <div class="guide-step-text">اضغط <strong>Generate new token (classic)</strong> — اختر صلاحيات <code>repo</code> و <code>workflow</code> ← توليد</div>
        </div>
        <div class="guide-step">
          <div class="guide-step-num">6</div>
          <div class="guide-step-text">انسخ التوكن (يبدأ بـ <code>ghp_</code>) والصقه هنا. <strong>لن يُعرض مرة أخرى!</strong></div>
        </div>
        <div style="margin-top:10px;padding:10px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:8px;font-size:.8rem;color:#fbbf24">
          ⚠️ <strong>مهم:</strong> لا تشارك توكنك مع أحد. يمنح صلاحية كاملة على ريبوهاتك.
        </div>
      </div>
    </details>

    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">🔑 GitHub Personal Access Token</label>
        <div style="position:relative">
          <input type="password" id="ghToken" class="form-control" placeholder="ghp_xxxxxxxxxxxxxxxxxx" value="${hasToken ? "••••••••••••••••••••" : ""}"/>
          <button onclick="toggleTokenVis()" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text3);font-size:.9rem">👁️</button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">👤 اسم مستخدم GitHub</label>
        <input type="text" id="ghOwner" class="form-control" value="${he(cfg.baseOwner||"castrolmocro")}" placeholder="castrolmocro"/>
      </div>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="saveToken()">💾 حفظ التوكن</button>
      <button class="btn btn-outline" onclick="testToken()">🔍 اختبار الاتصال</button>
      <button class="btn btn-danger btn-sm" onclick="clearToken()">🗑️ حذف التوكن</button>
    </div>
    <div id="tokenTestResult" style="margin-top:10px;font-size:.83rem"></div>
  </div>

  <!-- Repo Selection -->
  <div class="card" id="repoSection" style="padding:16px;${hasToken?"":"opacity:.5;pointer-events:none"}">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
      <div class="card-title">📁 اختيار الريبو</div>
      <button class="btn btn-outline btn-sm" onclick="loadRepos()">🔄 تحديث قائمة الريبوهات</button>
    </div>

    <div class="info-box" style="margin-bottom:12px">
      <h4>الريبو الأساسي للبوت (مختار تلقائياً):</h4>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-weight:700;color:#6ee7b7;font-size:1rem">📁 ${he(cfg.baseRepo||"WHITE-V3")}</span>
        <span style="font-size:.78rem;color:var(--text3)">← هذا الريبو هو الريبو الرئيسي للبوت</span>
      </div>
      <div style="margin-top:6px">
        <a href="https://github.com/${he(cfg.baseOwner||"castrolmocro")}/${he(cfg.baseRepo||"WHITE-V3")}" target="_blank" class="btn btn-outline btn-sm" style="font-size:.78rem">🔗 فتح على GitHub</a>
      </div>
    </div>

    <div style="font-size:.82rem;color:var(--text3);margin-bottom:8px">اختر الريبو الذي تريد استخدامه للعمليات:</div>
    <div id="repoGrid" class="repo-grid">
      <div style="color:var(--text3);text-align:center;padding:20px;grid-column:1/-1">اضغط "تحديث" لتحميل ريبوهاتك</div>
    </div>
    <div class="form-group" style="margin-top:12px">
      <label class="form-label">📁 الريبو المختار للعمليات</label>
      <input type="text" id="selectedRepo" class="form-control" value="${he(cfg.baseRepo||"WHITE-V3")}" placeholder="WHITE-V3"/>
    </div>
  </div>

  <!-- Push to GitHub -->
  <div class="card" id="pushSection" style="padding:16px;${hasToken?"":"opacity:.5;pointer-events:none"}">
    <div class="card-title" style="margin-bottom:14px;color:var(--green)">🚀 رفع الكود لـ GitHub</div>

    <div class="info-box warn" style="margin-bottom:14px">
      <h4>⚠️ تحذير قبل الرفع</h4>
      <ul>
        <li>سيتم رفع <strong>كل ملفات البوت</strong> للريبو المختور</li>
        <li>يُنصح دائماً برفع لـ <strong>فرع جديد أولاً</strong> وليس الـ main مباشرة</li>
        <li>استخدم <strong>النشر الآمن</strong> لحماية الريبو الأصلي من الكسر</li>
      </ul>
    </div>

    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">🌿 الفرع</label>
        <input type="text" id="pushBranch" class="form-control" value="main"/>
      </div>
      <div class="form-group">
        <label class="form-label">💬 رسالة Commit</label>
        <input type="text" id="pushMsg" class="form-control" value="🚀 تحديث من WHITE V3 Panel"/>
      </div>
    </div>
    <div class="btn-row">
      <button class="btn btn-success" style="font-size:.92rem" onclick="pushToGitHub('main')">🚀 رفع للـ main</button>
      <button class="btn btn-primary" onclick="pushToGitHub('branch')">🌿 رفع لفرع جديد</button>
      <button class="btn btn-outline" onclick="createNewRepo()">📦 إنشاء ريبو جديد</button>
    </div>
    <div id="pushStatus" style="margin-top:12px"></div>
    <div id="pushProgress" style="display:none;margin-top:8px">
      <div style="font-size:.8rem;color:var(--text3);margin-bottom:4px" id="pushProgressTxt">جارٍ الرفع...</div>
      <div class="prog-bar-outer"><div class="prog-bar-inner" id="pushProgressBar" style="width:0%"></div></div>
    </div>
  </div>

  <!-- Create Repo -->
  <div class="card" style="padding:16px">
    <div class="card-title" style="margin-bottom:12px">🆕 إنشاء ريبو جديد</div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">اسم الريبو</label>
        <input type="text" id="newRepoName" class="form-control" placeholder="my-bot-update-v2"/>
      </div>
      <div class="form-group" style="display:flex;flex-direction:column;justify-content:flex-end">
        <label style="display:flex;align-items:center;gap:8px;font-size:.83rem;cursor:pointer;padding:10px 0">
          <input type="checkbox" id="newRepoPrivate" checked/> ريبو خاص (مُوصى به)
        </label>
      </div>
    </div>
    <button class="btn btn-success" onclick="doCreateRepo()">➕ إنشاء الريبو</button>
    <div id="createRepoStatus" style="margin-top:8px;font-size:.83rem"></div>
  </div>

  <!-- Versions Log -->
  <div class="card" style="padding:16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div class="card-title">📋 سجل الرفع</div>
      <button class="btn btn-outline btn-sm" onclick="loadVersionsTable()">🔄</button>
    </div>
    <div style="overflow-x:auto">
      <table class="table" id="versionsTable">
        <thead><tr><th>الفرع/الريبو</th><th>التاريخ</th><th>الحالة</th><th>رابط</th></tr></thead>
        <tbody>${verRows}</tbody>
      </table>
    </div>
  </div>
</div>

<!-- ═══════════════ TAB: RAILWAY ═══════════════ -->
<div id="tab-railway" class="dh-panel">
  <!-- What is Railway -->
  <div class="info-box" style="margin-bottom:16px">
    <h4>🚂 ما هو Railway؟</h4>
    <p style="font-size:.83rem;color:var(--text2);line-height:1.8;margin-bottom:8px">
      Railway هو سيرفر سحابي يشغّل البوت الخاص بك بشكل مستمر على الإنترنت. عندما تعمل على Replit، البوت يعمل فقط عندما تفتح المشروع. Railway يجعله يعمل <strong>24/7</strong> حتى عندما تغلق الكمبيوتر.
    </p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px" class="two-col-grid">
      <div style="padding:10px;background:var(--bg3);border-radius:8px;font-size:.8rem">
        <div style="font-weight:700;color:#60a5fa;margin-bottom:6px">✅ مزايا Railway</div>
        <ul style="padding-right:14px;color:var(--text2);line-height:2;margin:0">
          <li>تشغيل مستمر 24/7</li>
          <li>ربط مباشر مع GitHub</li>
          <li>نشر تلقائي عند كل Push</li>
          <li>خطة مجانية متاحة</li>
        </ul>
      </div>
      <div style="padding:10px;background:var(--bg3);border-radius:8px;font-size:.8rem">
        <div style="font-weight:700;color:#fbbf24;margin-bottom:6px">📋 كيفية الربط</div>
        <ul style="padding-right:14px;color:var(--text2);line-height:2;margin:0">
          <li>أنشئ حساب على Railway</li>
          <li>اربط حسابك بـ GitHub</li>
          <li>أنشئ مشروعاً من الريبو</li>
          <li>اربطه هنا بالـ API Token</li>
        </ul>
      </div>
    </div>
  </div>

  <!-- Railway Token -->
  <div class="card" style="padding:16px">
    <div class="card-title" style="margin-bottom:14px">🔑 توكن Railway API</div>

    <div class="info-box warn" style="margin-bottom:14px">
      <h4>كيف أحصل على توكن Railway؟</h4>
      <div class="guide-step"><div class="guide-step-num">1</div><div class="guide-step-text">افتح <strong>railway.app</strong> وادخل على حسابك</div></div>
      <div class="guide-step"><div class="guide-step-num">2</div><div class="guide-step-text">اضغط على صورتك ← <strong>Account Settings</strong></div></div>
      <div class="guide-step"><div class="guide-step-num">3</div><div class="guide-step-text">اختر <strong>API Tokens</strong> ← <strong>New Token</strong></div></div>
      <div class="guide-step"><div class="guide-step-num">4</div><div class="guide-step-text">سمّ التوكن (مثلاً: WHITE-V3) وانسخه والصقه هنا</div></div>
    </div>

    <div class="form-group">
      <label class="form-label">Railway API Token</label>
      <input type="password" id="railwayToken" class="form-control" placeholder="railway_..." value="${cfg.railwayApiToken ? "••••••••••••••••" : ""}"/>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="saveRailwayToken()">💾 حفظ</button>
      <button class="btn btn-outline" onclick="loadRailwayProjects()">📋 تحميل المشاريع</button>
    </div>
    <div id="railwayProjectsList" style="margin-top:12px"></div>
  </div>

  <!-- Railway Webhook -->
  <div class="card" style="padding:16px">
    <div class="card-title" style="margin-bottom:14px">🪝 Railway Webhook (بديل سهل)</div>
    <div class="info-box" style="margin-bottom:12px">
      <h4>Webhook أسهل من API Token</h4>
      <p style="font-size:.82rem;color:var(--text2);line-height:1.8">إذا لم يكن لديك API Token، يمكنك استخدام Webhook لإعادة نشر البوت بضغطة زر واحدة.<br>
      اذهب لـ Railway ← مشروعك ← Settings ← Deploy ← Webhook URL وانسخه هنا.</p>
    </div>
    <div class="form-group">
      <label class="form-label">Webhook URL</label>
      <input type="text" id="railwayWebhook" class="form-control" placeholder="https://backboard.railway.app/webhook/..." value="${he(cfg.railwayWebhook||"")}"/>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="saveRailwayWebhook()">💾 حفظ</button>
      <button class="btn btn-success" onclick="triggerRailwayWebhook()">🚀 إعادة نشر البوت الآن</button>
    </div>
    <div id="webhookStatus" style="margin-top:8px;font-size:.83rem"></div>
  </div>

  <!-- Railway + GitHub workflow -->
  <div class="card" style="padding:16px">
    <div class="card-title" style="margin-bottom:14px">🔄 سير العمل الموصى به: Replit ← GitHub ← Railway</div>
    <div style="position:relative">
      <div style="display:flex;align-items:center;gap:0;flex-wrap:wrap;justify-content:center;margin:10px 0">
        <div style="text-align:center;padding:14px;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.3);border-radius:10px;min-width:100px">
          <div style="font-size:1.4rem">🖥️</div>
          <div style="font-size:.78rem;font-weight:700;color:#60a5fa;margin-top:4px">Replit</div>
          <div style="font-size:.7rem;color:var(--text3)">تطوير</div>
        </div>
        <div style="font-size:1.2rem;color:var(--text3);margin:0 8px">→</div>
        <div style="text-align:center;padding:14px;background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);border-radius:10px;min-width:100px">
          <div style="font-size:1.4rem">🔗</div>
          <div style="font-size:.78rem;font-weight:700;color:#c4b5fd;margin-top:4px">GitHub</div>
          <div style="font-size:.7rem;color:var(--text3)">تخزين</div>
        </div>
        <div style="font-size:1.2rem;color:var(--text3);margin:0 8px">→</div>
        <div style="text-align:center;padding:14px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:10px;min-width:100px">
          <div style="font-size:1.4rem">🚂</div>
          <div style="font-size:.78rem;font-weight:700;color:#6ee7b7;margin-top:4px">Railway</div>
          <div style="font-size:.7rem;color:var(--text3)">نشر 24/7</div>
        </div>
      </div>
      <div style="font-size:.8rem;color:var(--text2);line-height:2;text-align:center;margin-top:8px">
        تطوّر في Replit ← ترفع الكود لـ GitHub ← Railway ينشره تلقائياً
      </div>
    </div>
    <button class="btn btn-success" style="width:100%;margin-top:12px" onclick="showTab('safe-deploy',document.querySelector('[onclick=\\'showTab(\\\"safe-deploy\\\",this)\\']'))">🛡️ ابدأ النشر الآمن الآن</button>
  </div>
</div>

<!-- ═══════════════ TAB: FILES ═══════════════ -->
<div id="tab-files" class="dh-panel">
  <div class="card" style="padding:16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
      <div class="card-title">📁 محرر الملفات</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <input type="text" id="fileSearch" class="form-control" placeholder="🔍 ابحث..." style="width:180px;font-size:.82rem" oninput="filterFiles(this.value)"/>
        <button class="btn btn-outline btn-sm" onclick="loadFileList()">🔄</button>
      </div>
    </div>

    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">اختر ملفاً</label>
        <select id="editFileSelect" class="form-control" size="8" style="font-size:.8rem" onchange="loadEditFile(this.value)">
          ${files.map(f=>`<option value="${he(f)}">${he(f)}</option>`).join("")}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" id="editFileLabel">محتوى الملف</label>
        <textarea id="editFileContent" class="form-control" style="height:220px;font-family:'Courier New',monospace;font-size:.78rem;resize:vertical" placeholder="اختر ملفاً لتعديله..."></textarea>
      </div>
    </div>

    <div class="btn-row">
      <button class="btn btn-success" onclick="saveEditFile()">💾 حفظ الملف</button>
      <button class="btn btn-outline" onclick="reloadEditFile()">🔄 إعادة تحميل</button>
      <button class="btn btn-primary" onclick="copyEditContent()">📋 نسخ</button>
    </div>
    <div id="editFileStatus" style="margin-top:8px;font-size:.82rem"></div>
  </div>

  <!-- Upload -->
  <div class="card" style="padding:16px">
    <div class="card-title" style="margin-bottom:12px">📤 رفع ملفات</div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">اختر مجلد الوجهة</label>
        <select id="uploadDir" class="form-control" style="font-size:.82rem">
          <option value="scripts/cmds">scripts/cmds (أوامر)</option>
          <option value="scripts/events">scripts/events (أحداث)</option>
          <option value="bot">bot</option>
          <option value="webpanel">webpanel</option>
          <option value="">root (الجذر)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">الملف (.js, .json, .zip...)</label>
        <input type="file" id="uploadFile" class="form-control" accept=".js,.json,.txt,.md,.yaml,.yml,.zip,.sh"/>
      </div>
    </div>
    <button class="btn btn-primary" onclick="doUpload()">📤 رفع</button>
    <div id="uploadStatus" style="margin-top:8px;font-size:.83rem"></div>
  </div>
</div>

<!-- ═══════════════ TAB: SAFE DEPLOY ═══════════════ -->
<div id="tab-safe-deploy" class="dh-panel">

  <div class="info-box success" style="margin-bottom:16px">
    <h4>🛡️ لماذا النشر الآمن؟</h4>
    <p style="font-size:.83rem;color:var(--text2);line-height:1.8">
      عند تحديث البوت مباشرة على الريبو الأصلي، أي خطأ قد <strong>يكسر البوت للجميع</strong>. النشر الآمن يحمي الريبو الأصلي بإنشاء <strong>ريبو تجريبي جديد</strong> لكل تحديث. إذا نجح التحديث → يُطبَّق. إذا فشل → الريبو الأصلي سليم 100%.
    </p>
  </div>

  <!-- Safe Deploy Steps Visual -->
  <div class="card" style="padding:16px;margin-bottom:16px">
    <div class="card-title" style="margin-bottom:14px">📋 خطوات النشر الآمن</div>
    <div id="safeStep1" class="step-card">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="step-num pending" id="stepNum1">1</div>
        <div><div style="font-weight:700;font-size:.88rem">📤 رفع الكود لريبو تجريبي جديد</div><div style="font-size:.77rem;color:var(--text3);margin-top:2px">يُنشأ ريبو منفصل — الريبو الأصلي محمي تماماً</div></div>
      </div>
      <div id="step1status" style="margin-top:8px;font-size:.8rem;display:none"></div>
    </div>
    <div id="safeStep2" class="step-card">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="step-num pending" id="stepNum2">2</div>
        <div><div style="font-weight:700;font-size:.88rem">🚂 ربط Railway بالريبو التجريبي</div><div style="font-size:.77rem;color:var(--text3);margin-top:2px">يُشغَّل البوت من الريبو الجديد للاختبار</div></div>
      </div>
      <div id="step2status" style="margin-top:8px;font-size:.8rem;display:none"></div>
    </div>
    <div id="safeStep3" class="step-card">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="step-num pending" id="stepNum3">3</div>
        <div><div style="font-weight:700;font-size:.88rem">✅ تأكيد وحفظ كإصدار رسمي</div><div style="font-size:.77rem;color:var(--text3);margin-top:2px">بعد التحقق من أن كل شيء يعمل، يُحفظ كإصدار رسمي</div></div>
      </div>
      <div id="step3status" style="margin-top:8px;font-size:.8rem;display:none"></div>
    </div>
  </div>

  <!-- Safe Deploy Config -->
  <div class="card" style="padding:16px">
    <div class="card-title" style="margin-bottom:14px">⚙️ إعداد النشر الآمن</div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">📁 الريبو الأصلي (محمي دائماً)</label>
        <input type="text" id="sdBaseRepo" class="form-control" value="${he(cfg.baseRepo||"WHITE-V3")}" readonly style="background:rgba(239,68,68,.05);border-color:rgba(239,68,68,.3)"/>
        <div style="font-size:.72rem;color:#f87171;margin-top:4px">⛔ لن يُمس هذا الريبو أبداً</div>
      </div>
      <div class="form-group">
        <label class="form-label">📦 أقصى عدد ريبوهات تحديث</label>
        <input type="number" id="sdMaxKeep" class="form-control" value="${cfg.maxUpdateRepos||5}" min="2" max="20"/>
      </div>
      <div class="form-group">
        <label class="form-label">💬 رسالة التحديث</label>
        <input type="text" id="sdCommitMsg" class="form-control" value="🚀 تحديث من WHITE V3 Panel"/>
      </div>
      <div class="form-group" style="display:flex;flex-direction:column;justify-content:center;gap:8px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.83rem">
          <input type="checkbox" id="sdPrivate" checked/> ريبو التحديث خاص
        </label>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.83rem">
          <input type="checkbox" id="sdAutoClean" checked/> حذف الريبوهات القديمة
        </label>
      </div>
    </div>
    <button class="btn btn-success" style="width:100%;padding:13px;font-size:.95rem;margin-top:6px" onclick="startSafeDeploy()">
      🚀 ابدأ النشر الآمن الآن
    </button>
    <div id="sdMainStatus" style="margin-top:12px"></div>
    <div id="sdVersionsList" style="margin-top:14px"></div>
  </div>
</div>

<!-- ═══════════════ TAB: GUIDE ═══════════════ -->
<div id="tab-guide" class="dh-panel">
  <div class="card" style="padding:16px;margin-bottom:14px">
    <div class="card-title" style="margin-bottom:14px">📖 دليل المطور — بنية البوت</div>
    <div style="font-size:.83rem;color:var(--text2);line-height:1.9">
      <div style="display:grid;gap:12px">
        <div style="background:var(--bg3);border-radius:10px;padding:14px;border-right:3px solid #3b82f6">
          <div style="font-weight:700;color:#60a5fa;margin-bottom:6px">📁 هيكل المجلدات</div>
          <pre style="font-size:.75rem;color:#c9d1d9;margin:0;line-height:1.8">WHITE-V3/
├── index.js          ← نقطة البداية (Watchdog)
├── Goat.js           ← الكود الرئيسي للبوت
├── config.json       ← الإعدادات الرئيسية
├── account.txt       ← كوكيز فيسبوك
├── scripts/
│   ├── cmds/         ← أوامر البوت (/ping, /help...)
│   └── events/       ← أحداث (عند دخول عضو...)
├── bot/              ← تسجيل الدخول والمنطق
├── database/         ← قاعدة البيانات
└── webpanel/         ← لوحة التحكم</pre>
        </div>
        <div style="background:var(--bg3);border-radius:10px;padding:14px;border-right:3px solid #8b5cf6">
          <div style="font-weight:700;color:#c4b5fd;margin-bottom:6px">⚡ هيكل الأمر (Command)</div>
          <pre style="font-size:.74rem;color:#c9d1d9;margin:0;line-height:1.8">module.exports = {
  config: {
    name: "ping",           // اسم الأمر
    aliases: ["p"],         // اختصارات
    version: "1.0",
    author: "اسمك",
    countDown: 5,           // ثواني بين كل استخدام
    role: 0,                // 0=الكل، 1=ادمن، 2=سوبرادمن
    shortDescription: "يرد بـ Pong",
    category: "utility"
  },
  onStart: async ({ api, event, args }) => {
    api.sendMessage("🏓 Pong!", event.threadID);
  }
};</pre>
        </div>
        <div style="background:var(--bg3);border-radius:10px;padding:14px;border-right:3px solid #10b981">
          <div style="font-weight:700;color:#6ee7b7;margin-bottom:6px">🎯 أمثلة سريعة</div>
          <div style="display:grid;gap:8px">
            <div style="font-size:.8rem;padding:8px;background:var(--bg4);border-radius:6px">
              <code>api.sendMessage("نص", event.threadID)</code> — إرسال رسالة نصية
            </div>
            <div style="font-size:.8rem;padding:8px;background:var(--bg4);border-radius:6px">
              <code>api.sendMessage({body:"نص", attachment: stream}, event.threadID)</code> — رسالة مع صورة
            </div>
            <div style="font-size:.8rem;padding:8px;background:var(--bg4);border-radius:6px">
              <code>api.setMessageReaction("😍", event.messageID)</code> — إضافة تفاعل
            </div>
            <div style="font-size:.8rem;padding:8px;background:var(--bg4);border-radius:6px">
              <code>global.db.usersData.get(userID)</code> — الحصول على بيانات مستخدم
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- AI Guide Chat -->
  <div class="card" style="padding:16px">
    <div class="card-title" style="margin-bottom:12px">🤖 سل المرشد (شرح بسيط)</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
      <button class="btn btn-outline btn-sm" onclick="guideAction('كيف أضيف أمر جديد للبوت؟')">أمر جديد</button>
      <button class="btn btn-outline btn-sm" onclick="guideAction('كيف أجعل البوت يرحب بالأعضاء الجدد؟')">ترحيب</button>
      <button class="btn btn-outline btn-sm" onclick="guideAction('اشرح لي كيف تعمل قاعدة البيانات؟')">قاعدة البيانات</button>
      <button class="btn btn-outline btn-sm" onclick="guideAction('كيف أستخدم الـ axios لجلب بيانات من API؟')">API خارجي</button>
      <button class="btn btn-danger btn-sm" onclick="clearChat('guide')">🗑️</button>
    </div>
    <div id="guideBox" class="msg-box" style="min-height:200px"></div>
    <div class="input-row">
      <textarea id="guideInput" class="form-control" placeholder="اسأل المرشد بلغة بسيطة..." rows="2" onkeydown="if(event.ctrlKey&&event.key==='Enter')sendToGuide()"></textarea>
      <button class="btn btn-primary" onclick="sendToGuide()">إرسال</button>
    </div>
  </div>
</div>

<!-- ═══════════════ JAVASCRIPT ═══════════════ -->
<script>
// ── State ──────────────────────────────────────────────────────────────────────
let chatHistory = [], freeHistory = [], guideHistory = [];
let lastAgentCode = "";
let currentRepo = "${he(cfg.baseRepo||"WHITE-V3")}";
let safeDeployActive = false;

// ── Helpers ────────────────────────────────────────────────────────────────────
function showTab(id, btn) {
  document.querySelectorAll(".dh-panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".dh-tab").forEach(b => b.classList.remove("active"));
  const panel = document.getElementById("tab-"+id);
  if (panel) panel.classList.add("active");
  if (btn) btn.classList.add("active");
  if (id === "github" && ${hasToken}) setTimeout(verifyToken, 300);
}

async function apiFetch(url, body) {
  const r = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
  return r.json();
}
function statusEl(id, html, type="") {
  const el = document.getElementById(id);
  if (!el) return;
  const colors = { ok:"rgba(16,185,129,.1)", error:"rgba(239,68,68,.1)", warn:"rgba(245,158,11,.1)", info:"rgba(59,130,246,.1)" };
  const borders = { ok:"rgba(16,185,129,.3)", error:"rgba(239,68,68,.3)", warn:"rgba(245,158,11,.3)", info:"rgba(59,130,246,.3)" };
  el.style.cssText = \`padding:10px 14px;border-radius:8px;font-size:.83rem;background:\${colors[type]||"var(--bg3)"};border:1px solid \${borders[type]||"var(--border)"}\`;
  el.innerHTML = html;
}
function showToast(msg, type="info") {
  const t = document.createElement("div");
  const c = { success:"rgba(16,185,129,.95)", error:"rgba(239,68,68,.95)", info:"rgba(59,130,246,.95)", warn:"rgba(245,158,11,.95)" };
  t.style.cssText = \`position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:\${c[type]||c.info};color:#fff;padding:10px 22px;border-radius:24px;font-size:.88rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:'Cairo',sans-serif;text-align:center;max-width:90vw\`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Message Box ────────────────────────────────────────────────────────────────
function appendMsg(boxId, who, icon, color, content) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const div = document.createElement("div");
  div.className = "msg-agent";
  const hdr = \`<div class="msg-agent-hdr" style="color:\${color}">\${icon} \${who}</div>\`;
  const body = content
    .replace(/\`\`\`(\\w+)?\\n?([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
      if (code.trim()) {
        lastAgentCode = code.trim();
        return \`<pre class="code-block">\${code.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</pre>
<button class="btn btn-outline btn-sm copy-btn" onclick="this.previousElementSibling&&navigator.clipboard.writeText(this.previousElementSibling.innerText).then(()=>{this.textContent='✅ تم النسخ';setTimeout(()=>this.textContent='📋 نسخ',2000)})">📋 نسخ الكود</button>\`;
      }
      return _;
    })
    .replace(/\\*\\*(.+?)\\*\\*/g,"<strong>$1</strong>")
    .replace(/\\n/g,"<br/>");
  div.innerHTML = hdr + \`<div style="color:var(--text);line-height:1.8">\${body}</div>\`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function appendUser(boxId, msg) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const div = document.createElement("div");
  div.className = "msg-me";
  div.innerHTML = \`<div style="font-size:.75rem;color:#94a3b8;margin-bottom:5px">👤 أنت</div><div>\${msg.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div>\`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function appendThinking(boxId, label) {
  const box = document.getElementById(boxId);
  const div = document.createElement("div");
  div.className = "msg-thinking";
  div.innerHTML = \`⏳ \${label} يعمل...\`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}
function rmThink(el) { if(el?.parentNode) el.parentNode.removeChild(el); }
function clearChat(target) {
  const map = { agents:"chatBox", chat:"chatBoxFree", guide:"guideBox" };
  const el = document.getElementById(map[target]);
  if (el) el.innerHTML = "";
  if (target==="agents") { chatHistory=[]; lastAgentCode=""; }
  if (target==="chat") freeHistory=[];
  if (target==="guide") guideHistory=[];
  fetch("/api/devhub/chat/clear",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({target})});
}

// ── File Context ───────────────────────────────────────────────────────────────
function getSelFiles() { return Array.from(document.getElementById("fileSelect")?.selectedOptions||[]).map(o=>o.value); }
function clearSel() { Array.from(document.getElementById("fileSelect")?.options||[]).forEach(o=>o.selected=false); }
async function previewFile() {
  const files = getSelFiles();
  if (!files.length) return showToast("اختر ملفاً أولاً","warn");
  const r = await apiFetch("/api/devhub/file",{path:files[0]});
  const area = document.getElementById("filePreviewArea");
  const pre  = document.getElementById("filePreview");
  if (area && pre) { area.style.display="block"; pre.textContent=r.content||r.error||""; }
}
async function buildCtx() {
  const files = getSelFiles();
  const ctxs = [];
  for (const f of files.slice(0,4)) {
    try { const r = await apiFetch("/api/devhub/file",{path:f}); if(r.content) ctxs.push({path:f,content:r.content.slice(0,8000)}); } catch(_) {}
  }
  return ctxs;
}
async function getAutoCtx() {
  if (!document.getElementById("autoCtxToggle")?.checked) return null;
  try { const r = await fetch("/api/devhub/bot/context"); const d = await r.json(); return d.context||null; } catch(_) { return null; }
}

// ── Send to Agents ─────────────────────────────────────────────────────────────
async function sendToAgents() {
  const inp = document.getElementById("chatInput");
  const msg = inp.value.trim();
  if (!msg) return showToast("اكتب طلبك أولاً","warn");
  const btn = document.getElementById("agentSendBtn");
  const btnTxt = document.getElementById("agentBtnTxt");
  const statusEl2 = document.getElementById("agentStatus");
  inp.value = "";
  btn.disabled = true;
  btnTxt.textContent = "⏳...";
  appendUser("chatBox", msg);
  chatHistory.push({role:"user", content:msg});

  statusEl2.textContent = "⏳ تحضير السياق...";
  const [autoCtx, fileCtx] = await Promise.all([getAutoCtx(), buildCtx()]);
  statusEl2.textContent = "🔍 المحلل يعمل...";
  const thk = appendThinking("chatBox", "الوكلاء الثلاثة");

  try {
    const r = await fetch("/api/devhub/ai/pipeline", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ message:msg, files:fileCtx, history:chatHistory.slice(-8), autoCtx })
    });
    rmThink(thk);
    const data = await r.json();
    statusEl2.textContent = "";
    if (data.steps) {
      for (const s of data.steps) {
        appendMsg("chatBox", s.name, s.icon, s.color||"#60a5fa", s.reply);
        chatHistory.push({role:"assistant", content:"["+s.name+"]: "+s.reply});
      }
    } else if (data.error) {
      const errDiv = document.createElement("div");
      errDiv.style.cssText = "background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:14px;margin-bottom:10px";
      errDiv.innerHTML = \`<div style="font-weight:700;color:#f87171;margin-bottom:6px">❌ خطأ في الاتصال</div>
<div style="font-size:.82rem;color:var(--text2);white-space:pre-line">\${(data.error||"").replace(/</g,"&lt;")}</div>
<button class="btn btn-outline btn-sm" style="margin-top:8px" onclick="this.closest('.msg-agent')?.remove();document.getElementById('chatInput').value=\\'\${msg.replace(/'/g,"\\\\'")}\\';sendToAgents()">🔄 أعد المحاولة</button>\`;
      document.getElementById("chatBox").appendChild(errDiv);
    }
  } catch(e) {
    rmThink(thk);
    statusEl2.textContent = "";
    appendMsg("chatBox","❌ خطأ في الشبكة","","#f87171",e.message+"\\n\\nتحقق من اتصالك بالإنترنت وأعد المحاولة.");
  }
  btn.disabled = false;
  btnTxt.textContent = "إرسال";
}
function quickAction(t) { document.getElementById("chatInput").value=t; sendToAgents(); }

// ── Free Chat ──────────────────────────────────────────────────────────────────
async function sendFree() {
  const inp = document.getElementById("freeInput");
  const msg = inp.value.trim();
  if (!msg) return;
  inp.value = "";
  appendUser("chatBoxFree", msg);
  freeHistory.push({role:"user", content:msg});
  const thk = appendThinking("chatBoxFree","AI");
  const model = document.getElementById("freeModel")?.value || "openai";
  const [autoCtx, fileCtx] = await Promise.all([getAutoCtx(), buildCtx()]);
  try {
    const r = await apiFetch("/api/devhub/ai/single", { model, message:msg, files:fileCtx, history:freeHistory.slice(-8), autoCtx });
    rmThink(thk);
    if (r.ok) { freeHistory.push({role:"assistant",content:r.reply}); appendMsg("chatBoxFree","AI",model==="mistral"?"🟣":model==="llama"?"🦙":model==="deepseek"?"🐋":"🔵","#60a5fa",r.reply); }
    else {
      const errDiv = document.createElement("div");
      errDiv.style.cssText = "background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:12px;margin-bottom:10px;font-size:.82rem";
      errDiv.innerHTML = \`<span style="color:#f87171">❌ \${(r.error||"").replace(/</g,"&lt;")}</span>
<button class="btn btn-outline btn-sm" style="margin-right:8px;margin-top:6px" onclick="document.getElementById('freeInput').value=\\'\${msg.replace(/'/g,"\\\\'")}\\';sendFree()">🔄 إعادة</button>\`;
      document.getElementById("chatBoxFree").appendChild(errDiv);
    }
  } catch(e) { rmThink(thk); appendMsg("chatBoxFree","❌","","#f87171",e.message); }
}

// ── Guide Chat ─────────────────────────────────────────────────────────────────
async function sendToGuide() {
  const inp = document.getElementById("guideInput");
  const msg = inp.value.trim();
  if (!msg) return;
  inp.value = "";
  appendUser("guideBox", msg);
  guideHistory.push({role:"user", content:msg});
  const thk = appendThinking("guideBox","المرشد");
  try {
    const r = await apiFetch("/api/devhub/ai/guide", { message:msg, history:guideHistory.slice(-6) });
    rmThink(thk);
    if (r.ok) { guideHistory.push({role:"assistant",content:r.reply}); appendMsg("guideBox","📚 المرشد","","#fbbf24",r.reply); }
    else {
      const el2 = document.getElementById("guideBox");
      const errDiv = document.createElement("div");
      errDiv.style.cssText = "background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:12px;margin-bottom:10px;font-size:.82rem";
      errDiv.innerHTML = \`<span style="color:#f87171">❌ \${(r.error||"").replace(/</g,"&lt;")}</span>
<button class="btn btn-outline btn-sm" style="margin-right:8px;margin-top:6px" onclick="document.getElementById('guideInput').value=\\'\${msg.replace(/'/g,"\\\\'")}\\';sendToGuide()">🔄 إعادة</button>\`;
      el2.appendChild(errDiv);
    }
  } catch(e) { rmThink(thk); appendMsg("guideBox","❌","","#f87171",e.message); }
}
function guideAction(t) { document.getElementById("guideInput").value=t; sendToGuide(); }

// ── Apply Code to File ─────────────────────────────────────────────────────────
async function applyLastCode() {
  if (!lastAgentCode) return showToast("لا يوجد كود بعد — أرسل طلباً للوكلاء أولاً","warn");
  const file = document.getElementById("applyFile")?.value;
  if (!file) return showToast("اختر ملفاً","warn");
  if (!confirm(\`سيتم الكتابة فوق الملف: \${file}\\nهل أنت متأكد؟\`)) return;
  const r = await apiFetch("/api/devhub/file/write", { path:file, content:lastAgentCode });
  document.getElementById("applyStatus").innerHTML = r.ok
    ? \`<span style="color:#6ee7b7">✅ تم تطبيق الكود على \${file}</span>\`
    : \`<span style="color:#f87171">❌ \${r.error||"خطأ"}</span>\`;
}

// ── Token ──────────────────────────────────────────────────────────────────────
function toggleTokenVis() {
  const inp = document.getElementById("ghToken");
  if (!inp) return;
  inp.type = inp.type==="password" ? "text" : "password";
}
async function saveToken() {
  const token = document.getElementById("ghToken")?.value?.trim();
  const owner = document.getElementById("ghOwner")?.value?.trim();
  if (!token || token === "••••••••••••••••••••") return showToast("أدخل التوكن أولاً","warn");
  if (!token.startsWith("ghp_") && !token.startsWith("github_")) return showToast("التوكن يجب أن يبدأ بـ ghp_ أو github_","warn");
  const r = await apiFetch("/api/devhub/config/save", { token, owner });
  if (r.ok) {
    showToast("✅ تم حفظ التوكن بنجاح","success");
    document.getElementById("tokenStatusDiv").className = "token-status token-ok";
    document.getElementById("tokenStatusDiv").innerHTML = "✅ التوكن محفوظ — جارٍ التحقق...";
    document.getElementById("repoSection").style.cssText = "";
    document.getElementById("pushSection").style.cssText = "";
    setTimeout(verifyToken, 500);
    setTimeout(loadRepos, 1500);
  } else {
    showToast("❌ "+ (r.error||"خطأ في الحفظ"),"error");
  }
}
async function testToken() {
  const statusDiv = document.getElementById("tokenTestResult");
  statusDiv.innerHTML = "<span style='color:var(--text3)'>⏳ جارٍ التحقق...</span>";
  const r = await fetch("/api/devhub/github/test").then(r=>r.json()).catch(()=>({error:"لا يوجد اتصال"}));
  if (r.ok) statusDiv.innerHTML = \`<span style="color:#6ee7b7">✅ متصل بنجاح — الحساب: <strong>\${r.login}</strong> | عدد الريبوهات: \${r.repos}</span>\`;
  else statusDiv.innerHTML = \`<span style="color:#f87171">❌ \${r.error||"فشل الاتصال"}</span>\`;
}
async function verifyToken() {
  const r = await fetch("/api/devhub/github/test").then(r=>r.json()).catch(()=>null);
  const disp = document.getElementById("ghUserDisplay");
  if (disp && r?.ok) disp.textContent = "@"+r.login;
}
async function clearToken() {
  if (!confirm("سيتم حذف التوكن. هل أنت متأكد؟")) return;
  await apiFetch("/api/devhub/config/save", { token: "CLEAR_TOKEN" });
  showToast("تم حذف التوكن","warn");
  location.reload();
}

// ── Repos ──────────────────────────────────────────────────────────────────────
async function loadRepos() {
  const grid = document.getElementById("repoGrid");
  if (!grid) return;
  grid.innerHTML = \`<div style="color:var(--text3);text-align:center;padding:20px;grid-column:1/-1">⏳ جارٍ تحميل ريبوهاتك...</div>\`;
  const r = await fetch("/api/devhub/github/repos").then(r=>r.json()).catch(()=>({error:"خطأ في الاتصال"}));
  if (r.error) { grid.innerHTML = \`<div style="color:#f87171;padding:14px;grid-column:1/-1">❌ \${r.error}</div>\`; return; }
  const repos = r.repos || [];
  if (!repos.length) { grid.innerHTML = \`<div style="color:var(--text3);padding:14px;grid-column:1/-1">لا توجد ريبوهات</div>\`; return; }
  grid.innerHTML = repos.map(repo => {
    const isBase = repo.name === currentRepo || repo.name === "${he(cfg.baseRepo||"WHITE-V3")}";
    return \`<div class="repo-item \${isBase?"selected":""}" onclick="selectRepo('\${repo.name}',this)">
      <div class="repo-name">📁 \${repo.name} \${isBase?"<span style='font-size:.7rem;color:#6ee7b7'>(الأساسي)</span>":""}</div>
      <div class="repo-meta">
        <span class="\${repo.private?"repo-private":"repo-public"}">\${repo.private?"🔒 خاص":"🌐 عام"}</span>
        \${repo.description ? \`<span style="color:var(--text3);font-size:.71rem">\${repo.description.slice(0,40)}</span>\` : ""}
      </div>
      <a href="\${repo.html_url}" target="_blank" style="font-size:.7rem;color:var(--accent2);text-decoration:none;margin-top:4px;display:inline-block">🔗 فتح</a>
    </div>\`;
  }).join("");
}
function selectRepo(name, el) {
  document.querySelectorAll(".repo-item").forEach(i=>i.classList.remove("selected"));
  el.classList.add("selected");
  currentRepo = name;
  const inp = document.getElementById("selectedRepo");
  if (inp) inp.value = name;
  showToast("تم اختيار: "+name,"info");
}

// ── Push to GitHub ─────────────────────────────────────────────────────────────
async function pushToGitHub(mode) {
  const repo = document.getElementById("selectedRepo")?.value?.trim() || currentRepo;
  const owner = document.getElementById("ghOwner")?.value?.trim() || "castrolmocro";
  const branch = document.getElementById("pushBranch")?.value?.trim() || "main";
  const msg = document.getElementById("pushMsg")?.value?.trim() || "🚀 تحديث من WHITE V3 Panel";
  if (!repo) return showToast("اختر ريبو أولاً","warn");

  const statusDiv = document.getElementById("pushStatus");
  const progDiv   = document.getElementById("pushProgress");
  const progBar   = document.getElementById("pushProgressBar");
  const progTxt   = document.getElementById("pushProgressTxt");

  if (mode === "branch") {
    const newBranch = "update-" + Date.now();
    statusDiv.innerHTML = \`<span style="color:var(--text3)">⏳ جارٍ الرفع لفرع جديد: \${newBranch}...</span>\`;
    progDiv.style.display="block"; progBar.style.width="30%"; progTxt.textContent="جارٍ تحضير الملفات...";
    const r = await apiFetch("/api/devhub/github/push-all", { owner, repo, branch:newBranch, commitMsg:msg });
    progBar.style.width="100%";
    if (r.ok) { statusDiv.innerHTML = \`<span style="color:#6ee7b7">✅ تم الرفع لفرع: <a href="\${r.url}" target="_blank" style="color:#60a5fa">\${r.url}</a></span>\`; showToast("✅ تم الرفع بنجاح","success"); }
    else { statusDiv.innerHTML = \`<span style="color:#f87171">❌ \${r.error||"فشل الرفع"}</span>\`; showToast("❌ فشل الرفع","error"); }
  } else {
    if (!confirm(\`سيتم الرفع لـ \${owner}/\${repo} فرع \${branch}\\nهذا سيستبدل محتوى الريبو. هل أنت متأكد؟\`)) return;
    statusDiv.innerHTML = \`<span style="color:var(--text3)">⏳ جارٍ رفع الكود...</span>\`;
    progDiv.style.display="block"; progBar.style.width="10%"; progTxt.textContent="جارٍ التحضير...";
    const interval = setInterval(()=>{ const w=parseInt(progBar.style.width); if(w<85) progBar.style.width=(w+5)+"%"; }, 2000);
    const r = await apiFetch("/api/devhub/github/push-all", { owner, repo, branch, commitMsg:msg });
    clearInterval(interval); progBar.style.width="100%";
    if (r.ok) { statusDiv.innerHTML = \`<span style="color:#6ee7b7">✅ تم الرفع بنجاح! <a href="\${r.url}" target="_blank" style="color:#60a5fa">🔗 فتح الريبو</a></span>\`; showToast("✅ تم الرفع لـ GitHub","success"); }
    else { statusDiv.innerHTML = \`<span style="color:#f87171">❌ \${r.error||"فشل الرفع"}</span>\`; showToast("❌ فشل الرفع: "+(r.error||""),"error"); }
  }
  setTimeout(()=>{ progDiv.style.display="none"; progBar.style.width="0%"; }, 5000);
  loadVersionsTable();
}
async function doCreateRepo() {
  const name = document.getElementById("newRepoName")?.value?.trim();
  const isPrivate = document.getElementById("newRepoPrivate")?.checked;
  if (!name) return showToast("أدخل اسم الريبو","warn");
  const el = document.getElementById("createRepoStatus");
  el.innerHTML = "⏳ جارٍ الإنشاء...";
  const r = await apiFetch("/api/devhub/github/create-repo", { name, private: isPrivate });
  if (r.ok) { el.innerHTML = \`<span style="color:#6ee7b7">✅ تم إنشاء الريبو: <a href="\${r.url}" target="_blank" style="color:#60a5fa">\${r.url}</a></span>\`; showToast("✅ تم إنشاء الريبو","success"); loadRepos(); }
  else { el.innerHTML = \`<span style="color:#f87171">❌ \${r.error||"فشل"}</span>\`; }
}
async function loadVersionsTable() {
  const r = await fetch("/api/devhub/versions").then(r=>r.json()).catch(()=>({versions:[]}));
  const tbody = document.getElementById("versionsTable")?.querySelector("tbody");
  if (!tbody) return;
  const vers = (r.versions||[]).slice(-8).reverse();
  tbody.innerHTML = vers.length
    ? vers.map(v=>\`<tr>
        <td><code style="color:#60a5fa;font-size:.78rem">\${v.branch||v.repo||"—"}</code></td>
        <td style="font-size:.78rem;color:var(--text2)">\${v.date||""}</td>
        <td><span class="badge \${v.status==="success"?"badge-green":v.status==="failed"?"badge-red":"badge-yellow"}">\${v.status||"—"}</span></td>
        <td>\${v.repoUrl?\`<a href="\${v.repoUrl}" target="_blank" class="btn btn-outline btn-sm" style="font-size:.72rem">🔗</a>\`:""}</td>
      </tr>\`).join("")
    : \`<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:16px">لا يوجد سجل بعد</td></tr>\`;
}

// ── Railway ────────────────────────────────────────────────────────────────────
async function saveRailwayToken() {
  const tok = document.getElementById("railwayToken")?.value?.trim();
  if (!tok || tok==="••••••••••••••••") return showToast("أدخل التوكن أولاً","warn");
  const r = await apiFetch("/api/devhub/smart-deploy/config", { railwayApiToken: tok });
  if (r.ok) showToast("✅ تم حفظ توكن Railway","success");
  else showToast("❌ "+(r.error||"خطأ"),"error");
}
async function saveRailwayWebhook() {
  const url = document.getElementById("railwayWebhook")?.value?.trim();
  const r = await apiFetch("/api/devhub/smart-deploy/config", { railwayWebhook: url });
  if (r.ok) showToast("✅ تم حفظ Webhook","success");
  else showToast("❌ "+(r.error||"خطأ"),"error");
}
async function triggerRailwayWebhook() {
  const el = document.getElementById("webhookStatus");
  el.innerHTML = "⏳ جارٍ إرسال طلب النشر...";
  const r = await apiFetch("/api/devhub/railway/redeploy", {});
  if (r.ok) { el.innerHTML = \`<span style="color:#6ee7b7">✅ تم إرسال طلب النشر — تحقق من Railway</span>\`; showToast("✅ طلب النشر أُرسل","success"); }
  else { el.innerHTML = \`<span style="color:#f87171">❌ \${r.error||"فشل الإرسال"}</span>\`; }
}
async function loadRailwayProjects() {
  const el = document.getElementById("railwayProjectsList");
  el.innerHTML = "⏳ جارٍ تحميل المشاريع...";
  const r = await apiFetch("/api/devhub/railway/projects", {});
  if (r.error) { el.innerHTML = \`<span style="color:#f87171">❌ \${r.error}</span>\`; return; }
  const projects = r.projects || [];
  el.innerHTML = projects.length
    ? projects.map(p=>\`
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px">
        <div style="font-weight:700;margin-bottom:6px">🚂 \${p.name}</div>
        <div style="font-size:.78rem;color:var(--text3);margin-bottom:6px">ID: \${p.id}</div>
        \${p.services.map(s=>\`<div style="font-size:.8rem;padding:6px;background:var(--bg4);border-radius:6px;margin-bottom:4px">
          🔧 \${s.name} <button class="btn btn-outline btn-sm" style="font-size:.7rem" onclick="selectRailwayService('\${s.id}','\${p.environments[0]?.id||''}')">اختيار</button>
        </div>\`).join("")}
      </div>\`).join("")
    : "<div style='color:var(--text3);text-align:center;padding:20px'>لا توجد مشاريع</div>";
}
async function selectRailwayService(serviceId, envId) {
  const r = await apiFetch("/api/devhub/smart-deploy/config", { railwayServiceId:serviceId, railwayEnvironmentId:envId });
  if (r.ok) showToast("✅ تم اختيار الخدمة","success");
}

// ── Safe Deploy ────────────────────────────────────────────────────────────────
function setStep(n, state, msg) {
  const el = document.getElementById("safeStep"+n);
  const num = document.getElementById("stepNum"+n);
  const st  = document.getElementById("step"+n+"status");
  if (!el||!num) return;
  el.className = "step-card "+state;
  num.className = "step-num "+state;
  num.textContent = state==="done" ? "✓" : n;
  if (st) { st.style.display="block"; st.style.color=state==="done"?"#6ee7b7":state==="error"?"#f87171":"var(--text3)"; st.textContent=msg||""; }
}
async function startSafeDeploy() {
  if (safeDeployActive) return showToast("النشر قيد التشغيل بالفعل","warn");
  const owner   = document.getElementById("ghOwner")?.value?.trim() || "castrolmocro";
  const baseRepo = document.getElementById("sdBaseRepo")?.value?.trim() || "WHITE-V3";
  const maxKeep  = parseInt(document.getElementById("sdMaxKeep")?.value)||5;
  const commitMsg = document.getElementById("sdCommitMsg")?.value?.trim() || "🚀 تحديث من WHITE V3 Panel";
  const isPrivate = document.getElementById("sdPrivate")?.checked;
  const autoClean = document.getElementById("sdAutoClean")?.checked;
  const mainStatus = document.getElementById("sdMainStatus");

  safeDeployActive = true;
  setStep(1,"active","جارٍ إنشاء ريبو التحديث...");
  setStep(2,"pending","");
  setStep(3,"pending","");
  mainStatus.innerHTML = "<span style='color:var(--text3)'>⏳ جارٍ النشر الآمن...</span>";

  try {
    const r = await apiFetch("/api/devhub/smart-deploy/create", { commitMsg, makePrivate:isPrivate, autoCleanup:autoClean });
    if (r.error) {
      setStep(1,"error",r.error);
      mainStatus.innerHTML = \`<span style="color:#f87171">❌ \${r.error}</span>\`;
      safeDeployActive = false;
      return;
    }
    const steps = r.steps || [];
    for (let i=0; i<steps.length; i++) {
      const s = steps[i];
      const state = s.msg?.startsWith("✅") ? "done" : s.msg?.startsWith("⚠️") ? "pending" : "done";
      setStep(i+1, state, s.msg);
    }
    if (r.repoUrl) {
      mainStatus.innerHTML = \`<div style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:10px;padding:14px">
        <div style="color:#6ee7b7;font-weight:700;margin-bottom:8px">✅ تم النشر بنجاح!</div>
        <div style="font-size:.83rem;color:var(--text2)">الريبو: <a href="\${r.repoUrl}" target="_blank" style="color:#60a5fa">\${r.repoUrl}</a></div>
        \${r.railwayUrl?\`<div style="font-size:.83rem;color:var(--text2);margin-top:4px">Railway: <a href="\${r.railwayUrl}" target="_blank" style="color:#60a5fa">\${r.railwayUrl}</a></div>\`:""}
      </div>\`;
      showToast("✅ النشر الآمن اكتمل!","success");
    }
  } catch(e) {
    setStep(1,"error",e.message);
    mainStatus.innerHTML = \`<span style="color:#f87171">❌ خطأ: \${e.message}</span>\`;
  }
  safeDeployActive = false;
}

// ── File Editor ────────────────────────────────────────────────────────────────
let currentEditFile = null;
async function loadEditFile(path) {
  if (!path) return;
  currentEditFile = path;
  document.getElementById("editFileLabel").textContent = "📄 "+path;
  document.getElementById("editFileContent").value = "⏳ جارٍ التحميل...";
  const r = await apiFetch("/api/devhub/file", {path});
  document.getElementById("editFileContent").value = r.content || r.error || "";
}
async function saveEditFile() {
  if (!currentEditFile) return showToast("اختر ملفاً أولاً","warn");
  const content = document.getElementById("editFileContent")?.value;
  const r = await apiFetch("/api/devhub/file/write", { path:currentEditFile, content });
  document.getElementById("editFileStatus").innerHTML = r.ok
    ? \`<span style="color:#6ee7b7">✅ تم حفظ \${currentEditFile}</span>\`
    : \`<span style="color:#f87171">❌ \${r.error||"خطأ"}</span>\`;
  if (r.ok) showToast("✅ تم حفظ الملف","success");
}
async function reloadEditFile() {
  if (currentEditFile) loadEditFile(currentEditFile);
}
function copyEditContent() {
  const c = document.getElementById("editFileContent")?.value;
  if (c) navigator.clipboard.writeText(c).then(()=>showToast("✅ تم النسخ","success"));
}
function filterFiles(query) {
  const sel = document.getElementById("editFileSelect");
  if (!sel) return;
  for (const opt of sel.options) {
    opt.style.display = opt.value.toLowerCase().includes(query.toLowerCase()) ? "" : "none";
  }
}
function loadFileList() { location.reload(); }

// ── Upload ─────────────────────────────────────────────────────────────────────
async function doUpload() {
  const file = document.getElementById("uploadFile")?.files[0];
  if (!file) return showToast("اختر ملفاً","warn");
  const dir  = document.getElementById("uploadDir")?.value || "scripts/cmds";
  const fd   = new FormData();
  fd.append("file", file);
  fd.append("targetDir", dir);
  const el = document.getElementById("uploadStatus");
  el.innerHTML = "⏳ جارٍ الرفع...";
  try {
    const r = await fetch("/api/devhub/upload", { method:"POST", body:fd }).then(r=>r.json());
    if (r.ok) { el.innerHTML = \`<span style="color:#6ee7b7">✅ \${r.message}</span>\`; showToast("✅ تم رفع الملف","success"); }
    else { el.innerHTML = \`<span style="color:#f87171">❌ \${r.error||"فشل"}</span>\`; }
  } catch(e) { el.innerHTML = \`<span style="color:#f87171">❌ \${e.message}</span>\`; }
}

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  ${hasToken ? "verifyToken(); setTimeout(loadRepos, 1000);" : ""}
});
</script>`;

    res.send(layout("مركز التطوير", body, "devhub"));
  });

  // ── Guide Page ──────────────────────────────────────────────────────────────
  app.get("/devhub/guide", auth, (req, res) => {
    res.redirect("/devhub#guide");
  });

  // ── API: Context ────────────────────────────────────────────────────────────
  app.get("/api/devhub/bot/context", auth, (req, res) => {
    try { res.json({ ok:true, context: buildAutoContext() }); }
    catch(e) { res.json({ error: e.message }); }
  });

  // ── API: AI Pipeline ────────────────────────────────────────────────────────
  app.post("/api/devhub/ai/pipeline", auth, async (req, res) => {
    try {
      const { message, files, history, autoCtx } = req.body;
      const steps = await runPipeline(message, files||[], history||[], autoCtx);
      res.json({ ok:true, steps });
    } catch(e) { res.json({ error: e.message }); }
  });

  // ── API: AI Single ──────────────────────────────────────────────────────────
  app.post("/api/devhub/ai/single", auth, async (req, res) => {
    try {
      const { model, message, files, history, autoCtx } = req.body;
      const ctxStr = [
        autoCtx ? `=== معلومات البوت ===\n${autoCtx}` : "",
        ...(files||[]).map(f=>`--- ${f.path} ---\n${f.content}`)
      ].filter(Boolean).join("\n\n");
      const agKey = model==="mistral"?"implementer": model==="llama"?"analyst": "analyst";
      const sysP  = AGENTS[agKey]?.prompt || AGENTS.analyst.prompt;
      const msgs  = [
        { role:"system", content:sysP },
        ...(history||[]).slice(-8),
        { role:"user", content:message + (ctxStr?`\n\n${ctxStr}`:"") }
      ];
      const result = await callAI(model||"openai", msgs);
      res.json({ ok:true, reply:result.reply, model:result.model });
    } catch(e) { res.json({ error: e.message }); }
  });

  // ── API: AI Guide ────────────────────────────────────────────────────────────
  app.post("/api/devhub/ai/guide", auth, async (req, res) => {
    try {
      const { message, history, autoCtx } = req.body;
      const sysPmt = `أنت مرشد تقني ودود يشرح لأشخاص لا يعرفون البرمجة.
- أجب بالعربية البسيطة
- اشرح خطوة بخطوة بأمثلة واضحة
- كن مشجعاً وإيجابياً
- إذا احتجت كود ضعه في \`\`\`javascript مع شرح بسيط`;
      const msgs = [
        { role:"system", content:sysPmt },
        ...(history||[]).slice(-6),
        { role:"user", content:message }
      ];
      const result = await callAI("openai", msgs);
      res.json({ ok:true, reply:result.reply });
    } catch(e) { res.json({ error: e.message }); }
  });

  // ── API: Chat Clear ──────────────────────────────────────────────────────────
  app.post("/api/devhub/chat/clear", auth, (req, res) => {
    try {
      const { target } = req.body;
      const cfg = loadCfg();
      if (!target||target==="agents"||target==="all") cfg.chatHistory=[];
      if (target==="chat"||target==="all") cfg.chatHistory=[];
      saveCfg(cfg);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  // ── API: File Read ───────────────────────────────────────────────────────────
  app.post("/api/devhub/file", auth, (req, res) => {
    try {
      const { path: p } = req.body;
      if (!p) return res.json({ error:"لا يوجد مسار" });
      res.json({ ok:true, content: readBotFile(p) });
    } catch(e) { res.json({ error:e.message }); }
  });

  // ── API: File Write ──────────────────────────────────────────────────────────
  app.post("/api/devhub/file/write", auth, (req, res) => {
    try {
      const { path: p, content } = req.body;
      if (!p || content===undefined) return res.json({ error:"مسار أو محتوى مفقود" });
      writeBotFile(p, content);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  // ── API: File List ───────────────────────────────────────────────────────────
  app.get("/api/devhub/files", auth, (req, res) => {
    res.json({ files: listAllBotFiles() });
  });

  // ── API: File Upload ─────────────────────────────────────────────────────────
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20*1024*1024 },
    fileFilter: (req, file, cb) => {
      const ok = new Set([".js",".json",".txt",".md",".yaml",".yml",".zip",".sh",".py",".html",".css",".ts",".env"]);
      cb(ok.has(path.extname(file.originalname).toLowerCase()) ? null : new Error("نوع غير مدعوم"), true);
    }
  });
  app.post("/api/devhub/upload", auth, upload.single("file"), async (req, res) => {
    try {
      const f = req.file;
      if (!f) return res.json({ error:"لم يتم رفع ملف" });
      const ext = path.extname(f.originalname).toLowerCase();
      const targetDir = req.body.targetDir || "scripts/cmds";
      if (ext === ".zip") {
        try {
          const AdmZip = require("adm-zip");
          const zip = new AdmZip(f.buffer);
          const saved = [];
          const allowedExts = new Set([".js",".json",".txt",".md",".yaml",".yml",".sh",".py",".html",".css",".ts",".env"]);
          for (const entry of zip.getEntries()) {
            if (entry.isDirectory || entry.entryName.includes("__MACOSX")) continue;
            if (!allowedExts.has(path.extname(entry.entryName).toLowerCase())) continue;
            let dest = entry.entryName;
            if (targetDir && !dest.includes("/")) dest = `${targetDir}/${dest}`;
            const full = path.join(ROOT, dest);
            fs.ensureDirSync(path.dirname(full));
            fs.writeFileSync(full, entry.getData());
            saved.push(dest);
          }
          return res.json({ ok:true, message:`تم استخراج ${saved.length} ملف`, files:saved });
        } catch(e) { return res.json({ error:`فشل فتح ZIP: ${e.message}` }); }
      } else {
        const dest = path.join(ROOT, targetDir, f.originalname);
        fs.ensureDirSync(path.dirname(dest));
        fs.writeFileSync(dest, f.buffer);
        return res.json({ ok:true, message:`تم رفع: ${targetDir}/${f.originalname}`, files:[`${targetDir}/${f.originalname}`] });
      }
    } catch(e) { res.json({ error:e.message }); }
  });

  // ── API: Config Save ─────────────────────────────────────────────────────────
  app.post("/api/devhub/config/save", auth, (req, res) => {
    try {
      const cfg = loadCfg();
      if (req.body.token === "CLEAR_TOKEN") { cfg.githubTokenEnc = ""; }
      else if (req.body.token && req.body.token !== "••••••••••••••••••••") cfg.githubTokenEnc = encTok(req.body.token);
      if (req.body.owner) cfg.baseOwner = req.body.owner;
      if (req.body.baseRepo) cfg.baseRepo = req.body.baseRepo;
      if (req.body.railwayUrl !== undefined) cfg.railwayUrl = req.body.railwayUrl;
      if (req.body.railwayWebhook !== undefined) cfg.railwayWebhook = req.body.railwayWebhook;
      saveCfg(cfg);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  // ── API: GitHub Test ─────────────────────────────────────────────────────────
  app.get("/api/devhub/github/test", auth, async (req, res) => {
    try {
      const token = loadToken();
      if (!token) return res.json({ error:"لا يوجد GitHub token — أضفه أولاً" });
      const user = await ghGetUser(token);
      res.json({ ok:true, login:user.login, repos:(user.public_repos||0)+(user.total_private_repos||0) });
    } catch(e) { res.json({ error:e.message }); }
  });

  // ── API: GitHub Repos ────────────────────────────────────────────────────────
  app.get("/api/devhub/github/repos", auth, async (req, res) => {
    try {
      const token = loadToken();
      if (!token) return res.json({ error:"لا يوجد GitHub token" });
      const repos = await ghGetRepos(token);
      res.json({ repos: repos.map(r=>({ name:r.name, html_url:r.html_url, private:r.private, description:r.description })) });
    } catch(e) { res.json({ error:e.message }); }
  });

  // ── API: Create Repo ─────────────────────────────────────────────────────────
  app.post("/api/devhub/github/create-repo", auth, async (req, res) => {
    try {
      const token = loadToken();
      if (!token) return res.json({ error:"لا يوجد token" });
      const { name, private: isPrivate } = req.body;
      const data = await ghCreateRepo(token, name, isPrivate !== false);
      res.json({ ok:true, url:data.html_url });
    } catch(e) { res.json({ error:e.message }); }
  });

  // ── API: Push All ────────────────────────────────────────────────────────────
  app.post("/api/devhub/github/push-all", auth, async (req, res) => {
    try {
      const token = loadToken();
      if (!token) return res.json({ error:"أضف GitHub token أولاً" });
      const cfg   = loadCfg();
      const owner = req.body.owner || cfg.baseOwner || "castrolmocro";
      const repo  = req.body.repo  || cfg.baseRepo  || "WHITE-V3";
      const branch= req.body.branch|| "main";
      const msg   = req.body.commitMsg || "🚀 Push from WHITE V3 Panel";
      const result = gitPush(token, owner, repo, branch, msg);
      if (!result.ok) return res.json({ error: result.error });
      const url = `https://github.com/${owner}/${repo}/tree/${branch}`;
      const vers = loadVersions();
      vers.push({ branch, repo, repoUrl:`https://github.com/${owner}/${repo}`, date:new Date().toLocaleString("ar-DZ"), status:"success" });
      saveVersions(vers);
      res.json({ ok:true, url:`https://github.com/${owner}/${repo}` });
    } catch(e) { res.json({ error:e.message }); }
  });

  // ── API: Versions ────────────────────────────────────────────────────────────
  app.get("/api/devhub/versions", auth, (req, res) => {
    res.json({ versions: loadVersions() });
  });

  // ── API: Railway Projects ────────────────────────────────────────────────────
  app.post("/api/devhub/railway/projects", auth, async (req, res) => {
    try {
      const cfg = loadCfg();
      const tok = cfg.railwayApiToken ? decTok(cfg.railwayApiToken) : "";
      if (!tok) return res.json({ error:"أضف Railway API Token أولاً" });
      const projects = await railwayGetProjects(tok);
      res.json({ ok:true, projects: projects.map(p=>({
        id:p.id, name:p.name,
        environments:(p.environments?.edges||[]).map(e=>e.node),
        services:(p.services?.edges||[]).map(e=>e.node)
      })) });
    } catch(e) { res.json({ error:e.message }); }
  });

  // ── API: Railway Redeploy ────────────────────────────────────────────────────
  app.post("/api/devhub/railway/redeploy", auth, async (req, res) => {
    try {
      const cfg = loadCfg();
      const tok = cfg.railwayApiToken ? decTok(cfg.railwayApiToken) : "";
      const webhook = req.body.webhookUrl || cfg.railwayWebhook || "";
      if (tok && cfg.railwayServiceId && cfg.railwayEnvironmentId) {
        await railwayTriggerDeploy(tok, cfg.railwayServiceId, cfg.railwayEnvironmentId);
        return res.json({ ok:true });
      }
      if (webhook) {
        const r = await fetch(webhook, { method:"POST", headers:{"Content-Type":"application/json"}, body:"{}" });
        return res.json({ ok:r.ok, status:r.status });
      }
      res.json({ error:"لم يتم إعداد Railway — أضف API Token أو Webhook" });
    } catch(e) { res.json({ error:e.message }); }
  });

  // ── API: Smart Deploy Config ─────────────────────────────────────────────────
  app.post("/api/devhub/smart-deploy/config", auth, (req, res) => {
    try {
      const cfg = loadCfg();
      if (req.body.railwayApiToken && req.body.railwayApiToken!=="••••••••••••••••") cfg.railwayApiToken=encTok(req.body.railwayApiToken);
      if (req.body.railwayProjectId  !== undefined) cfg.railwayProjectId  = req.body.railwayProjectId;
      if (req.body.railwayServiceId  !== undefined) cfg.railwayServiceId  = req.body.railwayServiceId;
      if (req.body.railwayEnvironmentId!==undefined) cfg.railwayEnvironmentId=req.body.railwayEnvironmentId;
      if (req.body.maxUpdateRepos    !== undefined) cfg.maxUpdateRepos    = parseInt(req.body.maxUpdateRepos)||5;
      if (req.body.railwayWebhook    !== undefined) cfg.railwayWebhook    = req.body.railwayWebhook;
      if (req.body.baseRepo)                        cfg.baseRepo          = req.body.baseRepo;
      saveCfg(cfg);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  // ── API: Smart Deploy Create ─────────────────────────────────────────────────
  app.post("/api/devhub/smart-deploy/create", auth, async (req, res) => {
    const steps = [];
    try {
      const cfg   = loadCfg();
      const token = loadToken();
      if (!token) return res.json({ error:"أضف GitHub Token أولاً من تبويب GitHub", steps });
      const owner   = cfg.baseOwner || "castrolmocro";
      const baseRepo= cfg.baseRepo  || "WHITE-V3";
      const msg     = req.body.commitMsg || "🚀 تحديث من WHITE V3 Panel";
      const makePrv = req.body.makePrivate !== false;

      // Step 1: Create new update repo
      const vers = loadVersions();
      const idx  = (vers.filter(v=>v.type==="smart").length) + 1;
      const newRepo = `${baseRepo}-upd-${idx}-${Date.now().toString(36)}`;
      steps.push({ icon:"📁", label:"إنشاء الريبو", msg:`جارٍ إنشاء ${newRepo}...` });
      await ghCreateRepo(token, newRepo, makePrv);
      await new Promise(r=>setTimeout(r,4000));
      steps[0].msg = `✅ تم إنشاء ${newRepo}`;

      // Step 2: Push files
      steps.push({ icon:"📤", label:"رفع الملفات", msg:"جارٍ رفع الملفات..." });
      const pushResult = gitPush(token, owner, newRepo, "main", `${msg} (#${idx})`);
      if (!pushResult.ok) { steps[1].msg = `❌ فشل الرفع: ${pushResult.error}`; }
      else { steps[1].msg = "✅ تم رفع الملفات بنجاح"; }

      // Step 3: Railway (optional)
      steps.push({ icon:"🚂", label:"تحديث Railway", msg:"جارٍ تحديث Railway..." });
      const rTok = cfg.railwayApiToken ? decTok(cfg.railwayApiToken) : "";
      if (rTok && cfg.railwayServiceId && cfg.railwayEnvironmentId) {
        try {
          await railwayTriggerDeploy(rTok, cfg.railwayServiceId, cfg.railwayEnvironmentId);
          steps[2].msg = "✅ Railway مُحدَّث — جارٍ النشر";
        } catch(re) { steps[2].msg = `⚠️ ${re.message}`; }
      } else if (cfg.railwayWebhook) {
        try {
          const r = await fetch(cfg.railwayWebhook, { method:"POST", headers:{"Content-Type":"application/json"}, body:"{}" });
          steps[2].msg = r.ok ? "✅ Railway Webhook أُرسل" : `⚠️ HTTP ${r.status}`;
        } catch(e) { steps[2].msg = `⚠️ ${e.message}`; }
      } else {
        steps[2].msg = "⏭️ Railway غير مُعداد (اختياري)";
      }

      const repoUrl = `https://github.com/${owner}/${newRepo}`;
      vers.push({ branch:"main", repo:newRepo, repoUrl, date:new Date().toLocaleString("ar-DZ"), status:pushResult.ok?"success":"failed", type:"smart" });
      saveVersions(vers);
      res.json({ ok:true, steps, repoUrl });
    } catch(e) { res.json({ error:e.message, steps }); }
  });
};
