/**
 * Liberty E2EE Module — Main Entry Point
 * Integrates with Goat Bot's message pipeline to provide
 * full End-to-End Encryption support for:
 *   - Private (DM) conversations
 *   - Encrypted group chats
 *   - PIN-based simple encryption
 *   - Full Signal/Liberty Protocol (X3DH + Double Ratchet)
 */

const keyStore = require("./keyStore");
const sessionManager = require("./sessionManager");
const { buildHandshake } = require("./signalProtocol");

let _initialized = false;
let _pin = null;

/**
 * Initialize the E2EE module with the bot's PIN
 * Call this once on bot startup
 */
function init(pin) {
    if (!pin) {
        console.warn("[E2EE] No PIN provided — E2EE module will run in passive mode (decrypt only).");
        _initialized = keyStore.isInitialized();
        return _initialized;
    }

    _pin = String(pin).trim();

    if (keyStore.isInitialized() && keyStore.verifyPIN(_pin)) {
        _initialized = true;
        console.log("[E2EE] Keys loaded from store. Liberty Protocol active.");
        return true;
    }

    // First time or PIN changed — initialize fresh keys
    keyStore.initialize(_pin);
    _initialized = true;
    console.log("[E2EE] New identity keys generated. Liberty Protocol active.");
    return true;
}

/**
 * Process an incoming message through the E2EE pipeline
 * Returns { handled, plaintext, participantID, type } or null if not E2EE
 */
function processIncoming(event) {
    if (!event || !event.body) return null;
    if (!sessionManager.isE2EEMessage(event.body)) return null;

    const participantID = event.senderID || event.userID;
    const result = sessionManager.decryptFrom(participantID, event.body);

    if (!result) return { handled: true, plaintext: null, error: "Decryption failed", participantID };

    if (result.type === "handshake") {
        return { handled: true, type: "handshake", participantID, bundle: result.bundle };
    }

    if (result.type === "session_established") {
        return { handled: true, type: "session_established", participantID, responseBundle: result.responseBundle };
    }

    if (result.type === "message") {
        return { handled: true, type: "message", plaintext: result.plaintext, participantID };
    }

    return null;
}

/**
 * Encrypt a message to send to a participant
 * Automatically picks the right method (X3DH ratchet or PIN)
 */
function encryptOutgoing(participantID, plaintext) {
    if (!_initialized) return null;
    return sessionManager.encryptFor(participantID, plaintext);
}

/**
 * Get the bot's public key bundle (share this to initiate E2EE)
 */
function getPublicBundle() {
    return keyStore.getPublicKeyBundle();
}

/**
 * Get the handshake packet to send to initiate E2EE
 */
function getHandshakePacket() {
    return buildHandshake();
}

/**
 * Start a PIN-based E2EE session with a participant
 */
function startPinSession(participantID, pin) {
    return sessionManager.startPinSession(participantID, pin || _pin);
}

/**
 * Check if a session exists for a participant
 */
function hasSession(participantID) {
    return sessionManager.hasSession(participantID);
}

/**
 * Terminate an E2EE session
 */
function terminateSession(participantID) {
    sessionManager.terminateSession(participantID);
}

/**
 * Get session info for a participant
 */
function getSessionInfo(participantID) {
    return sessionManager.getSessionInfo(participantID);
}

/**
 * List all active sessions
 */
function listSessions() {
    return sessionManager.listSessions();
}

/**
 * Check if module is active and initialized
 */
function isActive() {
    return _initialized;
}

/**
 * Get current PIN (for internal use only)
 */
function getPin() {
    return _pin;
}

module.exports = {
    init,
    processIncoming,
    encryptOutgoing,
    getPublicBundle,
    getHandshakePacket,
    startPinSession,
    hasSession,
    terminateSession,
    getSessionInfo,
    listSessions,
    isActive,
    getPin,
    isE2EEMessage: sessionManager.isE2EEMessage
};
