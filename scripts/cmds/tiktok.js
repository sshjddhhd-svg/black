const axios = require("axios");
const fs    = require("fs-extra");
const path  = require("path");
const os    = require("os");

// TikWM — بحث مع عدد المشاهدات + تحميل بدون علامة مائية
const SEARCH_API = "https://www.tikwm.com/api/feed/search";

function formatViews(n) {
  if (!n) return "0";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(1)     + "M";
  if (n >= 1_000)         return (n / 1_000).toFixed(1)         + "K";
  return String(n);
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

module.exports = {
  config: {
    name:        "tiktok",
    aliases:     ["tt", "tik"],
    version:     "3.0",
    author:      "Custom",
    countDown:   5,
    role:        0,
    description: "ابحث في TikTok واختر فيديو لتحميله",
    category:    "media",
    guide: { en: "{pn} <كلمة البحث>\nمثال: {pn} gojo" }
  },

  onStart: async function ({ api, event, args, commandName, message }) {
    const query = args.join(" ").trim();
    if (!query)
      return message.reply("❗ اكتب كلمة البحث.\nمثال: /tik gojo");

    api.setMessageReaction("🔍", event.messageID, () => {}, true);
    const waitMsg = await message.reply(`🔍 جاري البحث في TikTok عن "${query}"...`);

    try {
      const res = await axios.get(SEARCH_API, {
        params:  { keywords: query, count: 6, cursor: 0, hd: 1 },
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      const videos = res.data?.data?.videos;
      if (!videos?.length) {
        api.unsendMessage(waitMsg.messageID).catch(() => {});
        api.setMessageReaction("❌", event.messageID, () => {}, true);
        return message.reply(`❌ لم أجد نتائج لـ "${query}".`);
      }

      // بناء القائمة
      let body = `🎵 نتائج TikTok لـ "${query}"\n`;
      body += "━━━━━━━━━━━━━━━━━━\n";

      videos.forEach((v, i) => {
        const title  = (v.title || v.content_desc || "بدون عنوان").slice(0, 55);
        const views  = formatViews(v.play_count);
        const dur    = formatDuration(v.duration || 0);
        const author = v.author?.nickname || v.author?.unique_id || "";
        body += `${i + 1}️⃣ ${title}\n`;
        body += `   👤 ${author}  ·  👁 ${views}  ·  ⏱ ${dur}\n\n`;
      });

      body += "━━━━━━━━━━━━━━━━━━\n";
      body += `📥 ردّ بالرقم (1-${videos.length}) لتحميل الفيديو`;

      api.unsendMessage(waitMsg.messageID).catch(() => {});
      api.setMessageReaction("✅", event.messageID, () => {}, true);

      api.sendMessage(
        { body },
        event.threadID,
        (err, info) => {
          if (err || !info) return;
          global.GoatBot.onReply.set(info.messageID, {
            commandName,
            author:    event.senderID,
            messageID: info.messageID,
            videos
          });
        },
        event.messageID
      );

    } catch (err) {
      api.unsendMessage(waitMsg.messageID).catch(() => {});
      api.setMessageReaction("❌", event.messageID, () => {}, true);
      message.reply("❌ خطأ في البحث، حاول مجدداً.");
    }
  },

  onReply: async function ({ api, event, Reply, message }) {
    const choice = parseInt(event.body);
    const { videos, messageID, author } = Reply;

    if (event.senderID !== author) return;
    if (isNaN(choice) || choice < 1 || choice > videos.length)
      return message.reply(`❌ رقم غير صحيح — أدخل رقماً بين 1 و ${videos.length}`);

    // احذف رسالة القائمة
    try { api.unsendMessage(messageID); } catch (_) {}

    const video = videos[choice - 1];
    const title = (video.title || video.content_desc || "TikTok").slice(0, 60);
    const views = formatViews(video.play_count);

    api.setMessageReaction("⏳", event.messageID, () => {}, true);
    const dlMsg = await message.reply(`⏳ جاري تحميل الفيديو...\n🎬 ${title}`);

    const tmpFile = path.join(os.tmpdir(), `tiktok_${process.pid}_${Date.now()}.mp4`);

    try {
      // تحميل الفيديو (بدون علامة مائية)
      const videoUrl = video.play || video.wmplay;
      if (!videoUrl) throw new Error("No video URL");

      const res = await axios.get(videoUrl, {
        responseType: "arraybuffer",
        timeout:      120000,
        headers:      { "User-Agent": "Mozilla/5.0", Referer: "https://www.tiktok.com/" }
      });

      fs.writeFileSync(tmpFile, res.data);

      api.unsendMessage(dlMsg.messageID).catch(() => {});
      api.setMessageReaction("✅", event.messageID, () => {}, true);

      api.sendMessage(
        {
          body:
            `🎵 ${title}\n` +
            `👤 ${video.author?.nickname || ""}\n` +
            `👁 ${views}  ·  ⏱ ${formatDuration(video.duration || 0)}`,
          attachment: fs.createReadStream(tmpFile)
        },
        event.threadID,
        () => { try { fs.unlinkSync(tmpFile); } catch (_) {} },
        event.messageID
      );

    } catch (err) {
      api.unsendMessage(dlMsg.messageID).catch(() => {});
      api.setMessageReaction("❌", event.messageID, () => {}, true);
      message.reply("❌ فشل تحميل الفيديو، جرّب مجدداً.");
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }
};
