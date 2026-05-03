/**
 * E2EE Key Store
 * Manages storage and retrieval of cryptographic keys for the Liberty Protocol
 */

const fs = require("fs-extra");
const path = require("path");
const { generateKeyPair, deriveKeyFromPIN, randomHex } = require("./crypto");

const KEYSTORE_PATH = path.join(process.cwd(), "database", "e2ee_keystore.json");

let _store = null;

function loadStore() {
    if (_store) return _store;
    if (fs.existsSync(KEYSTORE_PATH)) {
        try {
            _store = fs.readJSONSync(KEYSTORE_PATH);
        } catch {
            _store = defaultStore();
        }
    } else {
        _store = defaultStore();
    }
    return _store;
}

function defaultStore() {
    return {
        identity: null,       // Bot's identity key pair
        signedPreKey: null,   // Signed prekey
        oneTimePreKeys: [],   // Pool of one-time prekeys
        sessions: {},         // Active sessions per user/thread
        pinSalt: null,        // Salt used for PIN derivation
        pinHash: null,        // Hashed PIN for verification
        initialized: false
    };
}

function saveStore() {
    if (!_store) return;
    fs.ensureDirSync(path.dirname(KEYSTORE_PATH));
    fs.writeJSONSync(KEYSTORE_PATH, _store, { spaces: 2 });
}

/**
 * Initialize the key store with a PIN
 * PIN is used to derive the bot's master identity key
 */
function initialize(pin) {
    _store = loadStore();

    const { key, salt } = deriveKeyFromPIN(pin);
    _store.pinSalt = salt;

    // Store PIN verification hash
    const crypto = require("crypto");
    _store.pinHash = crypto.createHmac("sha256", key)
        .update("liberty_pin_verify")
        .digest("hex");

    // Generate or re-derive identity key pair from PIN
    // In Liberty/Signal protocol, identity key is long-term
    const seed = key.toString("hex");
    _store.identity = generateKeyPair();
    _store.identity.seed = seed; // store seed for consistency

    // Generate signed prekey
    _store.signedPreKey = {
        ...generateKeyPair(),
        keyId: randomHex(4),
        createdAt: Date.now()
    };

    // Generate pool of one-time prekeys
    _store.oneTimePreKeys = [];
    for (let i = 0; i < 20; i++) {
        _store.oneTimePreKeys.push({
            ...generateKeyPair(),
            keyId: randomHex(4)
        });
    }

    _store.initialized = true;
    saveStore();
    return true;
}

/**
 * Verify PIN against stored hash
 */
function verifyPIN(pin) {
    const store = loadStore();
    if (!store.initialized || !store.pinSalt || !store.pinHash) return false;
    const { key } = deriveKeyFromPIN(pin, store.pinSalt);
    const crypto = require("crypto");
    const hash = crypto.createHmac("sha256", key)
        .update("liberty_pin_verify")
        .digest("hex");
    return crypto.timingSafeEqual(
        Buffer.from(hash, "hex"),
        Buffer.from(store.pinHash, "hex")
    );
}

/**
 * Get bot's identity public key (for sharing in handshake)
 */
function getIdentityPublicKey() {
    const store = loadStore();
    return store.identity?.publicKey || null;
}

/**
 * Get bot's identity private key
 */
function getIdentityPrivateKey() {
    const store = loadStore();
    return store.identity?.privateKey || null;
}

/**
 * Get signed prekey
 */
function getSignedPreKey() {
    const store = loadStore();
    return store.signedPreKey || null;
}

/**
 * Get and consume a one-time prekey (removes it from pool)
 */
function consumeOneTimePreKey() {
    const store = loadStore();
    if (!store.oneTimePreKeys || store.oneTimePreKeys.length === 0) {
        // Regenerate if empty
        const { generateKeyPair } = require("./crypto");
        for (let i = 0; i < 10; i++) {
            store.oneTimePreKeys.push({
                ...generateKeyPair(),
                keyId: randomHex(4)
            });
        }
    }
    const key = store.oneTimePreKeys.shift();
    saveStore();
    return key;
}

/**
 * Get one-time prekey by ID (for verification)
 */
function getOneTimePreKey(keyId) {
    const store = loadStore();
    return store.oneTimePreKeys.find(k => k.keyId === keyId) || null;
}

/**
 * Save a session for a participant
 */
function saveSession(participantId, sessionData) {
    const store = loadStore();
    if (!store.sessions) store.sessions = {};
    store.sessions[participantId] = {
        ...sessionData,
        lastActivity: Date.now()
    };
    saveStore();
}

/**
 * Get a session for a participant
 */
function getSession(participantId) {
    const store = loadStore();
    return store.sessions?.[participantId] || null;
}

/**
 * Delete a session
 */
function deleteSession(participantId) {
    const store = loadStore();
    if (store.sessions?.[participantId]) {
        delete store.sessions[participantId];
        saveStore();
    }
}

/**
 * Get all active sessions
 */
function getAllSessions() {
    const store = loadStore();
    return store.sessions || {};
}

/**
 * Check if initialized
 */
function isInitialized() {
    const store = loadStore();
    return store.initialized === true;
}

/**
 * Get the full public key bundle for sharing (X3DH style)
 */
function getPublicKeyBundle() {
    const store = loadStore();
    if (!store.initialized) return null;

    const otk = store.oneTimePreKeys[0] || null;
    return {
        identityKey: store.identity.publicKey,
        signedPreKey: {
            keyId: store.signedPreKey.keyId,
            publicKey: store.signedPreKey.publicKey
        },
        oneTimePreKey: otk ? {
            keyId: otk.keyId,
            publicKey: otk.publicKey
        } : null
    };
}

module.exports = {
    initialize,
    verifyPIN,
    getIdentityPublicKey,
    getIdentityPrivateKey,
    getSignedPreKey,
    consumeOneTimePreKey,
    getOneTimePreKey,
    saveSession,
    getSession,
    deleteSession,
    getAllSessions,
    isInitialized,
    getPublicKeyBundle,
    loadStore,
    saveStore
};
