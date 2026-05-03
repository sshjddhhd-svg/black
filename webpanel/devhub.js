"use strict";
const fs      = require("fs-extra");
const path    = require("path");
const multer  = require("multer");
const os      = require("os");
const { execSync } = require("child_process");

const ROOT       = path.join(__dirname, "..");
const CFG_FILE   = path.join(__dirname, "devhub-config.json");
const VERSIONS_F = path.join(__dirname, "devhub-versions.json");
const PANEL_CFG  = path.join(__dirname, "panel-config.json");

// ─── Config helpers ───────────────────────────────────────────────────────────
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); }
  catch (_) { return { githubTokenEnc: "", baseRepo: "New-white-e2ee-v2", baseOwner: "castrolmocro", models: ["openai","mistral","llama"], conversationHistory: [] }; }
}
function saveCfg(c) { fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2)); }

function encToken(token) { return Buffer.from(String(token), "utf8").toString("base64"); }
function decToken(token) {
  try { return Buffer.from(String(token), "base64").toString("utf8"); }
  catch (_) { return ""; }
}
function loadToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return decToken(loadCfg().githubTokenEnc || ""); }
  catch (_) { return ""; }
}
function tokenFromEnv() { return !!process.env.GITHUB_TOKEN; }
function hasStoredToken() { return !!loadCfg().githubTokenEnc || !!process.env.GITHUB_TOKEN; }
function panelPassword() {
  try { const cfg = loadCfg(); return cfg.panelPassword || process.env.PANEL_PASSWORD || "djamel0191tlm"; }
  catch (_) { return process.env.PANEL_PASSWORD || "djamel0191tlm"; }
}
function loadVersions() {
  try { return JSON.parse(fs.readFileSync(VERSIONS_F, "utf8")); }
  catch (_) { return []; }
}
function saveVersions(v) { fs.writeFileSync(VERSIONS_F, JSON.stringify(v, null, 2)); }

// ─── Bot File Scanner — Full Access ──────────────────────────────────────────
const SCAN_DIRS = [
  "scripts/cmds", "scripts/events",
  "bot", "webpanel", "func", "logger", "database",
  ""
];
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", ".local", "assets", "images"]);
const SCAN_EXTS = new Set([".js", ".json", ".md", ".txt", ".yaml", ".yml", ".sh", ".env"]);

function listAllBotFiles() {
  const result = [];
  function scan(dir, prefix = "", depth = 0) {
    if (depth > 4) return;
    const full = dir ? path.join(ROOT, dir) : ROOT;
    try {
      const items = fs.readdirSync(full, { withFileTypes: true });
      for (const item of items) {
        const rel = dir ? `${dir}/${item.name}` : item.name;
        if (item.isDirectory()) {
          if (!SKIP_DIRS.has(item.name)) scan(rel, rel, depth + 1);
        } else if (SCAN_EXTS.has(path.extname(item.name).toLowerCase())) {
          result.push(rel);
        }
      }
    } catch (_) {}
  }
  for (const dir of SCAN_DIRS) {
    try {
      const full = dir ? path.join(ROOT, dir) : ROOT;
      const items = fs.readdirSync(full, { withFileTypes: true });
      for (const item of items) {
        if (!item.isDirectory() && SCAN_EXTS.has(path.extname(item.name).toLowerCase())) {
          result.push(dir ? `${dir}/${item.name}` : item.name);
        } else if (item.isDirectory() && !SKIP_DIRS.has(item.name) && dir !== "") {
          scan(`${dir}/${item.name}`, `${dir}/${item.name}`, 1);
        }
      }
    } catch (_) {}
  }
  // Deduplicate
  return [...new Set(result)].slice(0, 200);
}

function getFileTree() {
  const tree = {};
  const files = listAllBotFiles();
  for (const f of files) {
    const parts = f.split("/");
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = {};
      node = node[parts[i]];
    }
    const name = parts[parts.length - 1];
    node[name] = "file";
  }
  return { tree, files };
}

function readBotFile(relPath) {
  try {
    const full = path.join(ROOT, relPath);
    const content = fs.readFileSync(full, "utf8");
    return content.slice(0, 15000);
  } catch (e) { return `Error reading file: ${e.message}`; }
}

function writeBotFile(relPath, content) {
  const full = path.join(ROOT, relPath);
  fs.ensureDirSync(path.dirname(full));
  fs.writeFileSync(full, content, "utf8");
}

/** Builds automatic context: bot structure summary + key files */
function buildAutoContext() {
  const parts = [];

  // 1. Config summary
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    parts.push(`=== إعدادات البوت ===
البريفيكس: ${cfg.prefix || "/"}
اللغة: ${cfg.language || "en"}
اسم البوت: ${cfg.nickNameBot || "—"}
SuperAdmin IDs: ${(cfg.superAdminBot || []).join(", ")}
adminOnly: ${cfg.adminOnly?.enable ? "مفعّل" : "معطّل"}
antiInbox: ${cfg.antiInbox || false}`);
  } catch (_) {}

  // 2. Commands list
  try {
    const cmdsDir = path.join(ROOT, "scripts/cmds");
    const cmds = fs.readdirSync(cmdsDir).filter(f => f.endsWith(".js"));
    parts.push(`=== أوامر البوت (${cmds.length} أمر) ===\n${cmds.join(", ")}`);
  } catch (_) {}

  // 3. Events list
  try {
    const evDir = path.join(ROOT, "scripts/events");
    const evs = fs.readdirSync(evDir).filter(f => f.endsWith(".js"));
    parts.push(`=== أحداث البوت (${evs.length} حدث) ===\n${evs.join(", ")}`);
  } catch (_) {}

  // 4. Package info
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    parts.push(`=== معلومات المشروع ===
الاسم: ${pkg.name}, الإصدار: ${pkg.version}
Node: ${pkg.engines?.node || "—"}`);
  } catch (_) {}

  // 5. Bot info (Goat.js brief)
  try {
    const goat = fs.readFileSync(path.join(ROOT, "Goat.js"), "utf8").slice(0, 2000);
    parts.push(`=== Goat.js (بداية الملف الرئيسي) ===\n${goat}`);
  } catch (_) {}

  return parts.join("\n\n");
}

function getBotStats() {
  const stats = { cmds: 0, events: 0, prefix: "/", version: "—", name: "WHITE BOT" };
  try {
    const cmdsDir = path.join(ROOT, "scripts/cmds");
    stats.cmds = fs.readdirSync(cmdsDir).filter(f => f.endsWith(".js")).length;
  } catch (_) {}
  try {
    const evDir = path.join(ROOT, "scripts/events");
    stats.events = fs.readdirSync(evDir).filter(f => f.endsWith(".js")).length;
  } catch (_) {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    stats.prefix = cfg.prefix || "/";
    stats.name = cfg.nickNameBot || "WHITE BOT";
  } catch (_) {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    stats.version = pkg.version || "—";
  } catch (_) {}
  return stats;
}

// ─── GitHub API helper ────────────────────────────────────────────────────────
async function ghApi(token, method, endpoint, body) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "WHITE-V3-DevHub"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `GitHub API error ${res.status}`);
  return data;
}

// ─── AI API helper ────────────────────────────────────────────────────────────
async function callAI(model, messages) {
  const TIMEOUT_MS = 38000;
  const ALL_MODELS = ["openai", "mistral", "llama", "openai-fast", "deepseek"];
  // Put the preferred model first, then the rest
  const preferred = ALL_MODELS.includes(model) ? model : "openai";
  const order = [preferred, ...ALL_MODELS.filter(m => m !== preferred)];
  const endpoints = order.map(m => ({ url: "https://text.pollinations.ai/openai", model: m }));

  let lastErr = "";
  for (const ep of endpoints) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(ep.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "WHITE-V3-DevHub/3.0" },
          signal: controller.signal,
          body: JSON.stringify({
            model: ep.model, messages, stream: false,
            seed: Math.floor(Math.random() * 99999)
          })
        });
        clearTimeout(timer);
        if (!res.ok) { lastErr = `HTTP ${res.status} من ${ep.model}`; await new Promise(r=>setTimeout(r,600)); continue; }
        const data = await res.json();
        const reply = data?.choices?.[0]?.message?.content;
        if (reply?.trim()) return reply.trim();
        lastErr = `رد فارغ من ${ep.model}`;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e.name === "AbortError" ? `انتهت مهلة ${ep.model}` : e.message;
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }
  throw new Error(`فشل الاتصال بجميع نماذج الذكاء الاصطناعي.\nالسبب الأخير: ${lastErr}\n\nتحقق من اتصال الإنترنت وأعد المحاولة.`);
}

// ─── AI Agents ────────────────────────────────────────────────────────────────
const AGENTS = {
  analyst: {
    name: "المحلل", model: "llama", icon: "🔍", color: "#60a5fa",
    systemPrompt: `أنت خبير في بوتات فيسبوك Messenger بـ Node.js (نظام GoatBot/WhiteBot).
لديك وصول كامل لملفات البوت وهيكله.
قواعد الرد:
- أجب دائماً بالعربية
- كن موجزاً ومباشراً
- ركّز على المشكلة المحددة فقط
- إذا كان الطلب يحتاج كوداً ضعه في \`\`\`javascript بلوك
- لا تشرح أشياء واضحة
- إذا لم يكن لديك معلومات كافية اطلبها
- تذكر أن هذا بوت فيسبوك يعمل بـ GoatBot framework`
  },
  implementer: {
    name: "المطور", model: "mistral", icon: "💻", color: "#c4b5fd",
    systemPrompt: `أنت مطور Node.js متخصص في بوتات فيسبوك Messenger (GoatBot/WhiteBot).
قواعد:
- أجب بالعربية
- اكتب الكود المطلوب في \`\`\`javascript بلوك
- الكود يجب أن يكون متوافقاً مع نظام GoatBot
- استخدم module.exports = { config:{...}, onStart: async({...})=>{} } للأوامر
- لا تضف شرحاً غير ضروري`
  },
  reviewer: {
    name: "المراجع", model: "openai", icon: "✅", color: "#6ee7b7",
    systemPrompt: `أنت مراجع كود سريع لبوتات GoatBot فيسبوك.
قواعد:
- أجب بالعربية في 3-5 أسطر
- حكم واحد نهائي: ✅ صح أو ❌ خطأ مع السبب
- اذكر أي مشاكل محتملة
- لا تكرر الكود`
  },
  guide: {
    name: "المرشد", model: "openai", icon: "📚", color: "#fbbf24",
    systemPrompt: `أنت مرشد تقني صديق لأشخاص يريدون تطوير بوتات فيسبوك.
قواعد:
- أجب بالعربية البسيطة
- تحدث كأنك تشرح لشخص لا يعرف البرمجة
- استخدم أمثلة عملية
- اشرح الخطوات بترتيب واضح
- كن مشجعاً وإيجابياً
- إذا احتجت كود ضعه في \`\`\`javascript مع شرح بسيط لكل سطر`
  },
  claude: {
    name: "Claude AI", model: "claude", icon: "🤖", color: "#f59e0b",
    systemPrompt: `أنت مساعد ذكي متخصص في تطوير بوتات فيسبوك Messenger بـ Node.js (GoatBot framework).
لديك وصول كامل لملفات وهيكل البوت.
قواعد:
- أجب دائماً بالعربية
- ردود مختصرة وعملية
- الكود في \`\`\`javascript بلوك
- تذكر سياق المحادثة وتصرف بناءً عليه
- إذا سُئلت عن ملف معين أو أمر معين استخدم المعلومات المتوفرة`
  },
  advisor: {
    name: "مستشار البوت", model: "openai", icon: "💡", color: "#a78bfa",
    systemPrompt: `أنت مستشار ذكي لبوتات فيسبوك Messenger (نظام GoatBot/WhiteBot).
دورك: تقرأ ملفات البوت وتجيب على الأسئلة وتقترح أفكاراً وتحسينات — فقط بالكلام، لا تكتب كوداً كاملاً ولا تعدّل أي ملف أبداً.
قواعد الرد:
- أجب بالعربية البسيطة السهلة
- ردودك قصيرة وواضحة ومباشرة
- إذا سألك عن ميزة موجودة اشرح له كيف تعمل بكلمات بسيطة
- إذا طلب فكرة أو تحديث اقترح عليه الأفكار بنقاط مرتبة
- إذا سألك عن مشكلة اشرح السبب والحل بخطوات بسيطة
- لا تكتب كوداً طويلاً، فقط مقتطفات قصيرة إن لزم للتوضيح
- تذكر دائماً: أنت تقرأ فقط، لا تعدّل ولا تحذف ولا تنشئ ملفات
- كن ودوداً وتحدث كأنك صديق يفهم في البوتات`
  }
};

// ─── Multi-Agent Pipeline ──────────────────────────────────────────────────────
async function runMultiAgentPipeline(userRequest, fileContexts, history, autoCtx) {
  const steps = [];
  const ctxStr = [
    autoCtx ? `=== السياق التلقائي للبوت ===\n${autoCtx}` : "",
    ...(fileContexts || []).map(f => `\n--- ملف: ${f.path} ---\n${f.content}`)
  ].filter(Boolean).join("\n\n");

  const baseHistory = [
    ...history.slice(-6),
    { role: "user", content: userRequest + (ctxStr ? `\n\n${ctxStr}` : "") }
  ];

  // Step 1: Guide (for non-programmers) + Analyst
  const analystMsgs = [
    { role: "system", content: AGENTS.analyst.systemPrompt },
    ...baseHistory
  ];
  const analystReply = await callAI(AGENTS.analyst.model, analystMsgs);
  steps.push({ agent: "analyst", name: AGENTS.analyst.name, icon: AGENTS.analyst.icon, color: AGENTS.analyst.color, reply: analystReply });

  // Step 2: Implementer
  const implMsgs = [
    { role: "system", content: AGENTS.implementer.systemPrompt },
    ...baseHistory,
    { role: "assistant", content: `[المحلل]: ${analystReply}` },
    { role: "user", content: "بناءً على التحليل، اكتب الكود الكامل أو التعديلات اللازمة." }
  ];
  const implReply = await callAI(AGENTS.implementer.model, implMsgs);
  steps.push({ agent: "implementer", name: AGENTS.implementer.name, icon: AGENTS.implementer.icon, color: AGENTS.implementer.color, reply: implReply });

  // Step 3: Reviewer
  const reviewMsgs = [
    { role: "system", content: AGENTS.reviewer.systemPrompt },
    { role: "user", content: `الطلب: ${userRequest}\nالتحليل:\n${analystReply}\nالكود:\n${implReply}\nهل الكود صحيح؟` }
  ];
  const reviewReply = await callAI(AGENTS.reviewer.model, reviewMsgs);
  steps.push({ agent: "reviewer", name: AGENTS.reviewer.name, icon: AGENTS.reviewer.icon, color: AGENTS.reviewer.color, reply: reviewReply });

  return steps;
}

// ─── GitHub Operations ────────────────────────────────────────────────────────
async function listUserRepos(token) {
  return await ghApi(token, "GET", "/user/repos?per_page=50&sort=updated&type=owner");
}
async function createRepo(token, name, isPrivate = true) {
  return await ghApi(token, "POST", "/user/repos", {
    name, private: isPrivate, auto_init: true,
    description: `WHITE V3 Update — ${new Date().toISOString().split("T")[0]}`
  });
}
async function getRef(token, owner, repo, branch = "main") {
  try { return await ghApi(token, "GET", `/repos/${owner}/${repo}/git/refs/heads/${branch}`); }
  catch (_) { return await ghApi(token, "GET", `/repos/${owner}/${repo}/git/refs/heads/master`); }
}
async function createBranch(token, owner, repo, branchName, fromSha) {
  return await ghApi(token, "POST", `/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${branchName}`, sha: fromSha
  });
}
async function getFileBlob(token, owner, repo, filePath, branch = "main") {
  try { return await ghApi(token, "GET", `/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`); }
  catch (_) { return null; }
}
async function pushFile(token, owner, repo, filePath, content, branch, message) {
  const existing = await getFileBlob(token, owner, repo, filePath, branch);
  const body = { message, content: Buffer.from(content, "utf8").toString("base64"), branch };
  if (existing?.sha) body.sha = existing.sha;
  return await ghApi(token, "PUT", `/repos/${owner}/${repo}/contents/${filePath}`, body);
}
async function pushLocalFilesToBranch(token, owner, repo, branch, files, commitMsg) {
  const results = [];
  for (const relPath of files) {
    try {
      const content = readBotFile(relPath);
      await pushFile(token, owner, repo, relPath, content, branch, commitMsg);
      results.push({ file: relPath, ok: true });
    } catch (e) { results.push({ file: relPath, ok: false, error: e.message }); }
  }
  return results;
}

// ─── Railway ──────────────────────────────────────────────────────────────────
async function railwayGql(token, query, variables = {}) {
  const res = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.message || "Railway GraphQL error");
  return data.data;
}
async function railwayGetProjects(token) {
  const data = await railwayGql(token, `query { me { projects { edges { node { id name environments { edges { node { id name } } } services { edges { node { id name } } } } } } } }`);
  return data?.me?.projects?.edges?.map(e => e.node) || [];
}
async function railwayUpdateServiceSource(token, serviceId, owner, repo, branch = "main") {
  return await railwayGql(token,
    `mutation ServiceUpdate($id: String!, $input: ServiceUpdateInput!) { serviceUpdate(id: $id, input: $input) { id name } }`,
    { id: serviceId, input: { source: { repo: `${owner}/${repo}`, branch } } }
  );
}
async function railwayTriggerDeploy(token, serviceId, environmentId) {
  return await railwayGql(token,
    `mutation ServiceInstanceRedeploy($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }`,
    { serviceId, environmentId }
  );
}

// ─── Smart Deploy ─────────────────────────────────────────────────────────────
const SMART_VERSIONS_F = path.join(__dirname, "smart-versions.json");
function loadSmartVersions() {
  try { return JSON.parse(fs.readFileSync(SMART_VERSIONS_F, "utf8")); }
  catch (_) { return { currentIndex: 0, activeRepo: null, updates: [] }; }
}
function saveSmartVersions(v) { fs.writeFileSync(SMART_VERSIONS_F, JSON.stringify(v, null, 2)); }
function makeUpdateRepoName(baseName, index) { return `${baseName}-upd-${index}`; }

function nodeCopyAll(src, dst) {
  const _SKIP = new Set(["node_modules", ".git", ".cache", ".local"]);
  const _SKIP_EXT = new Set([".log", ".sqlite", ".db"]);
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (_SKIP.has(path.basename(src))) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) nodeCopyAll(path.join(src, f), path.join(dst, f));
  } else {
    if (_SKIP_EXT.has(path.extname(src))) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}
async function gitPushToRepo(token, owner, repoName, commitMsg) {
  const tmpDir = path.join(os.tmpdir(), `wv3-sd-${Date.now()}`);
  const remote = `https://${token}@github.com/${owner}/${repoName}.git`;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    nodeCopyAll(ROOT, tmpDir);
    execSync(`git init "${tmpDir}"`, { stdio: "pipe" });
    execSync(`git -C "${tmpDir}" config user.email "whitepanel@local.bot"`, { stdio: "pipe" });
    execSync(`git -C "${tmpDir}" config user.name "WHITE V3 Panel"`, { stdio: "pipe" });
    execSync(`git -C "${tmpDir}" config http.postBuffer 524288000`, { stdio: "pipe" });
    execSync(`git -C "${tmpDir}" add -A`, { stdio: "pipe" });
    execSync(`git -C "${tmpDir}" commit -m "${commitMsg.replace(/"/g, "'")}"`, { stdio: "pipe" });
    execSync(`git -C "${tmpDir}" remote add origin "${remote}"`, { stdio: "pipe" });
    execSync(`git -C "${tmpDir}" push origin HEAD:main --force`, { stdio: "pipe", timeout: 180000 });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}
async function cleanupOldUpdateRepos(token, owner, baseName, keepCount, currentIndex) {
  const deleted = [];
  for (let i = 1; i <= currentIndex - keepCount; i++) {
    const name = makeUpdateRepoName(baseName, i);
    try { await ghApi(token, "DELETE", `/repos/${owner}/${name}`); deleted.push(name); } catch (_) {}
  }
  return deleted;
}

// ─── Export routes ─────────────────────────────────────────────────────────────
module.exports = function mountDevHub(app, auth, layout) {

  // ── Main DevHub Page ────────────────────────────────────────────────────────
  app.get("/devhub", auth, (req, res) => {
    const cfg      = loadCfg();
    const versions = loadVersions();
    const stats    = getBotStats();
    const { files } = getFileTree();
    const hasToken = !!loadToken();

    let _savedPort = 4000;
    try { _savedPort = JSON.parse(fs.readFileSync(PANEL_CFG, "utf8")).port || 4000; } catch(_) {}

    // Build file options grouped by directory
    const filesByDir = {};
    for (const f of files) {
      const dir = f.includes("/") ? f.split("/").slice(0, -1).join("/") : "root";
      if (!filesByDir[dir]) filesByDir[dir] = [];
      filesByDir[dir].push(f);
    }
    const groupedOptions = Object.entries(filesByDir).map(([dir, fs_]) =>
      `<optgroup label="${dir}">${fs_.map(f => `<option value="${f}">${f.split("/").pop()}</option>`).join("")}</optgroup>`
    ).join("");

    const versionRows = versions.slice(-10).reverse().map(v => `
<tr>
  <td><code style="color:#60a5fa">${v.branch || v.repo}</code></td>
  <td style="color:var(--text2)">${v.date || ""}</td>
  <td><span class="badge ${v.status === "success" ? "badge-green" : v.status === "failed" ? "badge-red" : "badge-yellow"}">${v.status || "pending"}</span></td>
  <td>${v.repoUrl ? `<a href="${v.repoUrl}" target="_blank" class="btn btn-outline btn-sm">🔗</a>` : ""}</td>
</tr>`).join("") || `<tr><td colspan="4" style="text-align:center;color:var(--text3)">لا توجد إصدارات بعد</td></tr>`;

    const body = `
<style>
/* ── DevHub Extra Styles ── */
.devhub-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.dstat{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;position:relative;overflow:hidden;transition:all .2s}
.dstat:hover{border-color:var(--border2);transform:translateY(-2px)}
.dstat-glow{position:absolute;top:-20px;left:50%;transform:translateX(-50%);width:60px;height:60px;border-radius:50%;opacity:.15;filter:blur(15px)}
.dstat-icon{font-size:1.6rem;margin-bottom:6px}
.dstat-val{font-size:1.8rem;font-weight:800;color:var(--text);line-height:1}
.dstat-lbl{font-size:.72rem;color:var(--text3);margin-top:4px}

/* ── Unified Chat ── */
.chat-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:20px}
.chat-tabs{display:flex;background:var(--bg3);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.chat-tabs::-webkit-scrollbar{display:none}
.chat-tab{flex:none;min-width:80px;padding:11px 10px;text-align:center;cursor:pointer;font-size:.84rem;font-weight:600;color:var(--text3);border:none;background:none;transition:all .2s;font-family:'Cairo',sans-serif;white-space:nowrap}
.chat-tab.active{color:var(--accent2);background:var(--bg2);border-bottom:2px solid var(--accent)}
.chat-panel{display:none;padding:16px}
.chat-panel.active{display:block}
.chat-box{background:#030712;border:1px solid var(--border);border-radius:10px;padding:16px;min-height:380px;max-height:520px;overflow-y:auto;margin-bottom:12px;font-size:.86rem;line-height:1.7}
.chat-box::-webkit-scrollbar{width:5px}
.chat-box::-webkit-scrollbar-thumb{background:#1e2d45;border-radius:3px}

/* ── Chat input row (textarea + buttons) ── */
.chat-input-row{display:flex;gap:8px}
.chat-input-row textarea{flex:1;min-width:0}
.chat-input-btns{display:flex;flex-direction:column;gap:6px;flex-shrink:0}

/* ── Quick Actions ── */
.quick-actions{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}
.qa-btn{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:6px 12px;font-size:.79rem;color:var(--text2);cursor:pointer;font-family:'Cairo',sans-serif;transition:all .15s;white-space:nowrap}
.qa-btn:hover{background:var(--bg4);color:var(--text);border-color:var(--border2)}

/* ── Auto Context Toggle ── */
.ctx-toggle{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--bg3);border:1px solid var(--border);border-radius:10px;margin-bottom:12px;cursor:pointer}
.ctx-toggle-sw{position:relative;width:38px;height:20px;flex-shrink:0}
.ctx-toggle-sw input{opacity:0;width:0;height:0}
.ctx-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#1e2d45;border-radius:20px;transition:.3s}
.ctx-slider:before{position:absolute;content:"";height:14px;width:14px;left:3px;bottom:3px;background:#64748b;border-radius:50%;transition:.3s}
input:checked + .ctx-slider{background:rgba(16,185,129,.3);border:1px solid var(--green)}
input:checked + .ctx-slider:before{transform:translateX(18px);background:var(--green)}

/* ── File Tree ── */
.file-tree{background:#030712;border:1px solid var(--border);border-radius:10px;padding:10px;max-height:320px;overflow-y:auto;font-size:.8rem}
.file-tree::-webkit-scrollbar{width:4px}
.file-tree::-webkit-scrollbar-thumb{background:#1e2d45;border-radius:2px}
.ft-dir{color:var(--text3);padding:3px 0;font-weight:700;margin-top:6px;font-size:.75rem;text-transform:uppercase;letter-spacing:.5px}
.ft-file{color:#94a3b8;padding:3px 8px;border-radius:4px;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .15s}
.ft-file:hover{background:var(--bg4);color:var(--text)}
.ft-file.selected{background:rgba(59,130,246,.15);color:#60a5fa;border-right:2px solid var(--accent)}

/* ── Upload Drop Zone ── */
.drop-zone{border:2px dashed var(--border);border-radius:12px;padding:28px;text-align:center;transition:all .2s;cursor:pointer;position:relative}
.drop-zone.dragover{border-color:var(--green);background:rgba(16,185,129,.05)}
.drop-zone input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer}

/* ── Code Editor ── */
.code-editor{background:#010409;border:1px solid var(--border);border-radius:10px;padding:14px;font-family:'Courier New',monospace;font-size:.79rem;color:#c9d1d9;resize:vertical;min-height:200px;line-height:1.6;width:100%;outline:none}
.code-editor:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-glow)}

/* ── Responsive ── */
/* ── File manager mobile tab system ── */
.fm-tabs{display:none}
.fm-tab-btn{flex:1;padding:9px 6px;font-size:.82rem;font-weight:700;font-family:'Cairo',sans-serif;border:none;background:var(--bg3);color:var(--text3);cursor:pointer;transition:all .2s;border-bottom:2px solid transparent}
.fm-tab-btn.active{color:var(--accent2);background:var(--bg2);border-bottom-color:var(--accent)}

@media(max-width:768px){
  /* Stats: 2x2 grid */
  .devhub-stats{grid-template-columns:1fr 1fr;gap:10px}
  .dstat{padding:12px 8px}
  .dstat-val{font-size:1.5rem}

  /* Chat tabs: scrollable row */
  .chat-tab{min-width:70px;font-size:.76rem;padding:10px 7px}
  .chat-panel{padding:12px 10px}

  /* Chat box: shorter on mobile */
  .chat-box{min-height:260px;max-height:400px;padding:12px;font-size:.83rem}

  /* Chat input: stack textarea above buttons */
  .chat-input-row{flex-direction:column}
  .chat-input-btns{flex-direction:row;justify-content:flex-end}
  .chat-input-btns .btn{flex:1;max-width:100px}

  /* Agents info row: 3 compact boxes */
  .agents-info-row{gap:5px}
  .agents-info-row > div{padding:7px 4px}
  .agents-info-row > div .dstat-lbl{display:none}

  /* Auto-context toggle: compact */
  .ctx-toggle{padding:8px 10px;gap:8px}

  /* File selector: stack vertically */
  .file-selector-row{grid-template-columns:1fr!important}
  .file-selector-btns{flex-direction:row!important;justify-content:flex-start}

  /* File manager: show tabs, hide side-by-side */
  .fm-tabs{display:flex;border-bottom:1px solid var(--border)}
  .fm-tree-col{display:none}
  .fm-tree-col.fm-visible{display:block}
  .fm-editor-col{display:none}
  .fm-editor-col.fm-visible{display:block}
  .fm-grid{grid-template-columns:1fr!important}

  /* File tree: shorter on mobile */
  .file-tree{max-height:240px}

  /* Code editor: shorter rows */
  .code-editor{min-height:160px}

  /* Upload: stack */
  .upload-grid{grid-template-columns:1fr!important}

  /* Drop zone: compact */
  .drop-zone{padding:18px 12px}

  /* Quick actions: horizontal scroll */
  .quick-actions{flex-wrap:nowrap;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch;scrollbar-width:none}
  .quick-actions::-webkit-scrollbar{display:none}
  .qa-btn{font-size:.74rem;padding:5px 10px}

  /* two-col-grid */
  .two-col-grid{grid-template-columns:1fr!important}

  /* Context controls padding */
  .ctx-controls{padding:10px}

  /* Forms */
  .btn-row{flex-wrap:wrap}

  /* Page header */
  .page-sub{font-size:.78rem}
}

@media(max-width:480px){
  .devhub-stats{grid-template-columns:1fr 1fr}
  .chat-tab{min-width:60px;font-size:.72rem;padding:9px 5px}
  .chat-box{min-height:220px;font-size:.8rem}
  .card{padding:14px}
}
</style>

<div class="page-header">
  <div class="page-title">🤖 مركز التطوير</div>
  <div class="page-sub">طوّر البوت بمساعدة الذكاء الاصطناعي — مجاني 100% — جميع الملفات في متناول اليد</div>
</div>

<!-- ── Bot Stats Bar ── -->
<div class="devhub-stats">
  <div class="dstat">
    <div class="dstat-glow" style="background:#3b82f6"></div>
    <div class="dstat-icon">⚙️</div>
    <div class="dstat-val" style="color:#60a5fa">${stats.cmds}</div>
    <div class="dstat-lbl">أمر مثبّت</div>
  </div>
  <div class="dstat">
    <div class="dstat-glow" style="background:#8b5cf6"></div>
    <div class="dstat-icon">⚡</div>
    <div class="dstat-val" style="color:#c4b5fd">${stats.events}</div>
    <div class="dstat-lbl">حدث نشط</div>
  </div>
  <div class="dstat">
    <div class="dstat-glow" style="background:#10b981"></div>
    <div class="dstat-icon">🔑</div>
    <div class="dstat-val" style="color:var(--green);font-size:1.4rem">${stats.prefix}</div>
    <div class="dstat-lbl">البريفيكس</div>
  </div>
  <div class="dstat">
    <div class="dstat-glow" style="background:#f59e0b"></div>
    <div class="dstat-icon">📦</div>
    <div class="dstat-val" style="color:var(--yellow);font-size:1.3rem">v${stats.version}</div>
    <div class="dstat-lbl">الإصدار</div>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════════════════ -->
<!-- ──  UNIFIED CHAT  ── -->
<!-- ════════════════════════════════════════════════════════════════════════ -->
<div class="chat-wrap">
  <div class="chat-tabs">
    <button class="chat-tab active" onclick="switchTab('agents',this)">🚀 الوكلاء الثلاثة</button>
    <button class="chat-tab" onclick="switchTab('claude',this)">🤖 Claude AI</button>
    <button class="chat-tab" onclick="switchTab('quick',this)">⚡ سريع</button>
    <button class="chat-tab" onclick="switchTab('guide',this)">📚 مرشد المبتدئين</button>
    <button class="chat-tab" onclick="switchTab('advisor',this)">💡 مستشار البوت</button>
  </div>

  <!-- ─ Context Controls (shared) ─ -->
  <div class="ctx-controls" style="padding:12px 16px;background:var(--bg3);border-bottom:1px solid var(--border)">
    <!-- Auto Context Toggle -->
    <label class="ctx-toggle" for="autoCtxToggle" style="margin-bottom:10px">
      <div class="ctx-toggle-sw">
        <input type="checkbox" id="autoCtxToggle" checked/>
        <span class="ctx-slider"></span>
      </div>
      <div>
        <div style="font-size:.85rem;font-weight:700;color:var(--text)">🔓 وصول تلقائي لكل ملفات البوت</div>
        <div style="font-size:.74rem;color:var(--text3)">عند التفعيل يحصل الذكاء الاصطناعي على معلومات كاملة عن بوتك تلقائياً دون اختيار يدوي</div>
      </div>
    </label>

    <!-- Quick Actions -->
    <div style="font-size:.75rem;color:var(--text3);margin-bottom:6px;font-weight:600">⚡ إجراءات سريعة:</div>
    <div class="quick-actions">
      <button class="qa-btn" onclick="quickAction('أضف أمر جديد باسم myCommand يعرض رسالة ترحيب')">➕ أمر جديد</button>
      <button class="qa-btn" onclick="quickAction('أصلح الخطأ الموجود في البوت')">🔧 أصلح خطأ</button>
      <button class="qa-btn" onclick="quickAction('اشرح لي كيف يعمل هذا الكود')">📖 اشرح الكود</button>
      <button class="qa-btn" onclick="quickAction('أنشئ حدث event يرد تلقائياً على رسائل معينة')">⚡ حدث جديد</button>
      <button class="qa-btn" onclick="quickAction('ما هي أوامر البوت المثبتة وما وظيفة كل منها؟')">📋 قائمة الأوامر</button>
      <button class="qa-btn" onclick="quickAction('كيف أضيف صلاحية admin لمستخدم معين؟')">👑 إدارة الأدمن</button>
      <button class="qa-btn" onclick="quickAction('أضف حماية للبوت من الرسائل المسيئة')">🛡️ حماية البوت</button>
      <button class="qa-btn" onclick="quickAction('كيف أجعل أمراً يعمل فقط للأدمن؟')">🔒 تقييد أمر</button>
    </div>

    <!-- File Selector (compact) -->
    <div class="file-selector-row" style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end;margin-top:8px">
      <div>
        <div style="font-size:.75rem;color:var(--text3);margin-bottom:4px;font-weight:600">📁 ملفات إضافية للسياق (اختياري مع الوصول التلقائي):</div>
        <select id="fileSelect" class="form-control" multiple style="height:70px;font-size:.8rem">
          ${groupedOptions}
        </select>
      </div>
      <div class="file-selector-btns" style="display:flex;flex-direction:column;gap:6px">
        <button class="btn btn-outline btn-sm" onclick="selectAll()">الكل</button>
        <button class="btn btn-outline btn-sm" onclick="clearSelect()">مسح</button>
        <button class="btn btn-outline btn-sm" onclick="previewSelectedFile()">👁️</button>
      </div>
    </div>
    <div id="filePreviewArea" style="display:none;margin-top:8px">
      <pre id="filePreview" style="background:#030712;border:1px solid var(--border);border-radius:8px;padding:10px;font-size:.73rem;max-height:150px;overflow-y:auto;color:#94a3b8;white-space:pre-wrap;margin:0"></pre>
    </div>
  </div>

  <!-- ─────────── TAB: الوكلاء الثلاثة ─────────── -->
  <div class="chat-panel active" id="tab-agents">
    <div class="agents-info-row" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
      <div style="background:var(--bg3);border:1px solid rgba(96,165,250,.25);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:1.2rem">🔍</div>
        <div style="font-size:.78rem;font-weight:700;color:#60a5fa">المحلل</div>
        <div class="dstat-lbl">يحلل ويخطط</div>
      </div>
      <div style="background:var(--bg3);border:1px solid rgba(196,181,253,.25);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:1.2rem">💻</div>
        <div style="font-size:.78rem;font-weight:700;color:#c4b5fd">المطور</div>
        <div class="dstat-lbl">يكتب الكود</div>
      </div>
      <div style="background:var(--bg3);border:1px solid rgba(110,231,183,.25);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:1.2rem">✅</div>
        <div style="font-size:.78rem;font-weight:700;color:#6ee7b7">المراجع</div>
        <div class="dstat-lbl">يراجع ويتحقق</div>
      </div>
    </div>
    <div class="chat-box" id="chatBox"></div>
    <div id="agentStatus" style="font-size:.8rem;color:var(--text3);min-height:20px;margin-bottom:8px"></div>
    <div class="chat-input-row">
      <textarea id="chatInput" class="form-control" rows="2" placeholder="مثال: أضف أمر /ping يرد بـ pong  |  Ctrl+Enter للإرسال" style="font-size:.88rem"></textarea>
      <div class="chat-input-btns">
        <button class="btn btn-primary" onclick="sendToAgents()" style="padding:10px 16px">🚀 إرسال</button>
        <button class="btn btn-outline btn-sm" onclick="clearChat('agents')">🗑️ مسح</button>
        <button class="btn btn-success btn-sm" onclick="applyFromChat()" title="حفظ الكود الأخير من المحادثة في ملف">💾 تطبيق</button>
      </div>
    </div>
  </div>

  <!-- ─────────── TAB: Claude ─────────── -->
  <div class="chat-panel" id="tab-claude">
    <div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:10px;margin-bottom:12px;font-size:.82rem;color:var(--text2)">
      🤖 <strong style="color:#fbbf24">Claude AI</strong> — ممتاز للشرح المفصّل، الكود المعقد، والأسئلة البرمجية العامة.
    </div>
    <div class="chat-box" id="claudeBox"></div>
    <div class="chat-input-row" style="margin-top:8px">
      <textarea id="claudeInput" class="form-control" rows="2" placeholder="اسأل Claude أي سؤال عن البوت أو البرمجة..." style="border-color:rgba(245,158,11,.3)"></textarea>
      <div class="chat-input-btns">
        <button class="btn btn-yellow" onclick="sendToClaude()" style="padding:10px 14px">🤖 إرسال</button>
        <button class="btn btn-outline btn-sm" onclick="clearChat('claude')">🗑️ مسح</button>
        <button class="btn btn-success btn-sm" onclick="applyFromChat()">💾 تطبيق</button>
      </div>
    </div>
  </div>

  <!-- ─────────── TAB: سريع ─────────── -->
  <div class="chat-panel" id="tab-quick">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
      <div style="background:var(--bg3);border:1px solid rgba(59,130,246,.2);border-radius:8px;padding:10px;text-align:center;cursor:pointer" onclick="setQuickModel('openai')">
        <div style="font-size:1.1rem">🔍</div>
        <div style="font-size:.8rem;font-weight:700;color:#60a5fa" id="qm-openai">OpenAI</div>
      </div>
      <div style="background:var(--bg3);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:10px;text-align:center;cursor:pointer" onclick="setQuickModel('claude')">
        <div style="font-size:1.1rem">🤖</div>
        <div style="font-size:.8rem;font-weight:700;color:#fbbf24">Claude</div>
      </div>
    </div>
    <div class="chat-box" id="quickBox"></div>
    <div class="chat-input-row" style="margin-top:8px">
      <textarea id="quickInput" class="form-control" rows="2" placeholder="سؤال سريع..."></textarea>
      <div class="chat-input-btns">
        <button class="btn btn-primary" onclick="sendQuick()" style="padding:10px 16px">⚡ إرسال</button>
        <button class="btn btn-outline btn-sm" onclick="clearChat('quick')">🗑️ مسح</button>
      </div>
    </div>
    <div style="font-size:.75rem;color:var(--text3);margin-top:6px">النموذج: <span id="quickModelDisplay" style="color:var(--accent2)">OpenAI</span></div>
  </div>

  <!-- ─────────── TAB: مرشد المبتدئين ─────────── -->
  <div class="chat-panel" id="tab-guide">
    <div style="background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.25);border-radius:8px;padding:12px;margin-bottom:12px;font-size:.84rem;color:var(--text2)">
      📚 <strong style="color:var(--green)">مرشد المبتدئين</strong> — يشرح بلغة بسيطة لمن لا يعرف البرمجة. اسأله أي شيء!
    </div>
    <div class="quick-actions" style="margin-bottom:12px">
      <button class="qa-btn" onclick="guideAction('ما هو البوت وكيف يعمل؟')">❓ ما هو البوت؟</button>
      <button class="qa-btn" onclick="guideAction('كيف أضيف أمراً جديداً للبوت بدون معرفة برمجة؟')">➕ كيف أضيف أمر؟</button>
      <button class="qa-btn" onclick="guideAction('ما معنى البريفيكس وكيف أغيره؟')">🔑 ما هو البريفيكس؟</button>
      <button class="qa-btn" onclick="guideAction('كيف أجعل أحداً مشرفاً في البوت؟')">👑 كيف أضيف أدمن؟</button>
      <button class="qa-btn" onclick="guideAction('البوت لا يشتغل ماذا أفعل؟')">🆘 البوت لا يشتغل</button>
      <button class="qa-btn" onclick="guideAction('كيف أنشر البوت على الإنترنت؟')">🌐 كيف أنشر البوت؟</button>
    </div>
    <div class="chat-box" id="guideBox"></div>
    <div class="chat-input-row" style="margin-top:8px">
      <textarea id="guideInput" class="form-control" rows="2" placeholder="اسأل أي سؤال... لا داعي لمعرفة البرمجة 😊" style="border-color:rgba(16,185,129,.3)"></textarea>
      <div class="chat-input-btns">
        <button class="btn btn-success" onclick="sendToGuide()" style="padding:10px 14px">📚 اسأل</button>
        <button class="btn btn-outline btn-sm" onclick="clearChat('guide')">🗑️</button>
      </div>
    </div>
  </div>

  <!-- ─────────── TAB: مستشار البوت ─────────── -->
  <div class="chat-panel" id="tab-advisor">
    <div style="background:rgba(167,139,250,.07);border:1px solid rgba(167,139,250,.3);border-radius:8px;padding:12px;margin-bottom:12px;font-size:.84rem;color:var(--text2)">
      💡 <strong style="color:#a78bfa">مستشار البوت</strong> — يقرأ ملفات بوتك ويجيبك على أسئلتك ويقترح أفكاراً وتحديثات.
      <span style="display:block;margin-top:4px;font-size:.76rem;color:var(--text3)">🔒 للقراءة فقط — لا يعدّل أي ملف، فقط يستشير ويقترح.</span>
    </div>
    <!-- Advisor Quick Prompts -->
    <div class="quick-actions" style="margin-bottom:12px">
      <button class="qa-btn" onclick="advisorAction('ما هي أوامر البوت الموجودة وماذا تفعل؟')">📋 أوامر البوت</button>
      <button class="qa-btn" onclick="advisorAction('اقترح لي 5 ميزات جديدة يمكن إضافتها للبوت')">💡 أفكار جديدة</button>
      <button class="qa-btn" onclick="advisorAction('ما هي نقاط ضعف البوت الحالي وكيف أحسّنه؟')">🔍 نقاط التحسين</button>
      <button class="qa-btn" onclick="advisorAction('اشرح لي كيف يعمل نظام الأحداث events في البوت')">⚡ شرح الأحداث</button>
      <button class="qa-btn" onclick="advisorAction('ما هو الفرق بين الأوامر والأحداث في البوت؟')">❓ أوامر vs أحداث</button>
      <button class="qa-btn" onclick="advisorAction('كيف أجعل البوت أسرع وأكثر كفاءة؟')">🚀 تحسين الأداء</button>
      <button class="qa-btn" onclick="advisorAction('اقترح أوامر مسلية يحبها المستخدمون في الجروبات')">🎮 أوامر مسلية</button>
      <button class="qa-btn" onclick="advisorAction('كيف أضيف ردوداً تلقائية على كلمات معينة؟')">🤖 ردود تلقائية</button>
    </div>
    <div class="chat-box" id="advisorBox"></div>
    <div class="chat-input-row" style="margin-top:8px">
      <textarea id="advisorInput" class="form-control" rows="2" placeholder="اسأل عن بوتك أو اطلب فكرة أو تحديث... | Ctrl+Enter للإرسال" style="border-color:rgba(167,139,250,.3)"></textarea>
      <div class="chat-input-btns">
        <button class="btn" onclick="sendToAdvisor()" style="padding:10px 14px;background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;border:none;border-radius:8px;font-family:'Cairo',sans-serif;font-weight:700;cursor:pointer">💡 استشر</button>
        <button class="btn btn-outline btn-sm" onclick="clearChat('advisor')">🗑️</button>
      </div>
    </div>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════════════════ -->
<!-- ── FILE MANAGER ── -->
<!-- ════════════════════════════════════════════════════════════════════════ -->
<div class="card">
  <div class="card-header">
    <div class="card-title">📂 مدير الملفات</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-outline btn-sm" onclick="refreshFileTree()">🔄</button>
      <button class="btn btn-success btn-sm" onclick="saveEditedFile()">💾 حفظ</button>
    </div>
  </div>

  <!-- Mobile tabs for file manager -->
  <div class="fm-tabs">
    <button class="fm-tab-btn active" id="fmTreeTab" onclick="switchFmTab('tree')">📂 الملفات</button>
    <button class="fm-tab-btn" id="fmEditorTab" onclick="switchFmTab('editor')">✏️ المحرر</button>
  </div>

  <div class="fm-grid" style="display:grid;grid-template-columns:260px 1fr;gap:14px;margin-top:10px">
    <!-- File Tree -->
    <div class="fm-tree-col fm-visible">
      <input type="text" id="fileSearch" class="form-control" placeholder="🔍 ابحث عن ملف..." style="margin-bottom:8px;font-size:.83rem" oninput="filterFiles(this.value)"/>
      <div class="file-tree" id="fileTree">
        <div style="color:var(--text3);font-size:.8rem">جارٍ التحميل...</div>
      </div>
    </div>
    <!-- File Editor -->
    <div class="fm-editor-col">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px">
        <div style="font-size:.8rem;color:var(--text2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px" id="editorFilePath">لم يتم اختيار ملف</div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          <button class="btn btn-outline btn-sm" onclick="analyzeFileWithAI()">🤖 AI</button>
          <button class="btn btn-outline btn-sm" onclick="sendFileToAgents()">🚀 وكلاء</button>
        </div>
      </div>
      <textarea class="code-editor" id="fileEditor" placeholder="اختر ملفاً لتعديله..." rows="14"></textarea>
    </div>
  </div>
  <div id="fileEditorStatus" style="margin-top:8px;font-size:.82rem"></div>
</div>

<!-- ════════════════════════════════════════════════════════════════════════ -->
<!-- ── UPLOAD ── -->
<!-- ════════════════════════════════════════════════════════════════════════ -->
<div class="card" style="border-color:rgba(16,185,129,.35)">
  <div class="card-header">
    <div class="card-title" style="color:var(--green)">📤 رفع ملفات للبوت</div>
    <span class="badge badge-green">zip • js • json • txt • md • yaml</span>
  </div>
  <p style="color:var(--text3);font-size:.83rem;margin-bottom:14px">
    ارفع أوامر جاهزة، ملفات ZIP، أو أي ملف. يمكن إرسال الملف مباشرة للذكاء الاصطناعي ليحلله ويعدّل عليه.
  </p>

  <div class="upload-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
    <!-- Drop Zone -->
    <div>
      <div class="drop-zone" id="dropZone" ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event)">
        <input type="file" id="uploadFileInput" accept=".js,.json,.txt,.md,.zip,.yaml,.yml,.sh,.env,.py,.html,.css" onchange="uploadFile(this.files[0])"/>
        <div style="font-size:2rem;margin-bottom:8px">📂</div>
        <div style="font-size:.88rem;font-weight:700;color:var(--text)">اسحب الملف هنا أو اضغط للاختيار</div>
        <div style="font-size:.76rem;color:var(--text3);margin-top:6px">.js .json .zip .txt .md .yaml .sh .html .css .py</div>
        <div style="font-size:.75rem;color:var(--text3);margin-top:4px">حجم أقصى: 20MB</div>
      </div>
    </div>

    <!-- Upload Options -->
    <div>
      <div class="form-group">
        <label class="form-label">📁 المجلد الهدف</label>
        <select id="uploadTargetDir" class="form-control">
          <option value="scripts/cmds">scripts/cmds — أوامر البوت</option>
          <option value="scripts/events">scripts/events — أحداث البوت</option>
          <option value="bot">bot — مكونات البوت</option>
          <option value="">الجذر (root)</option>
          <option value="func">func — وظائف مساعدة</option>
        </select>
      </div>
      <div class="form-group" style="margin-top:10px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="analyzeAfterUpload" checked style="width:16px;height:16px"/>
          <span style="font-size:.84rem;color:var(--text2)">🤖 تحليل بالذكاء الاصطناعي بعد الرفع</span>
        </label>
      </div>
      <div class="form-group" style="margin-top:8px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="sendZipToAgents" checked style="width:16px;height:16px"/>
          <span style="font-size:.84rem;color:var(--text2)">🚀 إرسال محتوى ZIP للوكلاء تلقائياً</span>
        </label>
      </div>
    </div>
  </div>

  <div id="uploadStatus" style="margin-top:12px;font-size:.85rem"></div>
  <div id="uploadedFilesList" style="margin-top:10px"></div>
</div>

<!-- ════════════════════════════════════════════════════════════════════════ -->
<!-- ── GITHUB SETTINGS ── -->
<!-- ════════════════════════════════════════════════════════════════════════ -->
<div class="card" id="sec-github">
  <div class="card-header">
    <div class="card-title">🐙 إعداد GitHub</div>
    <span class="badge ${hasToken ? "badge-green" : "badge-red"}" id="ghBadge">${hasToken ? "✅ موصول" : "❌ بحاجة توكن"}</span>
  </div>

  <!-- STEP 1: Token -->
  <div style="background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <div style="width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#6366f1);display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:800;color:#fff;flex-shrink:0">1</div>
      <div style="font-weight:700;font-size:.9rem">أدخل توكن GitHub</div>
      <a href="https://github.com/settings/tokens/new?scopes=repo,delete_repo&description=WHITE-V3-Panel" target="_blank" style="margin-right:auto;font-size:.75rem;color:#60a5fa;background:rgba(59,130,246,.1);padding:3px 8px;border-radius:6px;text-decoration:none">+ إنشاء توكن</a>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <div style="position:relative;flex:1">
        <input type="password" id="ghToken" class="form-control" value="${hasToken ? "••••••••••••••••" : ""}" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" style="padding-left:40px"/>
        <button onclick="document.getElementById('ghToken').type=document.getElementById('ghToken').type==='password'?'text':'password'" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text3);font-size:.9rem;padding:0">👁️</button>
      </div>
      <button class="btn btn-primary" onclick="saveGhConfig()" style="flex-shrink:0;white-space:nowrap">💾 حفظ وتحقق</button>
    </div>
    <div style="font-size:.73rem;margin-top:6px;color:var(--text3)">
      ${process.env.GITHUB_TOKEN ? `✅ محمّل من متغيرات البيئة`
        : loadCfg().githubTokenEnc ? `⚠️ محفوظ — أعد الإدخال لتحديثه`
        : `الصلاحيات المطلوبة: <code style="color:#60a5fa">repo</code> + <code style="color:#60a5fa">delete_repo</code>`}
    </div>
    <div id="ghVerifyStatus" style="margin-top:8px;font-size:.84rem;font-weight:600"></div>
  </div>

  <!-- STEP 2: Choose Base Repo -->
  <div style="background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <div style="width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#10b981,#059669);display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:800;color:#fff;flex-shrink:0">2</div>
      <div style="font-weight:700;font-size:.9rem">اختر ريبو البوت الأساسي</div>
      <button class="btn btn-outline btn-sm" onclick="listMyRepos()" style="margin-right:auto;font-size:.75rem">🔄 تحميل ريبوهاتي</button>
    </div>
    <div style="background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.2);border-radius:8px;padding:10px;margin-bottom:10px;font-size:.82rem">
      📌 الريبو الحالي: <strong style="color:#6ee7b7" id="currentBaseRepoDisplay">${loadCfg().baseRepo || "غير محدد"}</strong>
      &nbsp;•&nbsp; المالك: <strong style="color:#6ee7b7" id="currentOwnerDisplay">${loadCfg().baseOwner || "غير محدد"}</strong>
    </div>
    <div id="repoPickerGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;max-height:280px;overflow-y:auto;margin-bottom:10px">
      <div style="text-align:center;color:var(--text3);font-size:.83rem;padding:20px;grid-column:1/-1">
        💡 اضغط "تحميل ريبوهاتي" لعرض ريبوهاتك واختيار الريبو الأساسي
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <div style="flex:1;min-width:140px">
        <label class="form-label" style="font-size:.77rem">أو أدخل يدوياً — المالك</label>
        <input type="text" id="ghOwner" class="form-control" value="${loadCfg().baseOwner || ""}" placeholder="castrolmocro" style="font-size:.83rem"/>
      </div>
      <div style="flex:1;min-width:140px">
        <label class="form-label" style="font-size:.77rem">اسم الريبو</label>
        <input type="text" id="ghBaseRepo" class="form-control" value="${loadCfg().baseRepo || ""}" placeholder="WHITE-V3" style="font-size:.83rem"/>
      </div>
      <div style="display:flex;align-items:flex-end">
        <button class="btn btn-success btn-sm" onclick="saveBaseRepo()">✅ تعيين كريبو أساسي</button>
      </div>
    </div>
  </div>

  <!-- STEP 3: Other Settings -->
  <div style="background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:16px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <div style="width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#d97706);display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:800;color:#fff;flex-shrink:0">3</div>
      <div style="font-weight:700;font-size:.9rem">إعدادات إضافية</div>
    </div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">🚂 Railway Webhook (اختياري)</label>
        <input type="text" id="railwayWebhook" class="form-control" value="${loadCfg().railwayWebhook || ""}" placeholder="https://backboard.railway.app/webhook/..."/>
      </div>
      <div class="form-group">
        <label class="form-label">🔌 بورت البانل (الحالي: ${_savedPort})</label>
        <div style="display:flex;gap:8px">
          <input type="number" id="panelPort" class="form-control" value="${_savedPort}" min="1024" max="65535"/>
          <button class="btn btn-outline btn-sm" onclick="savePort()" style="flex-shrink:0">حفظ</button>
        </div>
      </div>
    </div>
    <div class="btn-row" style="margin-top:8px">
      <button class="btn btn-outline btn-sm" onclick="saveRailwayWebhookVal()">💾 حفظ Railway Webhook</button>
    </div>
  </div>
</div>

<!-- ── Push ALL ── -->
<div class="card" style="border-color:rgba(16,185,129,.4)">
  <div class="card-header">
    <div class="card-title" style="color:var(--green)">🚀 رفع كل الكود لـ GitHub</div>
    <span class="badge badge-green">git push --force</span>
  </div>
  <div class="form-grid">
    <div class="form-group">
      <label class="form-label">📁 الريبو</label>
      <input type="text" id="pushAllRepo" class="form-control" value="${loadCfg().baseRepo || "New-white-e2ee-v2"}"/>
    </div>
    <div class="form-group">
      <label class="form-label">👤 المالك</label>
      <input type="text" id="pushAllOwner" class="form-control" value="${loadCfg().baseOwner || "castrolmocro"}"/>
    </div>
    <div class="form-group">
      <label class="form-label">🌿 الفرع</label>
      <input type="text" id="pushAllBranch" class="form-control" value="main"/>
    </div>
    <div class="form-group">
      <label class="form-label">💬 رسالة الـ Commit</label>
      <input type="text" id="pushAllMsg" class="form-control" value="🚀 تحديث من WHITE V3 Panel"/>
    </div>
  </div>
  <div class="btn-row">
    <button class="btn btn-success" style="font-size:.95rem;padding:11px 24px" onclick="pushAllToGithub()">🚀 رفع كل الكود</button>
    <button class="btn btn-primary" style="background:rgba(139,92,246,.9)" onclick="pushAllAndMakePrivate()">🔒 رفع + خاص</button>
    <button class="btn btn-yellow" onclick="pushAllThenRailway()">🚀🚂 رفع + Railway</button>
  </div>
  <div id="pushAllStatus" style="margin-top:10px"></div>
</div>

<!-- ── Repo Management ── -->
<div class="card">
  <div class="card-header">
    <div class="card-title">⚙️ إدارة الريبوهات</div>
    <button class="btn btn-outline btn-sm" onclick="refreshRepos()">🔄 تحديث</button>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:12px" class="two-col-grid">
    <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px">
      <div style="font-weight:700;margin-bottom:10px">🔒 خصوصية الريبو</div>
      <input type="text" id="visRepo" class="form-control" placeholder="اسم الريبو" style="margin-bottom:8px"/>
      <div class="btn-row" style="margin:0">
        <button class="btn btn-outline btn-sm" onclick="setRepoVisibility(true)">🔒 خاص</button>
        <button class="btn btn-outline btn-sm" onclick="setRepoVisibility(false)">🌐 عام</button>
      </div>
      <div id="visStatus" style="margin-top:8px;font-size:.8rem"></div>
    </div>
    <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px">
      <div style="font-weight:700;margin-bottom:10px">🆕 إنشاء ريبو جديد</div>
      <input type="text" id="newRepoName" class="form-control" placeholder="اسم الريبو الجديد" style="margin-bottom:8px"/>
      <button class="btn btn-success btn-sm" onclick="createNewRepo()">➕ إنشاء</button>
    </div>
  </div>
  <div id="repoList"></div>
</div>

<!-- ── Versions ── -->
<div class="card" id="sec-versions">
  <div class="card-header">
    <div class="card-title">📦 سجل الإصدارات</div>
    <button class="btn btn-outline btn-sm" onclick="loadVersionsTable()">🔄 تحديث</button>
  </div>
  <div style="overflow-x:auto">
    <table class="table" id="versionsTable">
      <thead><tr><th>الفرع/الريبو</th><th>التاريخ</th><th>الحالة</th><th>رابط</th></tr></thead>
      <tbody>${versionRows}</tbody>
    </table>
  </div>
</div>

<!-- ── Apply & Push (selected files) ── -->
<div class="card">
  <div class="card-header">
    <div class="card-title">🛠️ رفع ملفات محددة</div>
  </div>
  <div class="form-grid">
    <div class="form-group">
      <label class="form-label">اسم الإصدار / الفرع</label>
      <input type="text" id="updateName" class="form-control" placeholder="update-feature-x" value="update-${Date.now()}"/>
    </div>
    <div class="form-group">
      <label class="form-label">رسالة الـ commit</label>
      <input type="text" id="commitMsg" class="form-control" value="🤖 Auto-update by DevHub"/>
    </div>
  </div>
  <div class="form-group">
    <label class="form-label">الملفات المراد رفعها</label>
    <select id="pushFileSelect" class="form-control" multiple style="height:100px">
      ${groupedOptions}
    </select>
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" onclick="applyAndPush('branch')">📤 رفع لفرع جديد</button>
    <button class="btn btn-outline" onclick="applyAndPush('repo')">📦 رفع لريبو جديد</button>
  </div>
  <div id="pushStatus" style="margin-top:10px"></div>
</div>

<!-- ════════════════════════════════════════════════════════════════════════ -->
<!-- ── SMART DEPLOY ── -->
<!-- ════════════════════════════════════════════════════════════════════════ -->
<div class="card" id="sec-smart-deploy" style="border-color:rgba(16,185,129,.5)">
  <div class="card-header">
    <div class="card-title" style="color:var(--green)">🚀 النشر الذكي</div>
    <span class="badge badge-green">Auto Rollback</span>
  </div>
  <div style="background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.2);border-radius:10px;padding:12px;margin-bottom:14px;font-size:.82rem;color:var(--text2)">
    كل تحديث يُنشر في ريبو جديد منفصل. الريبو الأصلي محمي. عند مشكلة اضغط <strong>Rollback</strong> للعودة.
  </div>

  <div class="form-grid">
    <div class="form-group">
      <label class="form-label">🔑 Railway API Token</label>
      <input type="password" id="sdRailwayToken" class="form-control" value="${loadCfg().railwayApiToken ? "••••••••••••••••" : ""}" placeholder="railway_... (اختياري)"/>
    </div>
    <div class="form-group">
      <label class="form-label">📁 الريبو الأصلي</label>
      <input type="text" id="sdBaseRepo" class="form-control" value="${loadCfg().baseRepo || "New-white-e2ee-v2"}"/>
    </div>
    <div class="form-group">
      <label class="form-label">📊 أقصى إصدارات</label>
      <input type="number" id="sdMaxKeep" class="form-control" value="${loadCfg().maxUpdateRepos || 5}" min="2" max="20"/>
    </div>
    <div class="form-group">
      <label class="form-label">🪝 Railway Webhook</label>
      <input type="text" id="sdWebhook" class="form-control" value="${loadCfg().railwayWebhook || ""}"/>
    </div>
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" onclick="saveSmartDeployConfig()">💾 حفظ إعداد النشر</button>
    <button class="btn btn-outline" onclick="loadRailwayProjects()">📋 مشاريع Railway</button>
  </div>
  <div id="sdProjectsBox" style="margin-top:10px"></div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0" class="two-col-grid">
    <div style="background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:12px">
      <div style="font-size:.73rem;color:var(--text3)">⛔ الريبو الأصلي (محمي)</div>
      <div id="sdBaseRepoDisplay" style="font-weight:700;color:#f87171;margin-top:4px">📁 ${loadCfg().baseRepo || "—"}</div>
    </div>
    <div style="background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.2);border-radius:8px;padding:12px">
      <div style="font-size:.73rem;color:var(--text3)">✅ الإصدار النشط</div>
      <div id="sdActiveDisplay" style="font-weight:700;color:var(--green);margin-top:4px">—</div>
      <div id="sdActiveDate" style="font-size:.72rem;color:var(--text3)">—</div>
    </div>
  </div>

  <div style="background:var(--bg3);border:1px solid rgba(16,185,129,.3);border-radius:10px;padding:14px;margin-bottom:14px">
    <div style="font-weight:700;margin-bottom:10px">📦 إنشاء تحديث جديد</div>
    <div class="form-grid">
      <div class="form-group">
        <input type="text" id="sdCommitMsg" class="form-control" value="🚀 تحديث من WHITE V3 Panel" placeholder="رسالة التحديث"/>
      </div>
      <div class="form-group" style="display:flex;flex-direction:column;gap:8px;justify-content:center">
        <label style="display:flex;align-items:center;gap:6px;font-size:.83rem;cursor:pointer">
          <input type="checkbox" id="sdMakePrivate" checked/> ريبو خاص
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:.83rem;cursor:pointer">
          <input type="checkbox" id="sdAutoCleanup" checked/> حذف القديم تلقائياً
        </label>
      </div>
    </div>
    <button class="btn btn-success" style="width:100%;padding:12px;font-size:.95rem" onclick="smartDeployCreate()">
      🚀 إنشاء تحديث جديد ونشره
    </button>
    <div id="sdCreateStatus" style="margin-top:10px"></div>
  </div>

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div style="font-weight:700">📋 سجل الإصدارات الذكية</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-outline btn-sm" onclick="loadSmartVersions()">🔄</button>
      <button class="btn btn-outline btn-sm" onclick="smartCleanup()">🗑️ تنظيف</button>
    </div>
  </div>
  <div id="sdVersionsTable"><div style="color:var(--text3);text-align:center;padding:16px;font-size:.85rem">اضغط 🔄 لتحميل الإصدارات</div></div>
</div>

<!-- ════════════════════════════════════════════════════════════════════════ -->
<!-- ── JAVASCRIPT ── -->
<!-- ════════════════════════════════════════════════════════════════════════ -->
<script>
// ── State ──────────────────────────────────────────────────────────────────────
let chatHistory    = [];
let claudeHistory  = [];
let quickHistory   = [];
let guideHistory   = [];
let advisorHistory = [];
let lastAgentCode  = "";
let activeTab      = "agents";
let selectedEditFile = null;
let quickModel     = "openai";
let allFiles       = [];

// ── Helpers ────────────────────────────────────────────────────────────────────
async function api(url, body) {
  const r = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
  return await r.json();
}
function showToast(msg, type="info") {
  const t = document.createElement("div");
  const colors = { success:"rgba(16,185,129,.9)", error:"rgba(239,68,68,.9)", info:"rgba(59,130,246,.9)" };
  t.style.cssText = \`position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:\${colors[type]||colors.info};color:#fff;padding:10px 22px;border-radius:24px;font-size:.88rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);font-family:'Cairo',sans-serif;white-space:nowrap\`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Tab Switching ──────────────────────────────────────────────────────────────
function switchTab(tab, btn) {
  document.querySelectorAll(".chat-tab").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".chat-panel").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("tab-" + tab).classList.add("active");
  activeTab = tab;
}

// ── Quick Actions ──────────────────────────────────────────────────────────────
function quickAction(text) {
  document.getElementById("chatInput").value = text;
  if (activeTab !== "agents") {
    const firstTab = document.querySelector('.chat-tab');
    if (firstTab) firstTab.click();
  }
  sendToAgents();
}
function guideAction(text) {
  document.getElementById("guideInput").value = text;
  sendToGuide();
}
function setQuickModel(m) {
  quickModel = m;
  document.getElementById("quickModelDisplay").textContent = m === "claude" ? "Claude" : "OpenAI";
}

// ── Auto Context ───────────────────────────────────────────────────────────────
async function getAutoContext() {
  if (!document.getElementById("autoCtxToggle").checked) return null;
  try {
    const r = await fetch("/api/devhub/bot/context");
    const d = await r.json();
    return d.context || null;
  } catch(_) { return null; }
}

// ── Message Rendering ──────────────────────────────────────────────────────────
function appendMsg(boxId, who, icon, color, content) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const div = document.createElement("div");
  div.style.cssText = "margin-bottom:14px;padding:12px 14px;border-radius:10px;background:var(--bg3);border:1px solid var(--border)";
  const header = \`<div style="font-size:.78rem;font-weight:700;color:\${color};margin-bottom:7px">\${icon} \${who}</div>\`;
  const formatted = content
    .replace(/\`\`\`(\\w+)?\\n?([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
      if (code.trim()) {
        lastAgentCode = code.trim();
        return \`<pre style="background:#010409;border:1px solid #1e2d45;border-radius:8px;padding:12px;font-size:.74rem;overflow-x:auto;white-space:pre-wrap;color:#c9d1d9;margin:8px 0">\${code.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre><button class="btn btn-outline btn-sm" style="font-size:.72rem;margin-bottom:6px" onclick="copyCode(this)">📋 نسخ الكود</button>\`;
      }
      return _;
    })
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\n/g, "<br/>");
  div.innerHTML = header + \`<div style="color:var(--text);line-height:1.75">\${formatted}</div>\`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function appendUserMsg(boxId, msg) {
  appendMsg(boxId, "أنت", "👤", "#94a3b8", msg.replace(/</g,'&lt;').replace(/>/g,'&gt;'));
}

function appendThinking(boxId, label) {
  const box = document.getElementById(boxId);
  const div = document.createElement("div");
  div.className = "thinking-indicator";
  div.style.cssText = "margin-bottom:12px;padding:12px;border-radius:10px;background:var(--bg3);border:1px solid var(--border);color:var(--text3);font-size:.84rem;animation:pulse 1.5s infinite";
  div.innerHTML = \`\${label} يفكر...\`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function removeThinking(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

function copyCode(btn) {
  const pre = btn.previousElementSibling;
  navigator.clipboard.writeText(pre.innerText).then(() => {
    btn.textContent = "✅ تم النسخ";
    setTimeout(() => btn.textContent = "📋 نسخ الكود", 2000);
  });
}

function clearChat(target) {
  const map = { agents:"chatBox", claude:"claudeBox", quick:"quickBox", guide:"guideBox", advisor:"advisorBox" };
  const boxId = map[target];
  if (boxId) document.getElementById(boxId).innerHTML = "";
  if (target === "agents") { chatHistory = []; lastAgentCode = ""; }
  if (target === "claude") claudeHistory = [];
  if (target === "quick") quickHistory = [];
  if (target === "guide") guideHistory = [];
  if (target === "advisor") advisorHistory = [];
  fetch("/api/devhub/chat/clear",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({target})});
}

// ── File Context ───────────────────────────────────────────────────────────────
function getSelectedFiles() {
  return Array.from(document.getElementById("fileSelect").selectedOptions).map(o => o.value);
}
function selectAll() { Array.from(document.getElementById("fileSelect").options).forEach(o => o.selected = true); }
function clearSelect() { Array.from(document.getElementById("fileSelect").options).forEach(o => o.selected = false); }
async function previewSelectedFile() {
  const files = getSelectedFiles();
  if (!files.length) return showToast("اختر ملفاً أولاً","error");
  const r = await api("/api/devhub/file", {path: files[0]});
  const area = document.getElementById("filePreviewArea");
  area.style.display = "block";
  document.getElementById("filePreview").textContent = r.content || r.error || "لا يوجد محتوى";
}

async function buildFileContexts(maxFiles = 5) {
  const files = getSelectedFiles();
  const ctxs = [];
  for (const f of files.slice(0, maxFiles)) {
    try {
      const r = await api("/api/devhub/file", {path: f});
      if (r.content) ctxs.push({path: f, content: r.content.slice(0, 6000)});
    } catch(_) {}
  }
  return ctxs;
}

// ── Send to Agents ─────────────────────────────────────────────────────────────
async function sendToAgents() {
  const input = document.getElementById("chatInput");
  const msg = input.value.trim();
  if (!msg) return showToast("اكتب طلبك أولاً","error");
  input.value = "";
  appendUserMsg("chatBox", msg);
  chatHistory.push({role:"user", content: msg});

  const statusEl = document.getElementById("agentStatus");
  statusEl.innerHTML = "⏳ جارٍ تحضير السياق...";

  const [autoCtx, fileContexts] = await Promise.all([getAutoContext(), buildFileContexts(4)]);
  statusEl.innerHTML = "🔍 المحلل يعمل...";
  const thk = appendThinking("chatBox", "🔍 المحلل");

  try {
    const r = await fetch("/api/devhub/ai/pipeline", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ message: msg, files: fileContexts, history: chatHistory.slice(-8), autoCtx })
    });
    removeThinking(thk);
    const data = await r.json();
    statusEl.innerHTML = "";
    if (data.steps) {
      for (const step of data.steps) {
        appendMsg("chatBox", step.icon + " " + step.name, "", step.color || "#60a5fa", step.reply);
        chatHistory.push({role:"assistant", content:"["+step.name+"]: "+step.reply});
      }
    } else {
      appendMsg("chatBox","🤖 AI","","#60a5fa", data.error || "لا يوجد رد");
    }
  } catch(e) {
    removeThinking(thk);
    statusEl.innerHTML = "";
    appendMsg("chatBox","❌ خطأ","","#f87171", e.message);
  }
}

// ── Send to Claude ─────────────────────────────────────────────────────────────
async function sendToClaude() {
  const inp = document.getElementById("claudeInput");
  const msg = inp.value.trim();
  if (!msg) return showToast("اكتب سؤالك أولاً","error");
  inp.value = "";
  appendUserMsg("claudeBox", msg);
  claudeHistory.push({role:"user", content: msg});
  const thk = appendThinking("claudeBox", "🤖 Claude");

  const [autoCtx, fileContexts] = await Promise.all([getAutoContext(), buildFileContexts(3)]);

  const r = await fetch("/api/devhub/ai/single", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ model:"claude", message: msg, files: fileContexts, history: claudeHistory.slice(-8), autoCtx })
  });
  removeThinking(thk);
  const data = await r.json();
  if (data.ok) {
    claudeHistory.push({role:"assistant", content: data.reply});
    appendMsg("claudeBox","Claude AI","🤖","#fbbf24", data.reply);
  } else {
    appendMsg("claudeBox","❌ خطأ","","#f87171", data.error || "فشل الاتصال");
  }
}

// ── Send Quick ─────────────────────────────────────────────────────────────────
async function sendQuick() {
  const inp = document.getElementById("quickInput");
  const msg = inp.value.trim();
  if (!msg) return showToast("اكتب سؤالك أولاً","error");
  inp.value = "";
  appendUserMsg("quickBox", msg);
  quickHistory.push({role:"user", content: msg});
  const thk = appendThinking("quickBox", "⚡ AI");

  const [autoCtx, fileContexts] = await Promise.all([getAutoContext(), buildFileContexts(2)]);

  const r = await fetch("/api/devhub/ai/single", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ model: quickModel, message: msg, files: fileContexts, history: quickHistory.slice(-6), autoCtx })
  });
  removeThinking(thk);
  const data = await r.json();
  const reply = data.reply || data.error || "لا يوجد رد";
  quickHistory.push({role:"assistant", content: reply});
  appendMsg("quickBox", quickModel === "claude" ? "🤖 Claude" : "🔍 OpenAI", "", quickModel === "claude" ? "#fbbf24" : "#60a5fa", reply);
}

// ── Send to Advisor (Read-Only Chat) ──────────────────────────────────────────
async function sendToAdvisor() {
  const inp = document.getElementById("advisorInput");
  const msg = inp.value.trim();
  if (!msg) return showToast("اكتب سؤالك أولاً","error");
  inp.value = "";
  appendUserMsg("advisorBox", msg);
  advisorHistory.push({role:"user", content: msg});
  const thk = appendThinking("advisorBox", "💡 المستشار");

  const autoCtx = await getAutoContext();

  try {
    const r = await fetch("/api/devhub/ai/advisor", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ message: msg, history: advisorHistory.slice(-8), autoCtx })
    });
    removeThinking(thk);
    const data = await r.json();
    const reply = data.reply || data.error || "لا يوجد رد";
    advisorHistory.push({role:"assistant", content: reply});
    appendMsg("advisorBox", "💡 مستشار البوت", "", "#a78bfa", reply);
  } catch(e) {
    removeThinking(thk);
    appendMsg("advisorBox","❌ خطأ","","#f87171", e.message);
  }
}

function advisorAction(text) {
  document.getElementById("advisorInput").value = text;
  sendToAdvisor();
}

// ── Send to Guide (Beginner) ───────────────────────────────────────────────────
async function sendToGuide() {
  const inp = document.getElementById("guideInput");
  const msg = inp.value.trim();
  if (!msg) return showToast("اكتب سؤالك أولاً","error");
  inp.value = "";
  appendUserMsg("guideBox", msg);
  guideHistory.push({role:"user", content: msg});
  const thk = appendThinking("guideBox", "📚 المرشد");

  const autoCtx = await getAutoContext();

  const r = await fetch("/api/devhub/ai/guide", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ message: msg, history: guideHistory.slice(-6), autoCtx })
  });
  removeThinking(thk);
  const data = await r.json();
  const reply = data.reply || data.error || "لا يوجد رد";
  guideHistory.push({role:"assistant", content: reply});
  appendMsg("guideBox", "📚 المرشد", "", "#6ee7b7", reply);
}

// ── File Manager Mobile Tab Switch ────────────────────────────────────────────
function switchFmTab(tab) {
  const treeCol = document.querySelector(".fm-tree-col");
  const editorCol = document.querySelector(".fm-editor-col");
  const treeBtn = document.getElementById("fmTreeTab");
  const editorBtn = document.getElementById("fmEditorTab");
  if (tab === "tree") {
    treeCol.classList.add("fm-visible"); treeCol.classList.remove("fm-hidden");
    editorCol.classList.remove("fm-visible");
    treeBtn.classList.add("active"); editorBtn.classList.remove("active");
  } else {
    editorCol.classList.add("fm-visible");
    treeCol.classList.remove("fm-visible");
    treeBtn.classList.remove("active"); editorBtn.classList.add("active");
  }
}

// ── File Tree ──────────────────────────────────────────────────────────────────
async function refreshFileTree() {
  const treeEl = document.getElementById("fileTree");
  treeEl.innerHTML = '<div style="color:var(--text3);padding:8px">جارٍ التحميل...</div>';
  const r = await fetch("/api/devhub/file/tree");
  const data = await r.json();
  if (!data.files) { treeEl.innerHTML = '<div style="color:var(--red)">فشل التحميل</div>'; return; }
  allFiles = data.files;
  renderFileTree(allFiles);
}

function renderFileTree(files) {
  const treeEl = document.getElementById("fileTree");
  const dirs = {};
  for (const f of files) {
    const parts = f.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "root";
    if (!dirs[dir]) dirs[dir] = [];
    dirs[dir].push(f);
  }
  let html = "";
  for (const [dir, fs_] of Object.entries(dirs)) {
    html += \`<div class="ft-dir">\${dir === "root" ? "📁 الجذر" : "📂 " + dir}</div>\`;
    for (const f of fs_) {
      const name = f.split("/").pop();
      const ext = name.split(".").pop();
      const icons = { js:"🟡", json:"📋", md:"📝", txt:"📄", sh:"⚙️", yaml:"📐", yml:"📐", env:"🔐" };
      html += \`<div class="ft-file" id="ft-\${f.replace(/[\\/\\.]/g,'_')}" onclick="openFileInEditor('\${f}')">\${icons[ext]||"📄"} \${name}</div>\`;
    }
  }
  treeEl.innerHTML = html || '<div style="color:var(--text3)">لا توجد ملفات</div>';
}

function filterFiles(q) {
  if (!allFiles.length) return;
  const filtered = q ? allFiles.filter(f => f.toLowerCase().includes(q.toLowerCase())) : allFiles;
  renderFileTree(filtered);
}

async function openFileInEditor(filePath) {
  // Update selected state
  document.querySelectorAll(".ft-file").forEach(el => el.classList.remove("selected"));
  const el = document.getElementById("ft-" + filePath.replace(/[\\/\\.]/g,'_'));
  if (el) el.classList.add("selected");

  selectedEditFile = filePath;
  document.getElementById("editorFilePath").innerHTML = \`<code style="color:#60a5fa">\${filePath}</code>\`;

  const r = await api("/api/devhub/file", {path: filePath});
  document.getElementById("fileEditor").value = r.content || r.error || "";
  showToast("📂 تم فتح: " + filePath.split("/").pop(), "info");
}

async function saveEditedFile() {
  if (!selectedEditFile) return showToast("اختر ملفاً أولاً","error");
  const content = document.getElementById("fileEditor").value;
  const r = await api("/api/devhub/file/write", {path: selectedEditFile, content});
  if (r.ok) {
    showToast("✅ تم حفظ: " + selectedEditFile.split("/").pop(), "success");
    document.getElementById("fileEditorStatus").innerHTML = \`<span style="color:var(--green)">✅ محفوظ بنجاح — \${new Date().toLocaleTimeString("ar")}</span>\`;
  } else {
    showToast("❌ فشل الحفظ: " + r.error, "error");
    document.getElementById("fileEditorStatus").innerHTML = \`<span style="color:var(--red)">❌ \${r.error}</span>\`;
  }
}

async function analyzeFileWithAI() {
  if (!selectedEditFile) return showToast("افتح ملفاً أولاً","error");
  const content = document.getElementById("fileEditor").value;
  const msg = \`حلّل هذا الملف وأخبرني بما يفعله وأي مشاكل محتملة:\n\nالملف: \${selectedEditFile}\n\n\\\`\\\`\\\`javascript\n\${content.slice(0, 5000)}\n\\\`\\\`\\\`\`;
  document.getElementById("claudeInput").value = msg;
  // Switch to Claude tab
  document.querySelectorAll('.chat-tab')[1].click();
  showToast("تم إرسال الملف لـ Claude للتحليل", "info");
}

async function sendFileToAgents() {
  if (!selectedEditFile) return showToast("افتح ملفاً أولاً","error");
  const content = document.getElementById("fileEditor").value;
  const msg = \`راجع هذا الملف وطوّره إذا لزم:\n\nالملف: \${selectedEditFile}\n\n\\\`\\\`\\\`javascript\n\${content.slice(0, 4000)}\n\\\`\\\`\\\`\`;
  document.getElementById("chatInput").value = msg;
  document.querySelectorAll('.chat-tab')[0].click();
  showToast("تم تحضير الملف للإرسال للوكلاء", "info");
}

// ── Apply from Chat ────────────────────────────────────────────────────────────
function applyFromChat() {
  if (!lastAgentCode) return showToast("لا يوجد كود في المحادثة بعد","error");
  const file = prompt("أدخل مسار الملف لحفظ الكود:\\nمثال: scripts/cmds/newcmd.js");
  if (!file) return;
  fetch("/api/devhub/file/write", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({path: file, content: lastAgentCode})
  }).then(r=>r.json()).then(data => {
    if (data.ok) {
      showToast("✅ تم حفظ الكود في " + file, "success");
      refreshFileTree();
    } else showToast("❌ " + data.error, "error");
  });
}

// ── File Upload ────────────────────────────────────────────────────────────────
function handleDragOver(e) { e.preventDefault(); document.getElementById("dropZone").classList.add("dragover"); }
function handleDragLeave(e) { document.getElementById("dropZone").classList.remove("dragover"); }
function handleDrop(e) {
  e.preventDefault();
  document.getElementById("dropZone").classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
}

async function uploadFile(file) {
  if (!file) return;
  const st = document.getElementById("uploadStatus");
  const targetDir = document.getElementById("uploadTargetDir").value;
  const analyzeAfter = document.getElementById("analyzeAfterUpload").checked;
  const sendZip = document.getElementById("sendZipToAgents").checked;

  st.innerHTML = \`<span style="color:var(--text3)">⏳ جارٍ رفع \${file.name}...</span>\`;

  const fd = new FormData();
  fd.append("file", file);
  fd.append("targetDir", targetDir);

  try {
    const r = await fetch("/api/devhub/upload", { method:"POST", body: fd });
    const data = await r.json();

    if (data.ok) {
      let html = \`<div style="padding:12px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.3);border-radius:10px">
        <div style="color:var(--green);font-weight:700;margin-bottom:8px">✅ \${data.message}</div>\`;

      if (data.files && data.files.length) {
        html += \`<div style="font-size:.8rem;color:var(--text2);margin-bottom:8px">الملفات المستخرجة:</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">\${data.files.map(f =>
            \`<span class="badge badge-blue" style="cursor:pointer;font-size:.73rem" onclick="openFileInEditor('\${f}')">\${f.split("/").pop()}</span>\`
          ).join("")}</div>\`;
      }

      html += \`<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        \${data.path ? \`<button class="btn btn-outline btn-sm" onclick="openFileInEditor('\${data.path}')">📂 فتح في المحرر</button>\` : ""}
        \${(analyzeAfter && data.path) ? \`<button class="btn btn-primary btn-sm" onclick="analyzeUploadedFile('\${data.path}')">🤖 تحليل بالذكاء الاصطناعي</button>\` : ""}
      </div></div>\`;

      st.innerHTML = html;

      // Auto-analyze ZIP content
      if (sendZip && data.files && data.files.length > 0) {
        const fileList = data.files.join("، ");
        document.getElementById("chatInput").value = \`تم رفع ملفات من ZIP: \${fileList}. حللها وأخبرني بما تفعله.\`;
        document.querySelectorAll('.chat-tab')[0].click();
        showToast("📤 تم رفع ZIP وتحضير تحليله", "success");
      } else {
        showToast("✅ تم رفع الملف بنجاح", "success");
      }
      refreshFileTree();
    } else {
      st.innerHTML = \`<span style="color:var(--red)">❌ \${data.error || "فشل الرفع"}</span>\`;
      showToast("❌ " + data.error, "error");
    }
  } catch(e) {
    st.innerHTML = \`<span style="color:var(--red)">❌ خطأ: \${e.message}</span>\`;
  }
}

async function analyzeUploadedFile(filePath) {
  const r = await api("/api/devhub/file", {path: filePath});
  if (r.content) {
    const msg = \`حلّل هذا الملف الذي تم رفعه للتو:\n\n\\\`\\\`\\\`javascript\n\${r.content.slice(0,4000)}\n\\\`\\\`\\\`\`;
    document.getElementById("claudeInput").value = msg;
    document.querySelectorAll('.chat-tab')[1].click();
    await sendToClaude();
  }
}

// ── GitHub Config ──────────────────────────────────────────────────────────────
async function saveGhConfig() {
  const token   = document.getElementById("ghToken").value.trim();
  const webhook = document.getElementById("railwayWebhook")?.value.trim() || "";
  const owner   = document.getElementById("ghOwner").value.trim();
  const repo    = document.getElementById("ghBaseRepo").value.trim();
  const payload = { owner, baseRepo: repo, railwayWebhook: webhook };
  if (token && token !== "••••••••••••••••") payload.token = token;
  const vst = document.getElementById("ghVerifyStatus");
  vst.innerHTML = '<span style="color:var(--text3)">⏳ جارٍ الحفظ والتحقق...</span>';
  const r = await api("/api/devhub/config/save", payload);
  if (r.ok) {
    if (token && token !== "••••••••••••••••") document.getElementById("ghToken").value = "••••••••••••••••";
    // Step 1: verify token
    const vr = await api("/api/devhub/github/test", {});
    if (vr.ok) {
      vst.innerHTML = \`<span style="color:var(--green)">✅ مرحباً <strong>\${vr.login}</strong> — التوكن صالح</span>\`;
      document.getElementById("ghBadge").className = "badge badge-green";
      document.getElementById("ghBadge").textContent = "✅ موصول";
      showToast("✅ التوكن صالح — جارٍ تحميل الريبوهات", "success");
      // Step 2: auto-load repos
      await listMyRepos();
    } else {
      vst.innerHTML = \`<span style="color:var(--red)">❌ التوكن غير صالح: \${vr.error||"خطأ"}</span>\`;
      showToast("❌ التوكن غير صالح", "error");
    }
  } else {
    vst.innerHTML = \`<span style="color:var(--red)">❌ \${r.error||"فشل الحفظ"}</span>\`;
    showToast("❌ " + (r.error||"فشل"), "error");
  }
}
async function saveBaseRepo() {
  const owner = document.getElementById("ghOwner").value.trim();
  const repo  = document.getElementById("ghBaseRepo").value.trim();
  if (!owner || !repo) return showToast("أدخل المالك والريبو","error");
  const r = await api("/api/devhub/config/save", { owner, baseRepo: repo });
  if (r.ok) {
    document.getElementById("currentBaseRepoDisplay").textContent = repo;
    document.getElementById("currentOwnerDisplay").textContent = owner;
    // sync push fields
    const pr = document.getElementById("pushAllRepo"); if(pr) pr.value = repo;
    const po = document.getElementById("pushAllOwner"); if(po) po.value = owner;
    showToast("✅ تم تعيين " + owner + "/" + repo + " كريبو أساسي", "success");
    // highlight selected card
    document.querySelectorAll(".repo-pick-card").forEach(c => {
      c.style.borderColor = (c.dataset.repo === repo && c.dataset.owner === owner) ? "#10b981" : "var(--border)";
    });
  } else showToast("❌ " + (r.error||"فشل"), "error");
}
async function saveRailwayWebhookVal() {
  const webhook = document.getElementById("railwayWebhook").value.trim();
  const r = await api("/api/devhub/config/save", { railwayWebhook: webhook });
  r.ok ? showToast("✅ تم حفظ Railway Webhook","success") : showToast("❌ فشل","error");
}
async function savePort() {
  const port = document.getElementById("panelPort").value;
  const r = await fetch("/api/devhub/panel/port", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({port:parseInt(port)})});
  const d = await r.json();
  d.ok ? showToast(\`✅ البورت \${d.port} — أعد تشغيل البوت\`,"success") : showToast("❌ "+d.error,"error");
}
async function testGhToken() {
  const vst = document.getElementById("ghVerifyStatus");
  if (vst) { vst.innerHTML = '<span style="color:var(--text3)">⏳ جارٍ الاختبار...</span>'; }
  const r = await api("/api/devhub/github/test", {});
  if (vst) {
    if (r.ok) vst.innerHTML = \`<span style="color:var(--green)">✅ مرحباً <strong>\${r.login}</strong></span>\`;
    else vst.innerHTML = \`<span style="color:var(--red)">❌ \${r.error}</span>\`;
  }
  return r;
}
async function listMyRepos() {
  const grid = document.getElementById("repoPickerGrid");
  if (!grid) return;
  grid.innerHTML = '<div style="text-align:center;color:var(--text3);padding:20px;grid-column:1/-1">⏳ جارٍ تحميل الريبوهات...</div>';
  const r = await fetch("/api/devhub/github/repos");
  const data = await r.json();
  if (!data.repos || !data.repos.length) {
    grid.innerHTML = \`<div style="text-align:center;color:var(--red);padding:16px;grid-column:1/-1">❌ \${data.error||"لا توجد ريبوهات أو التوكن غير صالح"}</div>\`;
    return;
  }
  const curRepo  = document.getElementById("ghBaseRepo")?.value.trim() || "";
  const curOwner = document.getElementById("ghOwner")?.value.trim() || "";
  grid.innerHTML = data.repos.map(rp => {
    const isCur = rp.name === curRepo && (rp.owner?.login||"") === curOwner;
    return \`<div class="repo-pick-card" data-repo="\${rp.name}" data-owner="\${rp.owner?.login||""}"
      onclick="selectRepo('\${rp.name}','\${rp.owner?.login||""}')"
      style="background:var(--bg4);border:2px solid \${isCur?"#10b981":"var(--border)"};border-radius:10px;padding:12px;cursor:pointer;transition:all .2s;\${isCur?"box-shadow:0 0 0 2px rgba(16,185,129,.25)":""}">
      <div style="font-weight:700;font-size:.85rem;color:var(--text);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${rp.name}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <span style="font-size:.7rem;padding:2px 7px;border-radius:8px;background:\${rp.private?"rgba(245,158,11,.15)":"rgba(16,185,129,.15)"};color:\${rp.private?"#fbbf24":"#6ee7b7"}">\${rp.private?"🔒 خاص":"🌐 عام"}</span>
        \${isCur ? '<span style="font-size:.7rem;padding:2px 7px;border-radius:8px;background:rgba(16,185,129,.15);color:#6ee7b7">✅ الحالي</span>' : ""}
      </div>
      <div style="font-size:.72rem;color:var(--text3);margin-top:5px">\${rp.owner?.login||""}</div>
    </div>\`;
  }).join("");
}
function selectRepo(repoName, ownerName) {
  document.getElementById("ghBaseRepo").value = repoName;
  document.getElementById("ghOwner").value = ownerName;
  document.querySelectorAll(".repo-pick-card").forEach(c => {
    const active = c.dataset.repo === repoName && c.dataset.owner === ownerName;
    c.style.borderColor = active ? "#10b981" : "var(--border)";
    c.style.boxShadow   = active ? "0 0 0 2px rgba(16,185,129,.25)" : "none";
  });
  showToast("✔ اختيار: " + ownerName + "/" + repoName + " — اضغط تعيين كريبو أساسي", "success");
}

// ── Push All ───────────────────────────────────────────────────────────────────
async function pushAllToGithub() {
  const repo = document.getElementById("pushAllRepo").value.trim();
  const owner = document.getElementById("pushAllOwner").value.trim();
  const branch = document.getElementById("pushAllBranch").value.trim() || "main";
  const msg = document.getElementById("pushAllMsg").value.trim() || "🚀 Push from WHITE V3 Panel";
  if (!repo || !owner) return showToast("أدخل الريبو والمالك","error");
  const st = document.getElementById("pushAllStatus");
  st.innerHTML = '<span style="color:var(--text3)">⏳ جارٍ الرفع...</span>';
  const r = await fetch("/api/devhub/github/push-all",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({repo,owner,branch,commitMsg:msg})});
  const data = await r.json();
  if (data.ok) {
    st.innerHTML = \`<span style="color:var(--green)">✅ تم الرفع! <a href="\${data.url}" target="_blank" style="color:#60a5fa">🔗 فتح الريبو</a></span>\`;
    showToast("✅ تم رفع الكود بنجاح","success");
    setTimeout(loadVersionsTable, 1000);
  } else {
    st.innerHTML = \`<span style="color:var(--red)">❌ \${data.error||"فشل"}</span>\`;
    showToast("❌ فشل: "+(data.error||"خطأ"),"error");
  }
  return data.ok;
}
async function pushAllAndMakePrivate() {
  const repo = document.getElementById("pushAllRepo").value.trim();
  const owner = document.getElementById("pushAllOwner").value.trim();
  const branch = document.getElementById("pushAllBranch").value.trim() || "main";
  const msg = document.getElementById("pushAllMsg").value.trim() || "🚀 Push from WHITE V3 Panel";
  const st = document.getElementById("pushAllStatus");
  st.innerHTML = '<span style="color:var(--text3)">⏳ جارٍ الرفع...</span>';
  const r = await fetch("/api/devhub/github/push-all-private",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({repo,owner,branch,commitMsg:msg})});
  const data = await r.json();
  if (data.ok) {
    st.innerHTML = \`<span style="color:var(--green)">✅ تم الرفع! الريبو 🔒 خاص. <a href="\${data.url}" target="_blank" style="color:#60a5fa">🔗 فتح</a></span>\`;
    showToast("✅ رُفع الكود والريبو خاص","success");
  } else {
    st.innerHTML = \`<span style="color:var(--red)">❌ \${data.error||"فشل"}</span>\`;
  }
}
async function pushAllThenRailway() {
  const ok = await pushAllToGithub();
  if (ok) { await new Promise(r => setTimeout(r, 2000)); await railwayRedeploy(); }
}
async function railwayRedeploy() {
  const r = await fetch("/api/devhub/railway/redeploy",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  const d = await r.json();
  d.ok ? showToast("✅ Railway يعيد النشر","success") : showToast("❌ "+d.error,"error");
}

// ── Repo Management ────────────────────────────────────────────────────────────
async function setRepoVisibility(makePrivate) {
  const repo = document.getElementById("visRepo").value.trim();
  if (!repo) return showToast("أدخل اسم الريبو","error");
  const st = document.getElementById("visStatus");
  st.innerHTML = '⏳...';
  const r = await fetch("/api/devhub/github/repo-visibility",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({repo,private:makePrivate})});
  const data = await r.json();
  if (data.ok) { st.innerHTML = \`<span style="color:var(--green)">✅ \${data.private?"🔒 خاص":"🌐 عام"}</span>\`; showToast("✅ تم","success"); }
  else { st.innerHTML = \`<span style="color:var(--red)">❌ \${data.error}</span>\`; }
}
async function refreshRepos() {
  const div = document.getElementById("repoList");
  div.innerHTML = '<span style="color:var(--text3)">⏳...</span>';
  const r = await fetch("/api/devhub/github/repos");
  const data = await r.json();
  if (data.repos) {
    div.innerHTML = \`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin-top:10px">\${
      data.repos.map(rp => \`
<div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px">
  <div style="font-weight:700;font-size:.85rem">\${rp.private?"🔒":"🌐"} \${rp.name}</div>
  <div style="margin-top:8px;display:flex;gap:5px;flex-wrap:wrap">
    <a href="\${rp.html_url}" target="_blank" class="btn btn-outline btn-sm">🔗</a>
    <button class="btn btn-outline btn-sm" onclick="quickToggleVis('\${rp.name}',\${!rp.private})">\${rp.private?"🌐":"🔒"}</button>
    <button class="btn btn-danger btn-sm" onclick="deleteRepo('\${rp.name}')">🗑️</button>
  </div>
</div>\`).join("")}</div>\`;
  } else div.innerHTML = \`<span style="color:var(--red)">❌ \${data.error||"فشل"}</span>\`;
}
async function quickToggleVis(name, makePrivate) {
  const r = await fetch("/api/devhub/github/repo-visibility",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({repo:name,private:makePrivate})});
  const d = await r.json();
  d.ok ? (showToast(\`✅ \${name}: \${d.private?"🔒 خاص":"🌐 عام"}\`,"success"), refreshRepos()) : showToast("❌ "+d.error,"error");
}
async function createNewRepo() {
  const name = document.getElementById("newRepoName").value.trim();
  if (!name) return showToast("أدخل اسم الريبو","error");
  const r = await fetch("/api/devhub/github/create-repo",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})});
  const d = await r.json();
  d.ok ? (showToast("✅ تم إنشاء: "+name,"success"), refreshRepos()) : showToast("❌ "+d.error,"error");
}
async function deleteRepo(name) {
  if (!confirm("هل أنت متأكد من حذف "+name+"؟")) return;
  const r = await fetch("/api/devhub/github/delete-repo",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})});
  const d = await r.json();
  d.ok ? (showToast("✅ تم الحذف","success"), refreshRepos()) : showToast("❌ "+d.error,"error");
}

// ── Apply and Push ─────────────────────────────────────────────────────────────
async function applyAndPush(mode) {
  const files = Array.from(document.getElementById("pushFileSelect").selectedOptions).map(o => o.value);
  if (!files.length) return showToast("اختر ملفات للرفع","error");
  const branchOrRepo = document.getElementById("updateName").value.trim() || "update-"+Date.now();
  const commitMsg = document.getElementById("commitMsg").value.trim() || "🤖 DevHub Update";
  const st = document.getElementById("pushStatus");
  st.innerHTML = \`<span style="color:var(--text3)">⏳ جارٍ الرفع...</span>\`;
  const r = await fetch("/api/devhub/github/push",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({files,branchOrRepo,commitMsg,mode})});
  const data = await r.json();
  if (data.ok) {
    st.innerHTML = \`<span style="color:var(--green)">✅ تم! <a href="\${data.url}" target="_blank" style="color:#60a5fa">🔗 GitHub</a></span>\`;
    showToast("✅ تم الرفع بنجاح","success");
    setTimeout(loadVersionsTable, 1000);
  } else {
    st.innerHTML = \`<span style="color:var(--red)">❌ \${data.error||"فشل"}</span>\`;
    showToast("❌ فشل","error");
  }
}

// ── Versions Table ─────────────────────────────────────────────────────────────
async function loadVersionsTable() {
  const r = await fetch("/api/devhub/versions");
  const data = await r.json();
  if (data.versions) {
    const tbody = document.querySelector("#versionsTable tbody");
    if (tbody) tbody.innerHTML = data.versions.slice().reverse().map(v => \`
<tr>
  <td><code style="color:#60a5fa">\${v.branch||v.repo}</code></td>
  <td style="color:var(--text2)">\${v.date||""}</td>
  <td><span class="badge \${v.status==="success"?"badge-green":v.status==="failed"?"badge-red":"badge-yellow"}">\${v.status||"—"}</span></td>
  <td>\${v.repoUrl?'<a href="'+v.repoUrl+'" target="_blank" class="btn btn-outline btn-sm">🔗</a>':""}</td>
</tr>\`).join("") || '<tr><td colspan="4" style="text-align:center;color:var(--text3)">لا توجد إصدارات</td></tr>';
  }
}

// ── Smart Deploy JS ────────────────────────────────────────────────────────────
async function saveSmartDeployConfig() {
  const token = document.getElementById("sdRailwayToken").value;
  const maxKeep = parseInt(document.getElementById("sdMaxKeep").value) || 5;
  const webhook = document.getElementById("sdWebhook").value.trim();
  const baseRepo = document.getElementById("sdBaseRepo").value.trim();
  const payload = { maxUpdateRepos: maxKeep, railwayWebhook: webhook };
  if (baseRepo) payload.baseRepo = baseRepo;
  if (token && token !== "••••••••••••••••") payload.railwayApiToken = token;
  const r = await api("/api/devhub/smart-deploy/config", payload);
  if (r.ok) {
    showToast("✅ تم حفظ إعداد النشر","success");
    if (token && token !== "••••••••••••••••") document.getElementById("sdRailwayToken").value = "••••••••••••••••";
    document.getElementById("sdBaseRepoDisplay").textContent = "📁 " + (baseRepo || r.baseRepo || "—");
  } else showToast("❌ " + r.error,"error");
}
async function loadRailwayProjects() {
  const box = document.getElementById("sdProjectsBox");
  box.innerHTML = '<span style="color:var(--text3)">⏳ تحميل مشاريع Railway...</span>';
  const r = await api("/api/devhub/railway/projects", {});
  if (!r.ok) { box.innerHTML = \`<span style="color:var(--red)">❌ \${r.error}</span>\`; return; }
  const projects = r.projects || [];
  if (!projects.length) { box.innerHTML = '<span style="color:var(--text3)">لا توجد مشاريع</span>'; return; }
  box.innerHTML = projects.map(p => {
    const svcs = p.services || [];
    const envs = p.environments || [];
    return \`<div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:6px">
      <div style="font-weight:700">📁 \${p.name}</div>
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
        \${svcs.map(s => \`<button class="btn btn-outline btn-sm" onclick="selectRailwayService('\${p.id}','\${s.id}','\${envs[0]?.id||""}','\${p.name}','\${s.name}')">⚙️ \${s.name}</button>\`).join("")}
      </div>
    </div>\`;
  }).join("");
}
async function selectRailwayService(projectId, serviceId, envId, pName, sName) {
  const r = await api("/api/devhub/smart-deploy/config", {railwayProjectId:projectId,railwayServiceId:serviceId,railwayEnvironmentId:envId});
  r.ok ? showToast(\`✅ \${pName}/\${sName}\`,"success") : showToast("❌ "+r.error,"error");
}
async function smartDeployCreate() {
  const msg = document.getElementById("sdCommitMsg").value.trim() || "🚀 تحديث من WHITE V3 Panel";
  const makePriv = document.getElementById("sdMakePrivate").checked;
  const autoClean = document.getElementById("sdAutoCleanup").checked;
  const st = document.getElementById("sdCreateStatus");
  st.innerHTML = \`<div style="color:var(--text3);padding:10px;background:var(--bg3);border-radius:8px">⏳ جارٍ النشر...</div>\`;
  try {
    const r = await fetch("/api/devhub/smart-deploy/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({commitMsg:msg,makePrivate:makePriv,autoCleanup:autoClean})});
    const data = await r.json();
    if (data.ok) {
      st.innerHTML = \`<div style="padding:12px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.3);border-radius:10px">
        <div style="font-weight:700;color:var(--green)">✅ تم النشر!</div>
        \${(data.steps||[]).map(s=>\`<div style="font-size:.82rem;margin-top:4px">\${s.icon} \${s.label}: \${s.msg} \${s.url?'<a href="'+s.url+'" target="_blank" style="color:#60a5fa">🔗</a>':""}</div>\`).join("")}
        <div style="font-size:.8rem;color:var(--text3);margin-top:8px">الإصدار النشط: <strong style="color:var(--green)">\${data.newRepo}</strong></div>
      </div>\`;
      showToast("✅ النشر الذكي اكتمل!","success");
      setTimeout(loadSmartVersions, 1000);
    } else {
      st.innerHTML = \`<div style="padding:10px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);border-radius:8px;color:var(--red)">❌ \${data.error||"فشل"}</div>\`;
    }
  } catch(e) { st.innerHTML = \`<span style="color:var(--red)">❌ \${e.message}</span>\`; }
}
async function smartRollback(index) {
  if (!confirm(\`تراجع للإصدار #\${index}؟\`)) return;
  const r = await fetch("/api/devhub/smart-deploy/rollback-to",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({index})});
  const d = await r.json();
  d.ok ? (showToast(\`✅ تراجع للإصدار #\${index}\`,"success"), setTimeout(loadSmartVersions,800)) : showToast("❌ "+d.error,"error");
}
async function smartDeleteRepo(index, name) {
  if (!confirm("حذف "+name+"؟")) return;
  const r = await fetch("/api/devhub/smart-deploy/delete-update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({index})});
  const d = await r.json();
  d.ok ? (showToast("✅ تم الحذف","success"), setTimeout(loadSmartVersions,600)) : showToast("❌ "+d.error,"error");
}
async function smartCleanup() {
  const r = await fetch("/api/devhub/smart-deploy/cleanup",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  const d = await r.json();
  d.ok ? (showToast(\`✅ حذف \${(d.deleted||[]).length} إصدار\`,"success"), setTimeout(loadSmartVersions,600)) : showToast("❌ "+d.error,"error");
}
async function loadSmartVersions() {
  const r = await fetch("/api/devhub/smart-deploy/status");
  const data = await r.json();
  if (!data.ok) return;
  const sv = data.smartVersions;
  document.getElementById("sdActiveDisplay").textContent = sv.activeRepo ? "✅ " + sv.activeRepo : "—";
  const act = sv.updates.find(u => u.repo === sv.activeRepo);
  document.getElementById("sdActiveDate").textContent = act ? act.date : "—";
  const updates = [...(sv.updates||[])].reverse();
  const box = document.getElementById("sdVersionsTable");
  if (!updates.length) { box.innerHTML = '<div style="color:var(--text3);text-align:center;padding:16px">لا توجد إصدارات — اضغط "إنشاء تحديث جديد"</div>'; return; }
  box.innerHTML = \`<div style="overflow-x:auto"><table class="table"><thead><tr><th>#</th><th>الريبو</th><th>التاريخ</th><th>الحالة</th><th>إجراءات</th></tr></thead>
    <tbody>\${updates.map(v => {
      const isActive = v.repo === sv.activeRepo;
      return \`<tr style="\${isActive?"background:rgba(16,185,129,.04)":""}">
        <td><strong style="color:\${isActive?"var(--green)":"var(--text2)"}">#\${v.index}</strong></td>
        <td><code style="color:\${isActive?"var(--green)":"#60a5fa"}">\${v.repo}</code>\${isActive?'<span class="badge badge-green" style="margin-right:6px;font-size:.7rem">نشط</span>':""}</td>
        <td style="font-size:.78rem;color:var(--text3)">\${v.date||"—"}</td>
        <td><span class="badge \${v.status==="success"?"badge-green":"badge-red"}">\${v.status||"—"}</span></td>
        <td><div style="display:flex;gap:4px;flex-wrap:wrap">
          \${v.repoUrl?'<a href="'+v.repoUrl+'" target="_blank" class="btn btn-outline btn-sm">🔗</a>':""}
          \${!isActive?'<button class="btn btn-sm" style="background:rgba(251,191,36,.15);color:var(--yellow);border:1px solid rgba(251,191,36,.3);font-size:.72rem" onclick="smartRollback('+v.index+')">↩️</button>':""}
          \${!isActive?'<button class="btn btn-outline btn-sm" style="border-color:rgba(239,68,68,.3);color:var(--red)" onclick="smartDeleteRepo('+v.index+",'"+v.repo+"')"+'>🗑️</button>':""}
        </div></td>
      </tr>\`;
    }).join("")}</tbody></table></div>\`;
}

// ── Keyboard Shortcuts ─────────────────────────────────────────────────────────
document.addEventListener("keydown", function(e) {
  if (e.ctrlKey && e.key === "Enter") {
    if (activeTab === "agents") sendToAgents();
    else if (activeTab === "claude") sendToClaude();
    else if (activeTab === "quick") sendQuick();
    else if (activeTab === "guide") sendToGuide();
    else if (activeTab === "advisor") sendToAdvisor();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  // Load saved histories
  try {
    const r = await fetch("/api/devhub/chat/history");
    const d = await r.json();
    if (d.chatHistory?.length) {
      chatHistory = d.chatHistory;
      d.chatHistory.forEach(m => {
        if (m.role === "user") appendUserMsg("chatBox", m.content.replace(/</g,'&lt;').replace(/>/g,'&gt;'));
        else appendMsg("chatBox","🤖 AI","","#60a5fa", m.content);
      });
    }
    if (d.claudeHistory?.length) {
      claudeHistory = d.claudeHistory;
      d.claudeHistory.forEach(m => {
        if (m.role === "user") appendUserMsg("claudeBox", m.content.replace(/</g,'&lt;').replace(/>/g,'&gt;'));
        else appendMsg("claudeBox","Claude AI","🤖","#fbbf24", m.content);
      });
    }
  } catch(_) {}

  // Welcome message if empty
  if (!chatHistory.length) {
    appendMsg("chatBox","🤖 مركز التطوير","","#60a5fa",
      'مرحباً! أنا هنا مع فريق من الوكلاء الذكيين لتطوير بوتك.\\n\\n🔍 **المحلل** — يحلل ويخطط\\n💻 **المطور** — يكتب الكود\\n✅ **المراجع** — يراجع ويتحقق\\n\\n🔓 **الوصول التلقائي** مفعّل: الذكاء الاصطناعي يعرف تلقائياً كل شيء عن بوتك!\\n\\n⚡ جرّب اضغط على أحد **الإجراءات السريعة** أعلاه، أو اكتب طلبك الآن. **Ctrl+Enter** للإرسال.');
  }
  if (!claudeHistory.length) {
    appendMsg("claudeBox","🤖 Claude","","#fbbf24","مرحباً! أنا Claude. اسألني أي شيء عن البوت أو البرمجة وسأساعدك بأفضل ما يمكن.");
  }
  appendMsg("guideBox","📚 المرشد","","#6ee7b7","مرحباً! 👋 أنا هنا لمساعدتك حتى لو لا تعرف البرمجة. اسألني أي شيء بلغة بسيطة وسأشرح لك خطوة بخطوة.");
  appendMsg("advisorBox","💡 مستشار البوت","","#a78bfa",'مرحباً! أنا مستشارك الخاص لبوت WHITE V3. 🤖\\n\\nأنا أقرأ ملفات بوتك تلقائياً وأجيب على أسئلتك بلغة بسيطة.\\n\\n**ما يمكنني فعله:**\\n📋 أشرح لك الأوامر والميزات الموجودة\\n💡 أقترح أفكاراً وتحديثات جديدة\\n🔍 أحلل نقاط القوة والضعف في بوتك\\n❓ أجاوب أسئلتك عن البوت\\n\\n**ما لا أفعله:**\\n🔒 لا أعدّل أي ملف — أنا للقراءة والاستشارة فقط\\n\\nاضغط على أي زر أعلاه أو اكتب سؤالك!');

  // Load smart versions and file tree
  loadSmartVersions();
  refreshFileTree();
})();
</script>`;

    res.send(layout("مركز التطوير", body, "devhub"));
  });

  // ── Bot Auto Context ────────────────────────────────────────────────────────
  app.get("/api/devhub/bot/context", auth, (req, res) => {
    try {
      const context = buildAutoContext();
      res.json({ ok: true, context });
    } catch (e) { res.json({ error: e.message }); }
  });

  // ── File Tree ────────────────────────────────────────────────────────────────
  app.get("/api/devhub/file/tree", auth, (req, res) => {
    try {
      const { files } = getFileTree();
      res.json({ ok: true, files });
    } catch (e) { res.json({ error: e.message }); }
  });

  // ── AI Pipeline ──────────────────────────────────────────────────────────────
  app.post("/api/devhub/ai/pipeline", auth, async (req, res) => {
    try {
      const { message, files, history, autoCtx } = req.body;
      const steps = await runMultiAgentPipeline(message, files || [], history || [], autoCtx);
      const cfg = loadCfg();
      cfg.chatHistory = [...(cfg.chatHistory || []).slice(-20),
        { role: "user", content: message },
        ...steps.map(s => ({ role: "assistant", content: `[${s.name}]: ${s.reply}` }))
      ];
      saveCfg(cfg);
      res.json({ ok: true, steps });
    } catch (e) { res.json({ error: e.message }); }
  });

  // ── AI Single ────────────────────────────────────────────────────────────────
  app.post("/api/devhub/ai/single", auth, async (req, res) => {
    try {
      const { model, message, files, history, autoCtx } = req.body;
      const ctxParts = [];
      if (autoCtx) ctxParts.push(`=== السياق التلقائي للبوت ===\n${autoCtx}`);
      ctxParts.push(...(files || []).map(f => `--- ${f.path} ---\n${f.content}`));
      const ctxStr = ctxParts.join("\n\n");

      const agentKey = model === "claude" ? "claude" : model === "mistral" ? "implementer" : model === "llama" ? "analyst" : "openai";
      const sysPrompt = AGENTS[agentKey]?.systemPrompt || AGENTS.analyst.systemPrompt;
      const cfg = loadCfg();
      const histKey = model === "claude" ? "claudeHistory" : "chatHistory";
      const savedHistory = cfg[histKey] || [];
      const combinedHistory = (history && history.length > 0) ? history : savedHistory.slice(-10);

      const msgs = [
        { role: "system", content: sysPrompt },
        ...combinedHistory.slice(-8),
        { role: "user", content: message + (ctxStr ? `\n\n${ctxStr}` : "") }
      ];
      const reply = await callAI(model || "openai", msgs);

      cfg[histKey] = [...(cfg[histKey] || []).slice(-20),
        { role: "user", content: message },
        { role: "assistant", content: reply }
      ];
      saveCfg(cfg);
      res.json({ ok: true, reply });
    } catch (e) { res.json({ error: e.message }); }
  });

  // ── AI Advisor (Read-Only Chat) ───────────────────────────────────────────────
  app.post("/api/devhub/ai/advisor", auth, async (req, res) => {
    try {
      const { message, history, autoCtx } = req.body;
      const ctxStr = autoCtx ? `=== معلومات البوت الحالي ===\n${autoCtx}` : "";
      const msgs = [
        { role: "system", content: AGENTS.advisor.systemPrompt },
        ...(history || []).slice(-8),
        { role: "user", content: message + (ctxStr ? `\n\n${ctxStr}` : "") }
      ];
      const reply = await callAI("openai", msgs);
      res.json({ ok: true, reply });
    } catch (e) { res.json({ error: e.message }); }
  });

  // ── AI Guide (Beginner) ──────────────────────────────────────────────────────
  app.post("/api/devhub/ai/guide", auth, async (req, res) => {
    try {
      const { message, history, autoCtx } = req.body;
      const ctxStr = autoCtx ? `=== معلومات البوت ===\n${autoCtx}` : "";
      const msgs = [
        { role: "system", content: AGENTS.guide.systemPrompt },
        ...(history || []).slice(-6),
        { role: "user", content: message + (ctxStr ? `\n\n${ctxStr}` : "") }
      ];
      const reply = await callAI("openai", msgs);
      res.json({ ok: true, reply });
    } catch (e) { res.json({ error: e.message }); }
  });

  // ── Chat History ──────────────────────────────────────────────────────────────
  app.get("/api/devhub/chat/history", auth, (req, res) => {
    try {
      const cfg = loadCfg();
      res.json({ ok: true, chatHistory: cfg.chatHistory || [], claudeHistory: cfg.claudeHistory || [] });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.post("/api/devhub/chat/clear", auth, (req, res) => {
    try {
      const { target } = req.body;
      const cfg = loadCfg();
      if (!target || target === "chat" || target === "agents" || target === "all") cfg.chatHistory = [];
      if (target === "claude" || target === "all") cfg.claudeHistory = [];
      saveCfg(cfg);
      res.json({ ok: true });
    } catch (e) { res.json({ error: e.message }); }
  });

  // ── File Ops ──────────────────────────────────────────────────────────────────
  app.post("/api/devhub/file", auth, (req, res) => {
    try {
      const { path: p } = req.body;
      if (!p) return res.json({ error: "No path" });
      const content = readBotFile(p);
      res.json({ ok: true, content });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.post("/api/devhub/file/write", auth, (req, res) => {
    try {
      const { path: p, content } = req.body;
      if (!p || content === undefined) return res.json({ error: "Missing path or content" });
      writeBotFile(p, content);
      res.json({ ok: true });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.get("/api/devhub/files", auth, (req, res) => {
    res.json({ files: listAllBotFiles() });
  });

  // ── File Upload (improved with adm-zip) ───────────────────────────────────────
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowed = [".js",".json",".txt",".md",".env",".yaml",".yml",".zip",".sh",".py",".html",".css",".ts"];
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowed.includes(ext)) cb(null, true);
      else cb(new Error(`نوع الملف غير مدعوم: ${ext}`));
    }
  });

  app.post("/api/devhub/upload", auth, upload.single("file"), async (req, res) => {
    try {
      const f = req.file;
      if (!f) return res.json({ error: "لم يتم رفع أي ملف" });
      const ext = path.extname(f.originalname).toLowerCase();
      const targetDir = req.body.targetDir || "scripts/cmds";

      if (ext === ".zip") {
        try {
          const AdmZip = require("adm-zip");
          const zip = new AdmZip(f.buffer);
          const entries = zip.getEntries();
          const saved = [];
          const allowedExts = new Set([".js",".json",".txt",".md",".yaml",".yml",".sh",".py",".html",".css",".ts",".env"]);

          for (const entry of entries) {
            if (entry.isDirectory) continue;
            const entryExt = path.extname(entry.entryName).toLowerCase();
            if (!allowedExts.has(entryExt)) continue;
            // Skip system files
            if (entry.entryName.includes("__MACOSX") || entry.entryName.startsWith(".")) continue;

            let destPath = entry.entryName;
            // If targeting a specific dir and entry has no dir prefix, add it
            if (targetDir && !destPath.startsWith(targetDir) && !destPath.includes("/")) {
              destPath = `${targetDir}/${destPath}`;
            }
            const dest = path.join(ROOT, destPath);
            fs.ensureDirSync(path.dirname(dest));
            fs.writeFileSync(dest, entry.getData());
            saved.push(destPath);
          }
          return res.json({ ok: true, message: `تم استخراج ${saved.length} ملف من ZIP: ${f.originalname}`, files: saved, zipName: f.originalname });
        } catch (zipErr) {
          return res.json({ ok: false, error: `فشل فتح ZIP: ${zipErr.message}` });
        }
      } else {
        // Regular file
        const targetPath = path.join(ROOT, targetDir, f.originalname);
        fs.ensureDirSync(path.dirname(targetPath));
        fs.writeFileSync(targetPath, f.buffer);
        const relPath = `${targetDir}/${f.originalname}`.replace(/^\//, "");
        return res.json({ ok: true, message: `تم رفع: ${relPath}`, path: relPath, files: [relPath] });
      }
    } catch (e) { res.json({ error: e.message }); }
  });

  // ── Config ────────────────────────────────────────────────────────────────────
  app.post("/api/devhub/config/save", auth, (req, res) => {
    try {
      const cfg = loadCfg();
      if (req.body.token && req.body.token !== "••••••••••••••••") cfg.githubTokenEnc = encToken(req.body.token);
      if (req.body.owner) cfg.baseOwner = req.body.owner;
      if (req.body.baseRepo) cfg.baseRepo = req.body.baseRepo;
      if (req.body.railwayUrl !== undefined) cfg.railwayUrl = req.body.railwayUrl;
      if (req.body.railwayWebhook !== undefined) cfg.railwayWebhook = req.body.railwayWebhook;
      if (req.body.panelPassword) cfg.panelPassword = req.body.panelPassword;
      saveCfg(cfg);
      res.json({ ok: true, tokenFromEnv: tokenFromEnv() });
    } catch (e) { res.json({ error: e.message }); }
  });

  // ── GitHub Endpoints ──────────────────────────────────────────────────────────
  app.post("/api/devhub/github/test", auth, async (req, res) => {
    try {
      const token = loadToken();
      if (!token) return res.json({ error: "لا يوجد GitHub token" });
      const user = await ghApi(token, "GET", "/user");
      res.json({ ok: true, login: user.login, repos: (user.public_repos || 0) + (user.total_private_repos || 0), fromEnv: tokenFromEnv() });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.get("/api/devhub/github/repos", auth, async (req, res) => {
    try {
      const token = loadToken();
      if (!token) return res.json({ error: "لا يوجد GitHub token" });
      const repos = await listUserRepos(token);
      res.json({ repos: repos.map(r => ({ name: r.name, html_url: r.html_url, private: r.private, description: r.description })) });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.post("/api/devhub/github/create-repo", auth, async (req, res) => {
    try {
      const token = loadToken();
      if (!token) return res.json({ error: "لا يوجد GitHub token" });
      const { name } = req.body;
      const data = await createRepo(token, name, true);
      res.json({ ok: true, url: data.html_url });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.post("/api/devhub/github/delete-repo", auth, async (req, res) => {
    try {
      const token = loadToken();
      if (!token) return res.json({ error: "لا يوجد GitHub token" });
      const cfg = loadCfg();
      const { name } = req.body;
      await ghApi(token, "DELETE", `/repos/${cfg.baseOwner}/${name}`);
      res.json({ ok: true });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.post("/api/devhub/github/push-all", auth, async (req, res) => {
    try {
      const token = req.body.token || loadToken();
      if (!token) return res.json({ error: "أضف GitHub token أولاً" });
      const cfg = loadCfg();
      const owner = req.body.owner || cfg.baseOwner || "castrolmocro";
      const repo = req.body.repo || cfg.baseRepo || "New-white-e2ee-v2";
      const branch = req.body.branch || "main";
      const commitMsg = req.body.commitMsg || "🚀 Push from WHITE V3 Panel";
      const remote = `https://${token}@github.com/${owner}/${repo}.git`;
      const tmpDir = path.join(os.tmpdir(), `wv3-push-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      nodeCopyAll(ROOT, tmpDir);
      execSync(`git init "${tmpDir}"`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" config user.email "whitepanel@local.bot"`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" config user.name "WHITE V3 Panel"`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" config http.postBuffer 524288000`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" add -A`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" commit -m "${commitMsg.replace(/"/g, "'")}"`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" remote add target "${remote}"`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" push target HEAD:${branch} --force`, { stdio: "pipe", timeout: 180000 });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
      const url = `https://github.com/${owner}/${repo}`;
      const versions = loadVersions();
      versions.push({ branch, repo, repoUrl: url, date: new Date().toLocaleString("ar-DZ"), files: ["(كل الملفات)"], status: "success" });
      saveVersions(versions);
      res.json({ ok: true, url });
    } catch (e) { res.json({ error: e.stderr?.toString() || e.message }); }
  });

  app.post("/api/devhub/github/push-all-private", auth, async (req, res) => {
    try {
      const token = req.body.token || loadToken();
      if (!token) return res.json({ error: "أضف GitHub token أولاً" });
      const cfg = loadCfg();
      const owner = req.body.owner || cfg.baseOwner || "castrolmocro";
      const repo = req.body.repo || cfg.baseRepo || "New-white-e2ee-v2";
      const branch = req.body.branch || "main";
      const commitMsg = req.body.commitMsg || "🚀 Full push from WHITE V3 Panel";
      const remote = `https://${token}@github.com/${owner}/${repo}.git`;
      const tmpDir = path.join(os.tmpdir(), `wv3-priv-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      nodeCopyAll(ROOT, tmpDir);
      execSync(`git init "${tmpDir}"`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" config user.email "whitepanel@local.bot"`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" config user.name "WHITE V3 Panel"`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" config http.postBuffer 524288000`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" add -A`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" commit -m "${commitMsg.replace(/"/g, "'")}"`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" remote add target "${remote}"`, { stdio: "pipe" });
      execSync(`git -C "${tmpDir}" push target HEAD:${branch} --force`, { stdio: "pipe", timeout: 180000 });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
      let isPrivate = false;
      try { const p = await ghApi(token, "PATCH", `/repos/${owner}/${repo}`, { private: true }); isPrivate = p.private === true; } catch(_) {}
      const url = `https://github.com/${owner}/${repo}`;
      const versions = loadVersions();
      versions.push({ branch, repo, repoUrl: url, date: new Date().toLocaleString("ar-DZ"), files: ["(كل الملفات)"], status: "success" });
      saveVersions(versions);
      res.json({ ok: true, url, private: isPrivate });
    } catch (e) { res.json({ error: e.stderr?.toString() || e.message }); }
  });

  app.post("/api/devhub/github/repo-visibility", auth, async (req, res) => {
    try {
      const token = loadToken();
      if (!token) return res.json({ error: "لا يوجد GitHub token" });
      const cfg = loadCfg();
      const owner = req.body.owner || cfg.baseOwner || "castrolmocro";
      const { repo, private: makePrivate } = req.body;
      if (!repo) return res.json({ error: "اسم الريبو مطلوب" });
      const data = await ghApi(token, "PATCH", `/repos/${owner}/${repo}`, { private: !!makePrivate });
      res.json({ ok: true, private: data.private, url: data.html_url });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.post("/api/devhub/github/push", auth, async (req, res) => {
    try {
      const cfg = loadCfg();
      const token = loadToken();
      if (!token) return res.json({ error: "أضف GitHub token أولاً" });
      const { files, branchOrRepo, commitMsg, mode } = req.body;
      const owner = cfg.baseOwner || "castrolmocro";
      const baseRepo = cfg.baseRepo || "New-white-e2ee-v2";
      const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const branchName = branchOrRepo || `update-${now}`;
      let targetUrl = "", pushResults = [];

      if (mode === "repo") {
        const newRepo = await createRepo(token, branchName, true);
        targetUrl = newRepo.html_url;
        await new Promise(r => setTimeout(r, 3000));
        pushResults = await pushLocalFilesToBranch(token, owner, branchName, "main", files, commitMsg || "🤖 Initial commit by DevHub");
      } else {
        targetUrl = `https://github.com/${owner}/${baseRepo}/tree/${branchName}`;
        try {
          const ref = await getRef(token, owner, baseRepo);
          const sha = ref?.object?.sha || ref?.[0]?.object?.sha;
          if (sha) await createBranch(token, owner, baseRepo, branchName, sha);
        } catch (_) {}
        pushResults = await pushLocalFilesToBranch(token, owner, baseRepo, branchName, files, commitMsg || "🤖 Update by DevHub");
      }
      const versions = loadVersions();
      const succeeded = pushResults.filter(r => r.ok).length;
      const failed = pushResults.filter(r => !r.ok).length;
      versions.push({
        branch: mode === "repo" ? undefined : branchName,
        repo: mode === "repo" ? branchName : undefined,
        repoUrl: targetUrl, date: new Date().toLocaleString("ar-DZ"),
        files, status: failed === 0 ? "success" : succeeded > 0 ? "partial" : "failed"
      });
      saveVersions(versions);
      res.json({ ok: true, url: targetUrl, pushed: succeeded, failed });
    } catch (e) { res.json({ error: e.message }); }
  });

  // ── Railway ────────────────────────────────────────────────────────────────────
  app.post("/api/devhub/railway/redeploy", auth, async (req, res) => {
    try {
      const cfg = loadCfg();
      const webhookUrl = req.body.webhookUrl || cfg.railwayWebhook || "";
      if (!webhookUrl) return res.json({ error: "لم يتم إعداد Railway webhook" });
      const r = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      res.json({ ok: r.ok, status: r.status });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.post("/api/devhub/railway/projects", auth, async (req, res) => {
    try {
      const cfg = loadCfg();
      const tok = cfg.railwayApiToken ? decToken(cfg.railwayApiToken) : "";
      if (!tok) return res.json({ error: "أضف Railway API Token أولاً" });
      const projects = await railwayGetProjects(tok);
      const simplified = projects.map(p => ({
        id: p.id, name: p.name,
        environments: p.environments?.edges?.map(e => e.node) || [],
        services: p.services?.edges?.map(e => e.node) || []
      }));
      res.json({ ok: true, projects: simplified });
    } catch (e) { res.json({ error: e.message }); }
  });

  // ── Panel Port ─────────────────────────────────────────────────────────────────
  app.post("/api/devhub/panel/port", auth, (req, res) => {
    try {
      const p = parseInt(req.body.port);
      if (!p || p < 1024 || p > 65535) return res.json({ error: "بورت غير صالح (1024–65535)" });
      fs.writeFileSync(PANEL_CFG, JSON.stringify({ port: p }, null, 2));
      res.json({ ok: true, port: p });
    } catch (e) { res.json({ error: e.message }); }
  });

  // ── Versions ───────────────────────────────────────────────────────────────────
  app.get("/api/devhub/versions", auth, (req, res) => {
    res.json({ versions: loadVersions() });
  });

  // ── Smart Deploy API ───────────────────────────────────────────────────────────
  app.post("/api/devhub/smart-deploy/config", auth, (req, res) => {
    try {
      const cfg = loadCfg();
      const { railwayApiToken, railwayProjectId, railwayServiceId, railwayEnvironmentId, maxUpdateRepos, railwayWebhook, baseRepo } = req.body;
      if (railwayApiToken && railwayApiToken !== "••••••••••••••••") cfg.railwayApiToken = encToken(railwayApiToken);
      if (railwayProjectId !== undefined) cfg.railwayProjectId = railwayProjectId;
      if (railwayServiceId !== undefined) cfg.railwayServiceId = railwayServiceId;
      if (railwayEnvironmentId !== undefined) cfg.railwayEnvironmentId = railwayEnvironmentId;
      if (maxUpdateRepos !== undefined) cfg.maxUpdateRepos = parseInt(maxUpdateRepos) || 5;
      if (railwayWebhook !== undefined) cfg.railwayWebhook = railwayWebhook;
      if (baseRepo) cfg.baseRepo = baseRepo;
      saveCfg(cfg);
      res.json({ ok: true, baseRepo: cfg.baseRepo });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.post("/api/devhub/smart-deploy/create", auth, async (req, res) => {
    const steps = [];
    try {
      const cfg = loadCfg();
      const token = loadToken();
      if (!token) return res.json({ error: "أضف GitHub Token أولاً", step: "github-token" });
      const owner = cfg.baseOwner || "castrolmocro";
      const baseRepo = cfg.baseRepo || "New-white-e2ee-v2";
      const maxKeep = cfg.maxUpdateRepos || 5;
      const commitMsg = req.body.commitMsg || "🚀 تحديث من WHITE V3 Panel";
      const makePriv = req.body.makePrivate !== false;
      const autoClean = req.body.autoCleanup !== false;
      const sv = loadSmartVersions();
      const idx = (sv.currentIndex || 0) + 1;
      const newRepoName = makeUpdateRepoName(baseRepo, idx);
      const newRepoUrl = `https://github.com/${owner}/${newRepoName}`;

      steps.push({ icon: "📁", label: "إنشاء الريبو", msg: `جارٍ إنشاء ${newRepoName}...` });
      await createRepo(token, newRepoName, makePriv);
      await new Promise(r => setTimeout(r, 3000));
      steps[0].msg = `✅ تم إنشاء ${newRepoName}`; steps[0].url = newRepoUrl;

      steps.push({ icon: "📤", label: "رفع الملفات", msg: "جارٍ رفع الملفات..." });
      await gitPushToRepo(token, owner, newRepoName, `${commitMsg} (upd-${idx})`);
      steps[1].msg = "✅ تم رفع الملفات"; steps[1].url = newRepoUrl;

      steps.push({ icon: "🚂", label: "تحديث Railway", msg: "جارٍ تحديث Railway..." });
      let railwayUpdated = false;
      const rTok = cfg.railwayApiToken ? decToken(cfg.railwayApiToken) : "";
      if (rTok && cfg.railwayServiceId) {
        try {
          await railwayUpdateServiceSource(rTok, cfg.railwayServiceId, owner, newRepoName);
          if (cfg.railwayEnvironmentId) await railwayTriggerDeploy(rTok, cfg.railwayServiceId, cfg.railwayEnvironmentId);
          railwayUpdated = true; steps[2].msg = "✅ Railway مُحدَّث";
        } catch (re) { steps[2].msg = `⚠️ ${re.message}`; }
      } else if (cfg.railwayWebhook) {
        try { await fetch(cfg.railwayWebhook, { method:"POST", headers:{"Content-Type":"application/json"}, body:"{}" }); railwayUpdated = true; steps[2].msg = "✅ Webhook أُرسل"; }
        catch (_) { steps[2].msg = "⚠️ فشل webhook"; }
      } else { steps[2].msg = "⚠️ لم يتم إعداد Railway"; }

      steps.push({ icon: "🗑️", label: "تنظيف القديم", msg: "جارٍ الحذف..." });
      let deleted = [];
      if (autoClean) deleted = await cleanupOldUpdateRepos(token, owner, baseRepo, maxKeep, idx);
      steps[3].msg = deleted.length ? `✅ تم حذف ${deleted.length} إصدار` : "✅ لا يوجد قديم";

      sv.currentIndex = idx;
      sv.activeRepo = newRepoName;
      sv.updates.push({ index: idx, repo: newRepoName, repoUrl: newRepoUrl, date: new Date().toLocaleString("ar-DZ"), status: "success", railwayUpdated, commitMsg: `${commitMsg} (upd-${idx})` });
      if (deleted.length) sv.updates = sv.updates.filter(u => !deleted.includes(u.repo));
      saveSmartVersions(sv);
      res.json({ ok: true, newRepo: newRepoName, newRepoUrl, railwayUpdated, steps });
    } catch (e) { res.json({ error: e.stderr?.toString() || e.message, step: steps[steps.length - 1]?.label || "?", steps }); }
  });

  app.post("/api/devhub/smart-deploy/rollback-to", auth, async (req, res) => {
    try {
      const cfg = loadCfg();
      const sv = loadSmartVersions();
      const idx = parseInt(req.body.index);
      const upd = sv.updates.find(u => u.index === idx);
      if (!upd) return res.json({ error: `لا يوجد إصدار #${idx}` });
      const owner = cfg.baseOwner || "castrolmocro";
      const rTok = cfg.railwayApiToken ? decToken(cfg.railwayApiToken) : "";
      if (rTok && cfg.railwayServiceId) {
        await railwayUpdateServiceSource(rTok, cfg.railwayServiceId, owner, upd.repo);
        if (cfg.railwayEnvironmentId) await railwayTriggerDeploy(rTok, cfg.railwayServiceId, cfg.railwayEnvironmentId);
      } else if (cfg.railwayWebhook) {
        try { await fetch(cfg.railwayWebhook, { method:"POST", headers:{"Content-Type":"application/json"}, body:"{}" }); } catch(_) {}
      }
      sv.activeRepo = upd.repo;
      saveSmartVersions(sv);
      res.json({ ok: true, activeRepo: upd.repo });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.post("/api/devhub/smart-deploy/delete-update", auth, async (req, res) => {
    try {
      const cfg = loadCfg();
      const sv = loadSmartVersions();
      const idx = parseInt(req.body.index);
      const upd = sv.updates.find(u => u.index === idx);
      if (!upd) return res.json({ error: `لا يوجد إصدار #${idx}` });
      if (upd.repo === sv.activeRepo) return res.json({ error: "لا يمكن حذف الإصدار النشط" });
      const token = loadToken();
      const owner = cfg.baseOwner || "castrolmocro";
      await ghApi(token, "DELETE", `/repos/${owner}/${upd.repo}`);
      sv.updates = sv.updates.filter(u => u.index !== idx);
      saveSmartVersions(sv);
      res.json({ ok: true });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.post("/api/devhub/smart-deploy/cleanup", auth, async (req, res) => {
    try {
      const cfg = loadCfg();
      const sv = loadSmartVersions();
      const token = loadToken();
      const owner = cfg.baseOwner || "castrolmocro";
      const baseRepo = cfg.baseRepo || "New-white-e2ee-v2";
      const maxKeep = cfg.maxUpdateRepos || 5;
      const deleted = await cleanupOldUpdateRepos(token, owner, baseRepo, maxKeep, sv.currentIndex || 0);
      if (deleted.length) sv.updates = sv.updates.filter(u => !deleted.includes(u.repo));
      saveSmartVersions(sv);
      res.json({ ok: true, deleted });
    } catch (e) { res.json({ error: e.message }); }
  });

  app.get("/api/devhub/smart-deploy/status", auth, (req, res) => {
    res.json({ ok: true, smartVersions: loadSmartVersions() });
  });

  // ── Guide Page ──────────────────────────────────────────────────────────────
  app.get("/devhub/guide", auth, (req, res) => {
    const cfg = loadCfg();
    const body = `
<div class="page-header">
  <div class="page-title">📖 دليل مركز التطوير</div>
  <div class="page-sub">كل ما تحتاجه لتطوير بوتك — وكلاء ذكاء اصطناعي، GitHub، ملفات، نشر</div>
</div>

<div style="background:linear-gradient(135deg,rgba(59,130,246,.12),rgba(139,92,246,.12));border:1px solid rgba(59,130,246,.35);border-radius:14px;padding:20px;margin-bottom:22px;text-align:center">
  <div style="font-size:1.8rem;margin-bottom:4px">⚪ WHITE V3</div>
  <div style="font-size:1.1rem;font-weight:800;background:linear-gradient(90deg,#3b82f6,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent">مركز التطوير — DevHub</div>
  <div style="font-size:.82rem;color:var(--text2);margin-top:6px">تطوير: <strong style="color:#fbbf24">DJAMEL</strong> &nbsp;•&nbsp; © ${new Date().getFullYear()} WHITE Bot</div>
</div>

<!-- ─── قسم 1: الوكلاء الذكية ─────────────────────────── -->
<div class="card" style="margin-bottom:16px;border-color:rgba(59,130,246,.35)">
  <div class="card-header"><div class="card-title" style="color:#60a5fa">🤖 الوكلاء الذكية — كيف تعمل؟</div></div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:14px">
    <div style="background:rgba(96,165,250,.08);border:1px solid rgba(96,165,250,.2);border-radius:10px;padding:12px">
      <div style="color:#60a5fa;font-weight:700;margin-bottom:6px;font-size:.88rem">🔍 المحلل</div>
      <div style="font-size:.8rem;color:var(--text2);line-height:1.7">يقرأ طلبك ويحدد المشكلة والملفات المطلوبة. لا يكتب كوداً — فقط تحليل دقيق.</div>
    </div>
    <div style="background:rgba(196,181,253,.08);border:1px solid rgba(196,181,253,.2);border-radius:10px;padding:12px">
      <div style="color:#c4b5fd;font-weight:700;margin-bottom:6px;font-size:.88rem">💻 المطور</div>
      <div style="font-size:.8rem;color:var(--text2);line-height:1.7">يأخذ تحليل المحلل ويكتب الكود الكامل داخل بلوك <code>javascript</code> جاهز للتطبيق.</div>
    </div>
    <div style="background:rgba(110,231,183,.08);border:1px solid rgba(110,231,183,.2);border-radius:10px;padding:12px">
      <div style="color:#6ee7b7;font-weight:700;margin-bottom:6px;font-size:.88rem">✅ المراجع</div>
      <div style="font-size:.8rem;color:var(--text2);line-height:1.7">يراجع الكود ويعطي حكماً: ✅ يعمل أو ❌ يحتاج تعديل — في 3-5 أسطر فقط.</div>
    </div>
    <div style="background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);border-radius:10px;padding:12px">
      <div style="color:#fbbf24;font-weight:700;margin-bottom:6px;font-size:.88rem">📚 المرشد</div>
      <div style="font-size:.8rem;color:var(--text2);line-height:1.7">يشرح بلغة بسيطة دون مصطلحات تقنية — مثالي للمبتدئين.</div>
    </div>
    <div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:10px;padding:12px">
      <div style="color:#f59e0b;font-weight:700;margin-bottom:6px;font-size:.88rem">🤖 Claude AI</div>
      <div style="font-size:.8rem;color:var(--text2);line-height:1.7">شرح مفصل وكود متقدم مع تذكّر سياق المحادثة.</div>
    </div>
    <div style="background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.2);border-radius:10px;padding:12px">
      <div style="color:#a78bfa;font-weight:700;margin-bottom:6px;font-size:.88rem">💡 مستشار البوت</div>
      <div style="font-size:.8rem;color:var(--text2);line-height:1.7">يقرأ ملفات البوت ويقترح الأفكار والتحسينات بالكلام — بدون كتابة كود.</div>
    </div>
  </div>
  <div style="background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.2);border-radius:8px;padding:10px;font-size:.82rem;color:var(--text2)">
    💡 <strong>نصيحة:</strong> استخدم <kbd style="background:var(--bg4);padding:2px 6px;border-radius:4px;font-size:.78rem">Ctrl+Enter</kbd> للإرسال السريع. الوكلاء يستخدمون 5 نماذج AI تلقائياً (OpenAI، Mistral، LLaMA، OpenAI-Fast، DeepSeek) — إذا فشل أحدها ينتقل للتالي تلقائياً.
  </div>
</div>

<!-- ─── قسم 2: GitHub والتوكن ─────────────────────────── -->
<div class="card" style="margin-bottom:16px;border-color:rgba(139,92,246,.35)">
  <div class="card-header"><div class="card-title" style="color:#a78bfa">🐙 ربط GitHub — خطوة بخطوة</div></div>
  <div style="display:flex;flex-direction:column;gap:10px">
    <div style="display:flex;gap:12px;align-items:flex-start;padding:12px;background:var(--bg3);border-radius:10px">
      <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#6366f1);display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:.82rem;flex-shrink:0">1</div>
      <div style="font-size:.83rem;color:var(--text2);line-height:1.8">
        <strong style="color:var(--text)">أنشئ توكن GitHub (PAT)</strong><br>
        انتقل لـ <a href="https://github.com/settings/tokens/new?scopes=repo,delete_repo&description=WHITE-V3-Panel" target="_blank" style="color:#60a5fa">GitHub → Settings → Developer settings → Tokens (classic)</a><br>
        اضغط <strong>Generate new token</strong> — فعّل صلاحيات <code style="color:#60a5fa">repo</code> و<code style="color:#60a5fa">delete_repo</code> — انسخ التوكن (يبدأ بـ <code>ghp_</code>)
      </div>
    </div>
    <div style="display:flex;gap:12px;align-items:flex-start;padding:12px;background:var(--bg3);border-radius:10px">
      <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#10b981,#059669);display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:.82rem;flex-shrink:0">2</div>
      <div style="font-size:.83rem;color:var(--text2);line-height:1.8">
        <strong style="color:var(--text)">الصقه في إعداد GitHub</strong><br>
        في قسم إعداد GitHub ↓ — الصق التوكن في حقل <strong>أدخل توكن GitHub</strong> ثم اضغط <strong>💾 حفظ وتحقق</strong><br>
        سيتحقق تلقائياً ويعرض ريبوهاتك فوراً
      </div>
    </div>
    <div style="display:flex;gap:12px;align-items:flex-start;padding:12px;background:var(--bg3);border-radius:10px">
      <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#d97706);display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:.82rem;flex-shrink:0">3</div>
      <div style="font-size:.83rem;color:var(--text2);line-height:1.8">
        <strong style="color:var(--text)">اختر ريبو البوت الأساسي</strong><br>
        بعد تحميل الريبوهات — انقر على الريبو الذي يحتوي بوتك (مثلاً <code>${cfg.baseRepo||"WHITE-V3"}</code>)<br>
        سيتم تمييزه بالأخضر، ثم اضغط <strong>✅ تعيين كريبو أساسي</strong> — سيُستخدم في جميع عمليات الرفع
      </div>
    </div>
    <div style="display:flex;gap:12px;align-items:flex-start;padding:12px;background:var(--bg3);border-radius:10px">
      <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#4f46e5);display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:.82rem;flex-shrink:0">4</div>
      <div style="font-size:.83rem;color:var(--text2);line-height:1.8">
        <strong style="color:var(--text)">ارفع كودك</strong><br>
        في قسم <strong>🚀 رفع كل الكود</strong> — اضغط <strong>🚀 رفع كل الكود</strong> لرفع جميع الملفات للريبو الأساسي<br>
        أو <strong>🔒 رفع + خاص</strong> لجعل الريبو خاصاً بعد الرفع
      </div>
    </div>
  </div>
  <div style="margin-top:10px;padding:10px;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:8px;font-size:.8rem;color:#fbbf24">
    ⚠️ <strong>مهم:</strong> لا تشارك توكن GitHub مع أحد. يمنح صلاحية كاملة على جميع ريبوهاتك.
  </div>
</div>

<!-- ─── قسم 3: مدير الملفات ─────────────────────────── -->
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-bottom:16px">
  <div class="card" style="margin:0;border-color:rgba(16,185,129,.35)">
    <div class="card-header"><div class="card-title" style="color:var(--green)">📂 مدير الملفات</div></div>
    <div style="font-size:.82rem;color:var(--text2);line-height:1.9">
      • تصفح شجرة الملفات بالكامل<br>
      • انقر ملف لفتحه وتعديله مباشرة<br>
      • <strong>تحليل AI</strong>: يُحلل الملف ويشرحه<br>
      • <strong>إرسال للوكلاء</strong>: طلب تحسين الملف<br>
      • <strong>💾 حفظ</strong>: يحفظ التعديلات فوراً
    </div>
  </div>
  <div class="card" style="margin:0;border-color:rgba(16,185,129,.35)">
    <div class="card-header"><div class="card-title" style="color:var(--green)">📤 رفع الملفات</div></div>
    <div style="font-size:.82rem;color:var(--text2);line-height:1.9">
      • اسحب وأفلت أي ملف للرفع<br>
      • ملفات <code>.zip</code> تُستخرج تلقائياً<br>
      • خيار <strong>تحليل بالذكاء</strong> يفحص الملف<br>
      • <strong>إرسال ZIP للوكلاء</strong> يحلل المحتوى<br>
      <span style="color:var(--text3);font-size:.75rem">أقصى حجم: 20MB</span>
    </div>
  </div>
  <div class="card" style="margin:0;border-color:rgba(245,158,11,.35)">
    <div class="card-header"><div class="card-title" style="color:var(--yellow)">⚡ نصائح مهمة</div></div>
    <div style="font-size:.82rem;color:var(--text2);line-height:1.9">
      • <kbd style="background:var(--bg4);padding:1px 5px;border-radius:3px">Ctrl+Enter</kbd> للإرسال السريع<br>
      • الإجراءات السريعة توفّر وقتك<br>
      • المحادثة تُحفظ تلقائياً<br>
      • <strong>💾 تطبيق</strong> يحفظ كود الوكلاء مباشرة<br>
      • للمبتدئين: تبويب <strong>المرشد</strong> الأوضح
    </div>
  </div>
</div>

<div style="padding:14px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;text-align:center">
  <div style="font-size:.78rem;color:var(--text3)">
    © ${new Date().getFullYear()} WHITE Bot by DJAMEL &nbsp;•&nbsp;
    <a href="https://github.com/${cfg.baseOwner||"castrolmocro"}/${cfg.baseRepo||"WHITE-V3"}" target="_blank" style="color:#60a5fa">GitHub: ${cfg.baseOwner||"castrolmocro"}/${cfg.baseRepo||"WHITE-V3"}</a>
  </div>
</div>`;
    res.send(layout("دليل المطور", body, "devhub/guide"));
  });
};
