/*
 * Shared Rate Limit Store
 * Provides a centralized in-memory rate limiter used by antispam,
 * antiflood, and any other protection system.
 *
 * Usage:
 *   const { check, reset } = require("./bot/protection/rateLimit");
 *   const result = check("threadID:userID", 5, 8000); // max 5 events in 8 seconds
 *   if (result.exceeded) { ... }
 */

const store = new Map(); // key → { events: [timestamp, ...], warned: boolean }

/**
 * Check if a key has exceeded the rate limit.
 * @param {string} key        Unique key (e.g. "threadID:userID:action")
 * @param {number} maxEvents  Max allowed events in the window
 * @param {number} windowMs   Time window in milliseconds
 * @returns {{ exceeded: boolean, count: number, warned: boolean }}
 */
function check(key, maxEvents, windowMs) {
	const now = Date.now();

	if (!store.has(key)) store.set(key, { events: [], warned: false });

	const entry = store.get(key);

	// Remove old events outside the window
	entry.events = entry.events.filter(t => now - t < windowMs);
	entry.events.push(now);

	const count    = entry.events.length;
	const exceeded = count > maxEvents;

	return { exceeded, count, warned: entry.warned };
}

/**
 * Mark a key as warned (so we can track first-warning vs. action phase).
 * @param {string} key
 */
function setWarned(key) {
	if (store.has(key)) store.get(key).warned = true;
}

/**
 * Reset a key's rate limit record.
 * @param {string} key
 */
function reset(key) {
	store.delete(key);
}

/**
 * Clean up all expired entries (call periodically to avoid memory leaks).
 * @param {number} windowMs
 */
function cleanup(windowMs = 60000) {
	const now = Date.now();
	for (const [key, entry] of store.entries()) {
		entry.events = entry.events.filter(t => now - t < windowMs);
		if (entry.events.length === 0) store.delete(key);
	}
}

// Auto-cleanup every 5 minutes
setInterval(() => cleanup(5 * 60 * 1000), 5 * 60 * 1000);

module.exports = { check, setWarned, reset, cleanup };
