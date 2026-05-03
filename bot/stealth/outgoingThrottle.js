"use strict";

/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  LAYER 7 — Outgoing Message Throttle & Burst Cooling
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *  Wraps api.sendMessage to enforce human-like sending rates:
 *
 *  • Per-thread limit: max N messages per thread in X minutes
 *    → adds cooling delay when limit approached
 *
 *  • Global limit: max M messages total in Y minutes
 *    → enters burst cooling (pause all sends) when exceeded
 *
 *  • Admin IDs are always exempt (zero throttle)
 *
 *  Facebook's automated-behavior detector looks for:
 *    - Identical response times across different threads
 *    - Too many messages sent per minute globally
 *    - Perfectly regular timing patterns
 *
 *  This module randomises all of the above.
 */

function log(level, msg) {
    const l = global.utils?.log;
    if (level === "warn") return l?.warn("THROTTLE", msg);
    if (level === "info") return l?.info("THROTTLE", msg);
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Per-thread tracking ─────────────────────────────────────────────────────
const threadSendTimes = new Map(); // threadID → [timestamps...]

// ─── Global tracking ─────────────────────────────────────────────────────────
const globalSendTimes = [];

// ─── Burst cooling state ──────────────────────────────────────────────────────
let burstCoolingUntil = 0;
let burstTriggerCount = 0;
let burstWindowStart  = Date.now();

// ─── Cleanup stale entries every 15 minutes ───────────────────────────────────
setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [tid, times] of threadSendTimes.entries()) {
        const fresh = times.filter(t => t > cutoff);
        if (fresh.length === 0) threadSendTimes.delete(tid);
        else threadSendTimes.set(tid, fresh);
    }
    const gi = globalSendTimes.findIndex(t => t > cutoff);
    if (gi > 0) globalSendTimes.splice(0, gi);
}, 15 * 60 * 1000);

function getConfig() {
    const cfg = global.GoatBot?.config?.stealth?.outgoingThrottle || {};
    return {
        enable:              cfg.enable !== false,
        maxPerThread:        cfg.maxPerThread        || 12,
        threadWindowMs:      (cfg.threadWindowMinutes || 5) * 60_000,
        maxGlobal:           cfg.maxGlobal           || 40,
        globalWindowMs:      (cfg.globalWindowMinutes || 10) * 60_000,
        coolingMinMs:        (cfg.coolingMinSeconds   || 15) * 1000,
        coolingMaxMs:        (cfg.coolingMaxSeconds   || 80) * 1000,
    };
}

function getBurstConfig() {
    const cfg = global.GoatBot?.config?.stealth?.burstCooling || {};
    return {
        enable:          cfg.enable !== false,
        triggerCount:    cfg.triggerCount         || 3,
        triggerWindowMs: (cfg.triggerWindowMinutes || 25) * 60_000,
        coolingMinMs:    (cfg.coolingMinMinutes    || 2) * 60_000,
        coolingMaxMs:    (cfg.coolingMaxMinutes    || 6) * 60_000,
    };
}

function isAdminExempt(threadID) {
    const admins  = (global.GoatBot?.config?.adminBot        || []).map(String);
    const supers  = (global.GoatBot?.config?.superAdminBot   || []).map(String);
    const all     = new Set([...admins, ...supers]);
    return all.has(String(threadID));
}

async function applyThrottle(threadID) {
    const cfg = getConfig();
    if (!cfg.enable) return;

    // Always exempt admin IDs
    if (isAdminExempt(threadID)) return;

    // ── Burst cooling check ───────────────────────────────────────────────────
    if (Date.now() < burstCoolingUntil) {
        const waitMs = burstCoolingUntil - Date.now();
        log("warn", `🧊 Burst cooling active — waiting ${Math.round(waitMs / 1000)}s before sending`);
        await sleep(waitMs);
    }

    const now = Date.now();

    // ── Per-thread check ──────────────────────────────────────────────────────
    if (!threadSendTimes.has(threadID)) threadSendTimes.set(threadID, []);
    const threadTimes = threadSendTimes.get(threadID).filter(t => now - t < cfg.threadWindowMs);
    threadSendTimes.set(threadID, threadTimes);

    if (threadTimes.length >= cfg.maxPerThread) {
        const delay = randInt(cfg.coolingMinMs, cfg.coolingMaxMs);
        log("warn", `🐢 Thread ${threadID}: ${threadTimes.length} msgs in window — cooling ${Math.round(delay / 1000)}s`);
        await sleep(delay);
    } else if (threadTimes.length >= Math.floor(cfg.maxPerThread * 0.7)) {
        // Approaching limit → add small random jitter
        const delay = randInt(2000, 8000);
        await sleep(delay);
    }

    // ── Global check ─────────────────────────────────────────────────────────
    const globalRecent = globalSendTimes.filter(t => now - t < cfg.globalWindowMs);
    globalSendTimes.length = 0;
    globalSendTimes.push(...globalRecent);

    if (globalSendTimes.length >= cfg.maxGlobal) {
        const delay = randInt(cfg.coolingMinMs * 2, cfg.coolingMaxMs * 2);
        log("warn", `⛔ Global rate limit: ${globalSendTimes.length} msgs in window — cooling ${Math.round(delay / 1000)}s`);

        // Check if this triggers a full burst cooling
        const burstCfg = getBurstConfig();
        if (burstCfg.enable) {
            if (now - burstWindowStart > burstCfg.triggerWindowMs) {
                burstTriggerCount = 0;
                burstWindowStart  = now;
            }
            burstTriggerCount++;
            if (burstTriggerCount >= burstCfg.triggerCount) {
                const coolingMs = randInt(burstCfg.coolingMinMs, burstCfg.coolingMaxMs);
                burstCoolingUntil = now + coolingMs;
                log("warn", `🚨 BURST DETECTED (${burstTriggerCount}x) — entering ${Math.round(coolingMs / 60000)} min cooling`);
                burstTriggerCount = 0;
                burstWindowStart  = now;
            }
        }

        await sleep(delay);
    }

    // ── Record this send ──────────────────────────────────────────────────────
    const ts = Date.now();
    threadSendTimes.get(threadID).push(ts);
    globalSendTimes.push(ts);
}

/**
 * Wraps api.sendMessage with outgoing throttle.
 * Call once after login: wrapSendMessage(api)
 */
function wrapSendMessage(api) {
    if (api.__throttleWrapped) return;
    api.__throttleWrapped = true;

    const _origSend = api.sendMessage.bind(api);

    api.sendMessage = async function(msg, threadID, callback, messageID) {
        try {
            await applyThrottle(String(threadID));
        } catch (_) {}
        return _origSend(msg, threadID, callback, messageID);
    };

    log("info", "✅ Outgoing throttle active on api.sendMessage");
}

module.exports = {
    wrapSendMessage,
    applyThrottle,
    getStatus() {
        return {
            burstCoolingUntil,
            burstCoolingActive: Date.now() < burstCoolingUntil,
            burstTriggerCount,
            globalQueueSize: globalSendTimes.length,
            trackedThreads:  threadSendTimes.size,
        };
    }
};
