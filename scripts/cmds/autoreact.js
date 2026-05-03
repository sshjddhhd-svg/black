module.exports = {
  config: {
    name: "autoreact",
    aliases: ["autoreacttoggle", "arreact", "autoreactoff", "autoreacton", "ar-toggle"],
    version: "4.4.0",
    author: "MOHAMMAD AKASH",
    role: 2,
    category: "system",
    shortDescription: "Auto react (emoji + text)",
    longDescription: "Stable auto reaction without silent API fail"
  },

  onStart: async function ({ event, args, threadsData, message }) {
    const { threadID } = event;
    const mode = (args[0] || "").toLowerCase();
    const current = await threadsData.get(threadID, "data.autoReactDisabled", false).catch(() => false);

    if (!mode || !["on", "off", "status"].includes(mode)) {
      return message.reply(`استخدم:\n/autoreact off\n/autoreact on\n/autoreact status\n\nالحالة الحالية: ${current ? "متوقف" : "شغال"}`);
    }

    if (mode === "status") {
      return message.reply(`التفاعل التلقائي في هذا الغروب: ${current ? "متوقف" : "شغال"}`);
    }

    const disabled = mode === "off";
    await threadsData.set(threadID, disabled, "data.autoReactDisabled");
    return message.reply(disabled ? "✅ تم إيقاف التفاعل التلقائي في هذا الغروب." : "✅ تم تشغيل التفاعل التلقائي في هذا الغروب.");
  },

  onChat: async function ({ api, event }) {
    try {
      const { messageID, body, senderID, threadID } = event;
      if (!messageID || !body) return;
      const disabled = await global.db?.threadsData?.get?.(threadID, "data.autoReactDisabled", false).catch(() => false);
      if (disabled) return;

      // ❌ নিজের / বটের মেসেজে রিয়েক্ট না
      if (senderID === api.getCurrentUserID()) return;

      // ❌ হালকা cooldown (2.5s)
      global.__autoReactCooldown ??= {};
      if (
        global.__autoReactCooldown[threadID] &&
        Date.now() - global.__autoReactCooldown[threadID] < 2500
      ) return;

      global.__autoReactCooldown[threadID] = Date.now();

      const text = body.toLowerCase();
      let react = null;

      // ==========================
      // Emoji Categories
      // ==========================
      const categories = [
        { e: ["😂","🤣","😆","😄","😁"], r: "😆" },
        { e: ["😭","😢","🥺","💔"], r: "😢" },
        { e: ["❤️","💖","💘","🥰","😍"], r: "❤️" },
        { e: ["😡","🤬"], r: "😡" },
        { e: ["😮","😱","😲"], r: "😮" },
        { e: ["😎","🔥","💯"], r: "😎" },
        { e: ["👍","👌","🙏"], r: "👍" },
        { e: ["🎉","🥳"], r: "🎉" }
      ];

      // ==========================
      // Text Triggers
      // ==========================
      const texts = [
        { k: ["haha","lol","moja","xd"], r: "😆" },
        { k: ["sad","kharap","mon kharap","cry"], r: "😢" },
        { k: ["love","valobasi","miss"], r: "❤️" },
        { k: ["rag","angry","rage"], r: "😡" },
        { k: ["wow","omg"], r: "😮" },
        { k: ["ok","yes","okay","hmm"], r: "👍" }
      ];

      // ==========================
      // Emoji check first
      // ==========================
      for (const c of categories) {
        if (c.e.some(x => text.includes(x))) {
          react = c.r;
          break;
        }
      }

      // ==========================
      // Text check
      // ==========================
      if (!react) {
        for (const t of texts) {
          if (t.k.some(x => text.includes(x))) {
            react = t.r;
            break;
          }
        }
      }

      // ❌ কিছু না মিললে রিয়েক্ট না
      if (!react) return;

      // ⏱ Human-like delay
      await new Promise(r => setTimeout(r, 800));

      // ✅ FINAL FIX — NO callback, NO true
      api.setMessageReaction(react, messageID);

    } catch (e) {}
  }
};
