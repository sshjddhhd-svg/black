/**
 * /nick [اسم]  — يغيّر كنية جميع الأعضاء للاسم المحدد ويستمر إلى الأبد
 * /nick off    — إيقاف
 *
 * - أدمن البوت فقط
 * - إذا غيّر أدمن البوت كنية شخص يدوياً → تُثبَّت (لا يتجاوزها الأمر)
 * - إذا غيّر عضو عادي كنيته → البوت يُعيدها فوراً
 */

if (!global._nickRunning)  global._nickRunning  = new Set();
if (!global._nickStopping) global._nickStopping = new Set();

// ── مساعدات ────────────────────────────────────────────────────────────────

function isBotAdmin(uid) {
  return (global.GoatBot?.config?.adminBot || [])
    .map(String).includes(String(uid));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sleepOrStop(ms, tid) {
  const step = 200;
  let elapsed = 0;
  while (elapsed < ms) {
    if (global._nickStopping.has(tid)) return;
    await sleep(Math.min(step, ms - elapsed));
    elapsed += step;
  }
}

/**
 * قراءة lock بأمان — يُرجع null عند الفشل (لا يُرجع {} لتجنب الخلط)
 */
async function loadLock(threadsData, tid) {
  try {
    const val = await threadsData.get(tid, "data.nickLock");
    return (val && typeof val === "object") ? val : null;
  } catch (_) { return null; }
}

async function saveLock(threadsData, tid, lock) {
  try { await threadsData.set(tid, lock, "data.nickLock"); } catch (_) {}
}

// ── الحلقة الرئيسية ────────────────────────────────────────────────────────

async function runCycle(api, threadsData, tid) {
  if (global._nickRunning.has(tid)) return;
  global._nickRunning.add(tid);
  global._nickStopping.delete(tid);

  const botID = String(api.getCurrentUserID());
  let dbErrors = 0;

  try {
    while (!global._nickStopping.has(tid)) {

      // قراءة الإعدادات
      const lock = await loadLock(threadsData, tid);

      // فشل قراءة DB → انتظر وأعد المحاولة (لا تتوقف)
      if (!lock) {
        dbErrors++;
        if (dbErrors > 15) break; // تخلّ بعد 15 فشل متتالي
        await sleepOrStop(5000, tid);
        continue;
      }
      dbErrors = 0;

      // إيقاف صريح
      if (!lock.enabled || !lock.name) break;

      const targetName = lock.name;
      const pinned     = lock.pinned || {};

      // جلب الأعضاء
      let members = [];
      try {
        const info = await api.getThreadInfo(tid);
        members = (info.participantIDs || []).filter(id => String(id) !== botID);
      } catch (_) {
        await sleepOrStop(15000, tid);
        continue;
      }

      if (!members.length) { await sleepOrStop(10000, tid); continue; }

      members.sort(() => Math.random() - 0.5);

      for (const uid of members) {
        if (global._nickStopping.has(tid)) break;
        if (pinned[String(uid)]) continue;

        try { await api.changeNickname(targetName, tid, uid); }
        catch (_) {}

        await sleepOrStop(5000, tid);
      }

      await sleepOrStop(3000, tid);
    }
  } finally {
    global._nickRunning.delete(tid);
    global._nickStopping.delete(tid);
  }
}

// ── Module ─────────────────────────────────────────────────────────────────

module.exports = {
  config: {
    name: "nick",
    version: "3.0",
    author: "Custom",
    countDown: 3,
    role: 2,
    description: "تغيير كنيات جميع الأعضاء لاسم واحد باستمرار",
    category: "admin",
    guide: {
      en:
        "  {pn} [اسم]    — شغّل وغيّر كنيات الكل لهذا الاسم\n" +
        "  {pn} off      — أوقف الأمر\n" +
        "  {pn} status   — الحالة الحالية\n" +
        "  {pn} reset    — أزل كنيات الكل\n" +
        "  {pn} unpin [ID/@mention] — فك تثبيت شخص"
    }
  },

  onStart: async function ({ api, event, args, message, threadsData }) {
    const { senderID, threadID } = event;
    if (!isBotAdmin(senderID)) return;

    const sub  = (args[0] || "").toLowerCase();
    const name = args.join(" ").trim();

    // ── /nick off ──────────────────────────────────────────────────────────
    if (sub === "off") {
      const lock = await loadLock(threadsData, threadID);
      if (lock) {
        lock.enabled = false;
        await saveLock(threadsData, threadID, lock);
      }
      global._nickStopping.add(threadID);
      return message.reply("🛑 تم إيقاف أمر الكنيات.");
    }

    // ── /nick status ────────────────────────────────────────────────────────
    if (sub === "status") {
      const lock    = await loadLock(threadsData, threadID);
      const running = global._nickRunning.has(threadID);
      const pins    = Object.keys(lock?.pinned || {}).length;
      return message.reply(
        "📊 حالة أمر الكنيات\n" +
        "━━━━━━━━━━━━━━━━━━\n" +
        `▶️ الحالة  : ${running ? "🟢 يعمل" : "🔴 متوقف"}\n` +
        `📛 الاسم   : ${lock?.name || "—"}\n` +
        `📌 مثبتون : ${pins} شخص`
      );
    }

    // ── /nick reset ─────────────────────────────────────────────────────────
    if (sub === "reset") {
      message.reply("⏳ جاري إزالة جميع الكنيات...");
      let info;
      try { info = await api.getThreadInfo(threadID); }
      catch (_) { return message.reply("❌ فشل في جلب معلومات الغروب."); }

      const botID   = String(api.getCurrentUserID());
      const members = (info.participantIDs || []).filter(id => String(id) !== botID);
      let done = 0;
      for (const uid of members) {
        try { await api.changeNickname("", threadID, uid); done++; } catch (_) {}
        await sleep(2000);
      }
      return message.reply(`✅ تمت إزالة كنيات ${done}/${members.length} عضو.`);
    }

    // ── /nick unpin ─────────────────────────────────────────────────────────
    if (sub === "unpin") {
      const mentionIDs = Object.keys(event.mentions || {});
      const targetID   = String(mentionIDs[0] || args[1] || "");
      if (!targetID) return message.reply("❌ حدد الشخص: /nick unpin [ID] أو @منشن");

      const lock = await loadLock(threadsData, threadID);
      if (!lock?.pinned?.[targetID])
        return message.reply("⚠️ هذا الشخص ليس لديه كنية مثبتة.");

      delete lock.pinned[targetID];
      await saveLock(threadsData, threadID, lock);
      return message.reply("✅ فُك تثبيت كنية هذا الشخص — سيُغيّرها الأمر في الدورة التالية.");
    }

    // ── /nick (بدون وسيطة) ─────────────────────────────────────────────────
    if (!name) {
      return message.reply(
        "📋 أمر الكنيات\n━━━━━━━━━━━━━━━━━━\n" +
        "• /nick [اسم]   — شغّل وغيّر كنيات الكل لهذا الاسم\n" +
        "• /nick off     — أوقف الأمر\n" +
        "• /nick status  — الحالة الحالية\n" +
        "• /nick reset   — أزل كنيات الكل\n" +
        "• /nick unpin [ID/@mention] — فك تثبيت شخص\n" +
        "━━━━━━━━━━━━━━━━━━\n" +
        "📌 غيّر كنية شخص يدوياً (كأدمن) → البوت لن يتجاوزها أبداً."
      );
    }

    // ── /nick [اسم] ─────────────────────────────────────────────────────────
    const existing = await loadLock(threadsData, threadID);
    const lock = existing || {};
    lock.name    = name;
    lock.enabled = true;
    if (!lock.pinned) lock.pinned = {};
    await saveLock(threadsData, threadID, lock);

    if (global._nickRunning.has(threadID)) {
      return message.reply(
        `✅ تم تحديث الاسم إلى: "${name}"\n` +
        "سيُطبَّق على الكل في الدورة التالية."
      );
    }

    message.reply(
      `🔄 تشغيل أمر الكنيات!\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📛 الاسم المستهدف: ${name}\n` +
      `⏱ 5 ثوانٍ بين كل عضو\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `اكتب /nick off للإيقاف`
    );

    runCycle(api, threadsData, threadID).catch(() => {});
  },

  // ── مراقبة تغييرات الكنيات ──────────────────────────────────────────────
  onEvent: async function ({ api, event, threadsData }) {
    if (event.logMessageType !== "log:user-nickname") return;

    const { threadID, author, logMessageData } = event;
    const botID   = String(api.getCurrentUserID());
    const changer = String(author || "");
    const target  = String(logMessageData?.participant_id || "");
    const newNick = logMessageData?.nickname || "";

    if (!changer || !target) return;
    if (changer === botID)   return; // تغيير البوت نفسه — تجاهل

    if (isBotAdmin(changer) && target !== botID) {
      // ── أدمن البوت غيّر كنية شخص يدوياً → ثبّتها ──────────────────────
      // اقرأ lock أولاً — إذا فشلت لا تحفظ لتجنب تخريب البيانات
      const lock = await loadLock(threadsData, threadID);
      if (!lock) return;

      if (!lock.pinned) lock.pinned = {};
      if (newNick) {
        lock.pinned[target] = newNick;  // تثبيت
      } else {
        delete lock.pinned[target];     // فك التثبيت
      }
      await saveLock(threadsData, threadID, lock);

    } else if (!isBotAdmin(changer) && target !== botID) {
      // ── عضو عادي غيّر كنيته → أعد تطبيق الاسم المستهدف فوراً ──────────
      if (!global._nickRunning.has(threadID)) return;

      const lock = await loadLock(threadsData, threadID);
      if (!lock?.enabled || !lock?.name) return;
      if (lock.pinned?.[target]) return; // محمي من أدمن — لا تتدخل

      setTimeout(async () => {
        try { await api.changeNickname(lock.name, threadID, target); }
        catch (_) {}
      }, 5000);
    }
  }
};
