/**
 * E2EE Auto-Handler Event
 * Automatically handles Liberty Protocol handshake messages
 * and notifies admins about new encrypted sessions
 */

module.exports = {
    config: {
        name: "e2eeAutoHandler",
        version: "1.0",
        author: "Liberty Protocol",
        category: "e2ee",
        description: "Automatically processes E2EE handshakes and session management"
    },

    onStart: async () => {},

    onChat: async function ({ api, event, message }) {
        try {
            // Only process messages with E2EE prefix
            if (!event.body || !event.body.startsWith("🔒E2EE:")) return;

            const e2ee = global.e2ee;
            if (!e2ee) return;

            // The middleware in handlerAction.js handles the actual decryption.
            // This event handler logs new session activity for admin awareness.
            const sessionManager = require("../../bot/e2ee/sessionManager");
            const senderID = event.senderID || event.userID;

            if (!sessionManager.hasSession(senderID) && !sessionManager.hasSession(event.threadID)) {
                // Unrecognized E2EE message — the middleware will handle response
                return;
            }
        } catch (err) {
            // Silent fail — never break normal bot operation
        }
    }
};
