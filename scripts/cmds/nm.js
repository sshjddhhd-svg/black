/**
 * /nm — Name Lock with random-interval restore
 *
 * /nm [name]          — lock group name
 * /unm                — unlock
 * /nm time [s]        — fixed delay (e.g. /nm time 9)
 * /nm time [min] [max]— random range  (e.g. /nm time 9 19)
 * /nm status          — show current settings
 */

// Persistent across hot-reloads: store timers on global to survive module cache re-use
if (!global._nmTimers)  global._nmTimers  = new Map();
if (!global._nmRetries) global._nmRetries = new Map();

const timers  = global._nmTimers;
const retries = global._nmRetries;

function isBotAdmin(senderID) {
  const adminBot = global.GoatBot?.config?.adminBot || [];
  return adminBot.map(id => String(id).trim()).includes(String(senderID));
}

/** Pick a random integer in [min, max] */
function randBetween(min, max) {
  if (min >= max) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Get the actual delay in ms for this restore cycle */
function getDelayMs(nmLock) {
  const min = nmLock.minDelay ?? nmLock.delay ?? 9;
  const max = nmLock.maxDelay ?? min;
  return randBetween(min, max) * 1000;
}

/** Schedule a restore with retry logic */
function scheduleRestore(api, threadsData, threadID, nmLock, delayMs) {
  // Cancel any pending restore for this thread
  if (timers.has(threadID)) {
    clearTimeout(timers.get(threadID));
    timers.delete(threadID);
  }

  const timer = setTimeout(async () => {
    timers.delete(threadID);

    // Re-read from DB in case settings changed
    let lock;
    try { lock = await threadsData.get(threadID, "data.nmLock"); } catch (_) { lock = nmLock; }
    if (!lock?.enabled || !lock?.name) return;

    // Attempt setTitle with up to 3 retries
    let attempt = 0;
    const maxAttempts = 3;
    const trySet = async () => {
      attempt++;
      try {
        await api.setTitle(lock.name, threadID);
        retries.delete(threadID);
      } catch (err) {
        if (attempt < maxAttempts) {
          // Exponential back-off: 2s, 4s
          const retryDelay = attempt * 2000;
          const t = setTimeout(trySet, retryDelay);
          retries.set(threadID, t);
        }
        // After max attempts, silently give up — next name-change event will trigger a fresh restore
      }
    };

    await trySet();
  }, delayMs);

  timers.set(threadID, timer);
}

// ─── Module ───────────────────────────────────────────────────────────────────

module.exports = {
  config: {
    name: "nm",
    version: "2.0",
    author: "Custom",
    countDown: 5,
    role: 0,
    description: "قفل اسم الغروب مع تأخير عشوائي",
    category: "group",
    guide: {
      en:
        "  {pn} [name]           — Lock group name\n" +
        "  /unm                  — Unlock group name\n" +
        "  {pn} time [s]         — Fixed restore delay (e.g. /nm time 9)\n" +
        "  {pn} time [min] [max] — Random range      (e.g. /nm time 9 19)\n" +
        "  {pn} status           — Show current settings"
    }
  },

  onStart: async function ({ api, event, args, message, threadsData }) {
    const { senderID, threadID } = event;
    if (!isBotAdmin(senderID)) return;

    const sub = (args[0] || "").toLowerCase();

    // ── /nm status ──────────────────────────────────────────────────────────
    if (sub === "status") {
      const lock = await threadsData.get(threadID, "data.nmLock");
      if (!lock?.name) {
        return message.reply("📋 Name lock is OFF for this group.");
      }
      const min = lock.minDelay ?? lock.delay ?? 9;
      const max = lock.maxDelay ?? min;
      const delayStr = min === max ? `${min}s` : `${min}–${max}s (random)`;
      return message.reply(
        `📋 Name Lock Status\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🔒 Status : ${lock.enabled ? "ON" : "OFF"}\n` +
        `📛 Name   : ${lock.name}\n` +
        `⏱ Delay  : ${delayStr}`
      );
    }

    // ── /nm time [min] [max?] ────────────────────────────────────────────────
    if (sub === "time") {
      const v1 = parseInt(args[1]);
      const v2 = parseInt(args[2]);

      if (isNaN(v1) || v1 < 1) {
        return message.reply(
          "❌ مثال:\n" +
          "  /nm time 9      — ثابت 9 ثوان\n" +
          "  /nm time 9 19   — عشوائي بين 9 و 19 ثانية"
        );
      }

      const current = await threadsData.get(threadID, "data.nmLock") || {};
      if (!current.name) {
        return message.reply("❌ لم يُقفل اسم بعد. استخدم /nm [الاسم] أولاً.");
      }

      if (!isNaN(v2) && v2 >= v1) {
        // Random range
        current.minDelay = v1;
        current.maxDelay = v2;
        current.delay    = v1; // backward compat
        await threadsData.set(threadID, current, "data.nmLock");
        return message.reply(
          `✅ تأخير الاستعادة: عشوائي بين ${v1} و ${v2} ثانية\n` +
          `كل مرة يتغير الاسم سيختار البوت وقتاً عشوائياً في هذا النطاق.`
        );
      } else {
        // Fixed
        current.minDelay = v1;
        current.maxDelay = v1;
        current.delay    = v1;
        await threadsData.set(threadID, current, "data.nmLock");
        return message.reply(`✅ تأخير الاستعادة: ثابت ${v1} ثانية`);
      }
    }

    // ── /nm [name] ───────────────────────────────────────────────────────────
    const name = args.join(" ").trim();
    if (!name) {
      return message.reply(
        "📋 أوامر قفل الاسم\n" +
        "━━━━━━━━━━━━━━━━━━\n" +
        "• /nm [الاسم]          — قفل اسم الغروب\n" +
        "• /unm                 — فتح قفل الاسم\n" +
        "• /nm time [ث]         — تأخير ثابت (مثال: /nm time 9)\n" +
        "• /nm time [ث1] [ث2]  — تأخير عشوائي (مثال: /nm time 9 19)\n" +
        "• /nm status           — عرض الإعدادات الحالية\n" +
        "━━━━━━━━━━━━━━━━━━\n" +
        "التأخير الافتراضي: 9 ثانية"
      );
    }

    // Preserve existing delay settings if already configured
    const existing = await threadsData.get(threadID, "data.nmLock") || {};
    const minDelay = existing.minDelay ?? 9;
    const maxDelay = existing.maxDelay ?? 9;

    const newLock = {
      name,
      delay:    minDelay,
      minDelay,
      maxDelay,
      enabled:  true
    };
    await threadsData.set(threadID, newLock, "data.nmLock");

    try { await api.setTitle(name, threadID); } catch (_) {}

    const delayStr = minDelay === maxDelay
      ? `${minDelay}s`
      : `${minDelay}–${maxDelay}s (عشوائي)`;

    return message.reply(
      `🔒 تم قفل اسم الغروب!\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📛 الاسم  : ${name}\n` +
      `⏱ التأخير: ${delayStr}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `إذا غيّر أحد الاسم سيُستعاد تلقائياً.\n` +
      `استخدم /unm للإلغاء.`
    );
  },

  onEvent: async function ({ api, event, threadsData }) {
    const { threadID, author, logMessageType } = event;
    if (logMessageType !== "log:thread-name") return;

    const botID = String(api.getCurrentUserID());
    if (String(author) === botID) return;

    let nmLock;
    try { nmLock = await threadsData.get(threadID, "data.nmLock"); } catch (_) { return; }
    if (!nmLock?.enabled || !nmLock?.name) return;

    const delayMs = getDelayMs(nmLock);
    scheduleRestore(api, threadsData, threadID, nmLock, delayMs);
  }
};
