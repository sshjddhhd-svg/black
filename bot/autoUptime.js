const axios = require('axios');
const { config } = global.GoatBot;
const { log, getText } = global.utils;

// Clear any previous timer
if (global.timeOutUptime != undefined)
	clearTimeout(global.timeOutUptime);

if (!config.autoUptime.enable)
	return;

const PORT = config.dashBoard?.port || (!isNaN(config.serverUptime.port) && config.serverUptime.port) || 3001;

let myUrl = config.autoUptime.url || `https://${
	process.env.REPL_OWNER
		? `${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`
		: process.env.API_SERVER_EXTERNAL == "https://api.glitch.com"
			? `${process.env.PROJECT_DOMAIN}.glitch.me`
			: `localhost:${PORT}`
}`;
myUrl.includes('localhost') && (myUrl = myUrl.replace('https', 'http'));
myUrl += '/uptime';

let status = 'ok';

// FIX: use only recursive setTimeout (not setTimeout + setInterval which caused double-execution)
// FIX: timeInterval is in seconds, so multiply by 1000 consistently (was missing * 1000 inside the interval)
const intervalMs = (config.autoUptime.timeInterval || 180) * 1000;

async function autoUptime() {
	try {
		await axios.get(myUrl, { timeout: 10000 });
		if (status !== 'ok') {
			status = 'ok';
			log.info("UPTIME", "Bot is online");
		}
	} catch (e) {
		const err = e.response?.data || e;

		if (status === 'ok') {
			status = 'failed';

			if (err.statusAccountBot === "can't login") {
				log.err("UPTIME", "Can't login account bot");
			} else if (err.statusAccountBot === "block spam") {
				log.err("UPTIME", "Your account is blocked");
			} else {
				log.warn("UPTIME", "Uptime ping failed: " + (e.message || e));
			}
		}
	}

	// Schedule next ping using setTimeout (not setInterval) to avoid drift and double-execution
	global.timeOutUptime = setTimeout(autoUptime, intervalMs);
}

// Start after first interval (same as original intent)
global.timeOutUptime = setTimeout(autoUptime, intervalMs);
log.info("AUTO UPTIME", getText("autoUptime", "autoUptimeTurnedOn", myUrl));
