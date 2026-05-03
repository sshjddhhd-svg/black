module.exports = {
	config: {
		name: "checkwarn",
		version: "2.0",
		author: "NTKhang | Fixed by GoatBot",
		category: "events"
	},

	langs: {
		vi: {
			warn: "Thành viên %1 đã bị cảnh cáo đủ 3 lần trước đó và bị ban khỏi box chat\n- Name: %1\n- Uid: %2\n- Để gỡ ban vui lòng sử dụng lệnh \"%3warn unban <uid>\" (với uid là uid của người muốn gỡ ban)",
			needPermission: "Bot cần quyền quản trị viên để kick thành viên bị ban"
		},
		en: {
			warn: "⛔ Member %1 has been warned 3 times before and has been banned from the chat box\n- Name: %1\n- Uid: %2\n- To unban, please use the \"%3warn unban <uid>\" command",
			needPermission: "⚠️ Bot needs administrator permission to kick banned members"
		}
	},

	onStart: async ({ threadsData, message, event, api, client, getLang }) => {
		if (event.logMessageType !== "log:subscribe") return;

		return async function () {
			const { threadID } = event;
			const { data } = await threadsData.get(threadID);
			const warnList = data?.warn;
			if (!warnList || !warnList.length) return;

			const { addedParticipants } = event.logMessageData;
			for (const participant of addedParticipants) {
				const uid = participant.userFbId;
				const fullName = participant.fullName;

				// FIX: was comparing user.userID == user.userID (always true)
				// Now correctly compares participant uid against the warn list
				const findUser = warnList.find(w => w.uid == uid);

				if (findUser && findUser.list && findUser.list.length >= 3) {
					message.send(
						{
							body: getLang("warn", fullName, uid, client.getPrefix(threadID)),
							mentions: [{ tag: fullName, id: uid }]
						},
						function () {
							api.removeUserFromGroup(uid, threadID, (err) => {
								if (err) message.send(getLang("needPermission"));
							});
						}
					);
				}
			}
		};
	}
};
