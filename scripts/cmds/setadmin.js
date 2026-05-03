/**
 * /setadmin @tag       — ترقية مستخدم إلى أدمن في الغروب
 * /setadmin remove @tag — إزالة أدمن من الغروب
 * /setadmin all        — إزالة جميع الأدمن ما عدا أدمن البوت
 */

module.exports = {
	config: {
		name: "setadmin",
		aliases: ["promote", "demote", "unadmin"],
		version: "1.0",
		author: "Custom",
		countDown: 5,
		role: 1,
		description: {
			en: "Promote/demote group admins, or remove all admins except bot admin"
		},
		category: "admin",
		guide: {
			en:
				"  {pn} @tag           — ترقية مستخدم إلى أدمن\n" +
				"  {pn} remove @tag    — إزالة أدمن (خفض)\n" +
				"  {pn} all            — إزالة جميع الأدمن ما عدا البوت"
		}
	},

	langs: {
		en: {
			notGroupAdmin: "❌ البوت ليس أدمن في هذا الغروب.",
			noTarget:      "⚠️ تاق شخصاً أو ردّ على رسالته.",
			promoted:      "✅ تمت ترقية %1 إلى أدمن.",
			demoted:       "✅ تم خفض %1 من الأدمن.",
			allRemoved:    "✅ تم إزالة جميع الأدمن (%1 شخص) — البوت هو الأدمن الوحيد.",
			error:         "❌ فشلت العملية: %1"
		}
	},

	onStart: async function ({ api, event, args, message, threadsData, usersData, getLang }) {
		const { threadID, senderID, mentions, messageReply } = event;

		// تحقق أن البوت أدمن
		const threadInfo    = await threadsData.get(threadID);
		const adminIDs      = (threadInfo.adminIDs || []).map(a => String(a.id || a));
		const botID         = String(api.getCurrentUserID());

		if (!adminIDs.includes(botID))
			return message.reply(getLang("notGroupAdmin"));

		const sub = (args[0] || "").toLowerCase();

		// ── إزالة جميع الأدمن ما عدا البوت ─────────────────────────────────
		if (sub === "all") {
			const toRemove = adminIDs.filter(id => id !== botID);
			if (toRemove.length === 0)
				return message.reply("ℹ️ لا يوجد أدمن آخرون لإزالتهم.");

			let failed = 0;
			for (const id of toRemove) {
				try {
					await api.changeAdminStatus(threadID, id, false);
					await new Promise(r => setTimeout(r, 400));
				} catch (_) { failed++; }
			}
			return message.reply(getLang("allRemoved", toRemove.length - failed));
		}

		// ── تحديد المستخدم المستهدف ──────────────────────────────────────────
		let targetID = null;
		let targetName = null;

		const mentionIDs = Object.keys(mentions);
		if (mentionIDs.length > 0) {
			// تجاهل الكلمة الأولى إذا كانت "remove"
			const ids = (sub === "remove") ? mentionIDs : mentionIDs;
			targetID   = String(ids[0]);
			targetName = mentions[ids[0]] || targetID;
		} else if (messageReply) {
			targetID   = String(messageReply.senderID);
			targetName = await usersData.getName(targetID).catch(() => targetID) || targetID;
		} else {
			return message.reply(getLang("noTarget"));
		}

		// ── ترقية أو خفض ─────────────────────────────────────────────────────
		const isRemove = sub === "remove" || event.body?.toLowerCase().includes("demote") || event.body?.toLowerCase().startsWith("/unadmin");
		const makeAdmin = !isRemove;

		try {
			await api.changeAdminStatus(threadID, targetID, makeAdmin);
			return message.reply(
				makeAdmin
					? getLang("promoted", targetName)
					: getLang("demoted",  targetName)
			);
		} catch (err) {
			return message.reply(getLang("error", err?.message || String(err)));
		}
	}
};
