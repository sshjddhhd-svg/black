/*
 * Anti-Spam System
 * Tracks messages per user per thread. If a user exceeds the threshold
 * within the time window, they receive a warning → mute → kick.
 *
 * Config in config.json:
 * "antispam": {
 *   "enable": true,
 *   "maxMessages": 6,
 *   "timeWindowSeconds": 8,
 *   "warnBeforeAction": true,
 *   "action": "kick"    // "warn" | "mute" | "kick"
 * }
 */

const userMessageMap = new Map(); // "threadID:userID" → { count, timer, warned }

function getConfig() {
	const cfg = global.GoatBot?.config?.antispam || {};
	return {
		enable:           cfg.enable !== false,
		maxMessages:      cfg.maxMessages       || 6,
		windowMs:         (cfg.timeWindowSeconds || 8) * 1000,
		warnBeforeAction: cfg.warnBeforeAction  !== false,
		action:           cfg.action            || "kick"
	};
}

function isAdminOrBot(uid, threadAdminIDs) {
	const botAdmins = global.GoatBot?.config?.adminBot || [];
	const superAdmins = global.GoatBot?.config?.superAdminBot || [];
	const botID = global.GoatBot?.botID || global.botID || "";
	return (
		botAdmins.includes(String(uid)) ||
		superAdmins.includes(String(uid)) ||
		String(uid) === String(botID) ||
		(Array.isArray(threadAdminIDs) && threadAdminIDs.some(a =>
			(typeof a === "object" ? a.adminID : a) === String(uid)
		))
	);
}

module.exports = {
	config: {
		name: "antispam",
		version: "1.0",
		author: "GoatBot Protection",
		category: "events"
	},

	onStart: async ({ event, api, threadsData }) => {
		const cfg = getConfig();
		if (!cfg.enable) return;
		if (!event.senderID || event.type !== "message") return;

		const { senderID, threadID, isGroup } = event;
		if (!isGroup) return;

		// Get thread info for admin check
		let threadAdminIDs = [];
		try {
			const threadInfo = await threadsData.get(threadID);
			threadAdminIDs = threadInfo?.adminIDs || [];
		} catch (e) {}

		if (isAdminOrBot(senderID, threadAdminIDs)) return;

		const key = `${threadID}:${senderID}`;
		const now = Date.now();

		if (!userMessageMap.has(key)) {
			userMessageMap.set(key, { count: 0, firstMs: now, warned: false });
		}

		const entry = userMessageMap.get(key);

		// Reset if window expired
		if (now - entry.firstMs > cfg.windowMs) {
			entry.count   = 0;
			entry.firstMs = now;
			entry.warned  = false;
		}

		entry.count++;

		if (entry.count <= cfg.maxMessages) return;

		// Threshold exceeded
		if (cfg.warnBeforeAction && !entry.warned) {
			entry.warned = true;
			api.sendMessage(
				`⚠️ @${senderID} — You are sending messages too fast! Stop spamming or you will be removed.`,
				threadID
			).catch(() => {});
			return;
		}

		// Take action
		userMessageMap.delete(key);

		const performAction = cfg.action;
		if (performAction === "kick" || performAction === "mute") {
			try {
				if (performAction === "kick") {
					api.removeUserFromGroup(senderID, threadID, (err) => {
						if (!err) {
							api.sendMessage(
								`🚫 User has been removed for spamming.`,
								threadID
							).catch(() => {});
						}
					});
				}
			} catch (e) {}
		} else {
			api.sendMessage(
				`🚫 [ANTISPAM] User ${senderID} exceeded message limit.`,
				threadID
			).catch(() => {});
		}
	}
};
