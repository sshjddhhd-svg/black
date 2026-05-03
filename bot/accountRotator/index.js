/**
 * Account Rotator — Core Engine
 *
 * Automatically switches the bot to a backup Facebook account when the
 * current one is banned, restricted, or spam-blocked.
 *
 * Flow:
 *  1. Detector triggers rotateAccount()
 *  2. Mark current account as "restricted"
 *  3. Find next healthy account
 *  4. Login via fca-eryxenx and extract fresh cookies
 *  5. Save new cookies to account.txt
 *  6. Update currentIndex in config
 *  7. Notify all admins
 *  8. process.exit(2) → watchdog restarts bot with new account
 */

const login   = require("fca-eryxenx");
const fs      = require("fs-extra");
const path    = require("path");

// ─── State ─────────────────────────────────────────────────────────────────
let isRotating          = false;
let lastRotationTime    = 0;
const ROTATION_COOLDOWN = 3 * 60 * 1000; // 3 minutes between rotations
const MAX_ROTATION_ATTEMPTS = 3;
let rotationAttempts    = 0;

// ─── Helpers ───────────────────────────────────────────────────────────────
function log(level, msg) {
  const logger = global.utils?.log;
  if (level === "info")  return logger?.info ("ACCOUNT_ROTATOR", msg);
  if (level === "warn")  return logger?.warn ("ACCOUNT_ROTATOR", msg);
  if (level === "error") return logger?.err  ("ACCOUNT_ROTATOR", msg);
  console.log("[ACCOUNT_ROTATOR]", msg);
}

function notifyAdmins(message) {
  try {
    const api     = global.GoatBot?.fcaApi;
    const admins  = global.GoatBot?.config?.adminBot || [];
    const superAdmins = global.GoatBot?.config?.superAdminBot || [];
    const allAdmins   = [...new Set([...admins, ...superAdmins])];
    if (!api) return;
    for (const adminID of allAdmins) {
      const id = String(adminID).trim();
      if (!id) continue;
      api.sendMessage(message, id).catch(() => {});
    }
  } catch (e) {}
}

function getConfig() {
  return global.GoatBot?.config?.accountRotation || {};
}

function getAccounts() {
  return getConfig().accounts || [];
}

function getCurrentIndex() {
  return getConfig().currentIndex ?? 0;
}

function saveConfig() {
  try {
    const dirConfig = global.client?.dirConfig;
    if (!dirConfig) return;
    fs.writeFileSync(dirConfig, JSON.stringify(global.GoatBot.config, null, 2));
  } catch (e) {
    log("error", "Failed to save config: " + e.message);
  }
}

/**
 * Get the next available account index (skipping restricted ones).
 * Returns -1 if all accounts are restricted.
 */
function getNextAccountIndex() {
  const accounts = getAccounts();
  if (!accounts.length) return -1;

  const currentIdx = getCurrentIndex();
  const restricted = getConfig().restrictedIndexes || [];

  // Try next N accounts in rotation order
  for (let i = 1; i <= accounts.length; i++) {
    const idx = (currentIdx + i) % accounts.length;
    if (!restricted.includes(idx)) return idx;
  }

  // All restricted — reset restrictions and try again (they might have recovered)
  log("warn", "All accounts are restricted. Clearing restriction list and trying from index 0...");
  if (global.GoatBot?.config?.accountRotation) {
    global.GoatBot.config.accountRotation.restrictedIndexes = [];
    saveConfig();
  }
  return (currentIdx + 1) % accounts.length;
}

/**
 * Mark the current account as restricted so it's skipped on next rotation.
 */
function markCurrentAsRestricted() {
  const cfg = global.GoatBot?.config?.accountRotation;
  if (!cfg) return;
  if (!cfg.restrictedIndexes) cfg.restrictedIndexes = [];
  const current = getCurrentIndex();
  if (!cfg.restrictedIndexes.includes(current)) {
    cfg.restrictedIndexes.push(current);
    saveConfig();
    log("warn", `Account [${current}] marked as restricted.`);
  }
}

/**
 * Login to an account and return its appState (cookies).
 * @param {{ email: string, password: string, "2FASecret"?: string }} account
 * @returns {Promise<Array|null>}
 */
function loginAndGetCookies(account) {
  return new Promise((resolve) => {
    const credentials = { email: account.email, password: account.password };
    const options = {};

    log("info", `Logging in with account: ${account.email}`);

    login(credentials, options, (err, newApi) => {
      if (err) {
        const msg = err?.error || err?.message || String(err);
        log("error", `Login failed for ${account.email}: ${msg}`);
        resolve(null);
        return;
      }

      try {
        const appState = newApi.getAppState();
        if (!appState || !appState.length) {
          log("error", `Got empty appState for ${account.email}`);
          resolve(null);
          return;
        }
        log("info", `✅ Login successful for ${account.email}. Got ${appState.length} cookie(s).`);
        resolve(appState);
      } catch (e) {
        log("error", `Failed to extract appState: ${e.message}`);
        resolve(null);
      }
    });
  });
}

/**
 * Save appState to account.txt (replaces existing cookies).
 * @param {Array} appState
 */
async function saveCookies(appState) {
  const accountPath = path.join(process.cwd(), "account.txt");
  const data        = JSON.stringify(appState, null, 2);
  await fs.writeFile(accountPath, data, "utf-8");
  log("info", `💾 New cookies saved to account.txt (${appState.length} entries)`);
}

// ─── Main Rotation Function ─────────────────────────────────────────────────
/**
 * Rotate to the next available account.
 * @param {string} reason - Why the rotation was triggered
 * @returns {Promise<boolean>}
 */
module.exports.rotateAccount = async function rotateAccount(reason = "unknown") {
  // Guard: prevent concurrent rotations
  if (isRotating) {
    log("warn", "Rotation already in progress — skipping duplicate call.");
    return false;
  }

  // Guard: cooldown between rotations
  const now = Date.now();
  if (now - lastRotationTime < ROTATION_COOLDOWN) {
    const waitSec = Math.ceil((ROTATION_COOLDOWN - (now - lastRotationTime)) / 1000);
    log("warn", `Rotation cooldown active. Wait ${waitSec}s before next rotation.`);
    return false;
  }

  const cfg = getConfig();
  if (!cfg.enable) {
    log("info", "Account rotation is disabled in config.");
    return false;
  }

  const accounts = getAccounts();
  if (accounts.length < 2) {
    log("warn", "Need at least 2 accounts configured for rotation. Skipping.");
    return false;
  }

  if (rotationAttempts >= MAX_ROTATION_ATTEMPTS) {
    log("error", `Max rotation attempts (${MAX_ROTATION_ATTEMPTS}) reached. Manual intervention required.`);
    notifyAdmins(
      `⛔ ACCOUNT ROTATOR\n\n` +
      `Tried ${MAX_ROTATION_ATTEMPTS} account rotations — all failed or limit reached.\n` +
      `Manual intervention required!\n\n` +
      `Reason for last trigger: ${reason}`
    );
    return false;
  }

  isRotating = true;
  lastRotationTime = now;
  rotationAttempts++;

  const currentIdx = getCurrentIndex();
  const currentAccount = accounts[currentIdx];
  const label = currentAccount?.label || `Account #${currentIdx}`;

  log("warn", `⚠️ Rotation triggered! Reason: "${reason}"`);
  log("warn", `Current account: [${currentIdx}] ${currentAccount?.email || "?"}`);

  notifyAdmins(
    `🔄 ACCOUNT ROTATOR\n\n` +
    `⚠️ Trigger: ${reason}\n` +
    `📤 Switching away from: ${label} (${currentAccount?.email || "?"})\n` +
    `🔍 Finding next available account...`
  );

  // Mark current account as problematic
  markCurrentAsRestricted();

  // Find next account
  const nextIdx = getNextAccountIndex();
  if (nextIdx === -1) {
    log("error", "No backup accounts available.");
    notifyAdmins("❌ ACCOUNT ROTATOR\n\nNo backup accounts available. All accounts are restricted.");
    isRotating = false;
    return false;
  }

  const nextAccount = accounts[nextIdx];
  const nextLabel   = nextAccount?.label || `Account #${nextIdx}`;

  log("info", `Trying account [${nextIdx}]: ${nextAccount.email}`);
  notifyAdmins(
    `⏳ ACCOUNT ROTATOR\n\nAttempting login with:\n📧 ${nextLabel} (${nextAccount.email})\n\nPlease wait...`
  );

  // Login and get cookies
  const appState = await loginAndGetCookies(nextAccount);

  if (!appState) {
    log("error", `Failed to login with account [${nextIdx}]: ${nextAccount.email}`);

    // Mark this one as restricted too and try again recursively
    if (global.GoatBot?.config?.accountRotation) {
      if (!global.GoatBot.config.accountRotation.restrictedIndexes)
        global.GoatBot.config.accountRotation.restrictedIndexes = [];
      global.GoatBot.config.accountRotation.restrictedIndexes.push(nextIdx);
      saveConfig();
    }

    isRotating = false;
    notifyAdmins(`❌ Login failed for ${nextAccount.email}. Trying next account...`);

    // Try next after a short delay
    await new Promise(r => setTimeout(r, 5000));
    return module.exports.rotateAccount(`Previous login failed (${reason})`);
  }

  // Save new cookies to account.txt
  try {
    await saveCookies(appState);
  } catch (e) {
    log("error", "Failed to save cookies: " + e.message);
    isRotating = false;
    notifyAdmins(`❌ ACCOUNT ROTATOR\n\nLogin succeeded but failed to save cookies:\n${e.message}`);
    return false;
  }

  // Update config with new index and clear restrictions of the new account
  if (global.GoatBot?.config?.accountRotation) {
    global.GoatBot.config.accountRotation.currentIndex = nextIdx;
    global.GoatBot.config.accountRotation.lastRotationTime = new Date().toISOString();
    global.GoatBot.config.accountRotation.lastRotationReason = reason;

    // Remove new account from restricted list (it just worked)
    const restricted = global.GoatBot.config.accountRotation.restrictedIndexes || [];
    global.GoatBot.config.accountRotation.restrictedIndexes = restricted.filter(i => i !== nextIdx);

    saveConfig();
  }

  rotationAttempts = 0;

  log("info", `✅ Rotation complete! Switched to account [${nextIdx}]: ${nextAccount.email}`);
  notifyAdmins(
    `✅ ACCOUNT ROTATOR SUCCESS\n\n` +
    `📥 Now using: ${nextLabel} (${nextAccount.email})\n` +
    `🔄 Previous: ${label} (${currentAccount?.email || "?"})\n` +
    `💾 New cookies saved to account.txt\n` +
    `♻️ Bot is restarting in 3 seconds...\n\n` +
    `📝 All groups, commands, and data are preserved.`
  );

  isRotating = false;

  // Restart bot so it picks up the new account.txt
  setTimeout(() => process.exit(2), 3000);
  return true;
};

/**
 * Reset rotation state (call on successful login).
 */
module.exports.resetState = function () {
  isRotating       = false;
  rotationAttempts = 0;
};

/**
 * Get rotation status info.
 */
module.exports.getStatus = function () {
  const cfg      = getConfig();
  const accounts = getAccounts();
  const current  = getCurrentIndex();
  return {
    enabled:          cfg.enable || false,
    totalAccounts:    accounts.length,
    currentIndex:     current,
    currentEmail:     accounts[current]?.email || "?",
    currentLabel:     accounts[current]?.label || `Account #${current}`,
    restrictedIndexes: cfg.restrictedIndexes || [],
    lastRotationTime: cfg.lastRotationTime || null,
    lastRotationReason: cfg.lastRotationReason || null,
    isRotating,
    rotationAttempts
  };
};
