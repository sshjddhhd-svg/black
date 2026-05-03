const chalk = require('chalk');
const path  = require('path');
const { log, createOraDots, getText } = global.utils;

// ─── DJAMEL ASCII Art ─────────────────────────────────────────────────────────
const bigText = `
██████╗      ██╗ █████╗ ███╗   ███╗███████╗██╗     
██╔══██╗     ██║██╔══██╗████╗ ████║██╔════╝██║     
██║  ██║     ██║███████║██╔████╔██║█████╗  ██║     
██║  ██║██   ██║██╔══██║██║╚██╔╝██║██╔══╝  ██║     
██████╔╝╚█████╔╝██║  ██║██║ ╚═╝ ██║███████╗███████╗
╚═════╝  ╚════╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝
`;

// ─── Section header ───────────────────────────────────────────────────────────
function header(title) {
        const line = "━".repeat(50);
        return chalk.cyanBright(`\n${line}\n  ${title}\n${line}`);
}

// ─── Separator line ───────────────────────────────────────────────────────────
function sep() {
        return chalk.hex("#444444")("─".repeat(50));
}

// ─── Colored label ────────────────────────────────────────────────────────────
function label(icon, text, color = "#ffd369") {
        return `  ${icon}  ${chalk.hex(color)(text)}`;
}

// ─── Arabic RTL fix ───────────────────────────────────────────────────────────
function fixArabic(str) {
        if (typeof str !== "string") return str;
        return str.replace(/([\u0600-\u06FF][^\n]*)/g, m => "\u202B" + m + "\u202C");
}

module.exports = async function (api, createLine) {

        // ── Startup banner ──────────────────────────────────────────────────
        console.log(chalk.hex("#2BD2FF")(bigText));

        console.log(chalk.hex("#f5af19")("┌" + "─".repeat(50) + "┐"));
        console.log(chalk.hex("#f5af19")("│") + chalk.bold.whiteBright("  🚀  WHITE V3 DATABASE".padEnd(51)) + chalk.hex("#f5af19")("│"));
        console.log(chalk.hex("#f5af19")("└" + "─".repeat(50) + "┘"));
        console.log();
        console.log(label("📦", "Loading system resources…"));
        console.log(sep());

        const controller = await require(path.join(__dirname, '..', '..', 'database/controller/index.js'))(api);
        const { threadModel, userModel, dashBoardModel, globalModel, threadsData, usersData, dashBoardData, globalData, sequelize } = controller;

        console.log(label("🧵", "Thread data  ── ✅ OK", "#2BFF88"));
        console.log(label("👤", "User data    ── ✅ OK", "#2BFF88"));
        console.log(sep());

        // ── Auto Sync ───────────────────────────────────────────────────────
        if (api && global.GoatBot.config.database.autoSyncWhenStart == true) {

                console.log();
                console.log(chalk.hex("#f5af19")("┌" + "─".repeat(50) + "┐"));
                console.log(chalk.hex("#f5af19")("│") + chalk.bold.whiteBright("  🔄  AUTO SYNC ENABLED".padEnd(51)) + chalk.hex("#f5af19")("│"));
                console.log(chalk.hex("#f5af19")("└" + "─".repeat(50) + "┘"));

                const spin = createOraDots(getText('loadData', 'refreshingThreadData'));

                try {
                        api.setOptions({ logLevel: 'silent' });
                        spin._start();

                        const threadDataWillSet = [];
                        const allThreadData     = [...global.db.allThreadData];
                        const allThreadInfo     = await api.getThreadList(9999999, null, 'INBOX');

                        for (const threadInfo of allThreadInfo) {
                                if (threadInfo.isGroup && !allThreadData.some(t => t.threadID === threadInfo.threadID)) {
                                        threadDataWillSet.push(await threadsData.create(threadInfo.threadID, threadInfo));
                                } else {
                                        const refreshed = await threadsData.refreshInfo(threadInfo.threadID, threadInfo);
                                        allThreadData.splice(allThreadData.findIndex(t => t.threadID === threadInfo.threadID), 1);
                                        threadDataWillSet.push(refreshed);
                                }
                                global.db.receivedTheFirstMessage[threadInfo.threadID] = true;
                        }

                        const allThreadDataDontHaveBot = allThreadData.filter(
                                thread => !allThreadInfo.some(info => thread.threadID === info.threadID)
                        );
                        const botID = api.getCurrentUserID();
                        for (const thread of allThreadDataDontHaveBot) {
                                const me = thread.members.find(m => m.userID == botID);
                                if (me) {
                                        me.inGroup = false;
                                        await threadsData.set(thread.threadID, { members: thread.members });
                                }
                        }

                        global.db.allThreadData = [...threadDataWillSet, ...allThreadDataDontHaveBot];
                        spin._stop();
                        log.info('DATABASE', getText('loadData', 'refreshThreadDataSuccess', global.db.allThreadData.length));
                        console.log(label("✅", "Auto Sync Complete!", "#2BFF88"));
                }
                catch (err) {
                        spin._stop();
                        log.error('DATABASE', getText('loadData', 'refreshThreadDataError'), err);
                }
                finally {
                        api.setOptions({ logLevel: global.GoatBot.config.optionsFca.logLevel });
                }
        }

        console.log();
        console.log(chalk.hex("#f5af19")("┌" + "─".repeat(50) + "┐"));
        console.log(chalk.hex("#f5af19")("│") + chalk.bold.greenBright("  💻  SYSTEM READY".padEnd(51)) + chalk.hex("#f5af19")("│"));
        console.log(chalk.hex("#f5af19")("└" + "─".repeat(50) + "┘"));
        console.log();

        return {
                threadModel:    threadModel    || null,
                userModel:      userModel      || null,
                dashBoardModel: dashBoardModel || null,
                globalModel:    globalModel    || null,
                threadsData,
                usersData,
                dashBoardData,
                globalData,
                sequelize
        };
};
