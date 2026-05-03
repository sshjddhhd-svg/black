const { config } = global.GoatBot;
const { writeFileSync } = require("fs-extra");

/*
 * Admin Role Levels:
 *  0 = Regular user
 *  1 = Group admin (set by Facebook)
 *  2 = Bot moderator  (config.adminBot)
 *  3 = Bot super admin (config.superAdminBot) — full control
 */

function getSuperAdmins() {
	return config.superAdminBot || [];
}

function isSuperAdmin(uid) {
	return getSuperAdmins().includes(String(uid));
}

function isAdmin(uid) {
	return config.adminBot.includes(String(uid));
}

module.exports = {
	config: {
		name: "admin",
		version: "2.0",
		author: "NTKhang | Improved by GoatBot",
		countDown: 5,
		role: 2,
		description: {
			en: "Manage bot admin roles (levels 2–3)"
		},
		category: "system",
		guide: {
			en: "  {pn} add <uid|@tag>       — Add bot moderator (level 2)\n"
			  + "  {pn} remove <uid|@tag>    — Remove bot moderator\n"
			  + "  {pn} superadd <uid|@tag>  — Add super admin (level 3, owner only)\n"
			  + "  {pn} superremove <uid|@tag> — Remove super admin (owner only)\n"
			  + "  {pn} list                 — List all admins with their level"
		}
	},

	langs: {
		en: {
			added:            "✅ Added bot moderator (level 2) for %1 user(s):\n%2",
			alreadyAdmin:     "\n⚠️ %1 user(s) already have admin role:\n%2",
			missingIdAdd:     "⚠️ Please tag a user or enter a UID.",
			removed:          "✅ Removed bot moderator for %1 user(s):\n%2",
			notAdmin:         "⚠️ %1 user(s) are not bot admins:\n%2",
			missingIdRemove:  "⚠️ Please tag a user or enter a UID.",
			superAdded:       "👑 Added super admin (level 3) for %1 user(s):\n%2",
			superRemoved:     "✅ Removed super admin for %1 user(s):\n%2",
			noPermSuper:      "❌ Only existing super admins can manage super admin roles.",
			listAdmin:
				"👑 Bot Admin Roster\n"
				+ "──────────────────\n"
				+ "Level 3 — Super Admin (Owner):\n%1\n\n"
				+ "Level 2 — Bot Moderator:\n%2",
			notSuperAdmin:    "⚠️ %1 user(s) are not super admins:\n%2",
			cantRemoveSelf:   "❌ You cannot remove your own super admin role."
		}
	},

	onStart: async function ({ message, args, usersData, event, getLang }) {
		const senderID = event.senderID;

		const getTargetUIDs = () => {
			if (Object.keys(event.mentions || {}).length > 0)
				return Object.keys(event.mentions);
			if (event.messageReply?.senderID)
				return [event.messageReply.senderID];
			return args.filter(a => !isNaN(a) && a.length > 5);
		};

		const resolveNames = async (uids) =>
			Promise.all(uids.map(uid =>
				usersData.getName(uid).then(name => ({ uid: String(uid), name: name || uid }))
			));

		switch (args[0]) {
			case "add":
			case "-a": {
				const uids = getTargetUIDs();
				if (!uids.length) return message.reply(getLang("missingIdAdd"));

				const newOnes = [], already = [];
				for (const uid of uids) {
					if (isAdmin(uid)) already.push(uid);
					else newOnes.push(uid);
				}

				config.adminBot.push(...newOnes.map(String));
				writeFileSync(global.client.dirConfig, JSON.stringify(config, null, 2));

				const names = await resolveNames(uids);
				return message.reply(
					(newOnes.length > 0   ? getLang("added",         newOnes.length, names.filter(n => newOnes.includes(n.uid)).map(n => `  • ${n.name} (${n.uid})`).join("\n")) : "")
					+ (already.length > 0 ? getLang("alreadyAdmin",  already.length, already.map(uid => `  • ${uid}`).join("\n")) : "")
				);
			}

			case "remove":
			case "-r": {
				const uids = getTargetUIDs();
				if (!uids.length) return message.reply(getLang("missingIdRemove"));

				// FIX: was Object.keys(event.mentions)[0] → string instead of array
				const adminIds = [], notAdmin = [];
				for (const uid of uids) {
					if (isAdmin(uid)) adminIds.push(String(uid));
					else notAdmin.push(uid);
				}

				for (const uid of adminIds)
					config.adminBot.splice(config.adminBot.indexOf(uid), 1);

				writeFileSync(global.client.dirConfig, JSON.stringify(config, null, 2));
				const names = await resolveNames(adminIds.concat(notAdmin));
				return message.reply(
					(adminIds.length > 0  ? getLang("removed",   adminIds.length,  names.filter(n => adminIds.includes(n.uid)).map(n => `  • ${n.name} (${n.uid})`).join("\n")) : "")
					+ (notAdmin.length > 0 ? getLang("notAdmin",  notAdmin.length,  notAdmin.map(uid => `  • ${uid}`).join("\n")) : "")
				);
			}

			case "superadd": {
				if (!isSuperAdmin(senderID))
					return message.reply(getLang("noPermSuper"));

				const uids = getTargetUIDs();
				if (!uids.length) return message.reply(getLang("missingIdAdd"));

				if (!config.superAdminBot) config.superAdminBot = [];

				const newOnes = [], already = [];
				for (const uid of uids) {
					if (isSuperAdmin(uid)) already.push(uid);
					else newOnes.push(String(uid));
				}

				config.superAdminBot.push(...newOnes);
				// Super admins are also bot admins
				for (const uid of newOnes)
					if (!isAdmin(uid)) config.adminBot.push(uid);

				writeFileSync(global.client.dirConfig, JSON.stringify(config, null, 2));
				const names = await resolveNames(uids);
				return message.reply(
					(newOnes.length > 0   ? getLang("superAdded",   newOnes.length, names.filter(n => newOnes.includes(n.uid)).map(n => `  👑 ${n.name} (${n.uid})`).join("\n")) : "")
					+ (already.length > 0 ? getLang("alreadyAdmin", already.length, already.map(uid => `  • ${uid}`).join("\n")) : "")
				);
			}

			case "superremove": {
				if (!isSuperAdmin(senderID))
					return message.reply(getLang("noPermSuper"));

				const uids = getTargetUIDs();
				if (!uids.length) return message.reply(getLang("missingIdRemove"));

				if (uids.includes(senderID))
					return message.reply(getLang("cantRemoveSelf"));

				const removed = [], notSuper = [];
				for (const uid of uids) {
					if (isSuperAdmin(uid)) removed.push(String(uid));
					else notSuper.push(uid);
				}

				config.superAdminBot = (config.superAdminBot || []).filter(id => !removed.includes(id));
				writeFileSync(global.client.dirConfig, JSON.stringify(config, null, 2));

				const names = await resolveNames(uids);
				return message.reply(
					(removed.length > 0  ? getLang("superRemoved",  removed.length, names.filter(n => removed.includes(n.uid)).map(n => `  • ${n.name} (${n.uid})`).join("\n")) : "")
					+ (notSuper.length > 0 ? getLang("notSuperAdmin", notSuper.length, notSuper.map(uid => `  • ${uid}`).join("\n")) : "")
				);
			}

			case "list":
			case "-l": {
				const superAdmins = getSuperAdmins();
				const normalAdmins = config.adminBot.filter(uid => !superAdmins.includes(uid));

				const superNames  = await resolveNames(superAdmins);
				const normalNames = await resolveNames(normalAdmins);

				const superList  = superNames.length  ? superNames.map((n, i)  => `  ${i + 1}. 👑 ${n.name} (${n.uid})`).join("\n") : "  (none)";
				const normalList = normalNames.length ? normalNames.map((n, i) => `  ${i + 1}. 🛡️ ${n.name} (${n.uid})`).join("\n") : "  (none)";

				return message.reply(getLang("listAdmin", superList, normalList));
			}

			default:
				return message.SyntaxError();
		}
	}
};
