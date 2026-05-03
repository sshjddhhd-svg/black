/**
 * Liberty / Signal Protocol Implementation
 * Implements X3DH key agreement + Double Ratchet for E2EE in Facebook Messenger
 *
 * X3DH (Extended Triple Diffie-Hellman):
 *   - Used to establish shared secret between two parties without prior contact
 *   - Party A (initiator) uses: IK_A, EK_A (ephemeral) + IK_B, SPK_B, OPK_B (from B's bundle)
 *   - Master secret = HKDF(DH1 || DH2 || DH3 || DH4)
 *
 * Double Ratchet:
 *   - Uses the shared secret from X3DH to derive per-message keys
 *   - Provides forward secrecy and break-in recovery
 */

const {
    generateKeyPair,
    computeSharedSecret,
    hkdf,
    encryptMessage,
    decryptMessage,
    encodePayload,
    decodePayload
} = require("./crypto");

const keyStore = require("./keyStore");

// ─── X3DH ────────────────────────────────────────────────────────────────────

/**
 * PARTY A (initiator) sends initial message using B's public key bundle
 * Returns: { encryptedMessage, handshakeBundle, masterSecret }
 */
function x3dhInitiate(recipientBundle, message) {
    const ephemeralKey = generateKeyPair();
    const IK_A = keyStore.getIdentityPrivateKey();
    const IK_A_pub = keyStore.getIdentityPublicKey();

    // DH1 = DH(IK_A, SPK_B)
    const DH1 = computeSharedSecret(IK_A, recipientBundle.signedPreKey.publicKey);
    // DH2 = DH(EK_A, IK_B)
    const DH2 = computeSharedSecret(ephemeralKey.privateKey, recipientBundle.identityKey);
    // DH3 = DH(EK_A, SPK_B)
    const DH3 = computeSharedSecret(ephemeralKey.privateKey, recipientBundle.signedPreKey.publicKey);

    let masterSecret;
    if (recipientBundle.oneTimePreKey) {
        const DH4 = computeSharedSecret(ephemeralKey.privateKey, recipientBundle.oneTimePreKey.publicKey);
        const combined = Buffer.concat([
            Buffer.from(DH1, "hex"),
            Buffer.from(DH2, "hex"),
            Buffer.from(DH3, "hex"),
            Buffer.from(DH4, "hex")
        ]);
        masterSecret = hkdf(combined, Buffer.alloc(32), "LibertyProtocol_X3DH_v1").toString("hex");
    } else {
        const combined = Buffer.concat([
            Buffer.from(DH1, "hex"),
            Buffer.from(DH2, "hex"),
            Buffer.from(DH3, "hex")
        ]);
        masterSecret = hkdf(combined, Buffer.alloc(32), "LibertyProtocol_X3DH_v1").toString("hex");
    }

    const encrypted = encryptMessage(message, masterSecret);

    return {
        handshakeBundle: {
            type: "x3dh_init",
            identityKey: IK_A_pub,
            ephemeralKey: ephemeralKey.publicKey,
            signedPreKeyId: recipientBundle.signedPreKey.keyId,
            oneTimePreKeyId: recipientBundle.oneTimePreKey?.keyId || null
        },
        encryptedMessage: encrypted,
        masterSecret
    };
}

/**
 * PARTY B (responder) receives X3DH handshake and decrypts
 * Returns: { masterSecret, decryptedMessage }
 */
function x3dhRespond(handshakeBundle, encryptedMessage) {
    const IK_B = keyStore.getIdentityPrivateKey();
    const SPK_B = keyStore.getSignedPreKey();

    if (!IK_B || !SPK_B) throw new Error("Bot keys not initialized");

    // DH1 = DH(SPK_B, IK_A)
    const DH1 = computeSharedSecret(SPK_B.privateKey, handshakeBundle.identityKey);
    // DH2 = DH(IK_B, EK_A)
    const DH2 = computeSharedSecret(IK_B, handshakeBundle.ephemeralKey);
    // DH3 = DH(SPK_B, EK_A)
    const DH3 = computeSharedSecret(SPK_B.privateKey, handshakeBundle.ephemeralKey);

    let masterSecret;
    if (handshakeBundle.oneTimePreKeyId) {
        const OPK_B = keyStore.getOneTimePreKey(handshakeBundle.oneTimePreKeyId);
        if (!OPK_B) throw new Error("One-time prekey not found");
        const DH4 = computeSharedSecret(OPK_B.privateKey, handshakeBundle.ephemeralKey);
        const combined = Buffer.concat([
            Buffer.from(DH1, "hex"),
            Buffer.from(DH2, "hex"),
            Buffer.from(DH3, "hex"),
            Buffer.from(DH4, "hex")
        ]);
        masterSecret = hkdf(combined, Buffer.alloc(32), "LibertyProtocol_X3DH_v1").toString("hex");
    } else {
        const combined = Buffer.concat([
            Buffer.from(DH1, "hex"),
            Buffer.from(DH2, "hex"),
            Buffer.from(DH3, "hex")
        ]);
        masterSecret = hkdf(combined, Buffer.alloc(32), "LibertyProtocol_X3DH_v1").toString("hex");
    }

    const decryptedMessage = decryptMessage(encryptedMessage, masterSecret);
    return { masterSecret, decryptedMessage };
}

// ─── Double Ratchet ──────────────────────────────────────────────────────────

/**
 * Derive symmetric chain keys from master secret.
 * Both parties agree: chainKey_AB = for A→B direction, chainKey_BA = for B→A direction.
 */
function deriveChainKeys(masterSecret) {
    const ms = Buffer.from(masterSecret, "hex");
    // Chain key for initiator (A) sending to responder (B)
    const ck_AB = hkdf(ms, Buffer.from("LibertyRatchet_AB", "utf8"), "LibertyRatchet_Chain_AB").toString("hex");
    // Chain key for responder (B) sending to initiator (A)
    const ck_BA = hkdf(ms, Buffer.from("LibertyRatchet_BA", "utf8"), "LibertyRatchet_Chain_BA").toString("hex");
    return { ck_AB, ck_BA };
}

/**
 * Initialize a Double Ratchet session from a master secret.
 * isInitiator=true → Party A; false → Party B
 */
function initRatchet(masterSecret, isInitiator) {
    const { ck_AB, ck_BA } = deriveChainKeys(masterSecret);
    return {
        masterSecret,
        // sendChainKey = the key used when THIS party sends
        sendChainKey: isInitiator ? ck_AB : ck_BA,
        // recvChainKey = the key used when THIS party receives
        recvChainKey: isInitiator ? ck_BA : ck_AB,
        sendCount: 0,
        recvCount: 0,
        isInitiator
    };
}

/**
 * Derive next message key from chain key (Symmetric Ratchet step)
 */
function ratchetStep(chainKey) {
    const ck = Buffer.from(chainKey, "hex");
    const messageKey = hkdf(ck, Buffer.from("01", "hex"), "LibertyRatchet_MsgKey").toString("hex");
    const nextChainKey = hkdf(ck, Buffer.from("02", "hex"), "LibertyRatchet_NextChain").toString("hex");
    return { messageKey, nextChainKey };
}

/**
 * Encrypt a message using the Double Ratchet.
 * Returns { payload: string, updatedSession }
 */
function ratchetEncrypt(session, plaintext) {
    const { messageKey, nextChainKey } = ratchetStep(session.sendChainKey);
    const updatedSession = {
        ...session,
        sendChainKey: nextChainKey,
        sendCount: session.sendCount + 1
    };
    const msgIndex = session.sendCount;
    const encrypted = encryptMessage(plaintext, messageKey);
    const payload = encodePayload({
        v: 1,
        type: "msg",
        idx: msgIndex,
        enc: encrypted
    });
    return { payload, updatedSession };
}

/**
 * Decrypt a message using the Double Ratchet.
 * Returns { plaintext, updatedSession }
 */
function ratchetDecrypt(session, payloadText) {
    const payload = decodePayload(payloadText);
    if (!payload || payload.type !== "msg") throw new Error("Invalid payload");

    const target = payload.idx;
    const current = session.recvCount;
    if (target < current) throw new Error("Replayed message (idx " + target + " < " + current + ")");

    // Advance chain forward to reach the target index
    let chainKey = session.recvChainKey;
    let messageKey;
    for (let i = current; i <= target; i++) {
        const step = ratchetStep(chainKey);
        messageKey = step.messageKey;
        chainKey = step.nextChainKey;
    }

    const plaintext = decryptMessage(payload.enc, messageKey);
    const updatedSession = {
        ...session,
        recvChainKey: chainKey,
        recvCount: target + 1
    };
    return { plaintext, updatedSession };
}

// ─── Simple PIN-based Session ─────────────────────────────────────────────────

/**
 * Encrypt using a simple shared PIN-derived key
 */
function pinEncrypt(message, pin, salt) {
    const { deriveKeyFromPIN } = require("./crypto");
    const { key, salt: usedSalt } = deriveKeyFromPIN(pin, salt);
    const encrypted = encryptMessage(message, key.toString("hex"));
    return encodePayload({
        v: 1,
        type: "pin",
        salt: usedSalt,
        enc: encrypted
    });
}

/**
 * Decrypt using a PIN-derived key
 */
function pinDecrypt(payloadText, pin) {
    const payload = decodePayload(payloadText);
    if (!payload || payload.type !== "pin") return null;
    const { deriveKeyFromPIN } = require("./crypto");
    const { key } = deriveKeyFromPIN(pin, payload.salt);
    return decryptMessage(payload.enc, key.toString("hex"));
}

/**
 * Build a handshake packet for Liberty Protocol key exchange
 */
function buildHandshake() {
    const bundle = keyStore.getPublicKeyBundle();
    if (!bundle) return null;
    return encodePayload({
        v: 1,
        type: "handshake",
        bundle
    });
}

/**
 * Parse a handshake packet received from another party
 */
function parseHandshake(payloadText) {
    const payload = decodePayload(payloadText);
    if (!payload || payload.type !== "handshake") return null;
    return payload.bundle;
}

module.exports = {
    x3dhInitiate,
    x3dhRespond,
    initRatchet,
    ratchetEncrypt,
    ratchetDecrypt,
    pinEncrypt,
    pinDecrypt,
    buildHandshake,
    parseHandshake
};
