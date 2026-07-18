/* ============================================================
   Word Fall — game logic (vanilla JS, no dependencies)

   Words fall from the top of the playfield. The player types
   with no input box: the first letter typed locks onto the
   matching word closest to the ground, and each further correct
   letter lights up on the word itself. Finishing a word destroys
   it and scores points; a word that reaches the danger line at
   the bottom deals damage. At 0 HP the game ends and the final
   score is shown.

   Movement uses a single requestAnimationFrame loop with
   delta-time, so fall speed is framerate-independent.

   Accuracy metric: correct keystrokes / total keystrokes
   (letter keys only; Backspace/Escape are not counted).
   ============================================================ */

"use strict";

/* ------------------------------------------------------------
   Difficulty tiers, built from the ~3300-word WORD_BANK loaded
   by words.js (script tag before this file). Bucketed by length:
   short words are easy to type, long ones hard. Higher levels
   mix in longer words.
   ------------------------------------------------------------ */
const WORDS = {
  easy: WORD_BANK.filter((w) => w.length <= 5),
  medium: WORD_BANK.filter((w) => w.length >= 6 && w.length <= 9),
  hard: WORD_BANK.filter((w) => w.length >= 10),
};

/* ------------------------------------------------------------
   Tunable game constants
   ------------------------------------------------------------ */
const MAX_HP = 100;
const LAND_DAMAGE = 10;          // HP lost when a word reaches the ground
const WORDS_PER_LEVEL = 8;       // words destroyed per level-up
const BASE_FALL_SPEED = 42;      // px/second at level 1
const SPEED_PER_LEVEL = 12;      // extra px/second per level
const MAX_FALL_SPEED = 170;      // px/second cap
const BASE_SPAWN_MS = 2600;      // spawn interval at level 1
const SPAWN_MS_PER_LEVEL = 250;  // interval reduction per level
const MIN_SPAWN_MS = 950;        // spawn interval floor
const MAX_ACTIVE_WORDS = 6;      // never flood the screen past this
const STREAK_STEP = 5;           // completed words per multiplier increase
const MULT_INCREMENT = 0.5;      // multiplier gained per streak step
const MULT_CAP = 3;              // maximum score multiplier
const POINTS_PER_CHAR = 10;      // base points = word length × this

/* ------------------------------------------------------------
   DOM references
   ------------------------------------------------------------ */
const el = {
  game: document.getElementById("game"),
  playfield: document.getElementById("playfield"),
  dangerLine: document.getElementById("danger-line"),
  hudScore: document.getElementById("hud-score"),
  hudBestScore: document.getElementById("hud-best-score"),
  hudStreak: document.getElementById("hud-streak"),
  hudBestStreak: document.getElementById("hud-best-streak"),
  hudStreakBox: document.getElementById("hud-streak-box"),
  hudLevel: document.getElementById("hud-level"),
  playerHpFill: document.getElementById("player-hp-fill"),
  playerHpText: document.getElementById("player-hp-text"),
  vignette: document.getElementById("damage-vignette"),
  startScreen: document.getElementById("start-screen"),
  startBtn: document.getElementById("start-btn"),
  endScreen: document.getElementById("end-screen"),
  finalScore: document.getElementById("final-score"),
  scoreTitle: document.getElementById("score-title"),
  newRecord: document.getElementById("new-record"),
  bestScoreRow: document.getElementById("best-score-row"),
  statBestScore: document.getElementById("stat-best-score"),
  statBestStreak: document.getElementById("stat-best-streak"),
  statWords: document.getElementById("stat-words"),
  statWpm: document.getElementById("stat-wpm"),
  statAccuracy: document.getElementById("stat-accuracy"),
  statStreak: document.getElementById("stat-streak"),
  statLevel: document.getElementById("stat-level"),
  statTime: document.getElementById("stat-time"),
  wpmMessage: document.getElementById("wpm-message"),
  restartBtn: document.getElementById("restart-btn"),
  menuBtn: document.getElementById("menu-btn"),
  // Online / multiplayer UI
  onlineBtn: document.getElementById("online-btn"),
  onlineHint: document.getElementById("online-hint"),
  onlineScreen: document.getElementById("online-screen"),
  onlineSetup: document.getElementById("online-setup"),
  playerName: document.getElementById("player-name"),
  createBtn: document.getElementById("create-btn"),
  joinCode: document.getElementById("join-code"),
  joinBtn: document.getElementById("join-btn"),
  sizeButtons: document.getElementById("size-buttons"),
  roomCodeBox: document.getElementById("room-code-box"),
  roomCode: document.getElementById("room-code"),
  lobbyProgress: document.getElementById("lobby-progress"),
  lobbyNames: document.getElementById("lobby-names"),
  onlineStatus: document.getElementById("online-status"),
  onlineBack: document.getElementById("online-back"),
  countdownScreen: document.getElementById("countdown-screen"),
  countdown: document.getElementById("countdown"),
  scoreboardPanel: document.getElementById("scoreboard-panel"),
  scoreboardList: document.getElementById("scoreboard-list"),
  spectateBanner: document.getElementById("spectate-banner"),
  endTitle: document.getElementById("end-title"),
  matchResults: document.getElementById("match-results"),
  resultsBanner: document.getElementById("results-banner"),
  resultsList: document.getElementById("results-list"),
  soloResults: document.getElementById("solo-results"),
  lbStart: document.getElementById("lb-start"),
  lbStartList: document.getElementById("lb-start-list"),
  lbEnd: document.getElementById("lb-end"),
  lbEndList: document.getElementById("lb-end-list"),
  lbPlacement: document.getElementById("lb-placement"),
};

/* ------------------------------------------------------------
   All-time bests, persisted across sessions via localStorage.
   Falls back to in-memory-only if storage is unavailable.
   ------------------------------------------------------------ */
const best = loadBest();

function loadBest() {
  try {
    return {
      score: Number(localStorage.getItem("wordfall-best-score")) || 0,
      streak: Number(localStorage.getItem("wordfall-best-streak")) || 0,
    };
  } catch {
    return { score: 0, streak: 0 };
  }
}

function saveBest() {
  try {
    localStorage.setItem("wordfall-best-score", best.score);
    localStorage.setItem("wordfall-best-streak", best.streak);
  } catch {
    /* storage unavailable — bests still work for this session */
  }
}

/* ------------------------------------------------------------
   Mutable game state (reset by startGame)
   ------------------------------------------------------------ */
let state = null;
let rafId = 0;

function freshState() {
  return {
    running: false,
    playerHp: MAX_HP,
    score: 0,
    streak: 0,               // consecutive words without a wrong key / landing
    maxStreak: 0,
    wordsDestroyed: 0,
    correctKeystrokes: 0,
    totalKeystrokes: 0,
    startTime: 0,
    lastFrame: 0,            // timestamp of the previous rAF frame
    spawnTimer: 0,           // ms accumulated toward the next spawn
    words: [],               // active falling words: {text, x, y, speed, typed, el}
    target: null,            // the word currently locked onto, or null
    recentWords: [],         // last N spawned words, to avoid near-term repeats
    bestAtStart: best.score,        // all-time best score when this run began
    bestStreakAtStart: best.streak, // all-time best streak when this run began
    rand: Math.random,              // word-pick RNG; seeded in online matches
  };
}

/* ------------------------------------------------------------
   Core flow
   ------------------------------------------------------------ */

/** Reset all state and UI, then start a new game.
 *  rand: optional seeded RNG for online matches (both players share it). */
function startGame(rand) {
  cancelAnimationFrame(rafId);

  // Clear any leftover falling words from a previous game
  for (const w of state?.words ?? []) w.el.remove();

  state = freshState();
  if (typeof rand === "function") state.rand = rand;
  state.running = true;
  state.startTime = performance.now();
  state.lastFrame = performance.now();

  el.startScreen.classList.remove("overlay--visible");
  el.endScreen.classList.remove("overlay--visible");
  el.scoreboardPanel.classList.toggle("scoreboard--hidden", net.mode !== "online");

  // Drop button focus so Space/Enter while playing can't re-trigger a restart
  el.startBtn.blur();
  el.restartBtn.blur();

  updateHud();
  updateHealthBar();
  spawnWord(); // first word appears immediately

  rafId = requestAnimationFrame(gameLoop);
}

/** Main loop: advance the world by the elapsed time each frame. */
function gameLoop(now) {
  if (!state.running) return;

  // Clamp dt so returning from a background tab doesn't teleport words
  const dt = Math.min(now - state.lastFrame, 100);
  state.lastFrame = now;

  update(dt);
  rafId = requestAnimationFrame(gameLoop);
}

/** Advance falling words, spawn new ones, detect landings. */
function update(dt) {
  // Spawning
  state.spawnTimer += dt;
  if (state.spawnTimer >= spawnInterval() && state.words.length < MAX_ACTIVE_WORDS) {
    state.spawnTimer = 0;
    spawnWord();
  }

  // Falling + landing detection (iterate a copy: wordLanded mutates the list)
  const floorY = el.playfield.clientHeight - el.dangerLine.offsetHeight;
  for (const word of [...state.words]) {
    word.y += (word.speed * dt) / 1000;
    if (word.y + word.el.offsetHeight >= floorY) {
      wordLanded(word);
    } else {
      word.el.style.transform = `translate(${word.x}px, ${word.y}px)`;
    }
  }
}

/* ------------------------------------------------------------
   Difficulty scaling
   ------------------------------------------------------------ */

/** Current level, driven by words destroyed. */
function currentLevel() {
  return 1 + Math.floor(state.wordsDestroyed / WORDS_PER_LEVEL);
}

/** Milliseconds between spawns at the current level. */
function spawnInterval() {
  return Math.max(MIN_SPAWN_MS, BASE_SPAWN_MS - (currentLevel() - 1) * SPAWN_MS_PER_LEVEL);
}

/** Word pool for the current level: longer words unlock over time. */
function wordPool() {
  const level = currentLevel();
  if (level <= 2) return WORDS.easy;
  if (level <= 4) return [...WORDS.easy, ...WORDS.medium];
  if (level <= 6) return [...WORDS.medium, ...WORDS.hard];
  return [...WORDS.medium, ...WORDS.hard, ...WORDS.hard]; // hard-weighted
}

/* ------------------------------------------------------------
   Word lifecycle
   ------------------------------------------------------------ */

/**
 * Create a falling word at a random x position at the top.
 * Picks a word whose first letter differs from every active word's,
 * so the first keystroke always locks onto exactly one word.
 */
function spawnWord() {
  const pool = wordPool();
  const takenFirstLetters = new Set(state.words.map((w) => w.text[0]));

  // Word text comes from state.rand so online opponents (sharing a seed)
  // face the identical word sequence; position/speed jitter stays local
  let text = pool[Math.floor(state.rand() * pool.length)];
  for (let tries = 0; tries < 25; tries++) {
    if (!state.recentWords.includes(text) && !takenFirstLetters.has(text[0])) break;
    text = pool[Math.floor(state.rand() * pool.length)];
  }
  state.recentWords.push(text);
  if (state.recentWords.length > 25) state.recentWords.shift();

  // Build the DOM node with one span per character
  const node = document.createElement("div");
  node.className = "falling-word";
  for (const ch of text) {
    const span = document.createElement("span");
    span.className = "char";
    span.textContent = ch;
    node.appendChild(span);
  }
  el.playfield.appendChild(node);

  // Random x, clamped so the whole word stays on screen
  const maxX = Math.max(0, el.playfield.clientWidth - node.offsetWidth - 8);
  const x = 8 + Math.random() * maxX;

  // Slight per-word speed variance so words don't fall in lockstep;
  // longer words fall a touch slower to stay typeable
  const level = currentLevel();
  const base = Math.min(MAX_FALL_SPEED, BASE_FALL_SPEED + (level - 1) * SPEED_PER_LEVEL);
  const lengthEase = Math.max(0.7, 1 - (text.length - 5) * 0.02);
  const speed = base * lengthEase * (0.85 + Math.random() * 0.3);

  const word = { text, x, y: -node.offsetHeight, speed, typed: 0, el: node };
  node.style.transform = `translate(${x}px, ${word.y}px)`;
  state.words.push(word);
}

/** Word fully typed: destroy it and award points. */
function wordCompleted(word) {
  removeWord(word, "falling-word--destroyed");

  state.wordsDestroyed++;
  state.streak++;
  state.maxStreak = Math.max(state.maxStreak, state.streak);

  const points = Math.round(word.text.length * POINTS_PER_CHAR * currentMultiplier());
  state.score += points;
  spawnScoreFloat(word, points);

  updateHud(true);
}

/** Word reached the danger line: damage the player. */
function wordLanded(word) {
  removeWord(word, "falling-word--landed");

  state.streak = 0;
  state.playerHp = Math.max(0, state.playerHp - LAND_DAMAGE);
  updateHealthBar();
  updateHud();

  flashClass(el.game, "shake", 400);
  flashClass(el.vignette, "vignette--flash", 450);
  flashClass(el.dangerLine, "danger-line--hit", 450);

  if (state.playerHp <= 0) endGame();
}

/** Remove a word from play, leaving its exit animation to finish. */
function removeWord(word, animClass) {
  state.words = state.words.filter((w) => w !== word);
  if (state.target === word) state.target = null;

  word.el.classList.add(animClass);
  const node = word.el;
  setTimeout(() => node.remove(), 400);
}

/* ------------------------------------------------------------
   Typing: lock-on targeting on a global keydown listener
   ------------------------------------------------------------ */

function handleKey(e) {
  // Never hijack typing inside real inputs (name / room-code fields)
  if (e.target && e.target.tagName === "INPUT") return;
  if (!state || !state.running) return;

  // Escape releases the current lock-on
  if (e.key === "Escape") {
    if (state.target) setTyped(state.target, 0);
    setTarget(null);
    return;
  }

  // Backspace un-types one letter on the current target
  if (e.key === "Backspace") {
    if (state.target && state.target.typed > 0) {
      setTyped(state.target, state.target.typed - 1);
      if (state.target.typed === 0) setTarget(null);
    }
    e.preventDefault();
    return;
  }

  // Only single printable characters count as typing
  if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();

  state.totalKeystrokes++;

  if (!state.target) {
    // No lock yet: target the matching word closest to the ground
    const candidates = state.words.filter((w) => w.text[0] === key);
    if (candidates.length === 0) {
      // Missed completely — costs accuracy and the streak
      breakStreak();
      return;
    }
    const closest = candidates.reduce((a, b) => (a.y > b.y ? a : b));
    setTarget(closest);
    state.correctKeystrokes++;
    setTyped(closest, 1);
  } else if (state.target.text[state.target.typed] === key) {
    // Correct next letter on the locked word
    state.correctKeystrokes++;
    setTyped(state.target, state.target.typed + 1);
  } else {
    // Wrong letter: no HP damage (only landings hurt), but progress
    // on the target resets and the streak breaks
    flashClass(state.target.el, "falling-word--error", 250);
    setTyped(state.target, 0);
    setTarget(null);
    breakStreak();
    return;
  }

  if (state.target && state.target.typed === state.target.text.length) {
    wordCompleted(state.target);
  }
}

/** Set/unset the locked word, keeping the highlight class in sync. */
function setTarget(word) {
  if (state.target) state.target.el.classList.remove("falling-word--target");
  state.target = word;
  if (word) word.el.classList.add("falling-word--target");
}

/** Set how many letters of a word are typed and recolor its spans. */
function setTyped(word, count) {
  word.typed = count;
  [...word.el.children].forEach((span, i) => {
    span.classList.toggle("char--done", i < count);
  });
}

/** A mistake was made: reset the streak and refresh the HUD. */
function breakStreak() {
  state.streak = 0;
  updateHud();
}

/* ------------------------------------------------------------
   Scoring / HUD
   ------------------------------------------------------------ */

/** Current score multiplier from the streak (1.0 – MULT_CAP). */
function currentMultiplier() {
  return Math.min(MULT_CAP, 1 + Math.floor(state.streak / STREAK_STEP) * MULT_INCREMENT);
}

/** Refresh score / streak / level readouts; pop = animate the streak bump. */
function updateHud(pop = false) {
  // All-time bests update live the moment they're beaten
  best.score = Math.max(best.score, state.score);
  best.streak = Math.max(best.streak, state.streak);

  el.hudScore.textContent = state.score;
  el.hudBestScore.textContent = `BEST ${best.score}`;
  el.hudStreak.textContent = `×${state.streak} (PTS ×${currentMultiplier().toFixed(1)})`;
  el.hudBestStreak.textContent = `BEST ×${best.streak}`;
  el.hudLevel.textContent = currentLevel();

  // Glow green while this run is actively beating the old records
  el.hudBestScore.classList.toggle(
    "hud__stat-sub--record",
    state.score > 0 && state.score > state.bestAtStart
  );
  el.hudBestStreak.classList.toggle(
    "hud__stat-sub--record",
    state.streak > 0 && state.streak > state.bestStreakAtStart
  );

  // In online matches, keep the opponent's view of us fresh (throttled)
  if (net.mode === "online" && state.running) maybeSendState();
  el.hudStreakBox.classList.toggle("hud__stat--hot", state.streak >= STREAK_STEP);
  if (pop) flashClass(el.hudStreakBox, "hud__stat--pop", 250);
}

/**
 * Add a CSS class for `ms` milliseconds, then remove it.
 * Restarts cleanly if re-triggered mid-animation.
 */
function flashClass(node, className, ms) {
  node.classList.remove(className);
  // Force a reflow so the animation restarts even on rapid re-trigger
  void node.offsetWidth;
  node.classList.add(className);
  setTimeout(() => node.classList.remove(className), ms);
}

/** Sync the HP bar and its numeric label. */
function updateHealthBar() {
  el.playerHpFill.style.width = (state.playerHp / MAX_HP) * 100 + "%";
  el.playerHpText.textContent = `${state.playerHp} / ${MAX_HP}`;
}

/** Floating "+points" text where a word was destroyed. */
function spawnScoreFloat(word, points) {
  const float = document.createElement("div");
  float.className = "score-float";
  float.textContent = `+${points}`;
  float.style.left = word.x + "px";
  float.style.top = word.y + "px";
  el.playfield.appendChild(float);
  setTimeout(() => float.remove(), 800);
}

/* ------------------------------------------------------------
   Score-tier title — one-word rank shown under the final score
   ------------------------------------------------------------ */

const SCORE_TITLES = [
  { min: 0, title: "🌱 Newbie" },
  { min: 250, title: "⚔️ Challenger" },
  { min: 500, title: "🔥 Warrior" },
  { min: 900, title: "💎 Elite" },
  { min: 1600, title: "👑 Champion" },
  { min: 2600, title: "🏆 Mythic" },
];

/** Highest tier whose threshold the score has reached. */
function scoreTitle(score) {
  let title = SCORE_TITLES[0].title;
  for (const tier of SCORE_TITLES) {
    if (score >= tier.min) title = tier.title;
  }
  return title;
}

/* ------------------------------------------------------------
   WPM encouragement
   ------------------------------------------------------------ */

const RECORD_WPM = 305; // highest recorded typing speed

/*
 * WPM → "faster than X% of typists" anchors, based on the typical
 * typing-speed distribution (the average typist is ~40 WPM).
 * Values between anchors are linearly interpolated.
 */
const WPM_PERCENTILES = [
  [0, 5], [10, 15], [20, 38], [30, 52], [40, 65], [50, 77],
  [60, 85], [70, 90], [80, 94], [90, 96], [100, 98], [120, 99],
];

/** Percentage of typists slower than the given WPM (5–99.9). */
function wpmPercentile(wpm) {
  const last = WPM_PERCENTILES[WPM_PERCENTILES.length - 1];
  if (wpm >= last[0]) return Math.min(99.9, last[1] + (wpm - last[0]) * 0.005);
  for (let i = 1; i < WPM_PERCENTILES.length; i++) {
    const [x1, y1] = WPM_PERCENTILES[i - 1];
    const [x2, y2] = WPM_PERCENTILES[i];
    if (wpm <= x2) return y1 + ((wpm - x1) / (x2 - x1)) * (y2 - y1);
  }
  return last[1];
}

/** Short, always-motivating one-liner scaled to the player's WPM tier. */
function wpmMessage(wpm) {
  // Cap the displayed percentage below 100 — "faster than 100% of typists"
  // (including yourself) doesn't make sense, even at the record WPM.
  const pct = Math.min(99, Math.round(wpmPercentile(wpm)));
  const ofRecord = wpm / RECORD_WPM;

  if (ofRecord < 0.15) return `🌱 Word one of many — already faster than ${pct}% of typists!`;
  if (ofRecord < 0.3) return `⚡ Nice pace! Outtyping ${pct}% of typists already.`;
  if (ofRecord < 0.5) return `🔥 Faster than ${pct}% of typists — momentum's building.`;
  if (ofRecord < 0.8) return `🚀 Elite speed! Beating ${pct}% of typists worldwide.`;
  return `👑 Legendary — faster than ${pct}% of typists alive.`;
}

/* ------------------------------------------------------------
   Game over
   ------------------------------------------------------------ */

/** Collect this run's final stats (shared by solo and online endings). */
function finalStats() {
  const elapsed = (performance.now() - state.startTime) / 1000;
  const accuracy = state.totalKeystrokes
    ? Math.round((state.correctKeystrokes / state.totalKeystrokes) * 100)
    : 100;
  // Standard typing-test WPM: 5 correct keystrokes count as one word
  const wpm = elapsed > 0 ? Math.round(state.correctKeystrokes / 5 / (elapsed / 60)) : 0;
  return {
    score: state.score,
    wpm,
    accuracy,
    streak: state.maxStreak,
    words: state.wordsDestroyed,
    level: currentLevel(),
    elapsed,
  };
}

/** Stop the loop; show solo results, or report our death in a match. */
function endGame() {
  state.running = false;
  cancelAnimationFrame(rafId);
  setTarget(null);
  saveBest();

  const stats = finalStats();

  if (net.mode === "online") {
    // Eliminated but the match isn't over: watch the live scoreboard until
    // the server sends the final ranked results to everyone at once
    sendDeath(stats);
    el.spectateBanner.classList.remove("spectate-banner--hidden");
    return;
  }
  showSoloResults(stats);
}

/** Fill and show the solo scorecard (plus global leaderboard when served). */
function showSoloResults(stats) {
  const minutes = Math.floor(stats.elapsed / 60);
  const seconds = Math.floor(stats.elapsed % 60).toString().padStart(2, "0");
  const isNewRecord = stats.score > 0 && stats.score > state.bestAtStart;

  el.endTitle.innerHTML = '<span class="overlay__title-icon">💀</span> GAME OVER';
  el.matchResults.classList.add("match-results--hidden");
  el.soloResults.style.display = "";
  el.menuBtn.style.display = ""; // TRY AGAIN alone can't reach Online Multiplayer

  el.finalScore.textContent = stats.score;
  el.scoreTitle.textContent = scoreTitle(stats.score);
  el.newRecord.classList.toggle("final-score__record--visible", isNewRecord);
  el.bestScoreRow.classList.toggle("stats__row--record", isNewRecord);
  el.statBestScore.textContent = best.score;
  el.statBestStreak.textContent = best.streak;
  el.statWords.textContent = stats.words;
  el.statWpm.textContent = stats.wpm;
  el.wpmMessage.textContent = wpmMessage(stats.wpm);
  el.statAccuracy.textContent = stats.accuracy + "%";
  el.statStreak.textContent = stats.streak;
  el.statLevel.textContent = stats.level;
  el.statTime.textContent = `${minutes}:${seconds}`;

  submitSoloScore(stats); // no-op when not served over http

  el.endScreen.classList.add("overlay--visible");
}

/* ------------------------------------------------------------
   Online multiplayer — talks to the relay in server.js.
   Transport: EventSource (server → us) + fetch POST (us → server).
   ------------------------------------------------------------ */

const isServed =
  typeof location !== "undefined" &&
  (location.protocol === "http:" || location.protocol === "https:");

const net = {
  mode: "solo", // "solo" | "online"
  es: null,     // EventSource while in a room
  room: null,
  playerId: null,
  myName: "",
  roomSize: 4,      // chosen on Create; server echoes the real value back
  roster: [],       // [{id, name}] for everyone in the current match
  rows: {},         // playerId -> scoreboard <li> element
  lastSent: 0,      // throttle timestamp for state snapshots
};

/** Deterministic PRNG (mulberry32) — both players seed it identically,
 *  so they face the exact same word sequence. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function netSend(payload) {
  const res = await fetch("/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function savedName() {
  try {
    return localStorage.getItem("wordfall-name") || "Player";
  } catch {
    return "Player";
  }
}

function getMyName() {
  const name = el.playerName.value.trim() || "Player";
  try {
    localStorage.setItem("wordfall-name", name);
  } catch {
    /* fine — name just won't be remembered */
  }
  return name;
}

function showOnlineScreen() {
  try {
    el.playerName.value = localStorage.getItem("wordfall-name") || "";
  } catch {
    /* ignore */
  }
  el.onlineStatus.textContent = "";
  el.roomCodeBox.classList.add("room-code--hidden");
  el.onlineSetup.style.display = "";
  el.startScreen.classList.remove("overlay--visible");
  el.onlineScreen.classList.add("overlay--visible");
}

/** Tear down any online session and fall back to solo mode. */
function leaveOnline() {
  if (net.es) {
    net.es.close();
    net.es = null;
  }
  net.mode = "solo";
  net.room = null;
  net.playerId = null;
  net.roster = [];
  net.rows = {};
  el.scoreboardPanel.classList.add("scoreboard--hidden");
  el.spectateBanner.classList.add("spectate-banner--hidden");
  el.restartBtn.textContent = "TRY AGAIN";
}

async function createRoom() {
  net.myName = getMyName();
  el.onlineStatus.textContent = "";
  try {
    const res = await netSend({ type: "create", name: net.myName, size: net.roomSize });
    if (res.error) return void (el.onlineStatus.textContent = res.error);
    net.room = res.room;
    net.playerId = res.playerId;
    net.roomSize = res.size;
    el.roomCode.textContent = res.room;
    el.onlineSetup.style.display = "none";
    el.roomCodeBox.classList.remove("room-code--hidden");
    renderLobby({ joined: 1, size: res.size, names: [net.myName] });
    openEvents();
  } catch {
    el.onlineStatus.textContent = "Could not reach the server.";
  }
}

async function joinRoom() {
  net.myName = getMyName();
  const code = el.joinCode.value.trim().toUpperCase();
  if (code.length !== 4) {
    el.onlineStatus.textContent = "Enter the 4-letter room code.";
    return;
  }
  el.onlineStatus.textContent = "";
  try {
    const res = await netSend({ type: "join", room: code, name: net.myName });
    if (res.error) return void (el.onlineStatus.textContent = res.error);
    net.room = code;
    net.playerId = res.playerId;
    net.roomSize = res.size;
    el.onlineStatus.textContent = "Joined! Waiting for the room to fill…";
    openEvents();
  } catch {
    el.onlineStatus.textContent = "Could not reach the server.";
  }
}

function openEvents() {
  net.es = new EventSource(`/events?room=${net.room}&player=${net.playerId}`);
  net.es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "lobby-update") renderLobby(msg);
    else if (msg.type === "start") beginMatch(msg);
    else if (msg.type === "opponent-state") updateScoreboardRow(msg.id, msg.stats);
    else if (msg.type === "player-eliminated") markEliminated(msg.id);
    else if (msg.type === "gameover") onMatchOver(msg);
  };
}

/** Live "N/size joined" readout while waiting in the room-code lobby. */
function renderLobby({ joined, size, names }) {
  el.lobbyProgress.textContent = `${joined}/${size} joined`;
  el.lobbyNames.replaceChildren();
  for (const name of names) {
    const li = document.createElement("li");
    li.textContent = name;
    el.lobbyNames.appendChild(li);
  }
}

/** Every seat filled: 3-2-1 countdown, then the seeded round starts. */
function beginMatch({ seed, players }) {
  net.mode = "online";
  net.roster = players;
  el.onlineScreen.classList.remove("overlay--visible");
  el.spectateBanner.classList.add("spectate-banner--hidden");
  buildScoreboard(players);

  el.countdownScreen.classList.add("overlay--visible");
  let n = 3;
  el.countdown.textContent = n;
  const tick = setInterval(() => {
    n--;
    if (n > 0) {
      el.countdown.textContent = n;
    } else {
      clearInterval(tick);
      el.countdownScreen.classList.remove("overlay--visible");
      el.restartBtn.textContent = "BACK TO MENU";
      startGame(mulberry32(seed));
    }
  }, 1000);
}

/** Build one live scoreboard row per opponent (everyone but ourselves). */
function buildScoreboard(players) {
  el.scoreboardList.replaceChildren();
  net.rows = {};
  for (const p of players) {
    if (p.id === net.playerId) continue;

    const name = document.createElement("span");
    name.className = "scoreboard__name";
    name.textContent = p.name;

    const barFill = document.createElement("span");
    barFill.className = "scoreboard__bar-fill";
    const bar = document.createElement("span");
    bar.className = "scoreboard__bar";
    bar.appendChild(barFill);

    const score = document.createElement("span");
    score.className = "scoreboard__score";
    score.textContent = "0";

    const li = document.createElement("li");
    li.className = "scoreboard__row";
    li.append(name, bar, score);
    el.scoreboardList.appendChild(li);
    net.rows[p.id] = { row: li, barFill, score };
  }
}

/** Throttled snapshot of our run — feeds everyone else's scoreboard row and
 *  the server's leaderboard record once we're eliminated or win. */
function maybeSendState() {
  const now = performance.now();
  if (now - net.lastSent < 250) return;
  net.lastSent = now;
  netSend({
    type: "state",
    room: net.room,
    playerId: net.playerId,
    stats: { ...finalStats(), hp: state.playerHp },
  }).catch(() => {});
}

function updateScoreboardRow(id, stats) {
  const entry = net.rows[id];
  if (!entry || !stats) return;
  entry.score.textContent = stats.score;
  entry.barFill.style.width = Math.max(0, stats.hp) + "%";
}

function markEliminated(id) {
  const entry = net.rows[id];
  if (entry) entry.row.classList.add("scoreboard__row--out");
}

function sendDeath(stats) {
  netSend({
    type: "death",
    room: net.room,
    playerId: net.playerId,
    stats: { ...stats, hp: 0 },
  }).catch(() => {});
}

/** Server declared the final ranking: freeze play, show ranked results. */
function onMatchOver(msg) {
  if (state && state.running) {
    // We were still playing (won by outlasting/forfeit) — stop our board
    state.running = false;
    cancelAnimationFrame(rafId);
    setTarget(null);
    saveBest();
  }
  if (net.es) {
    net.es.close();
    net.es = null;
  }
  el.spectateBanner.classList.add("spectate-banner--hidden");

  const results = msg.results || [];
  const mine = results.find((r) => r.id === net.playerId);
  const iWon = !!mine && mine.rank === 1;

  el.endTitle.innerHTML = '<span class="overlay__title-icon">🏁</span> MATCH OVER';
  el.menuBtn.style.display = "none"; // restart-btn already reads "BACK TO MENU" here
  el.resultsBanner.textContent = iWon
    ? "🏆 YOU WIN!"
    : mine
    ? `YOU FINISHED #${mine.rank} of ${results.length}`
    : "MATCH OVER";
  el.resultsBanner.classList.toggle("match-results__banner--lost", !iWon);

  renderResults(results);

  el.soloResults.style.display = "none";
  el.matchResults.classList.remove("match-results--hidden");
  refreshEndLeaderboard(""); // match scores were recorded server-side

  el.endScreen.classList.add("overlay--visible");
}

/** Ranked results list: one row per player, winner and "you" highlighted. */
function renderResults(results) {
  el.resultsList.replaceChildren();
  for (const r of results) {
    const rank = document.createElement("span");
    rank.className = "match-results__rank";
    rank.textContent = r.rank === 1 ? "🏆" : `#${r.rank}`;

    const name = document.createElement("span");
    name.className = "match-results__name";
    name.textContent = r.id === net.playerId ? `${r.name} (you)` : r.name;

    const score = document.createElement("span");
    score.className = "match-results__score";
    score.textContent = r.stats ? r.stats.score : 0;

    const meta = document.createElement("span");
    meta.className = "match-results__meta";
    meta.textContent = r.stats ? `${r.stats.wpm} wpm · ${r.stats.accuracy}% accuracy` : "";

    const li = document.createElement("li");
    li.className = "match-results__row";
    if (r.rank === 1) li.classList.add("match-results__row--winner");
    if (r.id === net.playerId) li.classList.add("match-results__row--me");
    li.append(rank, name, score, meta);
    el.resultsList.appendChild(li);
  }
}

/* ------------------------------------------------------------
   Global leaderboard (server-backed; hidden when run from file://)
   ------------------------------------------------------------ */

function renderLeaderboard(listEl, entries, limit) {
  listEl.replaceChildren();
  const me = savedName();
  entries.slice(0, limit).forEach((entry, i) => {
    const li = document.createElement("li");
    if (entry.name === me) li.classList.add("lb-me");
    const cells = [
      ["lb-rank", `#${i + 1}`],
      ["lb-name", entry.name],
      ["lb-score", entry.score],
      ["lb-wpm", `${entry.wpm} wpm`],
    ];
    for (const [cls, text] of cells) {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = text;
      li.appendChild(span);
    }
    listEl.appendChild(li);
  });
}

async function refreshStartLeaderboard() {
  try {
    const entries = await (await fetch("/leaderboard")).json();
    if (!entries.length) return;
    renderLeaderboard(el.lbStartList, entries, entries.length); // show every ranked player
    el.lbStart.classList.remove("leaderboard--hidden");
  } catch {
    /* server unreachable — leave the panel hidden */
  }
}

/** After a solo run (when served over http): submit the score,
 *  then show the top-5 with our placement. */
async function submitSoloScore(stats) {
  if (!isServed) return;
  let placement = "";
  try {
    const res = await fetch("/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: savedName(), ...stats }),
    });
    const { rank } = await res.json();
    if (rank > 0) placement = `🏅 #${rank} of all players!`;
  } catch {
    return;
  }
  refreshEndLeaderboard(placement);
}

async function refreshEndLeaderboard(placement) {
  if (!isServed) return;
  try {
    const entries = await (await fetch("/leaderboard")).json();
    el.lbPlacement.textContent = placement || "";
    renderLeaderboard(el.lbEndList, entries, 5);
    el.lbEnd.classList.remove("leaderboard--hidden");
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------
   Event wiring
   ------------------------------------------------------------ */
document.addEventListener("keydown", handleKey);
el.startBtn.addEventListener("click", () => startGame());
el.restartBtn.addEventListener("click", () => {
  if (net.mode === "online") {
    // No instant rematch — back to the menu to create/join a new room
    returnToMenu();
    return;
  }
  startGame();
});
el.menuBtn.addEventListener("click", returnToMenu);

/** Close out the current result screen and land back on mode-select. */
function returnToMenu() {
  leaveOnline();
  el.endScreen.classList.remove("overlay--visible");
  el.startScreen.classList.add("overlay--visible");
  refreshStartLeaderboard();
}

el.onlineBtn.addEventListener("click", showOnlineScreen);
el.createBtn.addEventListener("click", createRoom);

el.sizeButtons.querySelectorAll(".size-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    net.roomSize = Number(btn.dataset.size);
    el.sizeButtons.querySelectorAll(".size-btn").forEach((b) => b.classList.toggle("size-btn--active", b === btn));
  });
});
el.joinBtn.addEventListener("click", joinRoom);
el.joinCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoom();
});
el.onlineBack.addEventListener("click", () => {
  leaveOnline();
  el.onlineScreen.classList.remove("overlay--visible");
  el.startScreen.classList.add("overlay--visible");
});

// Online play needs the relay server; from file:// we can only hint at it
if (isServed) {
  refreshStartLeaderboard();
} else {
  el.onlineBtn.disabled = true;
  el.onlineHint.textContent = 'To play online: run "node server.js" and open http://localhost:3000';
}
