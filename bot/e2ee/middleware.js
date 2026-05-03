/**
 * E2EE Middleware
 * Intercepts incoming and outgoing messages in the Goat Bot pipeline
 * to transparently handle Liberty Protocol encryption/decryption
 *
 * HOW IT WORKS:
 * 1. Incoming: If message starts with 🔒E2EE: → decrypt → pass decrypted body to handlers
 * 2. Outgoing: If E2EE session active for recipient → encrypt before sending
 * 3. Handshake: If 🔒E2EE:handshake received → auto-respond with bot's public bundle
 * 4. PIN Fallback: If no session exists, auto-try global config PIN
 */

const sessionManager = require("./sessionManager");
const { buildHandshake } = require("./signalProtocol");
const { pinDecrypt } = require("./signalProtocol");

/**
 * Wrap the FCA API to intercept sendMessage and auto-encrypt if session active
 */
function wrapApiForE2EE(api) {
    if (api.__e2ee_wrapped) return api;
    const originalSendMessage = api.sendMessage.bind(api);

    api.sendMessage = function (message, threadID, callback, messageID) {
        try {
            const e2ee = global.e2ee;
            if (!e2ee || !e2ee.isActive()) {
                return originalSendMessage(message, threadID, callback, messageID);
            }

            const tid = String(threadID || "");
            const hasThreadSess = sessionManager.hasSession(tid);

            // Only encrypt plain text messages if session is active for this thread/user
            if (typeof message === "string" && hasThreadSess) {
                const encrypted = e2ee.encryptOutgoing(tid, message);
                if (encrypted) {
                    return originalSendMessage(encrypted, threadID, callback, messageID);
                }
            } else if (
                message && typeof message === "object" && typeof message.body === "string"
                && hasThreadSess
            ) {
                const encrypted = e2ee.encryptOutgoing(tid, message.body);
                if (encrypted) {
                    return originalSendMessage({ ...message, body: encrypted }, threadID, callback, messageID);
                }
            }
        } catch (err) {
            // On any E2EE error, fall back to plaintext
        }
        return originalSendMessage(message, threadID, callback, messageID);
    };

    api.__e2ee_wrapped = true;
    return api;
}

/**
 * Try to decrypt using the global bot PIN as a fallback.
 * Useful for groups/DMs where no explicit session was started.
 */
function tryGlobalPinDecrypt(body) {
    const pin = global.GoatBot?.config?.e2ee?.pin
        || global.e2ee?.getPin?.()
        || process.env.E2EE_PIN
        || null;
    if (!pin) return null;
    try {
        const plaintext = pinDecrypt(body, String(pin));
        return plaintext || null;
    } catch (_) {
        return null;
    }
}

/**
 * Process an incoming event through the E2EE middleware
 * Returns modified event with decrypted body, or null to skip event
 *
 * Returns one of:
 *   { action: "pass", event }            — Normal message, pass to handlers
 *   { action: "handled" }                — E2EE control message handled, skip handlers
 *   { action: "decrypted", event }       — Decrypted, pass modified event to handlers
 */
async function processEvent(api, event) {
    const e2ee = global.e2ee;
    if (!e2ee) return { action: "pass", event };

    const body = event.body;
    if (!body || !sessionManager.isE2EEMessage(body)) {
        return { action: "pass", event };
    }

    const senderID = String(event.senderID || event.userID || "");
    const threadID = String(event.threadID || "");

    // ─── Try established session first (senderID then threadID) ────────────────
    let result = sessionManager.decryptFrom(senderID, body)
        || sessionManager.decryptFrom(threadID, body);

    // ─── Fallback: try global PIN ───────────────────────────────────────────────
    if (!result) {
        const plaintext = tryGlobalPinDecrypt(body);
        if (plaintext !== null) {
            // Auto-establish PIN session so future messages work faster
            const pin = global.GoatBot?.config?.e2ee?.pin
                || global.e2ee?.getPin?.()
                || process.env.E2EE_PIN;
            if (pin) {
                sessionManager.startPinSession(senderID, String(pin));
            }
            const modifiedEvent = { ...event, body: plaintext, _e2ee: true };
            return { action: "decrypted", event: modifiedEvent };
        }
    }

    if (!result) {
        // Encrypted but can't decrypt (no session, PIN mismatch) — inform sender
        try {
            const bundle = buildHandshake();
            api.sendMessage(
                "🔒 [Liberty E2EE] لا يمكن فك التشفير — لا توجد جلسة نشطة.\n"
                + "ابدأ جلسة تشفير:\n"
                + "  /e2ee pin <PIN>  — تشفير بـ PIN\n"
                + "  /e2ee handshake  — Liberty Protocol الكامل\n\n"
                + "المفتاح العام للبوت:\n" + bundle,
                threadID
            ).catch(() => {});
        } catch (_) {}
        return { action: "handled" };
    }

    // ─── Handshake received — auto-respond ─────────────────────────────────────
    if (result.type === "handshake") {
        try {
            const myBundle = buildHandshake();
            const hsResult = sessionManager.handleHandshake(senderID, body);
            if (hsResult.success) {
                const responsePayload = buildHandshake();
                api.sendMessage(
                    "🔒 [Liberty E2EE] ✅ تم استلام Handshake! الجلسة المشفرة نشطة الآن.\n\n"
                    + "المفتاح العام للبوت:\n" + responsePayload,
                    threadID
                ).catch(() => {});
                return { action: "handled" };
            }
            api.sendMessage(
                "🔒 [Liberty E2EE] تم استلام Handshake. مفتاح البوت:\n" + myBundle,
                threadID
            ).catch(() => {});
        } catch (_) {}
        return { action: "handled" };
    }

    // ─── X3DH init — session established automatically ─────────────────────────
    if (result.type === "session_established") {
        try {
            const responseBundle = buildHandshake();
            api.sendMessage(
                "🔒 [Liberty E2EE] ✅ تم إنشاء الجلسة عبر X3DH!\n"
                + "القناة المشفرة نشطة الآن.\n\n"
                + "مفتاح البوت:\n" + responseBundle,
                threadID
            ).catch(() => {});
        } catch (_) {}
        return { action: "handled" };
    }

    // ─── Decrypted message — replace body and pass through ─────────────────────
    if (result.type === "message" && result.plaintext) {
        const modifiedEvent = { ...event, body: result.plaintext, _e2ee: true };
        return { action: "decrypted", event: modifiedEvent };
    }

    return { action: "handled" };
}

module.exports = { processEvent, wrapApiForE2EE };
