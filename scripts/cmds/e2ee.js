/**
 * E2EE Command — Liberty Protocol Manager
 * كل الأوامر للأدمن فقط (role: 2)
 */

module.exports = {
    config: {
        name: "e2ee",
        version: "1.1",
        author: "Liberty Protocol Integration",
        countDown: 3,
        role: 2,
        description: {
            en: "Manage End-to-End Encryption (E2EE) sessions — Admin only"
        },
        category: "security",
        guide: {
            en: "   {pn} status — حالة نظام التشفير\n"
                + "   {pn} setpin <PIN> — تعيين PIN الماستر للبوت\n"
                + "   {pn} pin <PIN> — بدء جلسة مشفرة بـ PIN في هذه المحادثة\n"
                + "   {pn} handshake — مشاركة المفتاح العام (Liberty/X3DH)\n"
                + "   {pn} verify — التحقق أن الجلسة شغالة\n"
                + "   {pn} end — إنهاء جلسة التشفير الحالية\n"
                + "   {pn} sessions — عرض كل الجلسات النشطة\n"
                + "   {pn} encrypt <نص> — تشفير نص يدوياً\n"
                + "   {pn} decrypt <payload> — فك تشفير رسالة"
        }
    },

    langs: {
        en: {
            adminOnly:     "❌ هذا الأمر للأدمن فقط.",
            notInit:       "⚠️ نظام E2EE غير مهيأ. استخدم:\n{pn} setpin <PIN>",
            status:        "🔒 Liberty E2EE — الحالة\n━━━━━━━━━━━━━━━━\n✅ الوحدة: %1\n🔑 الجلسة: %2\n📡 الوضع: %3\n📤 مُرسَل: %4\n📥 مُستقبَل: %5",
            noSession:     "لا توجد جلسة نشطة",
            sessionActive: "نشطة (وضع %1)",
            handshake:     "🔑 Liberty Protocol — المفتاح العام\n━━━━━━━━━━━━━━━━\nأرسل هذا للطرف الآخر لبدء جلسة X3DH:\n\n%1",
            pinStarted:    "🔒 جلسة PIN بدأت بنجاح!\n━━━━━━━━━━━━━━━━\nكل الرسائل ستُشفَّر بالـ PIN.\n⚠️ اجعل الـ PIN سراً — الطرفان يحتاجانه.",
            pinMissing:    "❌ أدخل الـ PIN. مثال: {pn} pin <الرقم>",
            sessionEnded:  "🔓 جلسة التشفير أُنهيت لهذه المحادثة.",
            noActiveSession: "ℹ️ لا توجد جلسة نشطة في هذه المحادثة.",
            sessions:      "🔒 الجلسات النشطة (%1)\n━━━━━━━━━━━━━━━━\n%2",
            sessionEntry:  "• ID: %1\n  الوضع: %2\n  آخر نشاط: %3\n",
            noSessions:    "لا توجد جلسات نشطة حالياً.",
            verifyOk:      "✅ الجلسة نشطة وتعمل!\nالوضع: %1 | مُرسَل: %2 | مُستقبَل: %3",
            verifyFail:    "❌ لا توجد جلسة نشطة. ابدأ بـ:\n{pn} pin <PIN>",
            pinSet:        "✅ تم تعيين PIN الماستر وتوليد المفاتيح بنجاح.\nالبوت الآن جاهز للتشفير الكامل.",
            pinFail:       "❌ فشل تعيين PIN: %1",
            encrypted:     "🔒 الرسالة المشفرة:\n\n%1",
            decrypted:     "🔓 الرسالة بعد فك التشفير:\n\n%1",
            decryptFail:   "❌ فشل فك التشفير. تأكد أن الجلسة نشطة وأن الـ PIN صحيح.",
            encryptFail:   "❌ فشل التشفير. ابدأ جلسة أولاً: {pn} pin <PIN>",
            noText:        "❌ أدخل النص المطلوب.",
            noPinInConfig: "ℹ️ لا يوجد PIN في config.json حالياً.\n\nالبوت في وضع الاستقبال السلبي فقط.\nلتفعيل التشفير الكامل:\n{pn} setpin <PIN الخاص بك>"
        }
    },

    onStart: async function ({ api, event, args, message, role }) {
        const e2ee = global.e2ee;
        const sub = (args[0] || "status").toLowerCase();
        const senderID = event.senderID;
        const threadID = event.threadID;

        const pref = global.GoatBot.config.prefix + "e2ee";
        const getText = (key, ...a) => {
            let t = this.langs.en[key] || key;
            a.forEach((v, i) => { t = t.replace(`%${i + 1}`, v); });
            return t.replace(/\{pn\}/g, pref);
        };

        // التحقق من صلاحية الأدمن — role:2 يعني adminBot
        // لكن نتحقق يدوياً أيضاً ليشمل superAdminBot
        const adminList = [
            ...(global.GoatBot.config.adminBot || []),
            ...(global.GoatBot.config.superAdminBot || [])
        ].map(String);
        const isAdmin = adminList.includes(String(senderID));

        if (!isAdmin) return message.reply(getText("adminOnly"));

        switch (sub) {

            // ─── الحالة ───────────────────────────────────────────────
            case "status": {
                const active = e2ee?.isActive?.() ? "مُفعَّلة ✅" : "غير مُفعَّلة ❌";
                const sess = e2ee?.getSessionInfo?.(threadID)
                          || e2ee?.getSessionInfo?.(senderID);
                const mode = sess ? sess.mode : "none";
                const sent = sess?.sendCount ?? 0;
                const recv = sess?.recvCount ?? 0;
                const sessStr = sess
                    ? getText("sessionActive", sess.mode)
                    : getText("noSession");

                const hasPinInConfig = !!(global.GoatBot.config.e2ee?.pin);
                const pinStatus = hasPinInConfig
                    ? "✅ PIN موجود في config.json"
                    : "⚠️ لا يوجد PIN — " + getText("noPinInConfig").split("\n")[0];

                return message.reply(
                    getText("status", active, sessStr, mode, sent, recv)
                    + `\n🔐 PIN: ${pinStatus}`
                );
            }

            // ─── تعيين PIN الماستر ────────────────────────────────────
            case "setpin": {
                const pin = args.slice(1).join(" ").trim();
                if (!pin) return message.reply(getText("pinMissing"));
                try {
                    const keyStore = require("../../bot/e2ee/keyStore");
                    keyStore.initialize(pin);
                    if (!global.e2ee) {
                        global.e2ee = require("../../bot/e2ee/index");
                    }
                    global.e2ee.init(pin);

                    // حفظ PIN في config.json تلقائياً
                    const fs = require("fs-extra");
                    const cfg = global.GoatBot.config;
                    if (!cfg.e2ee) cfg.e2ee = {};
                    cfg.e2ee.pin = pin;
                    fs.writeJSONSync(global.client.dirConfig, cfg, { spaces: 2 });

                    return message.reply(getText("pinSet"));
                } catch (err) {
                    return message.reply(getText("pinFail", err.message));
                }
            }

            // ─── بدء جلسة PIN ────────────────────────────────────────
            case "pin": {
                const pin = args.slice(1).join(" ").trim();
                if (!pin) return message.reply(getText("pinMissing"));
                if (!e2ee) return message.reply(getText("notInit"));
                e2ee.startPinSession(threadID, pin);
                e2ee.startPinSession(senderID, pin);
                return message.reply(getText("pinStarted"));
            }

            // ─── مصافحة Liberty/X3DH ─────────────────────────────────
            case "handshake": {
                if (!e2ee?.isActive?.()) return message.reply(getText("notInit"));
                const packet = e2ee.getHandshakePacket();
                if (!packet) return message.reply(getText("notInit"));
                return message.reply(getText("handshake", packet));
            }

            // ─── التحقق من الجلسة ─────────────────────────────────────
            case "verify": {
                const sess = e2ee?.getSessionInfo?.(threadID)
                          || e2ee?.getSessionInfo?.(senderID);
                if (!sess) return message.reply(getText("verifyFail"));
                return message.reply(getText("verifyOk", sess.mode, sess.sendCount, sess.recvCount));
            }

            // ─── إنهاء الجلسة ────────────────────────────────────────
            case "end": {
                const s1 = e2ee?.getSessionInfo?.(threadID);
                const s2 = e2ee?.getSessionInfo?.(senderID);
                if (!s1 && !s2) return message.reply(getText("noActiveSession"));
                e2ee.terminateSession(threadID);
                e2ee.terminateSession(senderID);
                return message.reply(getText("sessionEnded"));
            }

            // ─── كل الجلسات النشطة ───────────────────────────────────
            case "sessions": {
                const sessions = e2ee?.listSessions?.() || [];
                if (!sessions.length) return message.reply(getText("noSessions"));
                const list = sessions.map(s =>
                    getText("sessionEntry", s.participantID, s.mode,
                        new Date(s.lastActivity).toLocaleString("ar"))
                ).join("\n");
                return message.reply(getText("sessions", sessions.length, list));
            }

            // ─── تشفير يدوي ──────────────────────────────────────────
            case "encrypt": {
                const text = args.slice(1).join(" ").trim();
                if (!text) return message.reply(getText("noText"));
                if (!e2ee) return message.reply(getText("notInit"));
                const sessID = e2ee.getSessionInfo?.(threadID) ? threadID : senderID;
                const encrypted = e2ee.encryptOutgoing?.(sessID, text);
                if (!encrypted) return message.reply(getText("encryptFail"));
                return message.reply(getText("encrypted", encrypted));
            }

            // ─── فك تشفير يدوي ───────────────────────────────────────
            case "decrypt": {
                const payload = args.slice(1).join(" ").trim();
                if (!payload) return message.reply(getText("noText"));
                const sessID = e2ee?.getSessionInfo?.(threadID) ? threadID : senderID;
                try {
                    const sessionManager = require("../../bot/e2ee/sessionManager");
                    const result = sessionManager.decryptFrom(sessID, payload);
                    if (!result || result.type !== "message") return message.reply(getText("decryptFail"));
                    return message.reply(getText("decrypted", result.plaintext));
                } catch {
                    return message.reply(getText("decryptFail"));
                }
            }

            // ─── مساعدة ──────────────────────────────────────────────
            default:
                return message.reply(
                    "🔒 Liberty E2EE — الأوامر (للأدمن فقط)\n"
                    + "━━━━━━━━━━━━━━━━\n"
                    + `${pref} status        ← حالة النظام\n`
                    + `${pref} setpin <PIN>  ← تعيين PIN الماستر\n`
                    + `${pref} pin <PIN>     ← بدء جلسة في هذه المحادثة\n`
                    + `${pref} handshake     ← مشاركة المفتاح العام\n`
                    + `${pref} verify        ← التحقق من الجلسة\n`
                    + `${pref} end           ← إنهاء الجلسة\n`
                    + `${pref} sessions      ← كل الجلسات النشطة\n`
                    + `${pref} encrypt <نص> ← تشفير يدوي\n`
                    + `${pref} decrypt <..>  ← فك تشفير يدوي`
                );
        }
    }
};
