const fs    = require("fs-extra");
const axios = require("axios");
const path  = require("path");

let pingTimer = null;
let saveTimer = null;
let isSaving  = false;

function getRandomMs(minMinutes, maxMinutes) {
        const minMs = minMinutes * 60 * 1000;
        const maxMs = maxMinutes * 60 * 1000;
        return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function doPing() {
        try {
                const api = global.GoatBot?.fcaApi;
                if (!api) return;

                const appState = api.getAppState();
                if (!appState || !appState.length) return;

                const cookieStr = appState.map(c => `${c.key}=${c.value}`).join("; ");
                // Use stealth engine's rotating UA when available, else fall back to config
                let userAgent;
                try {
                        const stealth = require("../stealth/index.js");
                        userAgent = stealth.isRunning() ? stealth.getCurrentUA() : null;
                } catch (_) {}
                userAgent = userAgent
                        || global.GoatBot.config?.facebookAccount?.userAgent
                        || "Mozilla/5.0 (Linux; Android 12; M2102J20SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 Mobile Safari/537.36";

                // Use HEAD first — no body downloaded (bandwidth & CPU efficient).
                // Fall back to minimal GET only to detect session expiry/spam page.
                let response;
                let body = "";
                try {
                        response = await axios.head("https://mbasic.facebook.com/", {
                                headers: {
                                        cookie: cookieStr,
                                        "user-agent":      userAgent,
                                        "accept":          "text/html,*/*;q=0.8",
                                        "accept-language": "en-US,en;q=0.9"
                                },
                                timeout: 10000,
                                validateStatus: null,
                                maxRedirects: 2,
                        });
                        // HEAD on a redirect means session expired — do a minimal GET to confirm
                        if (response.status === 302 || (response.headers?.location || "").includes("login")) {
                                const fullResp = await axios.get("https://mbasic.facebook.com/", {
                                        headers: { cookie: cookieStr, "user-agent": userAgent },
                                        timeout: 10000, validateStatus: null,
                                        maxContentLength: 32768, // cap at 32KB — enough to check for login form
                                });
                                body = fullResp.data || "";
                                response = fullResp;
                        }
                } catch (headErr) {
                        global.utils.log.warn("KEEP_ALIVE", "⚠️ Ping HEAD failed: " + (headErr.message || headErr));
                        return;
                }

                // FIX: check if facebook redirected to login page (session expired)
                const isSessionExpired =
                        response.status === 302 ||
                        (typeof body === "string" && (
                                body.includes("login_form") ||
                                body.includes("checkpoint") ||
                                body.includes("This content isn't available")
                        ));

                if (isSessionExpired) {
                        global.utils.log.warn("KEEP_ALIVE", "⚠️ Ping: session appears expired (login page detected).");
                        global.statusAccountBot = "session_expired";

                        // Try account rotation first, fall back to simple relogin
                        const rotationEnabled  = global.GoatBot?.config?.accountRotation?.enable;
                        const hasBackupAccounts = (global.GoatBot?.config?.accountRotation?.accounts?.length || 0) >= 2;

                        if (rotationEnabled && hasBackupAccounts) {
                                try {
                                        const detector = require("../accountRotator/detector.js");
                                        detector.onPingDetectedBlock("Session expired detected by keepAlive ping");
                                } catch (e) {
                                        global.utils.log.warn("KEEP_ALIVE", "Rotator unavailable: " + e.message);
                                        const reLoginBot = global.GoatBot?.reLoginBot;
                                        if (typeof reLoginBot === "function") reLoginBot();
                                }
                        } else {
                                const reLoginBot = global.GoatBot?.reLoginBot;
                                if (typeof reLoginBot === "function") reLoginBot();
                        }
                        return;
                }

                // Detect spam-block even on successful ping (e.g. checkpoint page with 200)
                const bodyStr = typeof body === "string" ? body.toLowerCase() : "";
                const isSpamBlocked =
                        bodyStr.includes("your account has been temporarily blocked") ||
                        bodyStr.includes("spam") ||
                        bodyStr.includes("we've detected automated behavior");

                if (isSpamBlocked) {
                        global.utils.log.warn("KEEP_ALIVE", "⚠️ Ping: spam/block page detected in response body.");
                        global.statusAccountBot = "spam_blocked";
                        try {
                                const detector = require("../accountRotator/detector.js");
                                detector.onPingDetectedBlock("Spam block page detected in keepAlive ping");
                        } catch (e) {}
                        return;
                }

                if (response.status >= 400) {
                        global.utils.log.warn("KEEP_ALIVE", `⚠️ Ping: unexpected HTTP ${response.status}`);
                        try {
                                const detector = require("../accountRotator/detector.js");
                                detector.onHttpResponse(response.status, body);
                        } catch (e) {}
                        return;
                }

                global.utils.log.info("KEEP_ALIVE", "✅ Ping sent — session active");
        } catch (e) {
                global.utils.log.warn("KEEP_ALIVE", "⚠️ Ping failed: " + (e.message || e));
        }
}

async function doSaveCookies(source) {
        if (isSaving) return;
        if (global.isRelogining) return;

        isSaving = true;
        try {
                const api = global.GoatBot?.fcaApi;
                if (!api) return;

                const appState = api.getAppState();
                if (!appState || !appState.length) return;

                const accountPath = path.join(process.cwd(), "account.txt");
                const current     = await fs.readFile(accountPath, "utf-8").catch(() => "");
                const newData     = JSON.stringify(appState, null, 2);

                if (current.trim() === newData.trim()) return;

                await fs.writeFile(accountPath, newData, "utf-8");
                global.utils.log.info("KEEP_ALIVE", `💾 Cookies saved to account.txt${source ? ` (${source})` : ""}`);
        } catch (e) {
                global.utils.log.warn("KEEP_ALIVE", "⚠️ Failed to save cookies: " + (e.message || e));
        } finally {
                isSaving = false;
        }
}

function schedulePing() {
        if (pingTimer) clearTimeout(pingTimer);
        const delay   = getRandomMs(8, 18);
        const minutes = Math.round(delay / 60000);
        pingTimer = setTimeout(async () => {
                await doPing();
                schedulePing();
        }, delay);
        global.utils.log.info("KEEP_ALIVE", `🔔 Next ping in ${minutes} min`);
}

function scheduleSave() {
        if (saveTimer) clearInterval(saveTimer);
        const interval = 2 * 60 * 60 * 1000;
        saveTimer = setInterval(async () => {
                // FIX: also restart save schedule after relogin completes
                if (global.isRelogining) return;
                await doSaveCookies("scheduled");
        }, interval);
}

module.exports = function startKeepAlive() {
        if (pingTimer) clearTimeout(pingTimer);
        if (saveTimer) clearInterval(saveTimer);

        global.utils.log.info(
                "KEEP_ALIVE",
                "🚀 Keep-alive started | HEAD-ping every 8–18 min | Cookies saved every 2h"
        );

        schedulePing();
        scheduleSave();
};

module.exports.stop = function () {
        if (pingTimer) clearTimeout(pingTimer);
        if (saveTimer) clearInterval(saveTimer);
        pingTimer = null;
        saveTimer = null;
};

module.exports.saveCookiesNow = function (source) {
        return doSaveCookies(source || "manual");
};
