let healthTimer  = null;
let restartCount = 0;
let backoffMs    = 0;
let lastSuccessTime = Date.now();

function getConfig() {
	const cfg = global.GoatBot?.config?.mqttHealthCheck || {};
	return {
		enable:              cfg.enable !== false,
		silentTimeoutMs:     (cfg.silentTimeoutMinutes    || 10) * 60 * 1000,
		checkIntervalMinMs:  (cfg.checkIntervalMinMinutes || 2)  * 60 * 1000,
		checkIntervalMaxMs:  (cfg.checkIntervalMaxMinutes || 5)  * 60 * 1000,
		maxRestarts:         cfg.maxRestarts      || 5,
		notifyAdmins:        cfg.notifyAdmins     !== false,
		backoffMultiplier:   cfg.backoffMultiplier || 1.5,
		maxBackoffMs:        (cfg.maxBackoffMinutes || 15) * 60 * 1000
	};
}

function randomBetween(min, max) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getJitteredInterval(minMs, maxMs) {
	return randomBetween(minMs, maxMs);
}

function sendAdminMessage(message) {
	try {
		const api    = global.GoatBot?.fcaApi;
		const admins = global.GoatBot?.config?.adminBot || [];
		if (!api) return;
		for (const adminID of admins) {
			const id = String(adminID).trim();
			if (!id || id === " ") continue;
			api.sendMessage(message, id).catch(() => {});
		}
	} catch (e) {}
}

// FIX: expose a function to reset the backoff counter when MQTT is healthy
function onMqttActivity() {
	const now = Date.now();
	global.lastMqttActivity = now;

	// If enough time has passed without a restart, reset the counter
	if (restartCount > 0 && (now - lastSuccessTime) > 5 * 60 * 1000) {
		restartCount  = 0;
		backoffMs     = 0;
		lastSuccessTime = now;
		global.utils?.log?.info?.("MQTT_HEALTH", "MQTT is healthy — restart counter reset.");
	}
}

async function doHealthCheck() {
	const cfg = getConfig();
	if (!cfg.enable) return scheduleNextCheck();

	const api = global.GoatBot?.fcaApi;
	if (!api) return scheduleNextCheck();

	const lastActivity = global.lastMqttActivity || global.GoatBot?.startTime || Date.now();
	const silentFor    = Date.now() - lastActivity;

	if (silentFor < cfg.silentTimeoutMs) {
		// FIX: reset backoff and restart counter when connection is healthy
		if (restartCount > 0) {
			restartCount    = 0;
			backoffMs       = 0;
			lastSuccessTime = Date.now();
			global.utils?.log?.info?.("MQTT_HEALTH", "MQTT recovered — counters reset.");
		}
		return scheduleNextCheck();
	}

	if (global.isRelogining) {
		global.utils?.log?.info?.("MQTT_HEALTH", "Relogin already in progress — skipping health check restart.");
		return scheduleNextCheck();
	}

	if (restartCount >= cfg.maxRestarts) {
		global.utils?.log?.err?.("MQTT_HEALTH", `Max restarts (${cfg.maxRestarts}) reached. Stopping health check.`);
		stopHealthCheck();
		if (cfg.notifyAdmins) {
			sendAdminMessage(
				`⛔ MQTT HEALTH CHECK\n\nBot restarted MQTT ${cfg.maxRestarts} times with no recovery.\nManual intervention required.`
			);
		}
		return;
	}

	// FIX: backoff logic — first attempt: pick a random initial backoff and wait
	// then multiply it for subsequent attempts (was: first wait = 0)
	if (backoffMs === 0) {
		backoffMs = randomBetween(15000, 45000);
	}

	global.utils?.log?.warn?.("MQTT_HEALTH", `Backoff: waiting ${Math.round(backoffMs / 1000)}s before restart...`);
	await new Promise(r => setTimeout(r, backoffMs));

	restartCount++;
	const silentMinutes = Math.round(silentFor / 60000);
	global.utils?.log?.warn?.("MQTT_HEALTH",
		`No MQTT activity for ${silentMinutes} min. Restarting listener (${restartCount}/${cfg.maxRestarts})...`
	);

	if (cfg.notifyAdmins) {
		sendAdminMessage(
			`⚠️ MQTT HEALTH CHECK\n\nNo activity for ${silentMinutes} min.\nRestarting listener (attempt ${restartCount}/${cfg.maxRestarts})...`
		);
	}

	try {
		if (api && typeof api.stopListening === "function") {
			await new Promise(resolve => {
				if (!api.stopListening(() => resolve())) resolve();
			});
			const pauseMs = randomBetween(800, 2500);
			await new Promise(r => setTimeout(r, pauseMs));
		}

		const reLoginBot = global.GoatBot?.reLoginBot;
		if (typeof reLoginBot === "function") {
			global.lastMqttActivity = Date.now();
			global.utils?.log?.info?.("MQTT_HEALTH", "Triggering re-login to recover MQTT...");
			reLoginBot();
		} else {
			global.utils?.log?.err?.("MQTT_HEALTH", "reLoginBot function not found.");
		}
	} catch (e) {
		global.utils?.log?.err?.("MQTT_HEALTH", "Error during restart: " + (e?.message || e));
	}

	// FIX: grow backoff AFTER using it (not before)
	backoffMs = Math.min(backoffMs * cfg.backoffMultiplier, cfg.maxBackoffMs);

	scheduleNextCheck();
}

function scheduleNextCheck() {
	if (healthTimer) clearTimeout(healthTimer);
	const cfg = getConfig();
	if (!cfg.enable) return;
	const delay   = getJitteredInterval(cfg.checkIntervalMinMs, cfg.checkIntervalMaxMs);
	const minutes = (delay / 60000).toFixed(1);
	global.utils?.log?.info?.("MQTT_HEALTH", `Next check in ${minutes} min`);
	healthTimer = setTimeout(doHealthCheck, delay);
}

function startHealthCheck() {
	if (healthTimer) clearTimeout(healthTimer);
	restartCount    = 0;
	backoffMs       = 0;
	lastSuccessTime = Date.now();
	global.lastMqttActivity = Date.now();

	const cfg = getConfig();
	if (!cfg.enable) {
		global.utils?.log?.info?.("MQTT_HEALTH", "MQTT health check is disabled.");
		return;
	}

	global.utils?.log?.info?.("MQTT_HEALTH",
		`Started — check every ${cfg.checkIntervalMinMs / 60000}–${cfg.checkIntervalMaxMs / 60000} min (randomized), ` +
		`restart if silent for ${cfg.silentTimeoutMs / 60000} min`
	);

	scheduleNextCheck();
}

function stopHealthCheck() {
	if (healthTimer) clearTimeout(healthTimer);
	healthTimer = null;
}

module.exports = { startHealthCheck, stopHealthCheck, onMqttActivity };
