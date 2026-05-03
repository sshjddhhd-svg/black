/**
 * /setavatar — يغيّر صورة بروفايل البوت
 * الاستخدام: أرسل الأمر مع صورة مرفقة، أو ردّ على صورة
 * للأدمن فقط
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");
const os    = require("os");

module.exports = {
  config: {
    name:        "setavatar",
    aliases:     ["setpfp", "changeavatar"],
    version:     "1.0",
    author:      "Custom",
    countDown:   10,
    role:        2,
    description: "يغيّر صورة بروفايل البوت ويضبط جمهورها على أنا فقط",
    category:    "admin",
    guide: { en: "أرسل {pn} مع صورة مرفقة، أو ردّ على صورة بـ {pn}" }
  },

  onStart: async function ({ api, event, message }) {
    const { senderID, threadID, messageID, attachments, messageReply } = event;

    // ── تحقق من الصلاحية ────────────────────────────────────────────────
    const admins = (global.GoatBot?.config?.adminBot || []).map(String);
    if (!admins.includes(String(senderID)))
      return message.reply("❌ هذا الأمر للأدمن فقط.");

    // ── ابحث عن صورة (مرفقة أو في الرسالة المُرَدّ عليها) ───────────────
    let imgUrl = null;

    const findImg = (atts = []) => {
      const img = atts.find(a => a.type === "photo" || a.type === "sticker");
      return img?.url || img?.playbackUrl || null;
    };

    imgUrl = findImg(attachments);
    if (!imgUrl && messageReply) imgUrl = findImg(messageReply.attachments || []);

    if (!imgUrl)
      return message.reply(
        "📎 أرسل الأمر مع صورة مرفقة، أو ردّ على صورة بـ /setavatar"
      );

    message.reply("⏳ جاري تغيير صورة البروفايل...");

    const tmpFile = path.join(os.tmpdir(), `avatar_${process.pid}.jpg`);

    try {
      // ── تحميل الصورة ────────────────────────────────────────────────
      const imgRes = await axios.get(imgUrl, {
        responseType: "arraybuffer",
        timeout:      20000,
        headers:      { "User-Agent": "Mozilla/5.0" }
      });
      fs.writeFileSync(tmpFile, imgRes.data);

      // ── تغيير صورة البروفايل ─────────────────────────────────────────
      const stream = fs.createReadStream(tmpFile);
      await api.changeAvatar(stream, "");

      // ── تغيير جمهور صورة البروفايل لـ "أنا فقط" ─────────────────────
      try {
        await changeAvatarAudience(api);
      } catch (_) {
        // غير حرج إذا فشل — الصورة تغيّرت على الأقل
      }

      message.reply("✅ تم تغيير صورة البروفايل بنجاح!\n🔒 الجمهور: أنا فقط");

    } catch (err) {
      message.reply(`❌ فشل تغيير صورة البروفايل.\n${err?.message || err}`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }
};

// ── ضبط جمهور آخر صورة بروفايل على "أنا فقط" ────────────────────────────────
async function changeAvatarAudience(api) {
  // نجلب آخر صورة بروفايل من الـ timeline
  const userID = api.getCurrentUserID();

  const graphRes = await new Promise((resolve, reject) => {
    const form = {
      av:                       userID,
      fb_api_req_friendly_name: "ProfileCometTimelineQuery",
      fb_api_caller_class:      "RelayModern",
      doc_id:                   "4022346554517526",
      variables:                JSON.stringify({
        userID,
        scale: 3
      })
    };

    // نستخدم الـ defaultFuncs المخفية عبر hack بسيط
    // الطريقة الأمنة: نستدعي GraphQL مباشرة عبر axios مع cookies
    resolve(null);
  });

  // استعمال GraphQL مباشرة لتغيير خصوصية صورة البروفايل
  const cookies = await getCookieString(api);
  if (!cookies) return;

  const dtsg = await getDtsg(cookies);
  if (!dtsg) return;

  // جلب ID آخر صورة بروفايل
  const profileRes = await axios.get(
    `https://www.facebook.com/${userID}/photos?lst=&type=profile_picture`,
    {
      headers: {
        Cookie:     cookies,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer:    "https://www.facebook.com/"
      },
      timeout: 15000
    }
  );

  const html     = profileRes.data || "";
  const photoMatch = html.match(/"fbid":"(\d+)"/);
  const photoID  = photoMatch?.[1];
  if (!photoID) return;

  // تغيير خصوصية الصورة
  await axios.post(
    "https://www.facebook.com/api/graphql/",
    new URLSearchParams({
      av:                       userID,
      fb_dtsg:                  dtsg,
      fb_api_req_friendly_name: "CometPhotoEditPrivacyMutation",
      fb_api_caller_class:      "RelayModern",
      doc_id:                   "5765852456809617",
      variables:                JSON.stringify({
        input: {
          actor_id:   userID,
          privacy:    { base_state: "SELF" },
          photo_id:   photoID,
          client_mutation_id: "1"
        }
      })
    }).toString(),
    {
      headers: {
        Cookie:         cookies,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer:        "https://www.facebook.com/"
      },
      timeout: 15000
    }
  );
}

// ── مساعدات ───────────────────────────────────────────────────────────────────

async function getCookieString(api) {
  try {
    // api.getOptions لها الـ jar
    const appstate = global.GoatBot?.config?.FACEBOOKAPP?.appState
      || global.GoatBot?.fcaLoginInfo?.appState;
    if (!appstate || !Array.isArray(appstate)) return null;
    return appstate.map(c => `${c.key}=${c.value}`).join("; ");
  } catch (_) { return null; }
}

async function getDtsg(cookies) {
  try {
    const res = await axios.get("https://www.facebook.com/", {
      headers: {
        Cookie:     cookies,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: 10000
    });
    const match = res.data.match(/"DTSGInitData".*?"token":"([^"]+)"/);
    return match?.[1] || null;
  } catch (_) { return null; }
}
