/**
 * Human-Like Bot Protection Module
 * Simulates organic human activity to reduce detection risk.
 * - Random reactions to recent messages (rare, ~5% of messages)
 * - Typing indicator before every bot send
 * - Random "mark as read" with realistic delays
 * - Occasional rare search behavior simulation
 */

const REACTION_EMOJIS = ['😆','❤️','😮','😢','😡','👍','🎉','🔥'];
const CHANCE_REACT    = 0.04;   // 4% chance to react to any incoming message
const CHANCE_READ     = 0.35;   // 35% chance to mark thread as read after processing
const MIN_READ_DELAY  = 1200;   // ms
const MAX_READ_DELAY  = 6000;   // ms
const MIN_TYPING_MS   = 800;
const MAX_TYPING_MS   = 2800;

let _api = null;
let _hooked = false;

function rnd(min, max){ return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function randReaction(){
  return REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
}

function maybeReact(messageID, threadID){
  if (!_api || !messageID) return;
  if (Math.random() > CHANCE_REACT) return;
  const delay = rnd(3000, 18000); // react 3–18 seconds later
  setTimeout(() => {
    try {
      _api.setMessageReaction(randReaction(), messageID, () => {}, true);
    } catch(_) {}
  }, delay);
}

function maybeMarkRead(threadID){
  if (!_api || !threadID) return;
  if (Math.random() > CHANCE_READ) return;
  const delay = rnd(MIN_READ_DELAY, MAX_READ_DELAY);
  setTimeout(() => {
    try {
      _api.markAsRead(threadID, () => {});
    } catch(_) {}
  }, delay);
}

async function typingWrap(fn, threadID){
  if (!_api || !threadID) return fn();
  try {
    await new Promise(r => _api.sendTypingIndicator(threadID, r));
  } catch(_) {}
  const wait = rnd(MIN_TYPING_MS, MAX_TYPING_MS);
  await sleep(wait);
  return fn();
}

function hookApi(api){
  if (!api || _hooked) return;
  _hooked = true;
  _api = api;

  // Wrap sendMessage to add typing indicator
  if (typeof api.sendMessage === 'function') {
    const _orig = api.sendMessage.bind(api);
    api.sendMessage = async function(msg, tid, cb, mid) {
      try {
        if (tid && typeof tid === 'string') {
          await new Promise(r => {
            try { api.sendTypingIndicator(tid, r); } catch(_) { r(); }
          });
          await sleep(rnd(MIN_TYPING_MS, MAX_TYPING_MS));
        }
      } catch(_) {}
      return _orig(msg, tid, cb, mid);
    };
  }

  console.log('[HUMANLIKE] ✅ Human-like protection active');
}

// ─── Global incoming message hook ─────────────────────────────────────────
// Called from server.js message tracker or anywhere
global._humanLikeOnMsg = function(messageID, threadID, senderID){
  if (!_api) return;
  // Only react to others, not bot's own messages
  if (senderID === 'BOT' || senderID === 'bot') return;
  maybeReact(messageID, threadID);
  maybeMarkRead(threadID);
};

// ─── Rare background activity: simulate a "search" every few hours ────────
function scheduleRareActivity(){
  const delay = rnd(2 * 3600 * 1000, 8 * 3600 * 1000); // 2–8 hours
  setTimeout(async () => {
    if (_api) {
      try {
        // Mark a random thread as read (simulates checking inbox)
        const threads = global.db?.allThreadData;
        if (threads && threads.length) {
          const t = threads[Math.floor(Math.random() * threads.length)];
          const tid = t.threadID || t.id;
          if (tid) {
            await sleep(rnd(2000, 8000));
            _api.markAsRead(tid, () => {});
          }
        }
      } catch(_) {}
    }
    scheduleRareActivity(); // reschedule
  }, delay);
}

// ─── Start / auto-attach ──────────────────────────────────────────────────
function start(){
  scheduleRareActivity();
  // Try to hook FCA api with retries
  let attempts = 0;
  const tryHook = setInterval(() => {
    const api = global.GoatBot?.fcaApi;
    if (api && !_hooked) {
      hookApi(api);
      clearInterval(tryHook);
    }
    if (++attempts > 60) clearInterval(tryHook);
  }, 5000);
}

module.exports = { start, hookApi, maybeReact, maybeMarkRead, typingWrap };
