/**
 * /accounts — Backup Account Management Command
 *
 * Manages the list of backup Facebook accounts used for auto-rotation.
 *
 * Usage:
 *   /accounts list              — Show all configured accounts and their status
 *   /accounts add <email> <password> [label] — Add a backup account
 *   /accounts remove <index>    — Remove account by index
 *   /accounts switch <index>    — Manually switch to an account
 *   /accounts status            — Show rotation system status
 *   /accounts unrestrict <index> — Mark an account as healthy again
 *   /accounts enable            — Enable auto-rotation
 *   /accounts disable           — Disable auto-rotation
 */

const { writeFileSync } = require("fs-extra");

module.exports = {
  config: {
    name: "accounts",
    version: "1.0",
    author: "GoatBot",
    countDown: 10,
    role: 3,
    description: { en: "Manage backup Facebook accounts for auto-rotation (super admin only)" },
    category: "system",
    guide: {
      en: "  {pn} list\n"
        + "  {pn} add <email> <password> [label]\n"
        + "  {pn} remove <index>\n"
        + "  {pn} switch <index>\n"
        + "  {pn} status\n"
        + "  {pn} unrestrict <index>\n"
        + "  {pn} enable | disable"
    }
  },

  langs: {
    en: {
      noConfig:      "❌ accountRotation is not configured in config.json.",
      listTitle:     "📋 Backup Account Roster\n══════════════════════",
      listEntry:     "%1. %2 %3 (%4)\n   📧 %5\n   🔒 2FA: %6",
      noAccounts:    "No accounts configured yet. Use /accounts add to add one.",
      statusTitle:   "📊 Account Rotator Status\n═══════════════════════",
      addSuccess:    "✅ Account added: %1 (%2)\nIndex: %3",
      addDuplicate:  "⚠️ That email is already in the list.",
      removeSuccess: "✅ Removed account [%1]: %2",
      removeInvalid: "⚠️ Invalid index. Use /accounts list to see valid indexes.",
      removeLast:    "❌ Cannot remove the last account.",
      switchStart:   "🔄 Switching to account [%1]: %2\nThis will restart the bot in ~10 seconds...",
      switchInvalid: "⚠️ Invalid index.",
      switchSame:    "ℹ️ Already using account [%1].",
      noRotator:     "❌ Account rotator module not found.",
      enabledOk:     "✅ Auto-rotation ENABLED.",
      disabledOk:    "✅ Auto-rotation DISABLED.",
      unrestricted:  "✅ Account [%1] marked as healthy (unrestricted).",
      roleError:     "❌ This command requires Super Admin (level 3)."
    }
  },

  onStart: async function ({ message, args, event, getLang }) {
    const { senderID } = event;

    // Super admin check (role: 3 in config should handle it, but double-check)
    const superAdmins = global.GoatBot?.config?.superAdminBot || [];
    const adminBot    = global.GoatBot?.config?.adminBot      || [];
    if (!superAdmins.includes(String(senderID)) && !adminBot.includes(String(senderID))) {
      return message.reply(getLang("roleError"));
    }

    const cfg = global.GoatBot?.config;
    if (!cfg) return message.reply("❌ Config not loaded.");

    if (!cfg.accountRotation) {
      cfg.accountRotation = {
        enable: false,
        accounts: [],
        currentIndex: 0,
        restrictedIndexes: []
      };
    }

    const rot      = cfg.accountRotation;
    const accounts = rot.accounts;

    const save = () => {
      try {
        writeFileSync(global.client.dirConfig, JSON.stringify(cfg, null, 2));
      } catch (e) {
        message.reply("⚠️ Failed to save config: " + e.message);
      }
    };

    const action = (args[0] || "list").toLowerCase();

    switch (action) {

      // ── list ──────────────────────────────────────────────────────────────
      case "list": {
        if (!accounts.length) return message.reply(getLang("listTitle") + "\n\n" + getLang("noAccounts"));
        const restricted = rot.restrictedIndexes || [];
        const lines = accounts.map((acc, i) => {
          const isCurrent    = i === rot.currentIndex;
          const isRestricted = restricted.includes(i);
          const statusIcon   = isCurrent ? "✅" : isRestricted ? "🚫" : "💤";
          const statusText   = isCurrent ? "ACTIVE" : isRestricted ? "RESTRICTED" : "STANDBY";
          const label        = acc.label || `Account #${i}`;
          const has2FA       = acc["2FASecret"] ? "Yes" : "No";
          return getLang("listEntry", i, statusIcon, label, statusText, acc.email, has2FA);
        });
        return message.reply(
          getLang("listTitle") + "\n\n" + lines.join("\n\n") +
          "\n\n" + `Auto-rotation: ${rot.enable ? "✅ ENABLED" : "❌ DISABLED"}`
        );
      }

      // ── add ───────────────────────────────────────────────────────────────
      case "add": {
        const email    = args[1];
        const password = args[2];
        const label    = args.slice(3).join(" ") || `Backup ${accounts.length}`;

        if (!email || !password)
          return message.reply("⚠️ Usage: /accounts add <email> <password> [label]");

        if (accounts.some(a => a.email.toLowerCase() === email.toLowerCase()))
          return message.reply(getLang("addDuplicate"));

        accounts.push({ email, password, "2FASecret": "", label });
        save();
        return message.reply(getLang("addSuccess", label, email, accounts.length - 1));
      }

      // ── remove ────────────────────────────────────────────────────────────
      case "remove": {
        const idx = parseInt(args[1]);
        if (isNaN(idx) || idx < 0 || idx >= accounts.length)
          return message.reply(getLang("removeInvalid"));
        if (accounts.length <= 1)
          return message.reply(getLang("removeLast"));

        const removed = accounts.splice(idx, 1)[0];

        // Adjust currentIndex if needed
        if (rot.currentIndex >= accounts.length)
          rot.currentIndex = 0;
        // Remove from restricted list
        rot.restrictedIndexes = (rot.restrictedIndexes || [])
          .filter(i => i !== idx)
          .map(i => i > idx ? i - 1 : i);

        save();
        return message.reply(getLang("removeSuccess", idx, removed.email));
      }

      // ── switch ────────────────────────────────────────────────────────────
      case "switch": {
        const idx = parseInt(args[1]);
        if (isNaN(idx) || idx < 0 || idx >= accounts.length)
          return message.reply(getLang("switchInvalid"));
        if (idx === rot.currentIndex)
          return message.reply(getLang("switchSame", idx));

        const target = accounts[idx];
        await message.reply(getLang("switchStart", idx, target.email));

        try {
          const rotator = require("../../bot/accountRotator/index.js");
          // Temporarily set currentIndex to one before target so rotation picks target
          rot.currentIndex = (idx - 1 + accounts.length) % accounts.length;
          save();
          await rotator.rotateAccount(`Manual switch requested by admin ${senderID}`);
        } catch (e) {
          return message.reply(getLang("noRotator") + "\n" + e.message);
        }
        break;
      }

      // ── status ────────────────────────────────────────────────────────────
      case "status": {
        try {
          const rotator = require("../../bot/accountRotator/index.js");
          const s = rotator.getStatus();
          const lastRot = s.lastRotationTime
            ? new Date(s.lastRotationTime).toLocaleString()
            : "Never";
          return message.reply(
            getLang("statusTitle") + "\n\n" +
            `📊 Total accounts:  ${s.totalAccounts}\n` +
            `✅ Current:         [${s.currentIndex}] ${s.currentLabel}\n` +
            `📧 Email:           ${s.currentEmail}\n` +
            `🔄 Auto-rotation:   ${s.enabled ? "Enabled" : "Disabled"}\n` +
            `🚫 Restricted:      ${s.restrictedIndexes.length > 0 ? s.restrictedIndexes.join(", ") : "None"}\n` +
            `⏱️ Last rotation:    ${lastRot}\n` +
            `📝 Last reason:     ${s.lastRotationReason || "N/A"}\n` +
            `🔁 Attempts:        ${s.rotationAttempts}`
          );
        } catch (e) {
          return message.reply(getLang("noRotator"));
        }
      }

      // ── unrestrict ────────────────────────────────────────────────────────
      case "unrestrict": {
        const idx = parseInt(args[1]);
        if (isNaN(idx) || idx < 0 || idx >= accounts.length)
          return message.reply(getLang("switchInvalid"));
        rot.restrictedIndexes = (rot.restrictedIndexes || []).filter(i => i !== idx);
        save();
        return message.reply(getLang("unrestricted", idx));
      }

      // ── enable / disable ──────────────────────────────────────────────────
      case "enable": {
        rot.enable = true;
        save();
        return message.reply(getLang("enabledOk"));
      }
      case "disable": {
        rot.enable = false;
        save();
        return message.reply(getLang("disabledOk"));
      }

      default:
        return message.SyntaxError();
    }
  }
};
