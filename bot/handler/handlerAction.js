const createFuncMessage = global.utils.message;
const handlerCheckDB = require("./handlerCheckData.js");
const fs = require("fs-extra");
const path = require("path");

const DM_LOCK_PATH = path.join(process.cwd(), "database/data/dmLock.json");

function isDmLocked() {
  if (global.GoatBot.dmLocked !== undefined) return global.GoatBot.dmLocked;
  try {
    if (fs.existsSync(DM_LOCK_PATH)) {
      const data = JSON.parse(fs.readFileSync(DM_LOCK_PATH, "utf8"));
      global.GoatBot.dmLocked = !!data.locked;
      return global.GoatBot.dmLocked;
    }
  } catch (_) {}
  global.GoatBot.dmLocked = false;
  return false;
}

function isBotAdmin(senderID) {
  const admins = (global.GoatBot.config.adminBot || []).map(String);
  return admins.includes(String(senderID));
}

module.exports = (
  api,
  threadModel,
  userModel,
  dashBoardModel,
  globalModel,
  usersData,
  threadsData,
  dashBoardData,
  globalData
) => {
  const handlerEvents = require(
    process.env.NODE_ENV == "development"
      ? "./handlerEvents.dev.js"
      : "./handlerEvents.js"
  )(
    api,
    threadModel,
    userModel,
    dashBoardModel,
    globalModel,
    usersData,
    threadsData,
    dashBoardData,
    globalData
  );

  return async function (event) {
    const senderID = event.senderID || event.userID || event.author;
    const isAdmin = isBotAdmin(senderID);

    // ✅ Anti-Inbox Protection (only when enabled AND sender is not a bot admin)
    if (
      global.GoatBot.config.antiInbox == true &&
      !isAdmin &&
      event.isGroup == false
    )
      return;

    // ✅ DM Lock: when locked, only bot admins can use the bot in private DMs
    if (event.isGroup == false && !isAdmin && isDmLocked()) return;

    // ─── Liberty E2EE Middleware ────────────────────────────────────────
    try {
      const e2eeMiddleware = require("../e2ee/middleware");
      if (
        event.body &&
        typeof event.body === "string" &&
        event.body.startsWith("🔒E2EE:")
      ) {
        const result = await e2eeMiddleware.processEvent(api, event);
        if (result.action === "handled") return;
        if (result.action === "decrypted") event = result.event;
      }
    } catch (e2eeErr) {}
    // ────────────────────────────────────────────────────────────────────

    // ── علامة الصح الزرقة (mark as read) ────────────────────────────────────
    if (event.type === "message" || event.type === "message_reply") {
      api.markAsRead(event.threadID).catch(() => {});
    }

    const message = createFuncMessage(api, event);
    await handlerCheckDB(usersData, threadsData, event);

    let handlerChat;
    try {
      handlerChat = await handlerEvents(event, message);
    } catch (err) {
      // DM processing error — log but don't crash the listener
      global.utils?.log?.err?.("HANDLER", "Error processing event: " + err.message);
      return;
    }
    if (!handlerChat) return;

    const {
      onAnyEvent,
      onFirstChat,
      onStart,
      onChat,
      onReply,
      onEvent,
      handlerEvent,
      onReaction,
      typ,
      presence,
      read_receipt
    } = handlerChat;

    onAnyEvent();

    switch (event.type) {
      case "message":
      case "message_reply":
      case "message_unsend":
        onFirstChat();
        onChat();
        onStart();
        onReply();
        break;

      case "event":
        handlerEvent();
        onEvent();
        break;

      case "message_reaction":
        onReaction();

        // 💣 React-Unsend System
        try {
          const cfg = global.GoatBot.config.reactUnsend || {};
          const adminIDs = global.GoatBot.config.adminBot || [];
          const isAdmin2 = adminIDs.map(String).includes(String(event.userID || event.senderID));

          if (
            cfg.enable &&
            cfg.emojis?.includes(event.reaction) &&
            (!cfg.onlyAdmin || isAdmin2)
          ) {
            await api.unsendMessage(event.messageID);
          }
        } catch (err) {
          console.error("❌ React-Unsend Error:", err);
        }

        break;

      case "typ":
        typ();
        break;

      case "presence":
        presence();
        break;

      case "read_receipt":
        read_receipt();
        break;

      default:
        break;
    }
  };
};
