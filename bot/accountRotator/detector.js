/**
 * Account Rotation Detector
 *
 * Monitors the bot for signs that the current Facebook account is
 * banned, spam-blocked, or restricted. Triggers rotation when detected.
 *
 * Detection signals:
 *  1. Consecutive message send failures across multiple threads
 *  2. Specific Facebook error codes (spam block, checkpoint, etc.)
 *  3. Session expiry detected by the keepAlive ping
 *  4. Error events from the MQTT listener
 *  5. Rate of delivery failures over a sliding window
 */

const { rotateAccount } = require("./index.js");

// ─── State ─────────────────────────────────────────────────────────────────
let sendFailures       = 0;   // consecutive send failures
let sendSuccesses      = 0;   // resets failure counter
let lastFailureTime    = 0;
let reportedBlockedAt  = 0;

const FAILURE_THRESHOLD    = 5;    // consecutive failures before rotation
const FAILURE_WINDOW_MS    = 60 * 1000; // only count failures within 60s
const BLOCK_COOLDOWN_MS    = 2 * 60 * 1000; // don't re-report within 2 min

// ─── Error pattern recognition ──────────────────────────────────────────────
const BLOCK_ERROR_PATTERNS = [
  // Account-level bans/blocks
  "spam",
  "block",
  "blocked",
  "checkpoint",
  "suspended",
  "disabled",
  "account_inactive",
  "login_blocked",
  "block spam",
  "OAuthException",
  // Message delivery failures
  "message not sent",
  "cannot send",
  "you can't send",
  "This account is not allowed",
  "temporarily blocked",
  "Too many requests",
  // Rate limiting
  "rate limit",
  "slow down"
];

function isBlockError(err) {
  if (!err) return false;
  const msg = (typeof err === "string" ? err : (err?.error || err?.message || JSON.stringify(err) || "")).toLowerCase();
  return BLOCK_ERROR_PATTERNS.some(pattern => msg.includes(pattern.toLowerCase()));
}

function log(level, msg) {
  const logger = global.utils?.log;
  if (level === "info")  return logger?.info ("ACCT_DETECTOR", msg);
  if (level === "warn")  return logger?.warn ("ACCT_DETECTOR", msg);
  if (level === "error") return logger?.err  ("ACCT_DETECTOR", msg);
}

async function triggerRotation(reason) {
  const now = Date.now();
  if (now - reportedBlockedAt < BLOCK_COOLDOWN_MS) return; // throttle
  reportedBlockedAt = now;
  sendFailures = 0;

  log("warn", `🚨 Block detected! Reason: "${reason}" — triggering account rotation...`);
  await rotateAccount(reason).catch(e =>
    log("error", "rotateAccount threw: " + e.message)
  );
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Call this when a message send attempt SUCCEEDS.
 */
module.exports.onSendSuccess = function () {
  sendSuccesses++;
  if (sendSuccesses >= 3) {
    // Multiple successes → reset failure counter
    sendFailures  = 0;
    sendSuccesses = 0;
  }
};

/**
 * Call this when a message send attempt FAILS.
 * @param {*} err - The error from api.sendMessage
 */
module.exports.onSendFailure = function (err) {
  const now = Date.now();
  sendSuccesses = 0;

  // Reset counter if failures are spread too far apart
  if (now - lastFailureTime > FAILURE_WINDOW_MS) {
    sendFailures = 0;
  }
  lastFailureTime = now;
  sendFailures++;

  const errStr = typeof err === "string" ? err : (err?.error || err?.message || "");
  log("warn", `Send failure #${sendFailures}: ${errStr}`);

  // Check for explicit block errors
  if (isBlockError(err)) {
    triggerRotation(`Send error: "${errStr}"`);
    return;
  }

  // Check consecutive failure threshold
  if (sendFailures >= FAILURE_THRESHOLD) {
    triggerRotation(`${sendFailures} consecutive send failures within ${FAILURE_WINDOW_MS / 1000}s`);
  }
};

/**
 * Call this when the MQTT listener reports an error.
 * @param {*} error
 */
module.exports.onMqttError = function (error) {
  if (!isBlockError(error)) return;
  const errStr = typeof error === "string" ? error : (error?.error || error?.message || JSON.stringify(error) || "");
  triggerRotation(`MQTT error: "${errStr}"`);
};

/**
 * Call this when the keepAlive ping detects a blocked/checkpoint page.
 * @param {string} reason
 */
module.exports.onPingDetectedBlock = function (reason) {
  triggerRotation(`Ping detected: "${reason}"`);
};

/**
 * Call this when the API returns a forbidden/checkpoint response.
 * @param {number} statusCode
 * @param {string} body
 */
module.exports.onHttpResponse = function (statusCode, body) {
  const cfg = global.GoatBot?.config?.accountRotation;
  if (!cfg?.enable) return;

  const bodyStr = typeof body === "string" ? body.toLowerCase() : "";
  const isBlocked =
    statusCode === 403 ||
    statusCode === 429 ||
    bodyStr.includes("checkpoint") ||
    bodyStr.includes("login_required") ||
    bodyStr.includes("blocked");

  if (isBlocked) {
    triggerRotation(`HTTP ${statusCode} response detected`);
  }
};

/**
 * Install hooks on the FCA API to monitor send calls automatically.
 * Call this once after api is ready.
 * @param {object} api - The fca-eryxenx API object
 */
module.exports.installApiHooks = function (api) {
  const cfg = global.GoatBot?.config?.accountRotation;
  if (!cfg?.enable) return;
  if (!api || typeof api.sendMessage !== "function") return;

  const original = api.sendMessage.bind(api);

  api.sendMessage = function (msg, threadID, callback, ...rest) {
    // Wrap the callback to intercept success/failure
    const wrappedCallback = (err, info) => {
      if (err) {
        module.exports.onSendFailure(err);
      } else {
        module.exports.onSendSuccess();
      }
      if (typeof callback === "function") callback(err, info);
    };

    return original(msg, threadID, wrappedCallback, ...rest);
  };

  log("info", "✅ API send hooks installed for account rotation detection.");
};
