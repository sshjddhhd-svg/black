const { colors } = require('../func/colors.js');
const moment     = require("moment-timezone");

// ─── Arabic RTL fix for terminals ────────────────────────────────────────────
// Wraps Arabic text with Unicode bidi control chars so it renders correctly
function rtl(text) {
  if (!text) return text;
  return "\u202B" + text + "\u202C";
}

// Fix Arabic in any string (replaces Arabic segments with RTL-wrapped versions)
function fixArabic(str) {
  if (typeof str !== "string") return str;
  return str.replace(/([\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF][^a-zA-Z0-9\n]*)+/g, (match) => rtl(match));
}

// ─── Time ────────────────────────────────────────────────────────────────────
const getTime = () => {
  const tz = (global.GoatBot?.config?.timeZone) || "Africa/Algiers";
  const t = moment().tz(tz).format("HH:mm:ss DD/MM/YYYY");
  return colors.gray(t);
};

// ─── Icons ───────────────────────────────────────────────────────────────────
const ICO = {
  info:    "✅",
  warn:    "⚠️ ",
  err:     "❌",
  success: "💚",
  master:  "📌",
  dev:     "🔧",
};

// ─── Format a log line ───────────────────────────────────────────────────────
function fmt(icon, labelColor, prefix, message) {
  const time  = getTime();
  const label = labelColor(`  ${prefix}  `);
  const msg   = fixArabic(typeof message === "string" ? message : String(message ?? ""));
  return `${time}  ${icon}  ${label} ${msg}`;
}

// ─── Extra error objects after the first message ─────────────────────────────
function printExtras(args) {
  for (let extra of Object.values(args).slice(2)) {
    if (typeof extra === "object" && !extra?.stack)
      extra = JSON.stringify(extra, null, 2);
    console.log("              ", typeof extra === "string" ? fixArabic(extra) : extra);
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  rtl,
  fixArabic,

  err: function logError(prefix, message) {
    if (message === undefined) { message = prefix; prefix = "ERROR"; }
    console.log(fmt(ICO.err, colors.redBright, prefix, message));
    printExtras(arguments);
  },

  error: function logError(prefix, message) {
    if (message === undefined) { message = prefix; prefix = "ERROR"; }
    console.log(fmt(ICO.err, colors.redBright, prefix, message));
    printExtras(arguments);
  },

  warn: function (prefix, message) {
    if (message === undefined) { message = prefix; prefix = "WARN"; }
    console.log(fmt(ICO.warn, colors.yellowBright, prefix, message));
  },

  info: function (prefix, message) {
    if (message === undefined) { message = prefix; prefix = "INFO"; }
    console.log(fmt(ICO.info, colors.cyanBright, prefix, message));
  },

  success: function (prefix, message) {
    if (message === undefined) { message = prefix; prefix = "SUCCESS"; }
    console.log(fmt(ICO.success, colors.greenBright, prefix, message));
  },

  succes: function (prefix, message) {
    if (message === undefined) { message = prefix; prefix = "SUCCESS"; }
    console.log(fmt(ICO.success, colors.greenBright, prefix, message));
  },

  master: function (prefix, message) {
    if (message === undefined) { message = prefix; prefix = "MASTER"; }
    console.log(fmt(ICO.master, colors.hex("#eb6734"), prefix, message));
  },

  dev: (...args) => {
    if (!["development", "production"].includes(process.env.NODE_ENV)) return;
    try { throw new Error(); }
    catch (err) {
      let pos = err.stack.split('\n')[2];
      pos = pos.slice(pos.indexOf(process.cwd()) + process.cwd().length + 1);
      if (pos.endsWith(')')) pos = pos.slice(0, -1);
      console.log(`\x1b[36m${pos} =>\x1b[0m`, ...args);
    }
  }
};
