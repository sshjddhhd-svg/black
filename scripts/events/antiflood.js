/*
 * Anti-Flood System
 * Detects when the same (or nearly same) message is sent repeatedly
 * in rapid succession — a common flooding pattern.
 *
 * Config in config.json:
 * "antiflood": {
 *   "enable": true,
 *   "sameMessageThreshold": 3,
 *   "timeWindowSeconds": 6,
 *   "deleteFlood": true,
 *   "kickOnFlood": false
 * }
 */

// "threadID:userID" → [{ body, time, messageID }]
const floodMap = new Map();

function getConfig() {
	const cfg = global.GoatBot?.config?.antiflood || {};
	return {
		enable:             cfg.enable             !== false,
		threshold:          cfg.sameMessageThreshold || 3,
		windowMs:           (cfg.timeWindowSeconds   || 6) * 1000,
		deleteFlood:        cfg.deleteFlood         !== false,
		kickOnFlood:        cfg.kickOnFlood         === true
	};
}

function isAdminOrBot(uid) {
	const botAdmins   = global.GoatBot?.config?.adminBot   || [];
	const superAdmins = global.GoatBot?.config?.superAdminBot || [];
	const botID = global.GoatBot?.botID || global.botID || "";
	return (
		botAdmins.includes(String(uid)) ||
		superAdmins.includes(String(uid)) ||
		String(uid) === String(botID)
	);
}

function normalizeBody(body) {
	if (!body) return "";
	return body.trim().toLowerCase().replace(/\s+/g, " ").substring(0, 100);
}

module.exports = {
	config: {
		name: "antiflood",
		version: "1.0",
		author: "GoatBot Protection",
		category: "events"
	},

	onStart: async ({ event, api }) => {
		const cfg = getConfig();
		if (!cfg.enable) return;
		if (!event.senderID || event.type !== "message") return;
		if (!event.isGroup) return;

		const { senderID, threadID, body, messageID } = event;
		if (!body) return;
		if (isAdminOrBot(senderID)) return;

		const key  = `${threadID}:${senderID}`;
		const norm = normalizeBody(body);
		const now  = Date.now();

		if (!floodMap.has(key)) floodMap.set(key, []);

		const history = floodMap.get(key);

		// Remove old entries outside the window
		while (history.length && now - history[0].time > cfg.windowMs) {
			history.shift();
		}

		history.push({ norm, time: now, messageID });

		// Count how many recent messages match the current message
		const matchCount = history.filter(h => h.norm === norm).length;

		if (matchCount < cfg.threshold) return;

		// Flood detected
		floodMap.set(key, []); // reset

		// Delete all matching messages
		if (cfg.deleteFlood) {
			const toDelete = history.filter(h => h.norm === norm);
			for (const msg of toDelete) {
				if (msg.messageID) {
					api.unsendMessage(msg.messageID).catch(() => {});
				}
			}
		}

		// Notify and optionally kick
		api.sendMessage(
			`🌊 [ANTI-FLOOD] Message flood detected from user ${senderID}. Repeated messages deleted.`,
			threadID
		).catch(() => {});

		if (cfg.kickOnFlood) {
			api.removeUserFromGroup(senderID, threadID).catch(() => {});
		}
	}
};
