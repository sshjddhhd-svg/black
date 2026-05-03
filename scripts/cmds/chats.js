const fs = require("fs-extra");
const path = require("path");

const angelDataPath = path.join(process.cwd(), "database/data/angelData.json");
const dmLockPath   = path.join(process.cwd(), "database/data/dmLock.json");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isBotAdmin(senderID) {
  const admins = (global.GoatBot.config.adminBot || []).map(String);
  return admins.includes(String(senderID));
}

// ─── DM Lock ──────────────────────────────────────────────────────────────────

function getDmLocked() {
  if (global.GoatBot.dmLocked !== undefined) return !!global.GoatBot.dmLocked;
  try {
    if (fs.existsSync(dmLockPath)) {
      const d = JSON.parse(fs.readFileSync(dmLockPath, "utf8"));
      global.GoatBot.dmLocked = !!d.locked;
      return global.GoatBot.dmLocked;
    }
  } catch (_) {}
  return false;
}

function setDmLocked(val) {
  global.GoatBot.dmLocked = !!val;
  try {
    fs.ensureDirSync(path.dirname(dmLockPath));
    fs.writeFileSync(dmLockPath, JSON.stringify({ locked: !!val }, null, 2));
  } catch (_) {}
}

// ─── Angel ────────────────────────────────────────────────────────────────────

function loadAngelData() {
  try {
    if (fs.existsSync(angelDataPath)) return JSON.parse(fs.readFileSync(angelDataPath, "utf8"));
  } catch (_) {}
  return {};
}

function saveAngelData(data) {
  try {
    fs.ensureDirSync(path.dirname(angelDataPath));
    fs.writeFileSync(angelDataPath, JSON.stringify(data, null, 2));
  } catch (_) {}
}

function startAngelInterval(api, threadID, threadData) {
  if (!global.GoatBot.angelIntervals) global.GoatBot.angelIntervals = {};
  if (global.GoatBot.angelIntervals[threadID]) {
    clearInterval(global.GoatBot.angelIntervals[threadID]);
    delete global.GoatBot.angelIntervals[threadID];
  }
  if (!threadData.active || !threadData.message) return;
  const ms = Math.max((threadData.intervalMinutes || 10), 1) * 60 * 1000;
  global.GoatBot.angelIntervals[threadID] = setInterval(() => {
    api.sendMessage(threadData.message, threadID).catch(() => {});
  }, ms);
}

function stopAngelInterval(threadID) {
  if (global.GoatBot.angelIntervals?.[threadID]) {
    clearInterval(global.GoatBot.angelIntervals[threadID]);
    delete global.GoatBot.angelIntervals[threadID];
  }
}

// ─── Reply helper ─────────────────────────────────────────────────────────────

function setReply(api, event, commandName, info, replyData) {
  if (!info?.messageID) return;
  global.GoatBot.onReply.set(info.messageID, {
    commandName,
    messageID: info.messageID,
    author: event.senderID,
    ...replyData
  });
}

// ─── Thread list fetcher ──────────────────────────────────────────────────────

async function safeGetThreadList(api, limit, cursor, tags) {
  try {
    const result = await api.getThreadList(limit, cursor, tags);
    if (Array.isArray(result)) return result;
    if (result?.data) return result.data;
    return [];
  } catch (_) { return []; }
}

async function getAllGroups(api) {
  let groups = [];
  let cursor = null;
  let pages = 0;
  while (pages < 5) {
    const batch = await safeGetThreadList(api, 50, cursor, ["INBOX"]);
    if (!batch.length) break;
    groups = groups.concat(batch.filter(t => t && t.isGroup && t.threadID));
    const lastItem = batch[batch.length - 1];
    if (!lastItem || batch.length < 50) break;
    cursor = lastItem.timestamp || null;
    if (!cursor) break;
    pages++;
    await new Promise(r => setTimeout(r, 300));
  }
  return groups;
}

async function getAllDMs(api) {
  const seen = new Set();
  let dms = [];

  // ── INBOX ─────────────────────────────────────────────────────────────────
  let cursor = null;
  let pages = 0;
  while (pages < 4) {
    const batch = await safeGetThreadList(api, 50, cursor, ["INBOX"]);
    if (!batch.length) break;
    for (const t of batch) {
      if (t && !t.isGroup && t.threadID && !seen.has(String(t.threadID))) {
        seen.add(String(t.threadID));
        dms.push(t);
      }
    }
    const lastItem = batch[batch.length - 1];
    if (!lastItem || batch.length < 50) break;
    cursor = lastItem.timestamp || null;
    if (!cursor) break;
    pages++;
    await new Promise(r => setTimeout(r, 200));
  }

  // ── PENDING + OTHER (طلبات لم تُقبل بعد) ─────────────────────────────────
  const pendingList = await safeGetThreadList(api, 30, null, ["PENDING"]);
  const otherList   = await safeGetThreadList(api, 30, null, ["OTHER"]);
  for (const t of [...pendingList, ...otherList]) {
    if (t && !t.isGroup && t.threadID && !seen.has(String(t.threadID))) {
      seen.add(String(t.threadID));
      t._pending = true;
      dms.push(t);
    }
  }

  return dms;
}

// ─── Remote command executor ──────────────────────────────────────────────────

async function executeCommandInThread(api, event, fullInput, targetThreadID, targetName, isGroupTarget) {
  if (!fullInput || !fullInput.trim()) return "❌ الأمر فارغ.";
  const prefix = global.GoatBot.config.prefix || "/";
  let body = fullInput.trim();
  if (!body.startsWith(prefix)) body = prefix + body;
  const parts = body.slice(prefix.length).trim().split(/\s+/);
  const cmdName = parts[0]?.toLowerCase();
  const args = parts.slice(1);
  if (!cmdName) return "❌ اسم الأمر غير صحيح.";
  const cmd = global.GoatBot.commands.get(cmdName)
    || [...global.GoatBot.commands.values()].find(c =>
      c.config?.aliases?.map(a => a.toLowerCase()).includes(cmdName)
    );
  if (!cmd?.onStart) return `❌ الأمر "${cmdName}" غير موجود أو لا يدعم التنفيذ.`;
  const fakeEvent = {
    threadID: targetThreadID,
    senderID: event.senderID,
    messageID: "remote_" + Date.now(),
    body: body,
    isGroup: !!isGroupTarget,
    type: "message",
    attachments: [],
    mentions: {}
  };
  try {
    await cmd.onStart({
      api,
      event: fakeEvent,
      args,
      commandName: cmd.config.name,
      message: {
        reply: (msg) => api.sendMessage(typeof msg === "object" ? msg : { body: String(msg) }, targetThreadID),
        send:  (msg) => api.sendMessage(typeof msg === "object" ? msg : { body: String(msg) }, targetThreadID),
      },
      threadsData: global.GoatBot.threadsData,
      usersData: global.GoatBot.usersData,
      dashBoardData: global.GoatBot.dashBoardData,
      globalData: global.GoatBot.globalData,
      role: 2,
      getLang: () => (t) => t,
    });
    return `✅ تم تنفيذ "${cmdName}" في "${targetName}"`;
  } catch (e) {
    return `❌ فشل تنفيذ "${cmdName}": ${e.message?.slice(0, 100)}`;
  }
}

// ─── Module ───────────────────────────────────────────────────────────────────

module.exports = {
  config: {
    name: "chats",
    aliases: ["groups", "dms"],
    version: "4.0",
    author: "Saint",
    countDown: 5,
    role: 2,
    description: "إدارة المحادثات — غروبات وخاص وقفل الرسائل",
    category: "admin",
    guide: { en: "  {pn}" }
  },

  onStart: async function ({ api, event, commandName }) {
    if (!isBotAdmin(event.senderID)) return;

    const locked = getDmLocked();
    const lockIcon = locked ? "🔒 مقفل" : "🔓 مفتوح";

    const menu =
      "💬 إدارة المحادثات\n"
      + "━━━━━━━━━━━━━━━━\n"
      + "1️⃣  طلبات المراسلة\n"
      + "2️⃣  الغروبات الحالية\n"
      + "3️⃣  المحادثات الخاصة\n"
      + `4️⃣  قفل الخاص · ${lockIcon}\n`
      + "━━━━━━━━━━━━━━━━\n"
      + "↩️ رد بالرقم لاختيار ما تريد";

    api.sendMessage(menu, event.threadID, (err, info) => {
      if (err || !info) return;
      setReply(api, event, commandName, info, { step: "MAIN_MENU" });
    }, event.messageID);
  },

  onReply: async function ({ api, event, Reply, commandName }) {
    if (!isBotAdmin(event.senderID)) return;
    if (event.senderID !== Reply.author) return;

    const input = (event.body || "").trim();
    const { step } = Reply;

    // ─── القائمة الرئيسية ──────────────────────────────────────────────────────
    if (step === "MAIN_MENU") {

      if (input === "1") {
        api.sendMessage("⏳ جاري جلب طلبات المراسلة...", event.threadID);
        const pending = await safeGetThreadList(api, 30, null, ["PENDING"]);
        const other   = await safeGetThreadList(api, 30, null, ["OTHER"]);
        const requests = [...pending, ...other].filter(r => r && r.threadID);

        if (!requests.length)
          return api.sendMessage("📭 لا توجد طلبات مراسلة حالياً.", event.threadID);

        const list = [];
        let msg = `📬 طلبات المراسلة (${requests.length})\n━━━━━━━━━━━━━━━\n`;
        requests.slice(0, 20).forEach((r, i) => {
          const name  = r.name || r.threadName || ("ID: " + r.threadID);
          const type  = r.isGroup ? "👥 غروب" : "👤 شخص";
          const count = Number(r.messageCount) || 0;
          msg += `${i + 1}. ${name}\n   ${type} · ${count} رسالة\n   🆔 ${r.threadID}\n\n`;
          list.push({ threadID: r.threadID, name, isGroup: !!r.isGroup });
        });
        msg += "━━━━━━━━━━━━━━━\n↩️ رد برقم الطلب للإجراء\n0️⃣  قبول الكل";

        api.sendMessage(msg, event.threadID, (err, info) => {
          if (err || !info) return;
          setReply(api, event, commandName, info, { step: "REQUEST_LIST", list });
        });

      } else if (input === "2") {
        api.sendMessage("⏳ جاري جلب الغروبات...", event.threadID);
        const groups = await getAllGroups(api);

        if (!groups.length)
          return api.sendMessage("📭 البوت ليس في أي غروب حالياً.", event.threadID);

        groups.sort((a, b) => (Number(b.messageCount) || 0) - (Number(a.messageCount) || 0));
        const list = [];
        const angelData = loadAngelData();
        let msg = `👥 الغروبات (${groups.length})\n━━━━━━━━━━━━━━━\n`;
        groups.slice(0, 25).forEach((g, i) => {
          const name  = g.name || g.threadName || ("ID: " + g.threadID);
          const angel = angelData[g.threadID]?.active ? "🟢" : "⚫";
          const count = Number(g.messageCount) || 0;
          msg += `${i + 1}. ${name}\n   💬 ${count} · Angel: ${angel}\n   🆔 ${g.threadID}\n\n`;
          list.push({ threadID: g.threadID, name });
        });
        msg += "━━━━━━━━━━━━━━━\n↩️ رد برقم الغروب لإدارته";

        api.sendMessage(msg, event.threadID, (err, info) => {
          if (err || !info) return;
          setReply(api, event, commandName, info, { step: "GROUP_LIST", list });
        });

      } else if (input === "3") {
        api.sendMessage("⏳ جاري جلب المحادثات الخاصة...", event.threadID);
        const dms = await getAllDMs(api);

        if (!dms.length)
          return api.sendMessage("📭 لا توجد محادثات خاصة حالياً.", event.threadID);

        dms.sort((a, b) => (Number(b.messageCount) || 0) - (Number(a.messageCount) || 0));
        const list = [];
        let msg = `👤 المحادثات الخاصة (${dms.length})\n━━━━━━━━━━━━━━━\n`;
        dms.slice(0, 25).forEach((d, i) => {
          const name    = d.name || d.threadName || ("ID: " + d.threadID);
          const count   = Number(d.messageCount) || 0;
          const pending = d._pending ? " · ⏳ PENDING" : "";
          msg += `${i + 1}. ${name}${pending}\n   💬 ${count} رسالة · 🆔 ${d.threadID}\n\n`;
          list.push({ threadID: d.threadID, name, isPending: !!d._pending });
        });
        msg += "━━━━━━━━━━━━━━━\n↩️ رد برقم المحادثة لإدارتها";

        api.sendMessage(msg, event.threadID, (err, info) => {
          if (err || !info) return;
          setReply(api, event, commandName, info, { step: "DM_LIST", list });
        });

      } else if (input === "4") {
        const locked = getDmLocked();
        const newLocked = !locked;
        setDmLocked(newLocked);
        const icon = newLocked ? "🔒" : "🔓";
        const statusText = newLocked
          ? "🔒 تم قفل الخاص\nالآن فقط أدمن البوت يمكنه التواصل مع البوت في الخاص."
          : "🔓 تم فتح الخاص\nالآن يمكن للجميع التواصل مع البوت في الخاص.";
        api.sendMessage(statusText, event.threadID);

      } else {
        api.sendMessage("⚠️ اختار من 1 إلى 4 فقط.", event.threadID);
      }
    }

    // ─── قائمة طلبات المراسلة ─────────────────────────────────────────────────
    else if (step === "REQUEST_LIST") {
      const { list } = Reply;
      if (input === "0") {
        api.sendMessage(`⏳ جاري قبول ${list.length} طلب...`, event.threadID);
        let success = 0, failed = 0;
        for (const req of list) {
          try {
            await api.sendMessage("مرحباً 👋", req.threadID).catch(() => {});
            await api.markAsRead(req.threadID).catch(() => {});
            success++;
            await new Promise(r => setTimeout(r, 500));
          } catch (_) { failed++; }
        }
        return api.sendMessage(`✅ تم قبول ${success} طلب${failed > 0 ? ` · فشل ${failed}` : ""}`, event.threadID);
      }
      const idx = parseInt(input) - 1;
      if (isNaN(idx) || idx < 0 || idx >= list.length)
        return api.sendMessage(`❌ رقم غير صحيح. اختار من 1 إلى ${list.length}.`, event.threadID);

      const selected = list[idx];
      const msg =
        `📨 ${selected.name}\n🆔 ${selected.threadID}\n`
        + "━━━━━━━━━━━━━━━\n"
        + "1️⃣  قبول الطلب\n"
        + "2️⃣  رفض وحذف الطلب\n"
        + "3️⃣  إرسال رسالة ثم قبول\n"
        + "━━━━━━━━━━━━━━━\n↩️ رد بالرقم";

      api.sendMessage(msg, event.threadID, (err, info) => {
        if (err || !info) return;
        setReply(api, event, commandName, info, { step: "REQUEST_ACTION", selected });
      });
    }

    // ─── إجراء الطلب ─────────────────────────────────────────────────────────
    else if (step === "REQUEST_ACTION") {
      const { selected } = Reply;
      if (input === "1") {
        try {
          await api.sendMessage("مرحباً! 👋", selected.threadID).catch(() => {});
          await api.markAsRead(selected.threadID).catch(() => {});
          api.sendMessage(`✅ تم قبول طلب "${selected.name}"`, event.threadID);
        } catch (e) {
          api.sendMessage(`❌ فشل القبول: ${e.message?.slice(0, 100)}`, event.threadID);
        }
      } else if (input === "2") {
        try {
          await api.deleteThread(selected.threadID).catch(() => {});
          api.sendMessage(`🗑️ تم حذف طلب "${selected.name}"`, event.threadID);
        } catch (e) {
          api.sendMessage(`❌ فشل الحذف: ${e.message?.slice(0, 100)}`, event.threadID);
        }
      } else if (input === "3") {
        api.sendMessage(
          `✏️ أرسل الرسالة لـ "${selected.name}" عند القبول:`,
          event.threadID,
          (err, info) => {
            if (err || !info) return;
            setReply(api, event, commandName, info, { step: "REQUEST_ACCEPT_MSG", selected });
          }
        );
      } else {
        api.sendMessage("⚠️ اختار 1 أو 2 أو 3 فقط.", event.threadID);
      }
    }

    // ─── رسالة مخصصة عند قبول الطلب ─────────────────────────────────────────
    else if (step === "REQUEST_ACCEPT_MSG") {
      const { selected } = Reply;
      try {
        await api.sendMessage(input || "مرحباً! 👋", selected.threadID);
        await api.markAsRead(selected.threadID).catch(() => {});
        api.sendMessage(`✅ تم قبول طلب "${selected.name}" وإرسال الرسالة.`, event.threadID);
      } catch (e) {
        api.sendMessage(`❌ فشل: ${e.message?.slice(0, 100)}`, event.threadID);
      }
    }

    // ─── قائمة الغروبات ───────────────────────────────────────────────────────
    else if (step === "GROUP_LIST") {
      const { list } = Reply;
      const idx = parseInt(input) - 1;
      if (isNaN(idx) || idx < 0 || idx >= list.length)
        return api.sendMessage(`❌ رقم غير صحيح. اختار من 1 إلى ${list.length}.`, event.threadID);

      const selected = list[idx];
      const angelData = loadAngelData();
      const ad = angelData[selected.threadID];
      const angelStatus = ad?.active ? "🟢 شغّال" : "⚫ متوقف";
      const angelMsg    = ad?.message || "لم تُضبط";
      const angelMins   = ad?.intervalMinutes || 10;

      const msg =
        `👥 ${selected.name}\n🆔 ${selected.threadID}\n`
        + `Angel: ${angelStatus} · "${angelMsg}" · كل ${angelMins} دقيقة\n`
        + "━━━━━━━━━━━━━━━\n"
        + "1️⃣  تفعيل Angel\n"
        + "2️⃣  إيقاف Angel\n"
        + "3️⃣  ضبط رسالة Angel\n"
        + "4️⃣  ضبط وقت Angel\n"
        + "5️⃣  إخراج البوت من الغروب\n"
        + "6️⃣  إرسال رسالة للغروب\n"
        + "7️⃣  تنفيذ أمر في الغروب 🔧\n"
        + "━━━━━━━━━━━━━━━\n↩️ رد بالرقم";

      api.sendMessage(msg, event.threadID, (err, info) => {
        if (err || !info) return;
        setReply(api, event, commandName, info, { step: "GROUP_ACTION", selected });
      });
    }

    // ─── إجراء الغروب ────────────────────────────────────────────────────────
    else if (step === "GROUP_ACTION") {
      const { selected } = Reply;
      const tid = selected.threadID;

      if (input === "1") {
        const angelData = loadAngelData();
        if (!angelData[tid]?.message)
          return api.sendMessage("❌ لم تُضبط رسالة Angel.\nاختار 3 أولاً لضبط الرسالة.", event.threadID);
        angelData[tid].active = true;
        saveAngelData(angelData);
        startAngelInterval(api, tid, angelData[tid]);
        api.sendMessage(
          `✅ تم تفعيل Angel في "${selected.name}"\n📝 "${angelData[tid].message}"\n⏱️ كل ${angelData[tid].intervalMinutes} دقيقة`,
          event.threadID
        );
      } else if (input === "2") {
        const angelData = loadAngelData();
        if (!angelData[tid]?.active)
          return api.sendMessage("⚠️ Angel ليس شغّالاً أصلاً.", event.threadID);
        angelData[tid].active = false;
        saveAngelData(angelData);
        stopAngelInterval(tid);
        api.sendMessage(`✅ تم إيقاف Angel في "${selected.name}"`, event.threadID);
      } else if (input === "3") {
        api.sendMessage(
          `✏️ أرسل الرسالة التي سيرسلها Angel في "${selected.name}":`,
          event.threadID,
          (err, info) => {
            if (err || !info) return;
            setReply(api, event, commandName, info, { step: "ANGEL_SET_MSG", selected });
          }
        );
      } else if (input === "4") {
        api.sendMessage(
          `⏱️ أرسل عدد الدقائق بين كل إرسال في "${selected.name}":`,
          event.threadID,
          (err, info) => {
            if (err || !info) return;
            setReply(api, event, commandName, info, { step: "ANGEL_SET_TIME", selected });
          }
        );
      } else if (input === "5") {
        api.sendMessage(
          `⚠️ هل تريد إخراج البوت من "${selected.name}"؟\nأرسل "نعم" للتأكيد أو أي شيء آخر للإلغاء`,
          event.threadID,
          (err, info) => {
            if (err || !info) return;
            setReply(api, event, commandName, info, { step: "GROUP_LEAVE_CONFIRM", selected });
          }
        );
      } else if (input === "6") {
        api.sendMessage(
          `💬 أرسل الرسالة التي تريد إرسالها إلى "${selected.name}":`,
          event.threadID,
          (err, info) => {
            if (err || !info) return;
            setReply(api, event, commandName, info, { step: "GROUP_SEND_MSG", selected });
          }
        );
      } else if (input === "7") {
        api.sendMessage(
          `🔧 أرسل الأمر لتنفيذه في "${selected.name}"\nأمثلة: angel on | lock on | setname اسم\nالبادئة اختيارية (${global.GoatBot.config.prefix || "/"})`,
          event.threadID,
          (err, info) => {
            if (err || !info) return;
            setReply(api, event, commandName, info, { step: "GROUP_EXEC_CMD", selected });
          }
        );
      } else {
        api.sendMessage("⚠️ اختار رقماً من 1 إلى 7.", event.threadID);
      }
    }

    // ─── ضبط رسالة Angel ─────────────────────────────────────────────────────
    else if (step === "ANGEL_SET_MSG") {
      const { selected } = Reply;
      if (!input) return api.sendMessage("❌ الرسالة فارغة.", event.threadID);
      const angelData = loadAngelData();
      if (!angelData[selected.threadID]) angelData[selected.threadID] = { intervalMinutes: 10, active: false };
      angelData[selected.threadID].message = input;
      saveAngelData(angelData);
      api.sendMessage(`✅ تم ضبط رسالة Angel في "${selected.name}":\n"${input}"`, event.threadID);
    }

    // ─── ضبط وقت Angel ───────────────────────────────────────────────────────
    else if (step === "ANGEL_SET_TIME") {
      const { selected } = Reply;
      const mins = parseFloat(input);
      if (isNaN(mins) || mins <= 0) return api.sendMessage("❌ أرسل رقماً صحيحاً (دقائق).", event.threadID);
      const angelData = loadAngelData();
      if (!angelData[selected.threadID]) angelData[selected.threadID] = { message: null, active: false };
      angelData[selected.threadID].intervalMinutes = mins;
      saveAngelData(angelData);
      if (angelData[selected.threadID].active && angelData[selected.threadID].message)
        startAngelInterval(api, selected.threadID, angelData[selected.threadID]);
      api.sendMessage(`✅ تم ضبط وقت Angel في "${selected.name}": كل ${mins} دقيقة`, event.threadID);
    }

    // ─── تأكيد الخروج من الغروب ───────────────────────────────────────────────
    else if (step === "GROUP_LEAVE_CONFIRM") {
      const { selected } = Reply;
      if (input === "نعم") {
        try {
          await api.removeUserFromGroup(api.getCurrentUserID(), selected.threadID);
          api.sendMessage(`✅ خرج البوت من "${selected.name}"`, event.threadID);
        } catch (e) {
          api.sendMessage(`❌ فشل الخروج: ${e.message?.slice(0, 100)}`, event.threadID);
        }
      } else {
        api.sendMessage("❎ تم الإلغاء.", event.threadID);
      }
    }

    // ─── إرسال رسالة للغروب ──────────────────────────────────────────────────
    else if (step === "GROUP_SEND_MSG") {
      const { selected } = Reply;
      if (!input) return api.sendMessage("❌ الرسالة فارغة.", event.threadID);
      try {
        await api.sendMessage(input, selected.threadID);
        api.sendMessage(`✅ تم إرسال الرسالة إلى "${selected.name}"`, event.threadID);
      } catch (e) {
        api.sendMessage(`❌ فشل الإرسال: ${e.message?.slice(0, 100)}`, event.threadID);
      }
    }

    // ─── تنفيذ أمر في الغروب ─────────────────────────────────────────────────
    else if (step === "GROUP_EXEC_CMD") {
      const { selected } = Reply;
      if (!input) return api.sendMessage("❌ لم ترسل أي أمر.", event.threadID);
      api.sendMessage(`⏳ جاري تنفيذ الأمر في "${selected.name}"...`, event.threadID);
      const result = await executeCommandInThread(api, event, input, selected.threadID, selected.name, true);
      api.sendMessage(result, event.threadID);
    }

    // ─── قائمة المحادثات الخاصة ───────────────────────────────────────────────
    else if (step === "DM_LIST") {
      const { list } = Reply;
      const idx = parseInt(input) - 1;
      if (isNaN(idx) || idx < 0 || idx >= list.length)
        return api.sendMessage(`❌ رقم غير صحيح. اختار من 1 إلى ${list.length}.`, event.threadID);

      const selected = list[idx];
      const msg =
        `👤 ${selected.name}\n🆔 ${selected.threadID}\n`
        + "━━━━━━━━━━━━━━━\n"
        + "1️⃣  إرسال رسالة\n"
        + "2️⃣  تنفيذ أمر في الخاص 🔧\n"
        + "3️⃣  حذف المحادثة\n"
        + "━━━━━━━━━━━━━━━\n↩️ رد بالرقم";

      api.sendMessage(msg, event.threadID, (err, info) => {
        if (err || !info) return;
        setReply(api, event, commandName, info, { step: "DM_ACTION", selected });
      });
    }

    // ─── إجراء المحادثة الخاصة ────────────────────────────────────────────────
    else if (step === "DM_ACTION") {
      const { selected } = Reply;

      // إذا كانت المحادثة PENDING، اقبلها أولاً
      if (selected.isPending && (input === "1" || input === "2")) {
        try {
          if (typeof api.handleMessageRequest === "function") {
            await api.handleMessageRequest(String(selected.threadID), true).catch(() => {});
          }
        } catch (_) {}
      }

      if (input === "1") {
        api.sendMessage(
          `💬 أرسل الرسالة التي تريد إرسالها لـ "${selected.name}":`,
          event.threadID,
          (err, info) => {
            if (err || !info) return;
            setReply(api, event, commandName, info, { step: "DM_SEND_MSG", selected });
          }
        );
      } else if (input === "2") {
        api.sendMessage(
          `🔧 أرسل الأمر لتنفيذه في خاص "${selected.name}"\nأمثلة: divel on | angel on\nالبادئة اختيارية (${global.GoatBot.config.prefix || "/"})`,
          event.threadID,
          (err, info) => {
            if (err || !info) return;
            setReply(api, event, commandName, info, { step: "DM_EXEC_CMD", selected });
          }
        );
      } else if (input === "3") {
        try {
          await api.deleteThread(selected.threadID).catch(() => {});
          api.sendMessage(`🗑️ تم حذف المحادثة مع "${selected.name}"`, event.threadID);
        } catch (e) {
          api.sendMessage(`❌ فشل الحذف: ${e.message?.slice(0, 100)}`, event.threadID);
        }
      } else {
        api.sendMessage("⚠️ اختار 1 أو 2 أو 3 فقط.", event.threadID);
      }
    }

    // ─── إرسال رسالة للخاص ────────────────────────────────────────────────────
    else if (step === "DM_SEND_MSG") {
      const { selected } = Reply;
      if (!input) return api.sendMessage("❌ الرسالة فارغة.", event.threadID);
      try {
        await api.sendMessage(input, selected.threadID);
        api.sendMessage(`✅ تم إرسال الرسالة لـ "${selected.name}"`, event.threadID);
      } catch (e) {
        api.sendMessage(`❌ فشل الإرسال: ${e.message?.slice(0, 100)}`, event.threadID);
      }
    }

    // ─── تنفيذ أمر في الخاص ───────────────────────────────────────────────────
    else if (step === "DM_EXEC_CMD") {
      const { selected } = Reply;
      if (!input) return api.sendMessage("❌ لم ترسل أي أمر.", event.threadID);
      api.sendMessage(`⏳ جاري تنفيذ الأمر في خاص "${selected.name}"...`, event.threadID);
      const result = await executeCommandInThread(api, event, input, selected.threadID, selected.name, false);
      api.sendMessage(result, event.threadID);
    }
  }
};
