const axios = require("axios");
const fs    = require("fs-extra");
const path  = require("path");
const os    = require("os");

// ─── Extract shortcode from URL ───────────────────────────────────────────────
function extractShortcode(url) {
  const m = url.match(/instagram\.com\/(?:p|reel|tv|stories\/[^/]+)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// ─── Method 1: cobalt.tools (free, open-source, best reliability) ─────────────
async function tryCobalt(url) {
  const res = await axios.post(
    "https://api.cobalt.tools/",
    { url, vCodec: "h264", vQuality: "720", filenamePattern: "classic", isAudioOnly: false },
    {
      timeout: 25000,
      headers: {
        "Accept":       "application/json",
        "Content-Type": "application/json",
        "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    }
  );
  const d = res.data;
  if (!d) throw new Error("cobalt: empty response");

  // status: redirect | stream | tunnel | picker
  if (d.status === "error") throw new Error("cobalt: " + (d.text || "unknown error"));
  if (d.status === "picker" && d.picker?.length) {
    const vid = d.picker.find(p => p.type === "video") || d.picker[0];
    if (vid?.url) return vid.url;
    throw new Error("cobalt: picker but no video URL");
  }
  if (d.url) return d.url;
  throw new Error("cobalt: no URL in response (status=" + d.status + ")");
}

// ─── Method 2: snapinsta.app ──────────────────────────────────────────────────
async function trySnapinsta(url) {
  const res = await axios.post(
    "https://snapinsta.app/action.php",
    `url=${encodeURIComponent(url)}&lang=en`,
    {
      timeout: 20000,
      headers: {
        "Content-Type":     "application/x-www-form-urlencoded",
        "Origin":           "https://snapinsta.app",
        "Referer":          "https://snapinsta.app/",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    }
  );
  const html = typeof res.data === "object" ? JSON.stringify(res.data) : String(res.data);
  const mp4  = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
  if (mp4) return decodeURIComponent(mp4[0].replace(/\\u0026/g, "&").replace(/\\\//g, "/"));
  throw new Error("snapinsta: no mp4 found");
}

// ─── Method 3: reelsaver.net ──────────────────────────────────────────────────
async function tryReelsaver(url) {
  const res = await axios.post(
    "https://reelsaver.net/wp-json/aio-dl/video-data/",
    { url },
    {
      timeout: 20000,
      headers: {
        "Content-Type": "application/json",
        "Origin":       "https://reelsaver.net",
        "Referer":      "https://reelsaver.net/",
        "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    }
  );
  const medias = res.data?.medias || [];
  const vid    = medias.find(m => m.type === "video" || m.extension === "mp4");
  if (vid?.url) return vid.url;
  throw new Error("reelsaver: no video found");
}

// ─── Method 4: instavideosave.net ────────────────────────────────────────────
async function tryInstaVideoSave(url) {
  const res = await axios.post(
    "https://instavideosave.net/",
    `url=${encodeURIComponent(url)}`,
    {
      timeout: 20000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin":       "https://instavideosave.net",
        "Referer":      "https://instavideosave.net/",
        "User-Agent":   "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36"
      }
    }
  );
  const html = String(res.data);
  const mp4  = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s<>]*/);
  if (mp4) return decodeURIComponent(mp4[0].replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/&amp;/g, "&"));
  throw new Error("instavideosave: no mp4 found");
}

// ─── Method 5: oembed thumbnail + CDN guess ───────────────────────────────────
async function tryOembed(url) {
  const oembed = await axios.get(
    `https://www.instagram.com/oembed/?url=${encodeURIComponent(url)}`,
    {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0" }
    }
  );
  const thumbUrl = oembed.data?.thumbnail_url;
  if (!thumbUrl) throw new Error("oembed: no thumbnail");
  // Replace image CDN path with video CDN path pattern
  const videoUrl = thumbUrl
    .replace(/\/s\d+x\d+\//, "/")
    .replace(/_n\.jpg$/, "_n.mp4")
    .replace(/\.jpg$/, ".mp4");
  // Quick HEAD check
  await axios.head(videoUrl, { timeout: 8000 });
  return videoUrl;
}

// ─── Download video URL to temp file ─────────────────────────────────────────
async function downloadVideoUrl(videoUrl, tmpFile) {
  const res = await axios.get(videoUrl, {
    responseType: "arraybuffer",
    timeout: 120000,
    maxRedirects: 10,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer":    "https://www.instagram.com/"
    }
  });
  if (res.data.byteLength < 5000)
    throw new Error("Downloaded file too small — probably not a video (" + res.data.byteLength + " bytes)");
  fs.writeFileSync(tmpFile, res.data);
}

// ─── Try all methods in sequence ─────────────────────────────────────────────
async function getInstagramVideo(url) {
  const shortcode = extractShortcode(url);
  const errors    = [];

  const methods = [
    { name: "cobalt.tools",    fn: () => tryCobalt(url) },
    { name: "snapinsta",       fn: () => trySnapinsta(url) },
    { name: "reelsaver",       fn: () => tryReelsaver(url) },
    { name: "instavideosave",  fn: () => tryInstaVideoSave(url) },
    { name: "oembed-cdn",      fn: () => tryOembed(url) },
  ];

  for (const m of methods) {
    try {
      const videoUrl = await m.fn();
      if (videoUrl) return { method: m.name, videoUrl };
    } catch (e) {
      errors.push(`${m.name}: ${e.message.slice(0, 70)}`);
    }
  }

  throw new Error("All methods failed:\n" + errors.map(e => "• " + e).join("\n"));
}

// ─── Command ──────────────────────────────────────────────────────────────────
module.exports = {
  config: {
    name:        "instagram",
    aliases:     ["ig", "insta", "reel"],
    version:     "2.0",
    author:      "DJAMEL",
    countDown:   5,
    role:        0,
    description: "تحميل فيديو Instagram / Reel من الرابط",
    category:    "media",
    guide: {
      en: "{pn} <رابط الـ Reel>\nمثال: {pn} https://www.instagram.com/reel/ABC123/"
    }
  },

  onStart: async function ({ api, event, args, message }) {
    const url = args.join(" ").trim();

    if (!url)
      return message.reply(
        "📲 أرسل رابط Instagram أو Reel.\n\n" +
        "مثال:\n/ig https://www.instagram.com/reel/ABC123/"
      );

    if (!url.includes("instagram.com"))
      return message.reply("❌ الرابط يجب أن يكون من instagram.com");

    if (!extractShortcode(url))
      return message.reply(
        "❌ رابط غير صالح.\n" +
        "يجب أن يكون رابط Post أو Reel:\n" +
        "https://www.instagram.com/reel/ABC123/"
      );

    api.setMessageReaction("⏳", event.messageID, () => {}, true);
    const waitMsg = await message.reply("⏳ جاري تحميل الفيديو...");

    const tmpFile = path.join(os.tmpdir(), `ig_${process.pid}_${Date.now()}.mp4`);

    try {
      const { method, videoUrl } = await getInstagramVideo(url);
      await downloadVideoUrl(videoUrl, tmpFile);

      api.unsendMessage(waitMsg.messageID).catch(() => {});
      api.setMessageReaction("✅", event.messageID, () => {}, true);

      api.sendMessage(
        {
          body:       `🎬 Instagram Reel\n✅ تم التحميل عبر: ${method}`,
          attachment: fs.createReadStream(tmpFile)
        },
        event.threadID,
        () => { try { fs.unlinkSync(tmpFile); } catch (_) {} },
        event.messageID
      );

    } catch (err) {
      api.unsendMessage(waitMsg.messageID).catch(() => {});
      api.setMessageReaction("❌", event.messageID, () => {}, true);
      message.reply(
        "❌ لم أستطع تحميل الفيديو.\n\n" +
        "تأكد أن:\n" +
        "• الرابط صحيح وليس لحساب خاص\n" +
        "• يبدأ بـ https://www.instagram.com/reel/\n\n" +
        (process.env.DEBUG_IG ? "⚠️ " + err.message : "⚠️ Instagram قد يكون يحجب الطلبات مؤقتاً، جرّب لاحقاً.")
      );
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }
};
