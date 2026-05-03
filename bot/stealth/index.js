/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  STEALTH ENGINE — Human Camouflage System  v2
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Makes the bot indistinguishable from a real human user by:
 *
 *  Layer 1 — Presence Cycling
 *  Layer 2 — Human Page Browsing (GET + HEAD with real browser headers)
 *  Layer 3 — Message Read Simulation
 *  Layer 4 — Sleep Mode (aggressive 01:00–08:00)
 *  Layer 5 — User-Agent Rotation (expanded pool + brand headers)
 *  Layer 6 — Action Jitter
 *  Layer 7 — Outgoing Message Throttle  (outgoingThrottle.js)
 *  Layer 8 — HTTP Request Fingerprinting (Sec-Fetch-*, Accept-Encoding…)
 *  Layer 9 — Warmup Mode (first 15 min: minimal activity)
 * Layer 10 — Typing Indicator before every reply
 */

"use strict";

const axios = require("axios");

// ─── Logging ────────────────────────────────────────────────────────────────
function log(level, msg) {
  const l = global.utils?.log;
  if (level === "info")  return l?.info("STEALTH", msg);
  if (level === "warn")  return l?.warn("STEALTH", msg);
  if (level === "debug") return; // suppress debug unless needed
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Random milliseconds between [minMin, maxMin] minutes */
function randMs(minMin, maxMin) {
  const lo = minMin * 60_000;
  const hi = maxMin * 60_000;
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

/** Random integer in [min, max] inclusive */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Resolves after ms milliseconds */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Current hour in the bot's configured timezone (0–23) */
function localHour() {
  const tz = global.GoatBot?.config?.timeZone || "Asia/Dhaka";
  try {
    return parseInt(
      new Date().toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }),
      10
    );
  } catch (_) {
    return new Date().getHours();
  }
}

/** True during the configured sleep window (default 02:00–07:00) */
function isSleepHour() {
  const cfg   = global.GoatBot?.config?.stealth || {};
  const start = cfg.sleepHourStart ?? 2;
  const end   = cfg.sleepHourEnd   ?? 7;
  const h     = localHour();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

/** Extract cookie string from live API appState */
function cookieStr(api) {
  try {
    const st = api.getAppState();
    if (!st?.length) return null;
    return st.map(c => `${c.key}=${c.value}`).join("; ");
  } catch (_) { return null; }
}

// ─── User-Agent Pool (realistic Android/iOS devices) ─────────────────────────

const UA_POOL = [
  // Android Chrome — various versions and devices
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; Redmi Note 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; 22041216G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; M2102J20SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; OnePlus 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; CPH2451) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  // iOS Safari
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  // Facebook in-app WebView (Android)
  "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/459.0.0.29.109;]",
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.90 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/461.0.0.34.108;]",
];

let _currentUAIdx = randInt(0, UA_POOL.length - 1);

function getUA() {
  return UA_POOL[_currentUAIdx];
}

function rotateUA() {
  _currentUAIdx = (_currentUAIdx + randInt(1, UA_POOL.length - 1)) % UA_POOL.length;
  log("info", `🔄 User-Agent rotated → ${UA_POOL[_currentUAIdx].slice(0, 60)}…`);
}

// ─── Layer 8: HTTP Request Fingerprinting ────────────────────────────────────
/**
 * Builds realistic browser headers matching the given UA.
 * Real Chrome/Firefox/Safari send all these headers — missing them
 * is a strong bot signal to Cloudflare and Facebook's detector.
 */
function buildBrowserHeaders(cookies, ua, referer = null) {
  const isChrome  = ua.includes("Chrome") && !ua.includes("FB_IAB");
  const isSafari  = ua.includes("Safari") && !ua.includes("Chrome");
  const isFbApp   = ua.includes("FB_IAB");
  const isMobile  = ua.includes("Mobile") || ua.includes("Android") || ua.includes("iPhone");

  const chromeVer = (ua.match(/Chrome\/(\d+)/) || [])[1] || "124";

  const h = {
    "cookie":                    cookies,
    "user-agent":                ua,
    "accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language":           "ar-DZ,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    "accept-encoding":           "gzip, deflate, br",
    "cache-control":             Math.random() < 0.5 ? "max-age=0" : "no-cache",
    "upgrade-insecure-requests": "1",
    "connection":                "keep-alive",
  };

  if (referer) {
    h["referer"]       = referer;
    h["sec-fetch-site"] = "same-origin";
  } else {
    h["sec-fetch-site"] = Math.random() < 0.7 ? "none" : "same-origin";
  }

  if (isChrome || isFbApp) {
    h["sec-fetch-mode"] = "navigate";
    h["sec-fetch-dest"] = "document";
    h["sec-fetch-user"] = "?1";
    h["sec-ch-ua"]         = `"Chromium";v="${chromeVer}", "Not:A-Brand";v="99", "Google Chrome";v="${chromeVer}"`;
    h["sec-ch-ua-mobile"]  = isMobile ? "?1" : "?0";
    h["sec-ch-ua-platform"] = isMobile ? '"Android"' : '"Windows"';
  } else if (isSafari) {
    // Safari doesn't send Sec-Fetch-* for some requests
    if (Math.random() < 0.6) {
      h["sec-fetch-mode"] = "navigate";
      h["sec-fetch-dest"] = "document";
    }
  }

  // DNT: 1 — common on privacy-conscious users (adds realism)
  if (Math.random() < 0.4) h["dnt"] = "1";

  return h;
}

// ─── Layer 9: Warmup Mode ─────────────────────────────────────────────────────
let _startTime = Date.now();

function isWarmup() {
  const warmupMin = global.GoatBot?.config?.stealth?.warmupMinutes ?? 15;
  return (Date.now() - _startTime) < warmupMin * 60_000;
}

// ─── Facebook pages to "browse" ───────────────────────────────────────────────

const PAGE_POOL = [
  // Mobile Facebook (m.facebook.com)
  { url: "https://m.facebook.com/",                          label: "Home feed",         method: "GET" },
  { url: "https://m.facebook.com/?sk=h_nor",                 label: "News feed",         method: "HEAD" },
  { url: "https://m.facebook.com/notifications",             label: "Notifications",     method: "GET" },
  { url: "https://m.facebook.com/messages",                  label: "Messages list",     method: "HEAD" },
  { url: "https://m.facebook.com/profile.php",               label: "Own profile",       method: "GET" },
  { url: "https://m.facebook.com/friend_requests",           label: "Friend requests",   method: "HEAD" },
  { url: "https://m.facebook.com/events/upcoming",           label: "Upcoming events",   method: "HEAD" },
  { url: "https://m.facebook.com/groups/feed",               label: "Groups feed",       method: "HEAD" },
  { url: "https://m.facebook.com/marketplace",               label: "Marketplace",       method: "HEAD" },
  { url: "https://m.facebook.com/stories/feeds/",            label: "Stories feed",      method: "HEAD" },
  { url: "https://m.facebook.com/video_channel_browse",      label: "Reels browse",      method: "HEAD" },
  // mbasic (lighter — used on slow connections)
  { url: "https://mbasic.facebook.com/",                     label: "mbasic home",       method: "GET" },
  { url: "https://mbasic.facebook.com/me",                   label: "mbasic profile",    method: "HEAD" },
  { url: "https://mbasic.facebook.com/notifications",        label: "mbasic notifs",     method: "HEAD" },
  { url: "https://mbasic.facebook.com/groups/?seemore=1",    label: "mbasic groups",     method: "HEAD" },
  { url: "https://mbasic.facebook.com/messages/?folder=pending", label: "mbasic pending", method: "HEAD" },
];

// ─── State ───────────────────────────────────────────────────────────────────

let running       = false;
let _api          = null;
const _loops      = []; // {id, name} for all running timers/intervals

function addTimer(name, fn, ms) {
  // Wrap fn so its entry is pruned from _loops once it fires
  let entry;
  const wrapped = function () {
    const idx = _loops.indexOf(entry);
    if (idx !== -1) _loops.splice(idx, 1);
    fn();
  };
  const id = setTimeout(wrapped, ms);
  entry = { id, name, type: "timeout" };
  _loops.push(entry);
  return id;
}

function _clearAll() {
  for (const { id, type } of _loops) {
    if (type === "timeout")  clearTimeout(id);
    else                     clearInterval(id);
  }
  _loops.length = 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LAYER 1 — Presence Cycling
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function presenceLoop() {
  if (!running) return;
  const api = _api;

  try {
    // Sleep hours → offline (more aggressive: 01:00–08:00)
    if (isSleepHour()) {
      try { api.setOptions({ online: false }); } catch (_) {}
      log("info", "🌙 Sleep mode — presence: offline");
      schedulePresence(randMs(25, 55));
      return;
    }

    // Warmup: stay mostly offline for first N minutes after login
    if (isWarmup()) {
      try { api.setOptions({ online: false }); } catch (_) {}
      log("info", "🌱 Warmup — presence: offline");
      schedulePresence(randMs(3, 8));
      return;
    }

    // Normal hours: 50% online, 30% idle, 20% briefly offline
    // (reduced online% from 60% — real people aren't ALWAYS online)
    const roll = Math.random();
    if (roll < 0.50) {
      try { api.setOptions({ online: true }); } catch (_) {}
      log("info", "🟢 Presence → online");
      schedulePresence(randMs(6, 18));
    } else if (roll < 0.80) {
      try { api.setOptions({ online: false }); } catch (_) {}
      log("info", "💤 Presence → idle");
      schedulePresence(randMs(5, 15));
    } else {
      // Offline break (simulates locking the phone, 10–25 min)
      try { api.setOptions({ online: false }); } catch (_) {}
      log("info", "📴 Presence → offline (break)");
      schedulePresence(randMs(10, 25));
    }
  } catch (_) {
    schedulePresence(randMs(10, 20));
  }
}

function schedulePresence(ms) {
  if (!running) return;
  addTimer("presence", presenceLoop, ms);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LAYER 2 — Human Page Browsing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function browseLoop() {
  if (!running) return;
  const api = _api;

  try {
    const cookies = cookieStr(api);
    if (!cookies) { scheduleBrowse(randMs(25, 50)); return; }

    // Skip browsing during sleep or warmup
    if (isSleepHour())  { scheduleBrowse(randMs(40, 90)); return; }
    if (isWarmup())     { scheduleBrowse(randMs(20, 40)); return; }

    // Occasionally rotate UA before a visit (simulates app restart)
    if (Math.random() < 0.10) rotateUA();

    const page = PAGE_POOL[randInt(0, PAGE_POOL.length - 1)];
    const ua   = getUA();

    // Layer 8: Use real browser headers for all requests
    const headers1 = buildBrowserHeaders(cookies, ua, null);

    // 40% of visits use GET (download content like a real browser), 60% HEAD
    const useGet = Math.random() < 0.40 || page.method === "GET";
    const method = useGet ? "get" : "head";

    await axios[method](page.url, {
      headers:        headers1,
      timeout:        12000,
      validateStatus: null,
      maxRedirects:   3,
      maxContentLength: useGet ? 65536 : undefined, // cap GET at 64KB
    });

    log("info", `🌐 Browsed (${method.toUpperCase()}): ${page.label}`);

    // 20% chance: do a follow-up page visit with referer (realistic navigation chain)
    if (Math.random() < 0.20) {
      await sleep(randInt(6000, 22000));
      const page2   = PAGE_POOL[randInt(0, PAGE_POOL.length - 1)];
      const headers2 = buildBrowserHeaders(cookies, ua, page.url);
      await axios.head(page2.url, {
        headers: headers2, timeout: 8000, validateStatus: null, maxRedirects: 2,
      });
      log("info", `🌐 Follow-up (HEAD): ${page2.label}`);
    }

  } catch (_) {}

  // Awake: 15–35 min between visits | Sleep: 50–100 min
  const next = isSleepHour() ? randMs(50, 100) : randMs(15, 35);
  scheduleBrowse(next);
}

function scheduleBrowse(ms) {
  if (!running) return;
  addTimer("browse", browseLoop, ms);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LAYER 3 — Mark-as-Read Simulation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function readLoop() {
  if (!running) return;
  const api = _api;

  try {
    if (!isSleepHour()) {
      // Collect known active thread IDs from angel & divel data
      const threadIDs = new Set();

      try {
        const angelData = global.GoatBot?.angelIntervals || {};
        Object.keys(angelData).forEach(id => threadIDs.add(id));
      } catch (_) {}

      try {
        const divelData = global.GoatBot?.divelWatchers || {};
        Object.keys(divelData).forEach(id => threadIDs.add(id));
      } catch (_) {}

      if (threadIDs.size > 0) {
        // Pick 1–3 random threads to mark as read
        const ids    = [...threadIDs];
        const count  = Math.min(randInt(1, 3), ids.length);
        const chosen = ids.sort(() => Math.random() - 0.5).slice(0, count);

        for (const tid of chosen) {
          try {
            await api.markAsRead(tid);
            log("info", `👁️ Marked thread ${tid} as read`);
            await sleep(randInt(800, 3000));
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  scheduleRead(isSleepHour() ? randMs(40, 80) : randMs(15, 45));
}

function scheduleRead(ms) {
  if (!running) return;
  addTimer("read", readLoop, ms);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LAYER 5 — Periodic UA Rotation (independent timer)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function uaRotationLoop() {
  if (!running) return;
  rotateUA();
  addTimer("ua-rotation", uaRotationLoop, randMs(60, 180)); // rotate every 1–3 hours
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LAYER 6 — Action Jitter (exported helper)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Wraps a function call with a realistic random delay so that
 * automated actions (angel, divel, etc.) never fire at exactly
 * the same time.
 *
 * Adds up to ±15% jitter to the configured interval.
 *
 * @param {number} intervalMs - The base interval in ms
 * @returns {number} - Jittered interval in ms
 */
function jitter(intervalMs) {
  const factor = 0.85 + Math.random() * 0.30; // 85%–115%
  return Math.round(intervalMs * factor);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PUBLIC API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Start the stealth engine.
 * @param {object} api - fca-eryxenx API object
 */
module.exports.start = function startStealth(api) {
  if (running) {
    log("warn", "Already running — skipping duplicate start.");
    return;
  }

  const cfg = global.GoatBot?.config?.stealth || {};
  if (cfg.enable === false) {
    log("info", "Stealth is disabled in config (stealth.enable = false).");
    return;
  }

  running    = true;
  _api       = api;
  _startTime = Date.now(); // reset warmup clock

  const warmupMin = cfg.warmupMinutes ?? 15;
  log("info", `🕵️ Stealth engine v2 started — 10 layers active`);
  log("info", `🌙 Sleep: ${cfg.sleepHourStart ?? 1}:00–${cfg.sleepHourEnd ?? 8}:00 | 🌱 Warmup: ${warmupMin} min`);

  // Stagger startup to avoid all loops firing at once
  addTimer("presence-init",    presenceLoop,    randMs(0, 2));
  addTimer("browse-init",      browseLoop,      randMs(20, 35));  // first browse after warmup
  addTimer("read-init",        readLoop,        randMs(18, 35));
  addTimer("ua-rotation-init", uaRotationLoop,  randMs(70, 130));
};

/**
 * Stop all stealth activity.
 */
module.exports.stop = function stopStealth() {
  running = false;
  _clearAll();
  log("info", "🛑 Stealth engine stopped.");
};

/**
 * Check if stealth is currently running.
 */
module.exports.isRunning = () => running;

/**
 * Get current user-agent (useful for keepAlive ping to stay consistent).
 */
module.exports.getCurrentUA = getUA;

/**
 * Apply jitter to an interval in ms — import this in angel/divel/etc.
 * @param {number} intervalMs
 * @returns {number}
 */
module.exports.jitter = jitter;

/**
 * Get a status summary object.
 */
module.exports.getStatus = function () {
  const cfg = global.GoatBot?.config?.stealth || {};
  return {
    running,
    currentUA:      getUA().slice(0, 60) + "…",
    uaPoolSize:     UA_POOL.length,
    pagePoolSize:   PAGE_POOL.length,
    isSleepHour:    isSleepHour(),
    isWarmup:       isWarmup(),
    localHour:      localHour(),
    sleepStart:     cfg.sleepHourStart ?? 1,
    sleepEnd:       cfg.sleepHourEnd   ?? 8,
    warmupMinutes:  cfg.warmupMinutes  ?? 15,
    activeTimers:   _loops.length,
  };
};

module.exports.isWarmup        = isWarmup;
module.exports.buildBrowserHeaders = buildBrowserHeaders;
