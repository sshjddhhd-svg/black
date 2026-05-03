/**
 * E2EE Session Manager
 * Manages active E2EE sessions for all participants (users and groups)
 * Handles session establishment, message routing, and key rotation
 */

const keyStore = require("./keyStore");
const {
    x3dhInitiate,
    x3dhRespond,
    initRatchet,
    ratchetEncrypt,
    ratchetDecrypt,
    pinEncrypt,
    pinDecrypt,
    buildHandshake,
    parseHandshake
} = require("./signalProtocol");
const { encodePayload, decodePayload } = require("./crypto");
const { log } = global.utils || { log: console };

/**
 * Check if a message body contains an E2EE payload
 */
function isE2EEMessage(body) {
    return typeof body === "string" && body.startsWith("🔒E2EE:");
}

/**
 * Establish an E2EE session with a participant using X3DH
 * Call this when Party A wants to initiate E2EE with the bot (Party B)
 */
function handleHandshake(senderID, payloadText) {
    try {
        const bundle = parseHandshake(payloadText);
        if (!bundle) return { success: false, error: "Invalid handshake bundle" };

        // Bot is Party B — compute shared secret from A's bundle
        const { masterSecret } = x3dhRespond(bundle, { iv: "0".repeat(24), ciphertext: "", tag: "0".repeat(32) });

        // Actually for handshake-only, we just store the bundle and compute master secret
        // The x3dhRespond expects to decrypt a message too — let's do it properly:
        const spk = keyStore.getSignedPreKey();
        const { computeSharedSecret, hkdf, generateKeyPair } = require("./crypto");
        const IK_B = keyStore.getIdentityPrivateKey();

        const DH1 = computeSharedSecret(spk.privateKey, bundle.identityKey);
        const DH2 = computeSharedSecret(IK_B, bundle.ephemeralKey || bundle.identityKey);
        const DH3 = computeSharedSecret(spk.privateKey, bundle.ephemeralKey || bundle.identityKey);

        let ms;
        if (bundle.oneTimePreKey) {
            const otk = keyStore.getOneTimePreKey(bundle.oneTimePreKey.keyId);
            const DH4 = otk ? computeSharedSecret(otk.privateKey, bundle.ephemeralKey || bundle.identityKey) : DH3;
            const combined = Buffer.from(DH1 + DH2 + DH3 + DH4, "hex");
            ms = hkdf(combined, Buffer.alloc(32), "LibertyProtocol_X3DH_v1").toString("hex");
        } else {
            const combined = Buffer.from(DH1 + DH2 + DH3, "hex");
            ms = hkdf(combined, Buffer.alloc(32), "LibertyProtocol_X3DH_v1").toString("hex");
        }

        const session = initRatchet(ms, false);
        session.partnerIdentityKey = bundle.identityKey;
        session.mode = "x3dh";
        keyStore.saveSession(senderID, session);

        return {
            success: true,
            masterSecret: ms,
            // Bot's response bundle for the handshake confirmation
            responseBundle: keyStore.getPublicKeyBundle()
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Initiate E2EE session with a participant (bot as Party A)
 * Returns the handshake payload to send as a message
 */
function initiateSession(participantID, recipientBundle) {
    try {
        if (!recipientBundle) {
            // Just send our public bundle, waiting for their handshake
            return { success: true, payload: buildHandshake(), waiting: true };
        }

        const { handshakeBundle, encryptedMessage, masterSecret } = x3dhInitiate(recipientBundle, "Liberty_Session_Init");
        const session = initRatchet(masterSecret, true);
        session.mode = "x3dh";
        keyStore.saveSession(participantID, session);

        const initPayload = encodePayload({
            v: 1,
            type: "x3dh_init",
            bundle: handshakeBundle
        });

        return { success: true, payload: initPayload };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Start a PIN-based session (simpler, for groups or when X3DH not available)
 */
function startPinSession(participantID, pin) {
    const session = {
        mode: "pin",
        pin,
        sendCount: 0,
        recvCount: 0,
        lastActivity: Date.now()
    };
    keyStore.saveSession(participantID, session);
    return { success: true };
}

/**
 * Encrypt a message for a participant
 */
function encryptFor(participantID, plaintext) {
    const session = keyStore.getSession(participantID);
    if (!session) return null;

    if (session.mode === "pin") {
        return pinEncrypt(plaintext, session.pin);
    }

    if (session.mode === "x3dh" || session.mode === "ratchet") {
        const { payload, updatedSession } = ratchetEncrypt(session, plaintext);
        keyStore.saveSession(participantID, updatedSession);
        return payload;
    }

    return null;
}

/**
 * Decrypt a message from a participant
 */
function decryptFrom(participantID, ciphertext) {
    try {
        const payload = decodePayload(ciphertext);
        if (!payload) return null;

        // Handle handshake
        if (payload.type === "handshake") {
            return { type: "handshake", bundle: payload.bundle };
        }

        // Handle x3dh init
        if (payload.type === "x3dh_init") {
            const result = handleHandshake(participantID, ciphertext);
            if (result.success) {
                return { type: "session_established", responseBundle: result.responseBundle };
            }
            return null;
        }

        // Handle pin-encrypted message
        if (payload.type === "pin") {
            const session = keyStore.getSession(participantID);
            if (!session || session.mode !== "pin") return null;
            const plaintext = pinDecrypt(ciphertext, session.pin);
            return { type: "message", plaintext };
        }

        // Handle ratchet message
        if (payload.type === "msg") {
            const session = keyStore.getSession(participantID);
            if (!session) return null;
            const { plaintext, updatedSession } = ratchetDecrypt(session, ciphertext);
            keyStore.saveSession(participantID, updatedSession);
            return { type: "message", plaintext };
        }

        return null;
    } catch (err) {
        return null;
    }
}

/**
 * Check if a session exists for a participant
 */
function hasSession(participantID) {
    return keyStore.getSession(participantID) !== null;
}

/**
 * Terminate session
 */
function terminateSession(participantID) {
    keyStore.deleteSession(participantID);
}

/**
 * Get session info
 */
function getSessionInfo(participantID) {
    const session = keyStore.getSession(participantID);
    if (!session) return null;
    return {
        mode: session.mode,
        sendCount: session.sendCount,
        recvCount: session.recvCount,
        lastActivity: session.lastActivity
    };
}

/**
 * Get all active sessions
 */
function listSessions() {
    const all = keyStore.getAllSessions();
    return Object.entries(all).map(([id, sess]) => ({
        participantID: id,
        mode: sess.mode,
        lastActivity: sess.lastActivity
    }));
}

module.exports = {
    isE2EEMessage,
    handleHandshake,
    initiateSession,
    startPinSession,
    encryptFor,
    decryptFrom,
    hasSession,
    terminateSession,
    getSessionInfo,
    listSessions,
    buildHandshake
};
