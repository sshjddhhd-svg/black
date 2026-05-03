/**
 * /groupimg        — يغيّر صورة الغروب ويقفلها (يُعيد تطبيقها إذا غيّرها أحد)
 * /groupimg off    — يفك القفل
 * /groupimg status — يعرض الحالة
 *
 * - أدمن البوت أو أدمن الغروب
 * - عند إعادة تطبيق القفل لا يُرسل أي رسالة
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");
const os    = require("os");

// مجلد لحفظ صور القفل (تبقى بعد إعادة التشغيل)
const CACHE_DIR = path.join(__dirname, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function lockFile(tid) {
  return path.join(CACHE_DIR, `groupimg_lock_${tid}.jpg`);
}

function isBotAdmin(uid) {
  return (global.GoatBot?.config?.adminBot || []).map(String).includes(String(uid));
}

function isGroupAdmin(uid, tid) {
  const list = global.GoatBot?.allThreadData?.[tid]?.adminIDs || [];
  return list.some(a => String(a.id || a) === String(uid));
}

/** تغيير صورة الغروب بصمت (بدون رسالة) */
async function applyImage(api, tid, filePath) {
  await api.changeGroupImage(fs.createReadStream(filePath), tid);
}

module.exports = {
  config: {
    name:        "groupimg",
    aliases:     ["setgroupimg", "groupphoto"],
    version:     "2.0",
    author:      "Custom",
    countDown:   10,
    role:        1,
    description: "يغيّر صورة الغروب ويقفلها",
    category:    "admin",
    guide: {
      en:
        "  {pn} [+ صورة]   — غيّر الصورة وفعّل القفل\n" +
        "  {pn} off         — فك القفل\n" +
        "  {pn} status      — اعرض الحالة"
    }
  },

  // ── الأمر الرئيسي ─────────────────────────────────────────────────────────
  onStart: async function ({ api, event, args, message, threadsData }) {
    const { senderID, threadID, attachments, messageReply } = event;

    if (!isBotAdmin(senderID) && !isGroupAdmin(senderID, threadID))
      return message.reply("❌ هذا الأمر لأدمن الغروب أو أدمن البوت فقط.");

    const sub = (args[0] || "").toLowerCase();

    // ── /groupimg off ─────────────────────────────────────────────────────
    if (sub === "off") {
      await threadsData.set(threadID, false, "data.groupImgLock");
      // احذف ملف القفل إن وجد
      try { fs.unlinkSync(lockFile(threadID)); } catch (_) {}
      return message.reply("🔓 تم فك قفل صورة الغروب.");
    }

    // ── /groupimg status ──────────────────────────────────────────────────
    if (sub === "status") {
      const locked = !!fs.existsSync(lockFile(threadID));
      return message.reply(
        locked
          ? "🔒 قفل الصورة: مفعّل — البوت يُعيد تطبيق الصورة إذا غيّرها أحد."
          : "🔓 قفل الصورة: معطّل."
      );
    }

    // ── /groupimg [+ صورة] ────────────────────────────────────────────────
    const findImg = (atts = []) => {
      const img = atts.find(a => a.type === "photo");
      return img?.url || img?.largePreviewUrl || null;
    };

    let imgUrl = findImg(attachments);
    if (!imgUrl && messageReply) imgUrl = findImg(messageReply.attachments || []);

    if (!imgUrl)
      return message.reply(
        "📎 أرسل الأمر مع صورة مرفقة، أو ردّ على صورة بـ /groupimg\n" +
        "أو: /groupimg off — لفك القفل\n" +
        "أو: /groupimg status — لعرض الحالة"
      );

    message.reply("⏳ جاري تغيير صورة الغروب وتفعيل القفل...");

    const tmpFile = path.join(os.tmpdir(), `groupimg_${process.pid}_${Date.now()}.jpg`);

    try {
      // تحميل الصورة
      const imgRes = await axios.get(imgUrl, {
        responseType: "arraybuffer",
        timeout:      20000,
        headers:      { "User-Agent": "Mozilla/5.0", Referer: "https://www.facebook.com/" }
      });

      if (!(imgRes.headers["content-type"] || "").includes("image"))
        return message.reply("❌ الرابط لا يحتوي على صورة صالحة.");

      // احفظ في ملف مؤقت أولاً ثم انسخه لملف القفل الدائم
      fs.writeFileSync(tmpFile, imgRes.data);

      // تغيير الصورة
      await applyImage(api, threadID, tmpFile);

      // احفظ نسخة دائمة للقفل
      fs.copyFileSync(tmpFile, lockFile(threadID));
      await threadsData.set(threadID, true, "data.groupImgLock");

      message.reply("✅ تم تغيير صورة الغروب!\n🔒 القفل مفعّل — سأُعيد تطبيقها تلقائياً إذا غيّرها أحد.");

    } catch (err) {
      const msg = err?.message || String(err);
      message.reply(
        msg.includes("MQTT") || msg.includes("mqtt")
          ? "❌ انتهت الجلسة — انتظر ثم حاول مجدداً."
          : `❌ فشل تغيير صورة الغروب.\n${msg}`
      );
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  },

  // ── مراقبة تغييرات صورة الغروب وإعادة تطبيق القفل ─────────────────────
  onEvent: async function ({ api, event }) {
    if (event.logMessageType !== "log:thread-image") return;

    const { threadID, author } = event;
    const botID = String(api.getCurrentUserID());

    // إذا البوت هو من غيّر → تجاهل (منع الحلقة اللانهائية)
    if (String(author) === botID) return;

    // تحقق من وجود ملف القفل
    const lf = lockFile(threadID);
    if (!fs.existsSync(lf)) return;

    // منع تشغيل أكثر من عملية إعادة تطبيق في نفس الوقت للغروب نفسه
    if (!global._groupImgLocking) global._groupImgLocking = new Set();
    if (global._groupImgLocking.has(threadID)) return;
    global._groupImgLocking.add(threadID);

    // انتظر 5 ثوانٍ قبل إعادة التطبيق
    await new Promise(r => setTimeout(r, 5000));

    // أعد المحاولة 3 مرات بفاصل 4 ثوانٍ إذا فشلت
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // تأكد أن الملف لا يزال موجوداً (قد يُحذف بـ /groupimg off)
        if (!fs.existsSync(lf)) break;
        await applyImage(api, threadID, lf);
        break; // نجح → اخرج من الحلقة
      } catch (_) {
        if (attempt < 3) await new Promise(r => setTimeout(r, 4000 * attempt));
      }
    }

    global._groupImgLocking.delete(threadID);
  }
};
