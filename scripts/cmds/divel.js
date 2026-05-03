const fs   = require("fs-extra");
const path = require("path");

const dataPath = path.join(process.cwd(), "database/data/divelData.json");

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadData() {
  try {
    if (fs.existsSync(dataPath)) return JSON.parse(fs.readFileSync(dataPath, "utf8"));
  } catch (_) {}
  return {};
}

function saveData(data) {
  fs.ensureDirSync(path.dirname(dataPath));
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

// ─── Global state ─────────────────────────────────────────────────────────────

if (!global.GoatBot.divelWatchers) {
  global.GoatBot.divelWatchers = {};
}

// ─── Human-typing simulation ──────────────────────────────────────────────────
/**
 * Shows "typing..." indicator for a realistic duration, then sends the message.
 * Duration is proportional to message length + random jitter.
 *
 * @param {object} api
 * @param {string} threadID
 * @param {string} msg
 */
async function humanTypeSend(api, threadID, msg) {
  // ~55 ms per character, clamped between 1.5 s and 8 s, ±20% jitter
  const baseMs   = Math.min(Math.max(msg.length * 55, 1500), 8000);
  const jitter   = baseMs * (0.8 + Math.random() * 0.4); // 80%–120% of base
  const duration = Math.round(jitter);

  let stopTyping = null;
  try {
    stopTyping = api.sendTypingIndicator(threadID);
  } catch (_) {}

  await new Promise(r => setTimeout(r, duration));

  try { if (typeof stopTyping === "function") stopTyping(); } catch (_) {}

  await api.sendMessage({ body: msg, isDaydreamMode: true }, threadID);
}

// ─── استعادة الغروبات المفعّلة بعد إعادة تشغيل البوت ───────────────────────

function restoreWatchers() {
  if (global.GoatBot.divelRestored) return;
  global.GoatBot.divelRestored = true;

  const data    = loadData();
  let restored  = 0;

  for (const [threadID, td] of Object.entries(data)) {
    if (td.active && td.message) {
      global.GoatBot.divelWatchers[threadID] = {
        active:      true,
        message:     td.message,
        waitMinutes: td.waitMinutes || 5,
        timer:       null
      };
      restored++;
    }
  }

  if (restored > 0 && global.utils?.log?.info) {
    global.utils.log.info("DIVEL", `✅ Restored ${restored} watcher(s) after restart`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isBotAdmin(senderID) {
  const admins = global.GoatBot.config.adminBot || [];
  return admins.includes(String(senderID)) || admins.includes(senderID);
}

// ─── Module ───────────────────────────────────────────────────────────────────

module.exports = {
  config: {
    name:             "divel",
    aliases:          ["devil", "ديفل"],
    version:          "1.2",
    author:           "Djamel",
    countDown:        3,
    role:             0,
    shortDescription: "يراقب الغروب ويرد بعد N دقيقة من آخر رسالة",
    longDescription:  "عكس Angel — يراقب المحادثة بصمت، فإذا أرسل أحد رسالة ينتظر N دقيقة ثم يرد برسالته تلقائياً مع مؤشر كتابة بشري.",
    category:         "admin",
    guide: {
      en: "  {pn} on — تفعيل المراقبة في هذا الغروب\n"
        + "  {pn} off — إيقاف المراقبة\n"
        + "  {pn} change [رسالة] — تحديد الرسالة\n"
        + "  {pn} time [دقائق] — تحديد وقت الانتظار\n"
        + "  {pn} status — عرض الحالة\n\n"
        + "مثال:\n"
        + "  /divel change هيا تكلموا! 👿\n"
        + "  /divel time 5\n"
        + "  /divel on"
    }
  },

  // ─── يُستدعى عند كل رسالة في أي غروب ──────────────────────────────────────
  onChat: async function ({ api, event }) {
    const { threadID, senderID } = event;

    // تجاهل الرسائل التي ليس لها محتوى حقيقي
    if (!event.body && !(event.attachments && event.attachments.length)) return;

    // تجاهل رسائل البوت نفسه
    try {
      const botID = String(api.getCurrentUserID() || "");
      if (botID && String(senderID) === botID) return;
    } catch (_) {}

    restoreWatchers();

    const watcher = global.GoatBot.divelWatchers[threadID];
    if (!watcher || !watcher.active || !watcher.message) return;

    // إعادة ضبط المؤقت (debounce) — كل رسالة جديدة تُعيد العدّ
    if (watcher.timer) {
      clearTimeout(watcher.timer);
      watcher.timer = null;
    }

    const ms  = (watcher.waitMinutes || 5) * 60 * 1000;
    const tid = threadID;
    const msg = watcher.message;

    watcher.timer = setTimeout(async () => {
      const w = global.GoatBot.divelWatchers[tid];
      if (!w || !w.active) return;
      w.timer = null;

      try {
        // مؤشر كتابة بشري ثم إرسال الرسالة
        await humanTypeSend(api, tid, msg);
      } catch (err) {
        global.utils?.log?.err?.("DIVEL", "Failed to send message: " + err.message);
      }
    }, ms);
  },

  // ─── أوامر الإعداد ──────────────────────────────────────────────────────────
  onStart: async function ({ api, event, args, message }) {
    const { senderID, threadID } = event;

    if (!isBotAdmin(senderID)) return;

    restoreWatchers();

    const action = args[0]?.toLowerCase();
    const data   = loadData();

    if (!data[threadID]) {
      data[threadID] = { message: null, waitMinutes: 5, active: false };
    }
    const td = data[threadID];

    switch (action) {

      case "change": {
        const newMsg = args.slice(1).join(" ").trim();
        if (!newMsg) return message.reply("اكتب الرسالة بعد الأمر.");
        td.message = newMsg;
        saveData(data);
        if (global.GoatBot.divelWatchers[threadID]) {
          global.GoatBot.divelWatchers[threadID].message = newMsg;
        }
        return message.reply(`تم حفظ الرسالة: "${newMsg}"`);
      }

      case "time": {
        const mins = parseFloat(args[1]);
        if (isNaN(mins) || mins <= 0) return message.reply("اكتب عدد الدقائق.");
        td.waitMinutes = mins;
        saveData(data);
        const watcher = global.GoatBot.divelWatchers[threadID];
        if (watcher) {
          watcher.waitMinutes = mins;
          if (watcher.timer) { clearTimeout(watcher.timer); watcher.timer = null; }
        }
        return message.reply(`تم ضبط وقت الانتظار: ${mins} دقيقة`);
      }

      case "on": {
        if (!td.message) return message.reply("حدد الرسالة أولاً: /divel change [رسالتك]");
        if (global.GoatBot.divelWatchers[threadID]?.active) return message.reply("Divel مفعّل بالفعل.");
        td.active = true;
        saveData(data);
        global.GoatBot.divelWatchers[threadID] = {
          active:      true,
          message:     td.message,
          waitMinutes: td.waitMinutes || 5,
          timer:       null
        };
        return message.reply(
          `تم تفعيل Divel. ✅\n`
          + `📝 الرسالة: "${td.message}"\n`
          + `⏱️ الانتظار: ${td.waitMinutes} دقيقة\n`
          + `✍️ مؤشر الكتابة البشري: مفعّل`
        );
      }

      case "off": {
        const watcher = global.GoatBot.divelWatchers[threadID];
        if (!watcher?.active) return message.reply("Divel غير مفعّل.");
        if (watcher.timer) clearTimeout(watcher.timer);
        delete global.GoatBot.divelWatchers[threadID];
        td.active = false;
        saveData(data);
        return message.reply("تم إيقاف Divel. ✅");
      }

      case "status": {
        const watcher = global.GoatBot.divelWatchers[threadID];
        return message.reply(
          `الحالة: ${watcher?.active ? "مفعّل 🟢" : "موقوف 🔴"}\n`
          + `الرسالة: ${td.message ? `"${td.message}"` : "غير محددة"}\n`
          + `وقت الانتظار: ${td.waitMinutes} دقيقة\n`
          + `مؤشر الكتابة: ✍️ مفعّل دائماً`
        );
      }

      default:
        return message.reply(
          "الأوامر:\n"
          + "/divel change [رسالة]\n"
          + "/divel time [دقائق]\n"
          + "/divel on\n"
          + "/divel off\n"
          + "/divel status"
        );
    }
  }
};
