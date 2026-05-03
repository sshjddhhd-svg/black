/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  STEALTH ENGINE — Human Camouflage System
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Makes the bot indistinguishable from a real human user by:
 *
 *  Layer 1 — Presence Cycling
 *    Randomly alternates between online / idle / offline states
 *    so the account is never "always online" (bot signature).
 *
 *  Layer 2 — Human Page Browsing
 *    Periodically visits realistic Facebook pages (feed, notifications,
 *    profile, messages) using session cookies — exactly like a person
 *    switching between tabs.
 *
 *  Layer 3 — Message Read Simulation
 *    Marks random active threads as "read" at irregular intervals,
 *    simulating a user glancing at their phone.
 *
 *  Layer 4 — Sleep Mode
 *    Dramatically reduces all activity during configurable sleeping hours.
 *    The account goes mostly offline and browses very rarely.
 *
 *  Layer 5 — User-Agent Rotation
 *    Rotates through a pool of real device user-agents for HTTP
 *    requests so fingerprinting across sessions is harder.
 *
 *  Layer 6 — Action Jitter
 *    Exports a helper so other modules (angel, divel, etc.) can add
 *    human-like random delays to any timed action.
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
  // Android Chrome
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; Redmi Note 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; M2102J20SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; OnePlus 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  // iOS Safari
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  // Facebook in-app WebView
  "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/459.0.0.29.109;]",
];

let _currentUAIdx = randInt(0, UA_POOL.length - 1);

function getUA() {
  return UA_POOL[_currentUAIdx];
}

function rotateUA() {
  _currentUAIdx = (_currentUAIdx + randInt(1, UA_POOL.length - 1)) % UA_POOL.length;
  log("info", `🔄 User-Agent rotated → ${UA_POOL[_currentUAIdx].slice(0, 60)}…`);
}

// ─── Facebook pages to "browse" ───────────────────────────────────────────────

const PAGE_POOL = [
  // Mobile Facebook
  { url: "https://m.facebook.com/",                       label: "Home feed" },
  { url: "https://m.facebook.com/?sk=h_nor",              label: "News feed" },
  { url: "https://m.facebook.com/notifications",          label: "Notifications" },
  { url: "https://m.facebook.com/messages",               label: "Messages list" },
  { url: "https://m.facebook.com/profile.php",            label: "Own profile" },
  { url: "https://m.facebook.com/friend_requests",        label: "Friend requests" },
  { url: "https://m.facebook.com/events/upcoming",        label: "Upcoming events" },
  { url: "https://m.facebook.com/groups/feed",            label: "Groups feed" },
  // mbasic (lighter — used often on slow connections)
  { url: "https://mbasic.facebook.com/",                  label: "mbasic home" },
  { url: "https://mbasic.facebook.com/me",                label: "mbasic profile" },
  { url: "https://mbasic.facebook.com/notifications",     label: "mbasic notifications" },
  { url: "https://mbasic.facebook.com/groups/?seemore=1", label: "mbasic groups" },
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
    if (isSleepHour()) {
      // Sleep hours → go offline
      try { api.setOptions({ online: false }); } catch (_) {}
      log("info", "🌙 Sleep mode — presence: offline");
      schedulePresence(randMs(20, 40));
      return;
    }

    // Daytime distribution: 60% online, 25% idle, 15% briefly offline
    const roll = Math.random();
    if (roll < 0.60) {
      try { api.setOptions({ online: true }); } catch (_) {}
      log("info", "🟢 Presence → online");
      schedulePresence(randMs(8, 22));
    } else if (roll < 0.85) {
      try { api.setOptions({ online: false }); } catch (_) {}
      log("info", "💤 Presence → idle");
      schedulePresence(randMs(4, 12));
    } else {
      // Short offline break (simulates locking the phone)
      try { api.setOptions({ online: false }); } catch (_) {}
      log("info", "📴 Presence → offline (short break)");
      schedulePresence(randMs(2, 7));
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

    // During sleep hours skip browsing almost entirely
    if (isSleepHour()) {
      scheduleBrowse(randMs(40, 80));
      return;
    }

    const page = PAGE_POOL[randInt(0, PAGE_POOL.length - 1)];
    const ua   = getUA();

    // Occasionally rotate UA before a visit (simulates app restart)
    if (Math.random() < 0.12) rotateUA();

    // Use HEAD request (no body downloaded) to mark session activity
    // with a tiny fraction of the bandwidth of a full GET
    await axios.head(page.url, {
      headers: {
        "cookie":          cookies,
        "user-agent":      ua,
        "accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9,ar;q=0.8",
        "referer":         "https://m.facebook.com/",
        "upgrade-insecure-requests": "1",
      },
      timeout:        8000,
      validateStatus: null,
      maxRedirects:   2,
    });

    log("info", `🌐 Browsed (HEAD): ${page.label}`);

    // Rarely do a second lightweight follow-up (15% chance instead of 35%)
    if (Math.random() < 0.15) {
      await sleep(randInt(5000, 18000));
      const page2 = PAGE_POOL[randInt(0, PAGE_POOL.length - 1)];
      await axios.head(page2.url, {
        headers: { "cookie": cookies, "user-agent": ua, "referer": page.url },
        timeout: 6000, validateStatus: null, maxRedirects: 2,
      });
      log("info", `🌐 Browsed follow-up (HEAD): ${page2.label}`);
    }

  } catch (_) {}

  // Longer gaps: 12-30 min awake, 45-90 min sleep
  const next = isSleepHour() ? randMs(45, 90) : randMs(12, 30);
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

  running = true;
  _api    = api;

  log("info", "🕵️ Stealth engine started — all 6 layers active");
  log("info", `🌙 Sleep hours: ${cfg.sleepHourStart ?? 2}:00 – ${cfg.sleepHourEnd ?? 7}:00`);

  // Stagger startup so all loops don't fire at once
  addTimer("presence-init",    presenceLoop,    randMs(0, 3));
  addTimer("browse-init",      browseLoop,      randMs(12, 22));  // first browse after 12-22 min
  addTimer("read-init",        readLoop,        randMs(15, 30));
  addTimer("ua-rotation-init", uaRotationLoop,  randMs(60, 120));
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
    localHour:      localHour(),
    sleepStart:     cfg.sleepHourStart ?? 2,
    sleepEnd:       cfg.sleepHourEnd   ?? 7,
    activeTimers:   _loops.length,
  };
};
