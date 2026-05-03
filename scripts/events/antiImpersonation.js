/*
 * Anti-Impersonation System
 * Detects users who change their name to impersonate admins, the bot,
 * or use authority-implying prefixes like [ADMIN], [BOT], [OWNER] etc.
 *
 * Config in config.json:
 * "antiImpersonation": {
 *   "enable": true
 * }
 */

const IMPERSONATION_PATTERNS = [
	/^\[?(admin|mod|moderator|owner|bot|support|staff|official|system|goat.?bot|helper)\]?$/i,
	/^(admin|mod|bot|owner|staff)\s*[\-_|:]/i,
	/[\-_|:]\s*(admin|mod|bot|owner|staff)$/i,
];

function getConfig() {
	return global.GoatBot?.config?.antiImpersonation || {};
}

function isAdminOrBot(uid) {
	const botAdmins   = global.GoatBot?.config?.adminBot      || [];
	const superAdmins = global.GoatBot?.config?.superAdminBot || [];
	const botID = global.GoatBot?.botID || global.botID || "";
	return (
		botAdmins.includes(String(uid)) ||
		superAdmins.includes(String(uid)) ||
		String(uid) === String(botID)
	);
}

function nameMatchesImpersonation(name) {
	if (!name) return false;
	const cleaned = name.trim();
	return IMPERSONATION_PATTERNS.some(pattern => pattern.test(cleaned));
}

module.exports = {
	config: {
		name: "antiImpersonation",
		version: "1.0",
		author: "GoatBot Protection",
		category: "events"
	},

	onStart: async ({ event, api, threadsData }) => {
		const cfg = getConfig();
		if (cfg.enable === false) return;

		// Trigger on nickname change events
		if (event.logMessageType !== "log:user-nickname") return;

		const { threadID, logMessageData } = event;
		if (!logMessageData) return;

		const changedUID  = logMessageData.participant_id;
		const newNickname = logMessageData.nickname || "";

		if (!changedUID || !newNickname) return;
		if (isAdminOrBot(changedUID)) return;

		// Check if the new nickname looks like an impersonation
		if (!nameMatchesImpersonation(newNickname)) return;

		try {
			// Revert the nickname
			await new Promise((resolve, reject) =>
				api.changeNickname("", threadID, changedUID, err => err ? reject(err) : resolve())
			);

			api.sendMessage(
				`⚠️ [ANTI-IMPERSONATION]\n\nUser ${changedUID} attempted to use an authority-implying nickname: "${newNickname}"\n\nNickname has been reset.`,
				threadID
			).catch(() => {});
		} catch (err) {
			api.sendMessage(
				`⚠️ [ANTI-IMPERSONATION] User ${changedUID} tried to use nickname "${newNickname}" but the bot couldn't revert it (missing admin rights).`,
				threadID
			).catch(() => {});
		}
	},

	// Also check when users join the group
	onEvent: async ({ event, api }) => {
		const cfg = getConfig();
		if (cfg.enable === false) return;

		if (event.logMessageType !== "log:subscribe") return;

		const { threadID } = event;
		const { addedParticipants } = event.logMessageData || {};
		if (!addedParticipants) return;

		for (const participant of addedParticipants) {
			const uid      = participant.userFbId;
			const fullName = participant.fullName || "";

			if (isAdminOrBot(uid)) continue;
			if (!nameMatchesImpersonation(fullName)) continue;

			api.sendMessage(
				`⚠️ [ANTI-IMPERSONATION] The joining user "${fullName}" (${uid}) has a name that resembles an admin/bot.\n\nPlease verify this user is legitimate.`,
				threadID
			).catch(() => {});
		}
	}
};
