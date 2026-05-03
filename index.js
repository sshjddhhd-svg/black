/**
 * @author DJAMEL
 * ! The source code is written by DJAMEL, please don't change the author's name everywhere. Thank you for using
 * ! Official source code: https://github.com/castrolmocro/New-white-e2ee-v2
 * ! If you do not download the source code from the above address, you are using an unknown version and at risk of having your account hacked
 *
 * Watchdog with max-restart cap, exponential backoff, and auto-reset.
 */

// ─── Node <18 polyfills (needed by undici / fetch on older runtimes) ──────────
if (typeof globalThis.ReadableStream === "undefined") {
        const { ReadableStream, WritableStream, TransformStream } = require("stream/web");
        globalThis.ReadableStream  = ReadableStream;
        globalThis.WritableStream  = WritableStream;
        globalThis.TransformStream = TransformStream;
}
if (typeof globalThis.Blob === "undefined") {
        globalThis.Blob = require("buffer").Blob;
}
// ─────────────────────────────────────────────────────────────────────────────

const { spawn } = require("child_process");
const log = require("./logger/log.js");

const MAX_RESTARTS      = 15;
const BASE_DELAY_MS     = 3000;
const MAX_DELAY_MS      = 5 * 60 * 1000; // 5 minutes
const RESET_AFTER_MS    = 10 * 60 * 1000; // reset counter after 10 min of stable uptime
const BACKOFF_MULTIPLIER = 1.8;

let restartCount = 0;
let currentDelay = BASE_DELAY_MS;
let stableTimer   = null;

function resetCounters() {
        restartCount = 0;
        currentDelay = BASE_DELAY_MS;
}

function startProject() {
        const child = spawn("node", ["Goat.js"], {
                cwd: __dirname,
                stdio: "inherit",
                shell: true
        });

        // If the bot runs for RESET_AFTER_MS without dying, consider it stable
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => {
                if (restartCount > 0) {
                        log.info("WATCHDOG", `Bot has been stable for ${RESET_AFTER_MS / 60000} min — resetting restart counter.`);
                        resetCounters();
                }
        }, RESET_AFTER_MS);

        child.on("close", (code) => {
                if (stableTimer) clearTimeout(stableTimer);

                // Exit code 0 = clean shutdown (e.g. /restart command), restart quickly
                if (code === 0) {
                        log.info("WATCHDOG", "Bot stopped cleanly (code 0). Restarting in 3s...");
                        resetCounters();
                        setTimeout(() => startProject(), 3000);
                        return;
                }

                restartCount++;

                if (restartCount > MAX_RESTARTS) {
                        log.err(
                                "WATCHDOG",
                                `Bot has crashed ${restartCount} times. MAX_RESTARTS (${MAX_RESTARTS}) exceeded.\n` +
                                "Watchdog is stopping to prevent infinite crash loop.\n" +
                                "Please fix the issue manually and restart the process."
                        );
                        process.exit(1);
                }

                log.warn(
                        "WATCHDOG",
                        `Bot stopped (code: ${code}). Restart attempt ${restartCount}/${MAX_RESTARTS} in ${Math.round(currentDelay / 1000)}s...`
                );

                setTimeout(() => startProject(), currentDelay);

                // Exponential backoff capped at MAX_DELAY_MS
                currentDelay = Math.min(currentDelay * BACKOFF_MULTIPLIER, MAX_DELAY_MS);
        });
}

startProject();

// ─── Uptime server ────────────────────────────────────────────────────────────
const express = require("express");
const app     = express();

app.get("/", (req, res) => {
        res.json({
                status: "running",
                pid: process.pid,
                restartCount,
                uptime: process.uptime()
        });
});

app.listen(3000, () => {
        log.info("WATCHDOG", "Uptime server listening on port 3000");
});
