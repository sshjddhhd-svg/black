# Liberty E2EE Protocol — Bot Integration

## Overview

This module implements **End-to-End Encryption** for the Goat Bot using the **Liberty Protocol** (Signal Protocol implementation in pure Node.js).

## Features

- **X3DH** (Extended Triple Diffie-Hellman) — Asynchronous key agreement, same as used by Signal/WhatsApp
- **Double Ratchet** — Per-message keys with forward secrecy and break-in recovery
- **PIN-based AES-256-GCM** — Simple symmetric encryption using a shared PIN
- **Works everywhere**: Private DMs, encrypted groups, regular groups
- **No extra packages** — Uses only Node.js built-in `crypto` module

## How It Works

### Message Format
All E2EE messages use the prefix: `🔒E2EE:<base64-payload>`

### Session Modes

#### 1. PIN Mode (Simple — recommended for groups)
- Both sides share the same PIN
- Messages encrypted with AES-256-GCM using PBKDF2-derived key
- Start with: `/e2ee pin <your-pin>`

#### 2. Liberty Protocol / X3DH Mode (Full — for high security)
- Full Signal Protocol key exchange
- Handshake establishes shared secret using X3DH
- Messages use Double Ratchet for per-message keys
- Start with: `/e2ee handshake` → share bundle → peer sends their bundle back

### X3DH Key Agreement

```
Party A (User)                    Party B (Bot)
--------------                    -------------
IK_A (identity key)               IK_B (identity key)
EK_A (ephemeral key)              SPK_B (signed prekey)
                                  OPK_B (one-time prekey)

DH1 = DH(IK_A, SPK_B)
DH2 = DH(EK_A, IK_B)
DH3 = DH(EK_A, SPK_B)
DH4 = DH(EK_A, OPK_B)  [if available]

Master Secret = HKDF(DH1 || DH2 || DH3 || DH4)
```

### Double Ratchet

After X3DH, the Double Ratchet provides:
- **Forward secrecy**: Past messages can't be decrypted if keys are compromised
- **Break-in recovery**: Future messages are safe even if current state is leaked

## Configuration

In `config.json`:
```json
"e2ee": {
  "enable": true,
  "pin": "your-messenger-pin-here"
}
```

Or via environment variable: `E2EE_PIN=your-pin`

## Commands

| Command | Description |
|---------|-------------|
| `/e2ee status` | Show E2EE status and current session |
| `/e2ee handshake` | Share bot's public key bundle |
| `/e2ee pin <PIN>` | Start PIN-based encrypted session |
| `/e2ee end` | Terminate current E2EE session |
| `/e2ee verify` | Verify session is active |
| `/e2ee encrypt <text>` | Manually encrypt a message |
| `/e2ee decrypt <payload>` | Manually decrypt a payload |
| `/e2ee setpin <PIN>` | [Admin] Set bot master PIN |
| `/e2ee sessions` | [Admin] List all active sessions |

## File Structure

```
bot/e2ee/
├── index.js          — Main module entry point
├── crypto.js         — Cryptographic primitives (ECDH, AES-GCM, HKDF)
├── keyStore.js       — Key storage and management
├── signalProtocol.js — X3DH + Double Ratchet implementation
├── sessionManager.js — Session lifecycle management
├── middleware.js     — Message pipeline integration
└── README.md         — This file
```

## Security Notes

1. The bot's identity key pair is derived from your PIN using PBKDF2 (100,000 iterations)
2. Keys are stored in `database/e2ee_keystore.json` — protect this file
3. PIN is never stored in plaintext — only an HMAC-SHA256 verification hash
4. Each message uses a unique nonce (IV) for AES-256-GCM
5. One-time prekeys are consumed after use (Signal Protocol standard)
