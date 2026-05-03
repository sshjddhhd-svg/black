const { log } = global.utils;

module.exports = async function ({ api, threadModel, userModel, dashBoardModel, globalModel, threadsData, usersData, dashBoardData, globalData, getText }) {

        setInterval(async () => {
                api.refreshFb_dtsg()
                        .then(() => { log.succes("refreshFb_dtsg", getText("custom", "refreshedFb_dtsg")); })
                        .catch((err) => { log.error("refreshFb_dtsg", getText("custom", "refreshedFb_dtsgError"), err); });
        }, 1000 * 60 * 60 * 48);

        // ─── Account Rotation ─────────────────────────────────────────────────
        try {
                const rotationCfg = global.GoatBot?.config?.accountRotation;
                if (rotationCfg?.enable) {
                        const detector = require("./bot/accountRotator/detector.js");
                        detector.installApiHooks(api);
                        log.info("ACCOUNT_ROTATOR", "✅ Send-failure monitoring active.");
                        const rotator = require("./bot/accountRotator/index.js");
                        rotator.resetState();
                } else {
                        log.info("ACCOUNT_ROTATOR", "Auto-rotation is disabled. Enable it in config or with /accounts enable.");
                }
        } catch (e) {
                log.warn("ACCOUNT_ROTATOR", "Failed to load rotator: " + e.message);
        }

        // ─── Stealth Engine ───────────────────────────────────────────────────
        try {
                const stealthCfg = global.GoatBot?.config?.stealth;
                if (stealthCfg?.enable !== false) {
                        const stealth = require("./stealth/index.js");
                        stealth.stop();
                        stealth.start(api);
                        log.info("STEALTH", "🕵️ Human-camouflage system v2 active (10 layers).");
                } else {
                        log.info("STEALTH", "Stealth engine disabled in config.");
                }
        } catch (e) {
                log.warn("STEALTH", "Failed to start stealth engine: " + e.message);
        }

        // ─── Layer 7: Outgoing Throttle ───────────────────────────────────────
        // يُغلّف api.sendMessage لتطبيق حدود الإرسال الإنسانية تلقائياً.
        // يجب تفعيله قبل installApiHooks (الـ rotator) ليكون الطبقة الداخلية.
        try {
                const stealthCfg = global.GoatBot?.config?.stealth;
                const throttleCfg = stealthCfg?.outgoingThrottle;
                if (stealthCfg?.enable !== false && throttleCfg?.enable !== false) {
                        const { wrapSendMessage } = require("./stealth/outgoingThrottle.js");
                        wrapSendMessage(api);
                        log.info("STEALTH", "⚡ Layer 7 — Outgoing throttle + burst-cooling active.");
                } else {
                        log.info("STEALTH", "Outgoing throttle disabled in config.");
                }
        } catch (e) {
                log.warn("STEALTH", "Failed to start outgoing throttle: " + e.message);
        }

        // ─── DM Lock ──────────────────────────────────────────────────────────
        try {
                const fs   = require("fs-extra");
                const path = require("path");
                const dlp  = path.join(process.cwd(), "database/data/dmLock.json");
                if (fs.existsSync(dlp)) {
                        const dlData = JSON.parse(fs.readFileSync(dlp, "utf8"));
                        global.GoatBot.dmLocked = !!dlData.locked;
                        const rtl = (s) => "\u202B" + s + "\u202C";
                        log.info("DM_LOCK", global.GoatBot.dmLocked
                                ? "🔒 " + rtl("الخاص مقفل — أدمن البوت فقط")
                                : "🔓 " + rtl("الخاص مفتوح"));
                } else {
                        global.GoatBot.dmLocked = false;
                }
        } catch (e) {
                global.GoatBot.dmLocked = false;
        }

        // ─── Liberty E2EE Module ───────────────────────────────────────────────
        try {
                const e2eeCfg = global.GoatBot?.config?.e2ee;
                const e2eeModule = require("./e2ee/index");
                global.e2ee = e2eeModule;

                if (e2eeCfg?.enable !== false) {
                        const pin = e2eeCfg?.pin || process.env.E2EE_PIN || null;
                        if (pin) {
                                const ok = e2eeModule.init(pin);
                                if (ok) {
                                        log.info("E2EE", "🔒 Liberty Protocol active. Identity keys loaded.");
                                        log.info("E2EE", `Public key: ${e2eeModule.getPublicBundle()?.identityKey?.slice(0, 16)}...`);
                                } else {
                                        log.warn("E2EE", "⚠️  E2EE initialized in passive mode (PIN verification failed).");
                                }
                        } else {
                                e2eeModule.init(null);
                                log.warn("E2EE", "⚠️  No E2EE PIN set. Running in passive mode.");
                        }
                } else {
                        log.info("E2EE", "Liberty E2EE module disabled in config.");
                }
        } catch (e) {
                log.warn("E2EE", "Failed to start Liberty E2EE module: " + e.message);
        }

        // ─── DM Auto-Accept + Pending Poller ──────────────────────────────────
        // فيسبوك يضع رسائل الخاص الجديدة في PENDING — MQTT لا يوصل أحداث PENDING.
        // الحل: بولينج دوري يقبل الطلبات ويحول الخاص لـ INBOX ثم يعالج الأوامر.

        if (!global.GoatBot._pendingProcessed) global.GoatBot._pendingProcessed = new Set();

        async function processPendingDMs() {
                const prefix   = global.GoatBot.config.prefix || "/";
                const adminIDs = (global.GoatBot.config.adminBot || []).map(String);
                const botID    = String(api.getCurrentUserID ? api.getCurrentUserID() : "");
                const dmLocked = !!global.GoatBot.dmLocked;

                let allPending = [];
                try {
                        const pending = await api.getThreadList(30, null, ["PENDING"]).catch(() => []);
                        const other   = await api.getThreadList(30, null, ["OTHER"]).catch(() => []);
                        allPending = [...(pending || []), ...(other || [])].filter(t => t && t.threadID);
                } catch (_) { return; }

                for (const thread of allPending) {
                        const tid     = String(thread.threadID);
                        const isAdmin = adminIDs.includes(tid);

                        // إذا الخاص مقفل والمرسل ليس أدمن — تجاهل
                        if (dmLocked && !isAdmin) continue;

                        // قبول الطلب (يحوّل الخاص من PENDING إلى INBOX)
                        try {
                                if (typeof api.handleMessageRequest === "function") {
                                        await api.handleMessageRequest(tid, true).catch(() => {});
                                }
                        } catch (_) {}

                        // ─── معالجة آخر الأوامر من الخاص (قبل أن يصبح INBOX) ──────────
                        // نجلب آخر 10 رسائل ونرسل أي أوامر لم تُعالج بعد
                        try {
                                const history = await api.getThreadHistory(tid, 10, null, Date.now()).catch(() => null);
                                if (!Array.isArray(history)) continue;

                                // نعالج من الأقدم للأحدث
                                for (const msg of history) {
                                        if (!msg || !msg.body) continue;
                                        if (!msg.body.startsWith(prefix)) continue;
                                        const sender = String(msg.senderID || msg.author || "");
                                        if (!sender || sender === botID) continue;

                                        const msgID = msg.messageID || msg.mid || "";
                                        if (msgID && global.GoatBot._pendingProcessed.has(msgID)) continue;
                                        if (msgID) global.GoatBot._pendingProcessed.add(msgID);

                                        // حد أقصى للـ Set
                                        if (global.GoatBot._pendingProcessed.size > 2000) {
                                                const arr = [...global.GoatBot._pendingProcessed];
                                                global.GoatBot._pendingProcessed = new Set(arr.slice(-1000));
                                        }

                                        const fakeEvent = {
                                                type: "message",
                                                threadID: tid,
                                                senderID: sender,
                                                messageID: msgID || ("pending_" + Date.now()),
                                                body: msg.body,
                                                isGroup: false,
                                                attachments: msg.attachments || [],
                                                mentions: msg.mentions || {},
                                                timestamp: String(msg.timestamp || Date.now()),
                                                participantIDs: []
                                        };

                                        try {
                                                if (global.GoatBot.callBackListen) {
                                                        global.GoatBot.callBackListen(null, fakeEvent);
                                                }
                                        } catch (_) {}

                                        await new Promise(r => setTimeout(r, 400));
                                }
                        } catch (_) {}

                        await new Promise(r => setTimeout(r, 600));
                }
        }

        // تشغيل أول مرة بعد 15 ثانية (البوت يحتاج وقت للاستقرار)
        setTimeout(processPendingDMs, 15000);
        // تكرار كل 3 دقائق (بدلاً من كل دقيقة) — تقليل طلبات API من 1440 إلى 480 يومياً
        const PENDING_INTERVAL_MS = 3 * 60 * 1000;
        const _pendingInterval = setInterval(processPendingDMs, PENDING_INTERVAL_MS);
        if (!global.GoatBot._pendingInterval) global.GoatBot._pendingInterval = _pendingInterval;

        log.info("DM_POLLER", "✅ Auto-accept PENDING DMs enabled — polling every 3 min");

        // ─── E2EE Group Decryption Helper ─────────────────────────────────────
        try {
                const { wrapApiForE2EE } = require("./e2ee/middleware");
                wrapApiForE2EE(api);
                log.info("E2EE", "🔐 E2EE API wrapper active — outgoing encryption enabled.");
        } catch (e) {
                log.warn("E2EE", "E2EE API wrapper skipped: " + e.message);
        }

        // ─── Admin Web Panel ───────────────────────────────────────────────────
        try {
                if (!global._panelStarted) {
                        global._panelStarted = true;
                        const startPanel = require("../webpanel/server.js");
                        startPanel();
                }
        } catch (e) {
                log.warn("PANEL", "Failed to start admin panel: " + e.message);
        }
};
