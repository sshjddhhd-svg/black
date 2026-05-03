const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

module.exports = {
  config: {
    name:        "pinterest",
    aliases:     ["pin", "pint"],
    version:     "1.0",
    author:      "nexo_here",
    countDown:   2,
    role:        0,
    description: "Search Pinterest and get image results",
    category:    "image",
    guide: {
      en: "{pn} [keyword] — Get Pinterest image results\nExample: {pn} Naruto"
    }
  },

  onStart: async function ({ api, event, args }) {
    const query = args.join(" ");
    if (!query)
      return api.sendMessage(
        "❗ Please provide a search keyword.\nExample: pinterest Naruto",
        event.threadID, event.messageID
      );

    // حاول 3 مرات إذا فشل الـ API
    const count = 5;
    // نطلب 3× العدد لضمان وجود 5 صور فريدة بعد إزالة المكرر
    const apiUrl = `https://betadash-api-swordslush-production.up.railway.app/pinterest?search=${encodeURIComponent(query)}&count=${count * 3}`;

    let imageList = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await axios.get(apiUrl, { timeout: 15000 });
        const data = res.data?.data;
        if (Array.isArray(data) && data.length > 0) { imageList = data; break; }
      } catch (_) {
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }

    if (!imageList)
      return api.sendMessage("❌ No results found!", event.threadID, event.messageID);

    // إزالة التكرار + تفضيل روابط originals (أعلى جودة)
    imageList = [...new Set(imageList)]
      .sort((a, b) => {
        const r = u => u.includes("originals") ? 0 : u.includes("736x") ? 1 : 2;
        return r(a) - r(b);
      });

    try {
      const attachments = [];
      const saved       = [];

      for (let i = 0; i < imageList.length && attachments.length < count; i++) {
        try {
          const imageRes = await axios.get(imageList[i], {
            responseType: "arraybuffer",
            timeout:      20000,
            headers:      { Referer: "https://www.pinterest.com/" }
          });
          const imagePath = path.join(__dirname, `pin_${process.pid}_${i}.jpg`);
          fs.writeFileSync(imagePath, imageRes.data);
          saved.push(imagePath);
          attachments.push(fs.createReadStream(imagePath));
        } catch (_) {
          // تخطّ الصورة المكسورة وكمّل
        }
      }

      if (!attachments.length)
        return api.sendMessage("🚫 Error fetching from Pinterest API.", event.threadID, event.messageID);

      api.sendMessage(
        { body: `🔍 Pinterest results for: "${query}"`, attachment: attachments },
        event.threadID,
        () => saved.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} }),
        event.messageID
      );

    } catch (err) {
      console.error(err);
      api.sendMessage("🚫 Error fetching from Pinterest API.", event.threadID, event.messageID);
    }
  }
};
