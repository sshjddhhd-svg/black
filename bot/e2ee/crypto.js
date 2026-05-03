/**
 * E2EE Cryptographic Primitives
 * Implements Signal Protocol / Liberty Protocol cryptographic operations
 * using Node.js built-in crypto module (no extra packages needed)
 */

const crypto = require("crypto");

const CURVE = "prime256v1"; // P-256 (same as used in Signal Protocol web)
const KDF_ITERATIONS = 100000;
const KDF_KEYLEN = 32;
const KDF_DIGEST = "sha256";
const AES_ALGO = "aes-256-gcm";
const HMAC_ALGO = "sha256";

/**
 * Derive a key from a PIN + salt using PBKDF2
 */
function deriveKeyFromPIN(pin, salt) {
    if (!salt) salt = crypto.randomBytes(32);
    if (typeof salt === "string") salt = Buffer.from(salt, "hex");
    const key = crypto.pbkdf2Sync(
        Buffer.from(String(pin), "utf8"),
        salt,
        KDF_ITERATIONS,
        KDF_KEYLEN,
        KDF_DIGEST
    );
    return { key, salt: salt.toString("hex") };
}

/**
 * Generate an ECDH key pair (identity key, signed prekey, one-time prekey)
 */
function generateKeyPair() {
    const ecdh = crypto.createECDH(CURVE);
    ecdh.generateKeys();
    return {
        privateKey: ecdh.getPrivateKey("hex"),
        publicKey: ecdh.getPublicKey("hex", "uncompressed")
    };
}

/**
 * ECDH shared secret computation
 */
function computeSharedSecret(privateKeyHex, publicKeyHex) {
    const ecdh = crypto.createECDH(CURVE);
    ecdh.setPrivateKey(Buffer.from(privateKeyHex, "hex"));
    const shared = ecdh.computeSecret(Buffer.from(publicKeyHex, "hex"));
    return shared.toString("hex");
}

/**
 * HKDF key derivation (as used in Signal Protocol)
 */
function hkdf(inputKeyMaterial, salt, info, length = 32) {
    if (typeof inputKeyMaterial === "string") inputKeyMaterial = Buffer.from(inputKeyMaterial, "hex");
    if (typeof salt === "string") salt = Buffer.from(salt, "hex");
    if (typeof info === "string") info = Buffer.from(info, "utf8");

    // Extract
    const prk = crypto.createHmac("sha256", salt).update(inputKeyMaterial).digest();

    // Expand
    const n = Math.ceil(length / 32);
    const okm = Buffer.alloc(n * 32);
    let prev = Buffer.alloc(0);
    for (let i = 0; i < n; i++) {
        const hmac = crypto.createHmac("sha256", prk);
        hmac.update(prev);
        hmac.update(info);
        hmac.update(Buffer.from([i + 1]));
        prev = hmac.digest();
        prev.copy(okm, i * 32);
    }
    return okm.slice(0, length);
}

/**
 * Encrypt a message using AES-256-GCM
 */
function encryptMessage(plaintext, keyHex) {
    const key = Buffer.from(keyHex, "hex").slice(0, 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(Buffer.from(plaintext, "utf8")),
        cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return {
        iv: iv.toString("hex"),
        ciphertext: encrypted.toString("hex"),
        tag: tag.toString("hex")
    };
}

/**
 * Decrypt a message using AES-256-GCM
 */
function decryptMessage(encryptedObj, keyHex) {
    const key = Buffer.from(keyHex, "hex").slice(0, 32);
    const iv = Buffer.from(encryptedObj.iv, "hex");
    const ciphertext = Buffer.from(encryptedObj.ciphertext, "hex");
    const tag = Buffer.from(encryptedObj.tag, "hex");
    const decipher = crypto.createDecipheriv(AES_ALGO, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
    ]);
    return decrypted.toString("utf8");
}

/**
 * Sign data with HMAC-SHA256
 */
function signData(data, keyHex) {
    if (typeof data !== "string") data = JSON.stringify(data);
    return crypto.createHmac(HMAC_ALGO, Buffer.from(keyHex, "hex"))
        .update(data)
        .digest("hex");
}

/**
 * Verify HMAC-SHA256 signature
 */
function verifySignature(data, signature, keyHex) {
    const expected = signData(data, keyHex);
    return crypto.timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(expected, "hex")
    );
}

/**
 * Encode an encrypted payload as a readable string for Messenger
 */
function encodePayload(payload) {
    return "🔒E2EE:" + Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Decode an encrypted payload from a Messenger message
 */
function decodePayload(text) {
    if (!text || !text.startsWith("🔒E2EE:")) return null;
    try {
        return JSON.parse(Buffer.from(text.slice(7), "base64").toString("utf8"));
    } catch {
        return null;
    }
}

/**
 * Generate random bytes as hex
 */
function randomHex(bytes = 16) {
    return crypto.randomBytes(bytes).toString("hex");
}

module.exports = {
    deriveKeyFromPIN,
    generateKeyPair,
    computeSharedSecret,
    hkdf,
    encryptMessage,
    decryptMessage,
    signData,
    verifySignature,
    encodePayload,
    decodePayload,
    randomHex
};
