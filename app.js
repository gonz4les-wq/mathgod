/* =========================================================================
   Mathgod — app logic
   --------------------------------------------------------------------------
   Difficulties:   1×1   |  1×2   |  2×2  (capped at 20)
   Game types:     Practice (10 questions)
                   Survival (one life, open-ended)
                   Sprint   (60 s)
                   Zen      (endless, no pressure)
   Modifiers:      Reverse  (find the missing factor)
                   Daily    (deterministic 10-question challenge once per day)

   Adaptive weighting per (a, b) pair, combo multipliers, daily streak,
   achievements with toast notifications, mistake review, and full local
   persistence — all in one file.
   ========================================================================= */

(() => {
  "use strict";

  /* ────────────────────────────  Constants  ─────────────────────────────── */

  const STORAGE_KEY        = "mathgod:v1";
  const XP_PER_CORRECT     = 10;
  const XP_STREAK_BONUS    = 2;
  const SPRINT_DURATION_MS = 60_000;
  const LOW_TIME_THRESHOLD_MS = 10_000;
  const COMBO_TIER_1 = 5;     // streak ≥ 5 → 2× XP
  const COMBO_TIER_2 = 10;    // streak ≥ 10 → 3× XP

  const MODES = {
    "1x1": { aRange: [2, 9],   bRange: [2, 9]   },
    "1x2": { aRange: [2, 9],   bRange: [10, 20] },
    "2x2": { aRange: [10, 20], bRange: [10, 20] },
  };

  const GAME_TYPES = {
    practice: {
      label: "Practice",
      hint: "Ten questions, then a summary.",
      length: 10,
      lives: Infinity,
      timeLimit: 0,
      recordKey: "timeMs",
      recordLabel: "Best time",
      cmp: "min",
    },
    survival: {
      label: "Survival",
      hint: "No limit. One wrong answer ends the run.",
      length: Infinity,
      lives: 1,
      timeLimit: 0,
      recordKey: "streak",
      recordLabel: "Longest run",
      cmp: "max",
    },
    sprint: {
      label: "Sprint",
      hint: "60 seconds. Solve as many as you can.",
      length: Infinity,
      lives: Infinity,
      timeLimit: SPRINT_DURATION_MS,
      recordKey: "count",
      recordLabel: "Best score",
      cmp: "max",
    },
    zen: {
      label: "Zen",
      hint: "Endless practice. No timer, no pressure.",
      length: Infinity,
      lives: Infinity,
      timeLimit: 0,
      recordKey: null,
      recordLabel: "",
      cmp: "max",
    },
  };

  const FEEDBACK_CORRECT = ["Nice.", "Got it.", "Clean.", "Sharp.", "Smooth."];
  const FEEDBACK_WRONG   = (a, b) => `${a} × ${b} = ${a * b}`;

  /* ─────────────────────────────  Shop catalog  ─────────────────────────
     Each item belongs to a category (theme / numberStyle / cardStyle /
     particles / keypadStyle). The "default" item per category is always
     owned and equipped, and is free / not visible in the shop.
     Items declare an `apply` hook that mutates the document root via a
     data-* attribute, which CSS rules pick up. Particles are JS-only and
     handled directly in `triggerCorrectParticles()`.
     Rarity tiers control accent colour and price tiers:
        common 200–500 · rare 800–1500 · epic 2500–3500 · legendary 8000
  ────────────────────────────────────────────────────────────────────── */
  const RARITY_ORDER = { common: 0, rare: 1, epic: 2, legendary: 3 };
  const CATEGORIES = [
    { id: "theme",       label: "Themes",   attr: "data-theme-pack"   },
    { id: "numberStyle", label: "Numbers",  attr: "data-number-style" },
    { id: "cardStyle",   label: "Card",     attr: "data-card-style"   },
    { id: "particles",   label: "Particles", attr: null /* JS only */ },
    { id: "keypadStyle", label: "Keypad",   attr: "data-keypad-style" },
  ];

  const ITEMS = [
    // ─── Themes ───────────────────────────────────────────────────────────
    { id: "theme:default",  category: "theme", name: "Indigo",     rarity: "common",    price: 0,    value: "default", preview: { kind: "swatch", colors: ["#6366f1", "#8b5cf6", "#f6f5f1", "#15151a"] } },
    { id: "theme:sunset",   category: "theme", name: "Sunset",     rarity: "common",    price: 200,  value: "sunset",  preview: { kind: "swatch", colors: ["#f97316", "#ef4444", "#fde68a", "#1e1b18"] } },
    { id: "theme:ocean",    category: "theme", name: "Ocean",      rarity: "common",    price: 300,  value: "ocean",   preview: { kind: "swatch", colors: ["#0891b2", "#06b6d4", "#ecfeff", "#0f1e24"] } },
    { id: "theme:sakura",   category: "theme", name: "Sakura",     rarity: "rare",      price: 800,  value: "sakura",  preview: { kind: "swatch", colors: ["#ec4899", "#f9a8d4", "#fff1f5", "#2a1820"] } },
    { id: "theme:forest",   category: "theme", name: "Forest",     rarity: "rare",      price: 800,  value: "forest",  preview: { kind: "swatch", colors: ["#16a34a", "#65a30d", "#f1f5e7", "#152017"] } },
    { id: "theme:neon",     category: "theme", name: "Neon",       rarity: "epic",      price: 2500, value: "neon",    preview: { kind: "swatch", colors: ["#f472b6", "#22d3ee", "#0a0a14", "#f1f1ff"] } },
    { id: "theme:retroLcd", category: "theme", name: "Retro LCD",  rarity: "legendary", price: 8000, value: "retroLcd", preview: { kind: "swatch", colors: ["#84cc16", "#65a30d", "#0a1408", "#d9f99d"] } },
    // ─── Number styles ────────────────────────────────────────────────────
    { id: "numberStyle:default", category: "numberStyle", name: "Default",  rarity: "common",  price: 0,    value: "default", preview: { kind: "number", style: "default" } },
    { id: "numberStyle:mono",    category: "numberStyle", name: "Monospace", rarity: "common", price: 400,  value: "mono",    preview: { kind: "number", style: "mono" } },
    { id: "numberStyle:serif",   category: "numberStyle", name: "Serif",    rarity: "rare",    price: 1000, value: "serif",   preview: { kind: "number", style: "serif" } },
    { id: "numberStyle:display", category: "numberStyle", name: "Display",  rarity: "epic",    price: 2500, value: "display", preview: { kind: "number", style: "display" } },
    // ─── Card styles ──────────────────────────────────────────────────────
    { id: "cardStyle:default",  category: "cardStyle", name: "Default",   rarity: "common", price: 0,    value: "default",  preview: { kind: "card", style: "default" } },
    { id: "cardStyle:outlined", category: "cardStyle", name: "Outlined",  rarity: "common", price: 500,  value: "outlined", preview: { kind: "card", style: "outlined" } },
    { id: "cardStyle:glow",     category: "cardStyle", name: "Glow",      rarity: "epic",   price: 3000, value: "glow",     preview: { kind: "card", style: "glow" } },
    // ─── Particles ────────────────────────────────────────────────────────
    { id: "particles:default",  category: "particles", name: "None",      rarity: "common",    price: 0,    value: "default" },
    { id: "particles:sparkle",  category: "particles", name: "Sparkle",   rarity: "rare",      price: 1500, value: "sparkle"  },
    { id: "particles:confetti", category: "particles", name: "Confetti",  rarity: "epic",      price: 3500, value: "confetti" },
    { id: "particles:stars",    category: "particles", name: "Stars",     rarity: "legendary", price: 8000, value: "stars"    },
    // ─── Keypad ───────────────────────────────────────────────────────────
    { id: "keypadStyle:default", category: "keypadStyle", name: "Default", rarity: "common", price: 0,    value: "default" },
    { id: "keypadStyle:sharp",   category: "keypadStyle", name: "Sharp",   rarity: "common", price: 300,  value: "sharp"   },
    { id: "keypadStyle:soft",    category: "keypadStyle", name: "Soft",    rarity: "rare",   price: 800,  value: "soft"    },
  ];

  const ITEM_BY_ID = Object.fromEntries(ITEMS.map((it) => [it.id, it]));
  const PRESTIGE_THRESHOLD_LEVEL = 25;

  /* ───────────────────────────  Story catalog  ───────────────────────────
     Five themed worlds; each has 8 normal levels plus a boss.
     - normal level: complete `target` correct answers; you have `maxWrongs`
       lives. Stars = 3 if no mistakes, 2 with 1, 1 otherwise.
     - boss: a HP-based fight under a 60s timer. Correct answers chip the
       boss; wrong answers cost a player life. Stars from remaining time.
     The accent colour styles the world map and the in-game header.
  ──────────────────────────────────────────────────────────────────────── */
  const WORLDS = [
    {
      id: "grass",
      name: "Grasslands",
      desc: "Calm pastures where your journey begins.",
      accent: "#16a34a",
      tint: "linear-gradient(160deg, #22c55e, #65a30d)",
      icon: "🌿",
      levels: [
        { name: "First steps",   mode: "1x1", target:  5, maxWrongs: 3, xp: 30 },
        { name: "Tall grass",    mode: "1x1", target:  7, maxWrongs: 3, xp: 35 },
        { name: "Quiet brook",   mode: "1x1", target:  8, maxWrongs: 2, xp: 40 },
        { name: "Stone path",    mode: "1x1", target: 10, maxWrongs: 2, xp: 50 },
        { name: "Sun-warmed",    mode: "1x1", target: 10, maxWrongs: 2, xp: 55 },
        { name: "Open field",    mode: "1x1", target: 12, maxWrongs: 2, xp: 60 },
        { name: "Mountain pass", mode: "1x1", target: 14, maxWrongs: 1, xp: 75, combo: 5 },
        { name: "Forest edge",   mode: "1x1", target: 15, maxWrongs: 1, xp: 90, combo: 6 },
      ],
      boss: { name: "Forest Guardian", icon: "🛡", hp: 80, mode: "1x1", timeLimit: 60_000, xp: 200 },
    },
    {
      id: "ice",
      name: "Ice Caverns",
      desc: "Frozen halls where every second counts.",
      accent: "#06b6d4",
      tint: "linear-gradient(160deg, #06b6d4, #3b82f6)",
      icon: "❄",
      levels: [
        { name: "Frozen pond",  mode: "1x1", target:  8, maxWrongs: 2, xp: 60 },
        { name: "Ice tunnel",   mode: "1x2", target:  6, maxWrongs: 3, xp: 70 },
        { name: "Snowfall",     mode: "1x2", target:  8, maxWrongs: 3, xp: 80 },
        { name: "Frozen sprint", mode: "1x1", gameType: "sprint", target: 14, maxWrongs: 99, xp: 90, timeLimit: 60_000 },
        { name: "Glacier rift", mode: "1x2", target: 10, maxWrongs: 2, xp: 100 },
        { name: "Aurora",       mode: "1x2", target: 10, maxWrongs: 2, xp: 110 },
        { name: "Snowstorm",    mode: "1x2", target: 12, maxWrongs: 1, xp: 130, combo: 5 },
        { name: "Crystal vault", mode: "1x2", target: 14, maxWrongs: 1, xp: 150, combo: 6 },
      ],
      boss: { name: "Frost Sentinel", icon: "❄", hp: 100, mode: "1x2", timeLimit: 60_000, xp: 280 },
    },
    {
      id: "neon",
      name: "Neon City",
      desc: "Pulse-quick streets that reward long combos.",
      accent: "#f472b6",
      tint: "linear-gradient(160deg, #ec4899, #8b5cf6)",
      icon: "✦",
      levels: [
        { name: "Downtown",   mode: "1x2", target: 10, maxWrongs: 2, xp: 110 },
        { name: "Skyline",    mode: "1x2", target: 10, maxWrongs: 2, xp: 120, combo: 5 },
        { name: "Arcade",     mode: "1x2", gameType: "sprint", target: 16, maxWrongs: 99, xp: 130, timeLimit: 60_000 },
        { name: "Subway",     mode: "1x2", target: 12, maxWrongs: 1, xp: 140, combo: 6 },
        { name: "Neon alley", mode: "1x2", target: 12, maxWrongs: 1, xp: 150, combo: 7 },
        { name: "Rooftop",    mode: "1x2", target: 14, maxWrongs: 1, xp: 170, combo: 7 },
        { name: "Highway",    mode: "1x2", target: 15, maxWrongs: 1, xp: 200, combo: 8 },
        { name: "Penthouse",  mode: "1x2", target: 18, maxWrongs: 1, xp: 240, combo: 8 },
      ],
      boss: { name: "Voltage King", icon: "⚡", hp: 120, mode: "1x2", timeLimit: 60_000, xp: 380 },
    },
    {
      id: "volcano",
      name: "Volcano Core",
      desc: "Two-digit fire under serious time pressure.",
      accent: "#f97316",
      tint: "linear-gradient(160deg, #f97316, #dc2626)",
      icon: "🔥",
      levels: [
        { name: "Foothills",     mode: "2x2", target:  6, maxWrongs: 3, xp: 160 },
        { name: "Ash plains",    mode: "2x2", target:  8, maxWrongs: 3, xp: 180 },
        { name: "Lava tube",     mode: "2x2", target:  8, maxWrongs: 2, xp: 200 },
        { name: "Pyre",          mode: "2x2", target: 10, maxWrongs: 2, xp: 230, timeLimit: 90_000 },
        { name: "Magma chamber", mode: "2x2", target: 10, maxWrongs: 1, xp: 260, timeLimit: 75_000 },
        { name: "Obsidian gate", mode: "2x2", target: 12, maxWrongs: 1, xp: 290 },
        { name: "Flame spire",   mode: "2x2", gameType: "sprint", target: 12, maxWrongs: 99, xp: 310, timeLimit: 60_000 },
        { name: "Inferno",       mode: "2x2", target: 14, maxWrongs: 1, xp: 360, combo: 6 },
      ],
      boss: { name: "Magma Titan", icon: "🔥", hp: 140, mode: "2x2", timeLimit: 60_000, xp: 500 },
    },
    {
      id: "sky",
      name: "Sky Kingdom",
      desc: "The final realm. Mixed pools and reverse questions.",
      accent: "#fbbf24",
      tint: "linear-gradient(160deg, #fbbf24, #f59e0b)",
      icon: "👑",
      levels: [
        { name: "Cloud bridge",     mode: "1x2", target: 10, maxWrongs: 2, xp: 220, reverse: true },
        { name: "Sun temple",       mode: "2x2", target:  8, maxWrongs: 2, xp: 240 },
        { name: "Wind path",        mode: "1x2", target: 12, maxWrongs: 1, xp: 280, reverse: true, combo: 5 },
        { name: "Floating gardens", mode: "2x2", target: 10, maxWrongs: 1, xp: 320 },
        { name: "Aurora reach",     mode: "1x2", gameType: "sprint", target: 18, maxWrongs: 99, xp: 340, timeLimit: 60_000, reverse: true },
        { name: "Star deck",        mode: "2x2", target: 12, maxWrongs: 1, xp: 380, combo: 6 },
        { name: "Skyfall",          mode: "2x2", target: 14, maxWrongs: 1, xp: 420, combo: 7, reverse: true },
        { name: "Heaven's gate",    mode: "2x2", target: 16, maxWrongs: 1, xp: 480, combo: 8 },
      ],
      boss: { name: "Sky Sovereign", icon: "👑", hp: 180, mode: "2x2", timeLimit: 60_000, xp: 700 },
    },
  ];

  const WORLD_BY_ID = Object.fromEntries(WORLDS.map((w) => [w.id, w]));

  /* Achievements: id → metadata + unlock predicate evaluated after a session. */
  const ACHIEVEMENTS = [
    { id: "first",        emoji: "✦", name: "First steps",       desc: "Finish your first session.",
      check: (s) => s.totalSessions >= 1 },
    { id: "flawless",     emoji: "★", name: "Flawless",            desc: "All 10 correct in a Practice session.",
      check: (s, c) => c.gameType === "practice" && c.completed && c.correct >= 10 },
    { id: "streak_25",    emoji: "◆", name: "Hot streak",          desc: "Reach a 25-question streak.",
      check: (s, c) => c.bestStreak >= 25 || s.bestStreak >= 25 },
    { id: "survivor_20",  emoji: "◆", name: "Survivor",            desc: "Answer 20 correctly in Survival.",
      check: (s, c) => c.gameType === "survival" && c.correct >= 20 },
    { id: "sprinter_20",  emoji: "◆", name: "Sprinter",            desc: "Solve 20 in a single Sprint.",
      check: (s, c) => c.gameType === "sprint" && c.correct >= 20 },
    { id: "zen_30",       emoji: "✦", name: "Zen mind",            desc: "Answer 30+ in a Zen session.",
      check: (s, c) => c.gameType === "zen" && c.correct >= 30 },
    { id: "reverse_done", emoji: "◆", name: "Reverse thinker",     desc: "Complete a session in Reverse mode.",
      check: (s, c) => c.reverse && c.correct >= 5 },
    { id: "daily_3",      emoji: "◆", name: "Three in a row",      desc: "3-day daily streak.",
      check: (s) => s.daily.streak >= 3 },
    { id: "daily_7",      emoji: "★", name: "Week strong",         desc: "7-day daily streak.",
      check: (s) => s.daily.streak >= 7 },
    { id: "centurion",    emoji: "✦", name: "Centurion",           desc: "100 correct answers, lifetime.",
      check: (s) => s.totalCorrect >= 100 },
    { id: "five_hundred", emoji: "★", name: "Five hundred",        desc: "500 correct answers, lifetime.",
      check: (s) => s.totalCorrect >= 500 },
    { id: "allrounder",   emoji: "◆", name: "All-rounder",         desc: "Try all four game types.",
      check: (s) => (s.tried.gameTypes || []).length >= 4 },
  ];

  /* ─────────────────────────────  Storage  ──────────────────────────────── */

  const defaults = () => ({
    onboarded: false,
    theme: "auto",
    gameType: "practice",
    reverseMode: false,
    totalXP: 0,
    totalSessions: 0,
    totalCorrect: 0,
    bestStreak: 0,
    mastery: {},
    records: {},
    achievements: {},
    daily: {
      streak: 0,
      bestStreak: 0,
      lastCompletedDate: null,
      lastPlayedDate: null,
    },
    tried: { gameTypes: [], reverse: false, daily: false },
    player: {
      lastSeenLevel: 1,   // for detecting level-ups
      prestige: 0,        // increments on prestige reset
    },
    shop: {
      owned: {},          // itemId -> true
      equipped: {
        theme:        "default",
        numberStyle:  "default",
        cardStyle:    "default",
        particles:    "default",
        keypadStyle:  "default",
      },
      featured: { date: null, ids: [] },
    },
    story: {
      currentWorld: 0,             // index into WORLDS for the world tab
      progress: {},                // worldId -> { unlocked, levels: [{stars, completed}], bossDefeated, bossStars }
    },
  });

  /* ─────────────────────────────  Levels  ───────────────────────────────── */

  /** XP required to be at the start of `level` (level 1 starts at 0). */
  function xpForLevel(level) { return 25 * (level - 1) * level; }

  /** The player's current level derived from total XP. */
  function levelFromXP(xp) {
    if (!Number.isFinite(xp) || xp <= 0) return 1;
    return Math.max(1, Math.floor((1 + Math.sqrt(1 + 4 * xp / 25)) / 2));
  }

  /** { level, current, needed, pct } — progress through the current level. */
  function levelProgress() {
    const level = levelFromXP(store.totalXP);
    const lo = xpForLevel(level);
    const hi = xpForLevel(level + 1);
    const current = Math.max(0, store.totalXP - lo);
    const needed  = Math.max(1, hi - lo);
    return { level, current, needed, pct: Math.min(1, current / needed) };
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw);
      const d = defaults();
      // Shallow merge plus careful sub-object merges so new fields land safely.
      return {
        ...d,
        ...parsed,
        mastery: parsed.mastery || {},
        records: parsed.records || {},
        achievements: parsed.achievements || {},
        daily:  { ...d.daily,  ...(parsed.daily  || {}) },
        tried:  { ...d.tried,  ...(parsed.tried  || {}) },
        player: { ...d.player, ...(parsed.player || {}) },
        shop:   {
          ...d.shop,
          ...(parsed.shop || {}),
          owned:    { ...(parsed.shop?.owned    || {}) },
          equipped: { ...d.shop.equipped, ...(parsed.shop?.equipped || {}) },
          featured: { ...d.shop.featured, ...(parsed.shop?.featured || {}) },
        },
        story:  {
          ...d.story,
          ...(parsed.story || {}),
          progress: { ...(parsed.story?.progress || {}) },
        },
      };
    } catch {
      return defaults();
    }
  }

  function saveStore() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }
    catch { /* private mode etc. */ }
  }

  const store = loadStore();

  /* ─────────────────────────  Date helpers  ─────────────────────────────── */

  /** Local-date key in YYYY-MM-DD for daily-streak bookkeeping. */
  function todayKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function yesterdayKey() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return todayKey(d);
  }
  function formatLongDate(d = new Date()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  /* ─────────────────────────────  PRNG  ─────────────────────────────────── */

  /** Mulberry32 — small deterministic PRNG, seeded from a string. */
  function seededRng(seedStr) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seedStr.length; i++) {
      h ^= seedStr.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    let t = h;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      let x = t;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ─────────────────────────  Runtime session state  ────────────────────── */

  let session = null;

  function freshSession(mode, gameType, opts = {}) {
    const baseCfg = GAME_TYPES[gameType];
    // Story levels may override timeLimit and lives.
    const story = opts.story || null;
    const cfg = story
      ? {
          ...baseCfg,
          timeLimit: story.timeLimit || 0,
          lives:     story.maxWrongs ?? baseCfg.lives,
          length:    story.isBoss ? Infinity : baseCfg.length,
        }
      : baseCfg;
    return {
      mode,                          // null when isDaily (mixed pool)
      gameType,
      cfg,
      reverse: !!opts.reverse,
      isDaily: !!opts.isDaily,
      dailyQuestions: opts.dailyQuestions || null,
      dailyIdx: 0,
      isStory: !!story,
      story,
      bossHP:    story?.isBoss ? story.bossHP : 0,
      bossMaxHP: story?.isBoss ? story.bossHP : 0,
      index: 0,
      input: "",
      streak: 0,
      bestStreak: 0,
      correct: 0,
      wrong: 0,
      xp: 0,
      livesLeft: cfg.lives,
      startTime: 0,
      endTime: 0,
      elapsedMs: 0,
      timerRAF: 0,
      timerStart: 0,
      timeLeftMs: cfg.timeLimit,
      question: null,
      locked: false,
      lastKey: null,
      pendingAdvance: 0,
      mistakes: [],                  // { a, b, product, guess, reverse, pos }
      comboTier: 0,                  // 0 / 1 / 2 → 1× / 2× / 3×
    };
  }

  /* ──────────────────────────  Question engine  ─────────────────────────── */

  function poolFor(mode) {
    const { aRange, bRange } = MODES[mode];
    const out = [];
    for (let a = aRange[0]; a <= aRange[1]; a++) {
      for (let b = bRange[0]; b <= bRange[1]; b++) out.push([a, b]);
    }
    return out;
  }

  function getRecord(key) {
    return store.mastery[key] || { seen: 0, correct: 0, lastSeen: 0 };
  }

  function pickQuestion(mode, avoidKey, opts = {}) {
    const pool = poolFor(mode);
    const now = Date.now();
    const weights = pool.map(([a, b]) => {
      const key = `${a}x${b}`;
      if (key === avoidKey) return 0;
      const r = getRecord(key);
      const accuracy = r.seen ? r.correct / r.seen : 0.5;
      const errorWeight = Math.max(0.15, 1.25 - accuracy);
      const familiarity = Math.min(r.seen, 4) / 4;
      const noveltyBoost = 1 + (1 - familiarity) * 0.8;
      const sinceMin = r.lastSeen ? (now - r.lastSeen) / 60000 : 9999;
      const recencyBoost = sinceMin > 2 ? 1.1 : 0.9;
      return errorWeight * noveltyBoost * recencyBoost;
    });
    const total = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    let a, b;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) { [a, b] = pool[i]; break; }
    }
    if (a === undefined) [a, b] = pool[pool.length - 1];
    return decorateQuestion(a, b, opts.reverse);
  }

  function decorateQuestion(a, b, reverse) {
    const q = { a, b, product: a * b, reverse: !!reverse, pos: null, target: 0 };
    if (reverse) {
      q.pos = Math.random() < 0.5 ? "a" : "b";
      q.target = q.pos === "a" ? a : b;
    } else {
      q.target = q.product;
    }
    return q;
  }

  function recordResult(a, b, wasCorrect) {
    const key = `${a}x${b}`;
    const r = { ...getRecord(key) };
    r.seen += 1;
    if (wasCorrect) r.correct += 1;
    r.lastSeen = Date.now();
    store.mastery[key] = r;
  }

  function modeMastery(mode) {
    const pool = poolFor(mode);
    let totalSeen = 0, weighted = 0;
    for (const [a, b] of pool) {
      const r = getRecord(`${a}x${b}`);
      if (r.seen === 0) continue;
      totalSeen += 1;
      const acc = r.correct / r.seen;
      const confidence = Math.min(1, r.seen / 3);
      weighted += acc * confidence;
    }
    if (totalSeen === 0) return 0;
    const coverage = totalSeen / pool.length;
    return Math.min(1, (weighted / totalSeen) * Math.sqrt(coverage));
  }

  /* ─────────────────────────────  Records  ──────────────────────────────── */

  function recordSlot(gameType, mode) {
    const k = `${gameType}:${mode}`;
    if (!store.records[k]) store.records[k] = {};
    return store.records[k];
  }
  function tryBeatRecord(gameType, mode, value) {
    if (value == null || Number.isNaN(value)) return false;
    const cfg = GAME_TYPES[gameType];
    if (!cfg.recordKey) return false;
    const slot = recordSlot(gameType, mode);
    const prev = slot[cfg.recordKey];
    const better = prev == null ? true : (cfg.cmp === "min" ? value < prev : value > prev);
    if (better) slot[cfg.recordKey] = value;
    return better;
  }
  function formatRecord(gameType, mode) {
    const cfg = GAME_TYPES[gameType];
    if (!cfg.recordKey) return "";
    const slot = recordSlot(gameType, mode);
    const val  = slot[cfg.recordKey];
    if (val == null) return "";
    if (cfg.recordKey === "timeMs") return `${cfg.recordLabel} · ${formatTime(val)}`;
    return `${cfg.recordLabel} · ${val}`;
  }

  /* ──────────────────────────────  Format  ──────────────────────────────── */

  function formatTime(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  function formatCount(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return Math.round(n / 1000) + "k";
  }

  /* ───────────────────────────────  DOM  ────────────────────────────────── */

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const views = {
    home:         $('[data-view="home"]'),
    game:         $('[data-view="game"]'),
    summary:      $('[data-view="summary"]'),
    onboard:      $('[data-view="onboard"]'),
    achievements: $('[data-view="achievements"]'),
  };

  const dom = {
    qA:           $("#qA"),
    qB:           $("#qB"),
    qEq:          $("#qEq"),
    qC:           $("#qC"),
    answer:       $(".answer"),
    answerValue:  $("#answerValue"),
    feedback:     $("#feedback"),
    questionCard: $("#questionCard"),
    progressWrap: $("#progressWrap"),
    progressFill: $("#progressFill"),
    timerBadge:   $("#timerBadge"),
    streakBadge:  $("#streakBadge"),
    streakNum:    $("#streakBadge [data-streak]"),
    comboBadge:   $("#comboBadge"),
    keypad:       $("#keypad"),
    themeToggle:  $("#themeToggle"),
    achBtn:       $("#achievementsBtn"),
    achBack:      $("#achBackBtn"),
    achList:      $("#achList"),
    achSummary:   $("#achSummary"),
    quitBtn:      $("#quitBtn"),
    againBtn:     $("#againBtn"),
    homeBtn:      $("#homeBtn"),
    onboardStart: $("#onboardStart"),
    sumCorrect:   $("#sumCorrect"),
    sumTime:      $("#sumTime"),
    sumStreak:    $("#sumStreak"),
    sumXP:        $("#sumXP"),
    summaryTitle: $("#summaryTitle"),
    summarySubtitle: $("#summarySubtitle"),
    summaryEmoji: $("#summaryEmoji"),
    summaryBest:  $("#summaryBest"),
    mistakeReview: $("#mistakeReview"),
    mistakeList:   $("#mistakeList"),
    mistakeSummary: $("#mistakeSummary"),
    seg:           $("#gameTypeSeg"),
    segHint:       $("#gameTypeHint"),
    reverseToggle: $("#reverseToggle"),
    dailyCard:     $("#dailyCard"),
    dailyDate:     $("#dailyDate"),
    dailySub:      $("#dailySub"),
    dailyStreakNum:$("#dailyStreakNum"),
    toasts:        $("#toasts"),
    prefsBtn:      $("#prefsBtn"),
    prefsLabel:    $("#prefsLabel"),
    prefsSheet:    $("#prefsSheet"),
    levelBadge:    $("#levelBadge"),
    levelNum:      $("#levelNum"),
    levelFill:     $("#levelFill"),
    shopBtn:       $("#shopBtn"),
    shopBackBtn:   $("#shopBackBtn"),
    shopBalance:   $("#shopBalance"),
    shopTabs:      $("#shopTabs"),
    shopGrid:      $("#shopGrid"),
    prestigeBox:   $("#prestigeBox"),
    prestigeBtn:   $("#prestigeBtn"),
    storyCard:     $("#storyCard"),
    storyWorldName:$("#storyWorldName"),
    storyProgressText: $("#storyProgressText"),
    storyCta:      $("#storyCta"),
    storyBarFill:  $("#storyBarFill"),
    storyBackBtn:  $("#storyBackBtn"),
    storyStars:    $("#storyStars"),
    storyWorldTabs:$("#storyWorldTabs"),
    storyWorldHead:$("#storyWorldHead"),
    storyMap:      $("#storyMap"),
    levelSheet:    $("#levelSheet"),
    levelSheetWorld: $("#levelSheetWorld"),
    levelSheetTitle: $("#levelSheetTitle"),
    levelSheetStars: $("#levelSheetStars"),
    levelSheetObjs:  $("#levelSheetObjs"),
    levelSheetStart: $("#levelSheetStart"),
    bossBar:       $("#bossBar"),
    bossAvatar:    $("#bossAvatar"),
    bossName:      $("#bossName"),
    bossHpFill:    $("#bossHpFill"),
    bossLives:     $("#bossLives"),
    storyHud:      $("#storyHud"),
    storyHudCount: $("#storyHudCount"),
    storyHudLives: $("#storyHudLives"),
  };

  // Register the additional views.
  views.shop  = $('[data-view="shop"]');
  views.story = $('[data-view="story"]');

  function showView(name) {
    Object.entries(views).forEach(([k, el]) => {
      if (!el) return;
      if (k === name) el.removeAttribute("hidden");
      else            el.setAttribute("hidden", "");
    });
  }

  /* ─────────────────────────────  Rendering  ────────────────────────────── */

  function renderHomeStats() {
    $('[data-stat="xp"]').textContent       = formatCount(store.totalXP);
    $('[data-stat="streak"]').textContent   = String(store.bestStreak);
    $('[data-stat="sessions"]').textContent = String(store.totalSessions);
    for (const mode of Object.keys(MODES)) {
      const pct = Math.round(modeMastery(mode) * 100);
      const fillEl = document.querySelector(`[data-fill="${mode}"]`);
      if (fillEl) fillEl.style.width = pct + "%";
      const bestEl = document.querySelector(`[data-best="${mode}"]`);
      if (bestEl) bestEl.textContent = formatRecord(store.gameType, mode);
    }
    renderDailyCard();
    renderAchievementsBadge();
    renderLevelBadge();
    renderStoryHomeCard();
  }

  /* ────────────────────────  Story home + map  ──────────────────────────── */

  function renderStoryHomeCard() {
    if (!dom.storyCard) return;
    syncStoryProgress();
    const next = nextStoryTarget();
    if (next) {
      const w = WORLDS[next.worldIdx];
      const completed = ensureWorldProgress(next.worldIdx).levels.filter(l => l.completed).length;
      dom.storyWorldName.textContent = w.name;
      dom.storyCard.style.setProperty("--story-tint", w.tint);
      dom.storyCard.style.setProperty("--story-accent", w.accent);
      if (next.kind === "boss") {
        dom.storyProgressText.textContent = `${w.name} · Boss awaits`;
      } else {
        dom.storyProgressText.textContent = `${w.name} · Level ${next.levelIdx + 1} of ${w.levels.length}`;
      }
      dom.storyCta.textContent = "Continue →";
      const pct = (completed / w.levels.length) * 100;
      dom.storyBarFill.style.width = pct + "%";
    } else {
      // All worlds cleared.
      dom.storyWorldName.textContent = "Complete";
      dom.storyProgressText.textContent = "All worlds cleared.";
      dom.storyCta.textContent = "Replay →";
      dom.storyBarFill.style.width = "100%";
    }
  }

  function openStory(worldIdx = store.story.currentWorld || 0) {
    syncStoryProgress();
    // Clamp to a valid unlocked world.
    let idx = worldIdx;
    if (!ensureWorldProgress(idx)?.unlocked) {
      for (let i = WORLDS.length - 1; i >= 0; i--) {
        if (ensureWorldProgress(i).unlocked) { idx = i; break; }
      }
    }
    store.story.currentWorld = idx;
    renderStoryView();
    showView("story");
  }

  function renderStoryView() {
    const idx = store.story.currentWorld || 0;
    // Total stars.
    const t = totalStars();
    dom.storyStars.textContent = `★ ${t.earned} / ${t.max}`;
    // World tabs.
    dom.storyWorldTabs.innerHTML = "";
    for (let i = 0; i < WORLDS.length; i++) {
      const w = WORLDS[i];
      const p = ensureWorldProgress(i);
      const btn = document.createElement("button");
      btn.className = "story-world-tab"
        + (i === idx ? " is-active" : "")
        + (!p.unlocked ? " is-locked" : "");
      btn.type = "button";
      btn.dataset.world = String(i);
      btn.innerHTML = `<span class="story-world-tab__icon">${p.unlocked ? w.icon : "🔒"}</span>
                       <span class="story-world-tab__name">${w.name}</span>`;
      dom.storyWorldTabs.appendChild(btn);
    }
    // World head: name + accent.
    const w = WORLDS[idx];
    const p = ensureWorldProgress(idx);
    document.documentElement.style.setProperty("--story-current-accent", w.accent);
    dom.storyWorldHead.innerHTML = `
      <div class="story-world-head__body">
        <p class="story-world-head__title">${w.name}</p>
        <p class="story-world-head__desc">${w.desc}</p>
      </div>
      <span class="story-world-head__badge" style="background:${w.tint}">${w.icon}</span>
    `;
    // Map nodes.
    dom.storyMap.innerHTML = "";
    dom.storyMap.style.setProperty("--story-accent", w.accent);
    dom.storyMap.style.setProperty("--story-tint", w.tint);
    for (let li = 0; li < w.levels.length; li++) {
      const lvl = w.levels[li];
      const entry = p.levels[li];
      const unlocked = isLevelUnlocked(idx, li);
      const node = document.createElement("button");
      node.type = "button";
      node.className = "story-node"
        + (li % 2 === 0 ? " story-node--left" : " story-node--right")
        + (unlocked ? "" : " is-locked")
        + (entry.completed ? " is-completed" : "");
      node.dataset.world = String(idx);
      node.dataset.level = String(li);
      node.innerHTML = `
        <span class="story-node__circle">${unlocked ? li + 1 : "🔒"}</span>
        <span class="story-node__name">${lvl.name}</span>
        <span class="story-node__stars">
          ${[0, 1, 2].map(i => `<i class="${i < entry.stars ? "is-on" : ""}">★</i>`).join("")}
        </span>
      `;
      dom.storyMap.appendChild(node);
    }
    // Boss node.
    const bossUnlocked = isBossUnlocked(idx);
    const bossNode = document.createElement("button");
    bossNode.type = "button";
    bossNode.className = "story-node story-node--boss story-node--center"
      + (bossUnlocked ? "" : " is-locked")
      + (p.bossDefeated ? " is-completed" : "");
    bossNode.dataset.world = String(idx);
    bossNode.dataset.level = "-1";
    bossNode.innerHTML = `
      <span class="story-node__circle story-node__circle--boss">${bossUnlocked ? w.boss.icon : "🔒"}</span>
      <span class="story-node__name">${w.boss.name}</span>
      <span class="story-node__stars">
        ${[0, 1, 2].map(i => `<i class="${i < (p.bossStars || 0) ? "is-on" : ""}">★</i>`).join("")}
      </span>
    `;
    dom.storyMap.appendChild(bossNode);
  }

  /* ───────────────────────  Level intro sheet  ──────────────────────────── */

  let pendingLevel = null;  // { worldIdx, levelIdx }

  function openLevelSheet(worldIdx, levelIdx) {
    const w = WORLDS[worldIdx];
    if (!w) return;
    const isBoss = levelIdx < 0;
    const cfg = isBoss ? w.boss : w.levels[levelIdx];
    const unlocked = isBoss ? isBossUnlocked(worldIdx) : isLevelUnlocked(worldIdx, levelIdx);
    if (!unlocked) return;
    pendingLevel = { worldIdx, levelIdx };
    const p = ensureWorldProgress(worldIdx);
    const stars = isBoss ? (p.bossStars || 0) : (p.levels[levelIdx]?.stars || 0);
    dom.levelSheetWorld.textContent = w.name;
    dom.levelSheetTitle.textContent = cfg.name;
    dom.levelSheetStars.textContent =
      "★".repeat(stars) + "☆".repeat(3 - stars);
    const objs = [];
    if (isBoss) {
      objs.push(`Defeat ${cfg.name} (HP ${cfg.hp})`);
      objs.push(`Time limit ${formatTime(cfg.timeLimit)}`);
      objs.push(`Mode · ${cfg.mode}`);
      objs.push(`Reward · ${cfg.xp} XP`);
    } else {
      objs.push(`Answer ${cfg.target} correctly`);
      if ((cfg.maxWrongs ?? 3) < 99) objs.push(`Lives · ${cfg.maxWrongs ?? 3}`);
      if (cfg.timeLimit) objs.push(`Time · ${formatTime(cfg.timeLimit)}`);
      if (cfg.combo) objs.push(`Bonus combo · ${cfg.combo}`);
      if (cfg.reverse) objs.push("Reverse questions");
      objs.push(`Mode · ${cfg.mode}`);
      objs.push(`Reward · ${cfg.xp} XP`);
    }
    dom.levelSheetObjs.innerHTML = objs.map(o => `<li>${o}</li>`).join("");
    openSheet(dom.levelSheet);
  }

  function openSheet(sheet) {
    if (!sheet) return;
    sheet.hidden = false;
    void sheet.offsetWidth;
    sheet.setAttribute("aria-hidden", "false");
  }
  function closeSheet(sheet) {
    if (!sheet) return;
    sheet.setAttribute("aria-hidden", "true");
    setTimeout(() => { sheet.hidden = true; }, 360);
  }

  function renderLevelBadge(opts = {}) {
    if (!dom.levelBadge) return;
    const lp = levelProgress();
    const prestige = store.player?.prestige || 0;
    dom.levelNum.textContent = prestige > 0 ? `★${prestige} · Lv ${lp.level}` : `Lv ${lp.level}`;
    dom.levelFill.style.width = (lp.pct * 100) + "%";
    if (opts.bump) {
      dom.levelBadge.classList.remove("bump");
      void dom.levelBadge.offsetWidth;
      dom.levelBadge.classList.add("bump");
    }
  }

  function renderGameType() {
    $$(".seg__btn", dom.seg).forEach((btn) => {
      const active = btn.dataset.gametype === store.gameType;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    dom.segHint.textContent = GAME_TYPES[store.gameType].hint;
    renderPrefsChip();
  }

  function renderReverseToggle() {
    dom.reverseToggle.classList.toggle("is-on", store.reverseMode);
    dom.reverseToggle.setAttribute("aria-pressed", store.reverseMode ? "true" : "false");
    renderPrefsChip();
  }

  /** The chip on the home page summarises the active prefs at a glance. */
  function renderPrefsChip() {
    if (!dom.prefsLabel || !dom.prefsBtn) return;
    const gtLabel = GAME_TYPES[store.gameType].label;
    dom.prefsLabel.textContent = store.reverseMode ? `${gtLabel} · Reverse` : gtLabel;
    // Highlight the chip whenever the user has diverged from the defaults.
    const modified = store.gameType !== "practice" || store.reverseMode;
    dom.prefsBtn.classList.toggle("is-modified", modified);
  }

  /* ───────────────────────────────  Shop  ───────────────────────────────── */

  /** Re-apply all equipped cosmetics to the document root. Called on load
   *  and after every equip change. */
  function applyEquipment() {
    const root = document.documentElement;
    for (const cat of CATEGORIES) {
      if (!cat.attr) continue;
      const value = store.shop.equipped[cat.id];
      if (!value || value === "default") root.removeAttribute(cat.attr);
      else root.setAttribute(cat.attr, value);
    }
  }

  /** Returns true if the user owns an item (defaults are implicitly owned). */
  function isOwned(item) {
    if (item.price === 0) return true;
    return !!store.shop.owned[item.id];
  }

  /** Returns true if the item is the currently equipped one in its category. */
  function isEquipped(item) {
    return store.shop.equipped[item.category] === item.value;
  }

  function equipItem(item) {
    if (!isOwned(item)) return;
    store.shop.equipped[item.category] = item.value;
    applyEquipment();
    saveStore();
    renderShop();
  }

  function buyItem(item) {
    if (isOwned(item)) return;
    if (store.totalXP < item.price) {
      // Bounce the balance to signal "not enough".
      dom.shopBalance?.classList.remove("nope");
      void dom.shopBalance?.offsetWidth;
      dom.shopBalance?.classList.add("nope");
      return;
    }
    store.totalXP -= item.price;
    store.shop.owned[item.id] = true;
    // First purchase in a category? Auto-equip the new item.
    if (store.shop.equipped[item.category] === "default") {
      store.shop.equipped[item.category] = item.value;
      applyEquipment();
    }
    saveStore();
    renderShop();
    renderLevelBadge();
    queueToast({
      emoji: rarityEmoji(item.rarity),
      name: `Unlocked · ${item.name}`,
      desc: `Tap "Equip" to apply.`,
    });
  }

  function rarityEmoji(r) {
    return r === "legendary" ? "★" : r === "epic" ? "✦" : r === "rare" ? "◆" : "•";
  }

  /* The shop view: tabs across the top, then a grid of item cards. */
  let shopCategory = "theme";

  function openShop() {
    shopCategory = "theme";
    renderShop();
    showView("shop");
  }
  function closeShop() { goHome(); }

  function renderShop() {
    if (!dom.shopGrid) return;
    // Balance.
    dom.shopBalance.textContent = `${formatCount(store.totalXP)} XP`;
    // Tabs.
    $$(".shop-tab", dom.shopTabs).forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.cat === shopCategory);
      btn.setAttribute("aria-selected", btn.dataset.cat === shopCategory ? "true" : "false");
    });
    // Items in this category, sorted by rarity then price (defaults last).
    const items = ITEMS
      .filter((it) => it.category === shopCategory && it.price > 0)
      .slice()
      .sort((a, b) =>
        (RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity]) || (a.price - b.price)
      );
    dom.shopGrid.innerHTML = "";
    for (const it of items) {
      dom.shopGrid.appendChild(buildShopCard(it));
    }
    // Prestige box visible when the user has reached the threshold.
    const prestigeReady = levelFromXP(store.totalXP) >= PRESTIGE_THRESHOLD_LEVEL;
    if (dom.prestigeBox) dom.prestigeBox.hidden = !prestigeReady;
  }

  function buildShopCard(item) {
    const owned = isOwned(item);
    const equipped = isEquipped(item);
    const affordable = store.totalXP >= item.price;
    const card = document.createElement("div");
    card.className = `shop-item rarity-${item.rarity}` + (owned ? " is-owned" : "");
    card.innerHTML = `
      <div class="shop-item__preview">${buildPreview(item)}</div>
      <div class="shop-item__body">
        <div class="shop-item__row">
          <span class="shop-item__name">${item.name}</span>
          <span class="shop-item__rarity">${item.rarity}</span>
        </div>
        ${owned
          ? `<button class="shop-item__cta ${equipped ? "is-equipped" : "is-equip"}" data-action="equip" data-id="${item.id}">
               ${equipped ? "Equipped" : "Equip"}
             </button>`
          : `<button class="shop-item__cta is-buy ${affordable ? "" : "is-locked"}" data-action="buy" data-id="${item.id}">
               <span class="shop-item__price">${item.price} XP</span>
             </button>`
        }
      </div>
    `;
    return card;
  }

  /** Build category-specific preview markup. */
  function buildPreview(item) {
    const p = item.preview;
    if (!p) {
      // For particles & keypad, render a small symbolic preview.
      if (item.category === "particles") {
        const dotColors = item.value === "stars" ? ["#fbbf24", "#f59e0b"]
                        : item.value === "confetti" ? ["#f472b6", "#22d3ee", "#a78bfa"]
                        : item.value === "sparkle" ? ["#a78bfa"]
                        : ["transparent"];
        const dots = Array.from({ length: 6 }).map((_, i) => {
          const c = dotColors[i % dotColors.length];
          return `<span class="preview-dot" style="--c:${c};--i:${i}"></span>`;
        }).join("");
        return `<div class="preview-particles">${dots}</div>`;
      }
      if (item.category === "keypadStyle") {
        const r = item.value === "soft" ? "18px" : item.value === "sharp" ? "4px" : "10px";
        return `<div class="preview-keypad">
          <span style="--r:${r}"></span><span style="--r:${r}"></span><span style="--r:${r}"></span>
        </div>`;
      }
      return "";
    }
    if (p.kind === "swatch") {
      return `<div class="preview-swatches">${
        p.colors.map((c) => `<span class="preview-swatch" style="background:${c}"></span>`).join("")
      }</div>`;
    }
    if (p.kind === "number") {
      return `<div class="preview-number" data-number-preview="${p.style}">42</div>`;
    }
    if (p.kind === "card") {
      return `<div class="preview-card preview-card--${p.style}"><span>7×8</span></div>`;
    }
    return "";
  }

  /* ─────────────────────────  Particle effects  ─────────────────────────── */

  /** Emit particles on the question card based on the equipped pack. */
  function triggerCorrectParticles() {
    const style = store.shop?.equipped?.particles;
    if (!style || style === "default") return;
    const host = dom.questionCard;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2 - 30;
    const count = style === "stars" ? 10 : style === "confetti" ? 14 : 8;

    for (let i = 0; i < count; i++) {
      const p = document.createElement("span");
      p.className = `particle particle--${style}`;
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.3;
      const dist = 60 + Math.random() * 60;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist * 0.6 - 20;
      p.style.setProperty("--x0", `${cx}px`);
      p.style.setProperty("--y0", `${cy}px`);
      p.style.setProperty("--dx", `${dx}px`);
      p.style.setProperty("--dy", `${dy}px`);
      p.style.setProperty("--rot", `${Math.random() * 360}deg`);
      // Random tint for confetti.
      if (style === "confetti") {
        const palette = ["#f472b6", "#22d3ee", "#a78bfa", "#fbbf24", "#34d399"];
        p.style.setProperty("--c", palette[Math.floor(Math.random() * palette.length)]);
      }
      host.appendChild(p);
      setTimeout(() => p.remove(), 900);
    }
  }

  /* ─────────────────────────────  Prestige  ─────────────────────────────── */

  function performPrestige() {
    if (levelFromXP(store.totalXP) < PRESTIGE_THRESHOLD_LEVEL) return;
    // Reset XP. Keep mastery, achievements, shop, story.
    store.player.prestige = (store.player.prestige || 0) + 1;
    store.totalXP = 0;
    store.player.lastSeenLevel = 1;
    saveStore();
    renderShop();
    renderLevelBadge({ bump: true });
    queueToast({
      emoji: "★",
      name: `Prestige ${store.player.prestige}`,
      desc: "Permanent +5% XP bonus from now on.",
    });
  }

  /** Multiplier applied to XP gains based on prestige tier. */
  function prestigeMultiplier() {
    return 1 + 0.05 * (store.player.prestige || 0);
  }

  /* ───────────────────────────────  Story  ──────────────────────────────── */

  /** Lazy-create the persisted progress slot for a world. */
  function ensureWorldProgress(worldIdx) {
    const w = WORLDS[worldIdx];
    if (!w) return null;
    let p = store.story.progress[w.id];
    if (!p) {
      p = {
        unlocked: worldIdx === 0,
        levels: w.levels.map(() => ({ stars: 0, completed: false })),
        bossDefeated: false,
        bossStars: 0,
      };
      store.story.progress[w.id] = p;
    }
    // Lengthen levels array if WORLDS grew.
    if (p.levels.length < w.levels.length) {
      while (p.levels.length < w.levels.length) p.levels.push({ stars: 0, completed: false });
    }
    return p;
  }

  /** Bootstrap progress for every world on first access. */
  function syncStoryProgress() {
    for (let i = 0; i < WORLDS.length; i++) ensureWorldProgress(i);
  }

  /** Returns true if the user can start a given level. */
  function isLevelUnlocked(worldIdx, levelIdx) {
    const p = ensureWorldProgress(worldIdx);
    if (!p?.unlocked) return false;
    if (levelIdx === 0) return true;
    return p.levels[levelIdx - 1]?.completed;
  }
  function isBossUnlocked(worldIdx) {
    const p = ensureWorldProgress(worldIdx);
    if (!p?.unlocked) return false;
    return p.levels.every((l) => l.completed);
  }

  /** Total stars across all worlds — used in the story hero card. */
  function totalStars() {
    let earned = 0, max = 0;
    for (const w of WORLDS) {
      const p = ensureWorldProgress(WORLDS.indexOf(w));
      for (const l of p.levels) {
        earned += l.stars;
        max += 3;
      }
      earned += p.bossStars || 0;
      max += 3;
    }
    return { earned, max };
  }

  /** Pick the next thing the player should do for the "Continue" CTA. */
  function nextStoryTarget() {
    for (let wi = 0; wi < WORLDS.length; wi++) {
      const w = WORLDS[wi];
      const p = ensureWorldProgress(wi);
      if (!p.unlocked) continue;
      for (let li = 0; li < w.levels.length; li++) {
        if (!p.levels[li].completed) return { worldIdx: wi, levelIdx: li, kind: "level" };
      }
      if (!p.bossDefeated) return { worldIdx: wi, levelIdx: -1, kind: "boss" };
    }
    return null;
  }

  /** Build a story session from a world/level reference and start it. */
  function startStoryLevel(worldIdx, levelIdx) {
    const w = WORLDS[worldIdx];
    if (!w) return;
    const isBoss = levelIdx < 0;
    const cfg = isBoss ? w.boss : w.levels[levelIdx];
    if (!cfg) return;
    if (isBoss && !isBossUnlocked(worldIdx)) return;
    if (!isBoss && !isLevelUnlocked(worldIdx, levelIdx)) return;

    store.story.currentWorld = worldIdx;
    saveStore();

    const gameType = cfg.gameType || "practice";
    startSession(cfg.mode, {
      gameType,
      reverse: !!cfg.reverse,
      story: {
        worldIdx,
        levelIdx,                  // -1 for boss
        isBoss,
        accent: w.accent,
        tint: w.tint,
        worldName: w.name,
        levelName: cfg.name,
        target: cfg.target || 10,
        maxWrongs: cfg.maxWrongs ?? 3,
        timeLimit: cfg.timeLimit || (gameType === "sprint" ? SPRINT_DURATION_MS : 0),
        comboGoal: cfg.combo || 0,
        bossHP: isBoss ? cfg.hp : 0,
        bossName: isBoss ? cfg.name : "",
        bossIcon: isBoss ? cfg.icon : "",
        xpReward: cfg.xp || 50,
      },
    });
  }

  /** Resolve the star count from a completed story session. */
  function computeStoryStars(sess) {
    if (!sess.story) return 0;
    if (sess.story.isBoss) {
      // Boss: 1 for defeat, +1 for ≥30s left, +1 for ≥45s left.
      if (sess.bossHP > 0) return 0;
      const left = sess.timeLeftMs;
      if (left >= 45_000) return 3;
      if (left >= 30_000) return 2;
      return 1;
    }
    // Normal level: based on wrongs.
    if (sess.correct < sess.story.target) return 0;
    if (sess.wrong === 0) return 3;
    if (sess.wrong === 1) return 2;
    return 1;
  }

  /** Persist story result after finishSession. */
  function finalizeStory(sess) {
    const s = sess.story;
    if (!s) return { stars: 0, firstClear: false, justUnlockedWorld: null };
    const stars = computeStoryStars(sess);
    const p = ensureWorldProgress(s.worldIdx);
    let firstClear = false;
    let justUnlockedWorld = null;

    if (s.isBoss) {
      if (stars > 0) {
        if (!p.bossDefeated) firstClear = true;
        p.bossDefeated = true;
        p.bossStars = Math.max(p.bossStars || 0, stars);
        // Unlock next world if any.
        const nextIdx = s.worldIdx + 1;
        if (nextIdx < WORLDS.length) {
          const np = ensureWorldProgress(nextIdx);
          if (!np.unlocked) {
            np.unlocked = true;
            justUnlockedWorld = WORLDS[nextIdx];
          }
        }
      }
    } else {
      const entry = p.levels[s.levelIdx];
      if (stars > 0) {
        if (!entry.completed) firstClear = true;
        entry.completed = true;
        entry.stars = Math.max(entry.stars || 0, stars);
      }
    }
    return { stars, firstClear, justUnlockedWorld };
  }

  /* ─────────────────────────────  Sheet  ────────────────────────────────── */

  function openPrefsSheet()  { openSheet(dom.prefsSheet); }
  function closePrefsSheet() { closeSheet(dom.prefsSheet); }

  function renderDailyCard() {
    const today = todayKey();
    dom.dailyDate.textContent = formatLongDate();
    const done = store.daily.lastCompletedDate === today;
    dom.dailyCard.classList.toggle("is-done", done);
    dom.dailyCard.disabled = done;
    if (done) {
      dom.dailySub.textContent = "Completed today. Back tomorrow for the next one.";
    } else {
      dom.dailySub.textContent = "10 mixed questions, the same for everyone today.";
    }
    dom.dailyStreakNum.textContent = String(store.daily.streak);
  }

  function renderAchievementsBadge() {
    const have = Object.keys(store.achievements).length;
    const total = ACHIEVEMENTS.length;
    if (dom.achSummary) dom.achSummary.textContent = `${have} / ${total}`;
  }

  function renderAchievementsList() {
    if (!dom.achList) return;
    dom.achList.innerHTML = "";
    for (const a of ACHIEVEMENTS) {
      const unlocked = !!store.achievements[a.id];
      const li = document.createElement("li");
      li.className = "ach-item" + (unlocked ? " is-unlocked" : "");
      li.innerHTML = `
        <span class="ach-item__emoji">${unlocked ? a.emoji : "·"}</span>
        <span class="ach-item__body">
          <span class="ach-item__name">${a.name}</span>
          <span class="ach-item__desc">${a.desc}</span>
        </span>
      `;
      dom.achList.appendChild(li);
    }
  }

  function renderQuestion() {
    if (!session?.question) return;
    const q = session.question;
    if (session.reverse) {
      dom.qEq.hidden = false;
      dom.qC.hidden  = false;
      dom.qC.textContent = String(q.product);
      dom.qA.textContent = q.pos === "a" ? "?" : String(q.a);
      dom.qB.textContent = q.pos === "b" ? "?" : String(q.b);
      dom.qA.classList.toggle("question__slot--hole", q.pos === "a");
      dom.qB.classList.toggle("question__slot--hole", q.pos === "b");
    } else {
      dom.qEq.hidden = true;
      dom.qC.hidden  = true;
      dom.qA.textContent = String(q.a);
      dom.qB.textContent = String(q.b);
      dom.qA.classList.remove("question__slot--hole");
      dom.qB.classList.remove("question__slot--hole");
    }
    renderInput();
    dom.feedback.textContent = "";
    dom.feedback.className = "feedback";
    dom.questionCard.classList.remove("swap-in");
    void dom.questionCard.offsetWidth;
    dom.questionCard.classList.add("swap-in");
  }

  function renderInput() {
    const v = session.input;
    if (!v) {
      dom.answerValue.innerHTML = "&nbsp;";
      dom.answer.classList.add("is-empty");
    } else {
      dom.answerValue.textContent = v;
      dom.answer.classList.remove("is-empty");
    }
    dom.answer.classList.remove("is-correct", "is-wrong");
  }

  function renderBossUI() {
    if (!dom.bossBar) return;
    if (!session?.isStory || !session.story.isBoss) {
      dom.bossBar.hidden = true;
      // Reset story tint when leaving a story session.
      document.documentElement.removeAttribute("data-story-accent");
      return;
    }
    const s = session.story;
    dom.bossBar.hidden = false;
    dom.bossAvatar.textContent = s.bossIcon || "◆";
    dom.bossName.textContent = s.bossName;
    const pct = (session.bossHP / Math.max(1, session.bossMaxHP)) * 100;
    dom.bossHpFill.style.width = pct + "%";
    dom.bossHpFill.classList.toggle("is-low", pct <= 30);
    // Lives display: hearts.
    const lives = Math.max(0, session.livesLeft);
    dom.bossLives.innerHTML = "";
    for (let i = 0; i < lives; i++) {
      const h = document.createElement("span");
      h.className = "boss-bar__heart";
      h.textContent = "♥";
      dom.bossLives.appendChild(h);
    }
  }

  function renderStoryHud() {
    // Non-boss story levels: show a small "X / target" badge + hearts in place of progress.
    if (!dom.storyHud) return;
    if (!session?.isStory || session.story.isBoss) {
      dom.storyHud.hidden = true;
      return;
    }
    const s = session.story;
    dom.storyHud.hidden = false;
    dom.storyHudCount.textContent = `${session.correct} / ${s.target}`;
    dom.storyHudLives.innerHTML = "";
    if (s.maxWrongs < 99) {
      for (let i = 0; i < Math.max(0, session.livesLeft); i++) {
        const h = document.createElement("span");
        h.className = "story-hud__heart";
        h.textContent = "♥";
        dom.storyHudLives.appendChild(h);
      }
    }
  }

  function renderProgress() {
    renderBossUI();
    renderStoryHud();
    if (session.isStory) {
      dom.progressWrap.hidden = true;
      if (session.cfg.timeLimit > 0) {
        dom.timerBadge.hidden = false;
        const low = session.timeLeftMs <= LOW_TIME_THRESHOLD_MS;
        dom.timerBadge.classList.toggle("is-low", low);
        dom.timerBadge.textContent = formatTime(session.timeLeftMs);
      } else {
        dom.timerBadge.hidden = true;
      }
      document.documentElement.setAttribute("data-story-accent", String(session.story.worldIdx));
      return;
    }
    document.documentElement.removeAttribute("data-story-accent");
    const gt = session.gameType;
    if (gt === "practice") {
      dom.progressWrap.hidden = false;
      dom.timerBadge.hidden = true;
      dom.progressFill.classList.remove("is-time", "is-low");
      const pct = (session.index / session.cfg.length) * 100;
      dom.progressFill.style.width = pct + "%";
    } else if (gt === "sprint") {
      dom.progressWrap.hidden = false;
      dom.timerBadge.hidden = false;
      dom.progressFill.classList.add("is-time");
      const pct = (session.timeLeftMs / session.cfg.timeLimit) * 100;
      dom.progressFill.style.width = pct + "%";
      const low = session.timeLeftMs <= LOW_TIME_THRESHOLD_MS;
      dom.progressFill.classList.toggle("is-low", low);
      dom.timerBadge.classList.toggle("is-low", low);
      dom.timerBadge.textContent = formatTime(session.timeLeftMs);
    } else {
      // survival, zen
      dom.progressWrap.hidden = true;
      dom.timerBadge.hidden = true;
    }
  }

  function renderStreak(animate = false) {
    dom.streakNum.textContent = String(session.streak);
    dom.streakBadge.classList.toggle("is-hot", session.streak >= 3);
    if (animate) {
      dom.streakBadge.classList.remove("pulse");
      void dom.streakBadge.offsetWidth;
      dom.streakBadge.classList.add("pulse");
    }
    renderCombo();
  }

  function renderCombo() {
    const tier = session.comboTier;
    if (tier === 0) {
      dom.comboBadge.hidden = true;
      return;
    }
    dom.comboBadge.hidden = false;
    dom.comboBadge.textContent = (tier === 2 ? "3×" : "2×");
    dom.comboBadge.classList.toggle("is-max", tier === 2);
  }

  /* ───────────────────────────  Sprint timer  ───────────────────────────── */

  function startTimer() {
    if (!session || session.cfg.timeLimit <= 0) return;
    const alreadyElapsed = session.cfg.timeLimit - session.timeLeftMs;
    session.timerStart = performance.now() - alreadyElapsed;
    const tick = (t) => {
      if (!session) return;
      const elapsed = t - session.timerStart;
      session.timeLeftMs = Math.max(0, session.cfg.timeLimit - elapsed);
      renderProgress();
      if (session.timeLeftMs <= 0) { finishSession(); return; }
      session.timerRAF = requestAnimationFrame(tick);
    };
    session.timerRAF = requestAnimationFrame(tick);
  }

  function stopTimer() {
    if (session?.timerRAF) {
      cancelAnimationFrame(session.timerRAF);
      session.timerRAF = 0;
    }
  }

  /* ──────────────────────────────  Flow  ────────────────────────────────── */

  function startSession(mode, opts = {}) {
    cancelPendingAdvance();
    stopTimer();
    const gameType = opts.gameType || store.gameType;
    session = freshSession(mode, gameType, {
      reverse: opts.reverse ?? store.reverseMode,
      isDaily: !!opts.isDaily,
      dailyQuestions: opts.dailyQuestions,
      story: opts.story || null,
    });
    session.startTime = Date.now();

    // Track which game types the user has tried (for achievements).
    if (!store.tried.gameTypes.includes(gameType)) {
      store.tried.gameTypes.push(gameType);
    }
    if (session.reverse) store.tried.reverse = true;
    if (session.isDaily) store.tried.daily = true;

    nextQuestion();
    renderStreak();
    renderProgress();
    renderBossUI();
    showView("game");
    if (session.cfg.timeLimit > 0) startTimer();
  }

  function nextQuestion() {
    session.input = "";
    session.locked = false;
    if (session.isDaily) {
      const q = session.dailyQuestions[session.dailyIdx++];
      session.question = decorateQuestion(q.a, q.b, session.reverse);
    } else {
      session.question = pickQuestion(session.mode, session.lastKey, { reverse: session.reverse });
      session.lastKey = `${session.question.a}x${session.question.b}`;
    }
    renderQuestion();
  }

  function submit() {
    if (!session || session.locked || !session.input) return;
    const guess = parseInt(session.input, 10);
    if (Number.isNaN(guess)) return;
    const q = session.question;
    const correct = guess === q.target;
    session.locked = true;
    recordResult(q.a, q.b, correct);

    if (correct) {
      session.correct += 1;
      session.streak += 1;
      session.bestStreak = Math.max(session.bestStreak, session.streak);
      // Combo tier: 5+ → 2×, 10+ → 3×. Resets on wrong (handled below).
      session.comboTier = session.streak >= COMBO_TIER_2 ? 2
                        : session.streak >= COMBO_TIER_1 ? 1
                        : 0;
      const multiplier = session.comboTier === 2 ? 3 : session.comboTier === 1 ? 2 : 1;
      const baseGain = (XP_PER_CORRECT + Math.min(session.streak, 10) * XP_STREAK_BONUS) * multiplier;
      const gained = Math.round(baseGain * prestigeMultiplier());
      session.xp += gained;
      // Boss damage — base 10, combo crits ramp up.
      if (session.isStory && session.story.isBoss) {
        const dmg = session.comboTier === 2 ? 25 : session.comboTier === 1 ? 16 : 10;
        session.bossHP = Math.max(0, session.bossHP - dmg);
        renderBossUI();
      }
      dom.answer.classList.add("is-correct");
      dom.feedback.textContent = pick(FEEDBACK_CORRECT);
      dom.feedback.classList.add("is-correct");
      dom.questionCard.classList.add("flash-correct");
      renderStreak(true);
      triggerCorrectParticles();
      haptic(8);
    } else {
      session.wrong += 1;
      session.streak = 0;
      session.comboTier = 0;
      if (session.livesLeft !== Infinity) session.livesLeft -= 1;
      session.mistakes.push({
        a: q.a, b: q.b, product: q.product,
        guess, reverse: session.reverse, pos: q.pos, target: q.target,
      });
      if (session.isStory) renderBossUI();
      dom.answer.classList.add("is-wrong");
      dom.feedback.textContent = FEEDBACK_WRONG(q.a, q.b);
      dom.feedback.classList.add("is-wrong");
      dom.questionCard.classList.add("flash-wrong");
      renderStreak();
      haptic([12, 40, 12]);
    }
    setTimeout(cleanupFlash, 700);
    const delay = correct ? 700 : 1500;
    schedule(() => advance(correct), delay);
  }

  function cleanupFlash() {
    if (!session) return;
    dom.questionCard.classList.remove("flash-correct", "flash-wrong");
  }

  function advance(lastWasCorrect) {
    if (!session) return;
    session.index += 1;
    renderProgress();
    let done = false;
    if (session.isStory) {
      const s = session.story;
      if (s.isBoss) {
        done = session.bossHP <= 0 || session.livesLeft <= 0;
      } else {
        done = session.correct >= s.target || session.livesLeft <= 0;
      }
    } else {
      done =
        (session.gameType === "survival" && !lastWasCorrect) ||
        (session.gameType === "practice" && session.index >= session.cfg.length) ||
        (session.isDaily && session.dailyIdx >= session.dailyQuestions.length);
    }
    if (done) finishSession();
    else nextQuestion();
  }

  function schedule(fn, delay) {
    cancelPendingAdvance();
    session.pendingAdvance = setTimeout(fn, delay);
  }
  function cancelPendingAdvance() {
    if (session?.pendingAdvance) {
      clearTimeout(session.pendingAdvance);
      session.pendingAdvance = 0;
    }
  }

  function finishSession() {
    if (!session) return;
    cancelPendingAdvance();
    stopTimer();
    session.endTime = Date.now();
    session.elapsedMs = session.endTime - session.startTime;

    const cfg = session.cfg;
    const completedFully =
      (session.gameType === "practice" && session.index >= cfg.length) ||
      (session.isDaily && session.dailyIdx >= (session.dailyQuestions?.length || 0));

    // Story result first, so XP rewards can be tallied below.
    let storyResult = null;
    if (session.isStory) {
      storyResult = finalizeStory(session);
      if (storyResult.stars > 0) session.xp += session.story.xpReward;
    }

    // Persistent counters.
    store.totalXP += session.xp;
    store.totalSessions += 1;
    store.totalCorrect += session.correct;
    store.bestStreak = Math.max(store.bestStreak, session.bestStreak);

    if (session.correct > 0) updateDailyStreak();
    if (session.isDaily && completedFully) {
      store.daily.lastCompletedDate = todayKey();
    }

    // Beat per-record bests (regular sessions only — not daily / story).
    let beat = false;
    if (!session.isDaily && !session.isStory && cfg.recordKey) {
      if (cfg.recordKey === "timeMs") {
        if (completedFully) beat = tryBeatRecord(session.gameType, session.mode, session.elapsedMs);
      } else if (cfg.recordKey === "streak") {
        beat = tryBeatRecord(session.gameType, session.mode, session.bestStreak);
      } else if (cfg.recordKey === "count") {
        beat = tryBeatRecord(session.gameType, session.mode, session.correct);
      }
    }

    // Achievements.
    const ctx = {
      gameType: session.gameType,
      reverse: session.reverse,
      isDaily: session.isDaily,
      correct: session.correct,
      bestStreak: session.bestStreak,
      completed: completedFully,
    };
    const unlocked = unlockAchievements(ctx);

    // Level-up detection.
    const newLevel = levelFromXP(store.totalXP);
    const levelsGained = newLevel - (store.player.lastSeenLevel || 1);
    if (levelsGained > 0) store.player.lastSeenLevel = newLevel;

    saveStore();
    renderSummary(beat, storyResult);
    showView("summary");
    unlocked.forEach(queueToast);
    if (levelsGained > 0) {
      queueToast({
        emoji: "▲",
        name: `Level ${newLevel}`,
        desc: levelsGained === 1 ? "New level reached." : `+${levelsGained} levels.`,
      });
    }
    if (storyResult?.justUnlockedWorld) {
      queueToast({
        emoji: "★",
        name: `Unlocked · ${storyResult.justUnlockedWorld.name}`,
        desc: storyResult.justUnlockedWorld.desc,
      });
    }
  }

  /* ─────────────────────────  Daily challenge  ──────────────────────────── */

  function buildDailyQuestions(dateKey) {
    const rng = seededRng("mathgod-daily-" + dateKey);
    // Mix from all three difficulties for variety.
    const pool = [...poolFor("1x1"), ...poolFor("1x2"), ...poolFor("2x2")];
    const picks = [];
    const seen = new Set();
    let safety = 200;
    while (picks.length < 10 && safety-- > 0) {
      const [a, b] = pool[Math.floor(rng() * pool.length)];
      const key = `${a}x${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push({ a, b });
    }
    return picks;
  }

  function startDailyChallenge() {
    if (store.daily.lastCompletedDate === todayKey()) return;
    const qs = buildDailyQuestions(todayKey());
    // Use "practice" rules (10 questions, then summary). Difficulty is mixed.
    startSession(null, {
      gameType: "practice",
      isDaily: true,
      dailyQuestions: qs,
      reverse: store.reverseMode,
    });
  }

  function updateDailyStreak() {
    const today = todayKey();
    const last  = store.daily.lastPlayedDate;
    if (last === today) return;
    if (last === yesterdayKey()) store.daily.streak += 1;
    else                          store.daily.streak  = 1;
    store.daily.lastPlayedDate = today;
    store.daily.bestStreak = Math.max(store.daily.bestStreak, store.daily.streak);
  }

  /* ───────────────────────────  Achievements  ───────────────────────────── */

  function unlockAchievements(ctx) {
    const newly = [];
    for (const a of ACHIEVEMENTS) {
      if (store.achievements[a.id]) continue;
      if (a.check(store, ctx)) {
        store.achievements[a.id] = { at: Date.now() };
        newly.push(a);
      }
    }
    return newly;
  }

  let toastBusy = false;
  const toastQueue = [];
  function queueToast(a) {
    toastQueue.push(a);
    drainToasts();
  }
  function drainToasts() {
    if (toastBusy || toastQueue.length === 0 || !dom.toasts) return;
    toastBusy = true;
    const a = toastQueue.shift();
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `
      <span class="toast__emoji">${a.emoji}</span>
      <span class="toast__body">
        <span class="toast__title">Unlocked · ${a.name}</span>
        <span class="toast__desc">${a.desc}</span>
      </span>
    `;
    dom.toasts.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-in"));
    setTimeout(() => {
      el.classList.remove("is-in");
      setTimeout(() => {
        el.remove();
        toastBusy = false;
        drainToasts();
      }, 360);
    }, 3200);
  }

  /* ──────────────────────────────  Summary  ─────────────────────────────── */

  function renderSummary(beat, storyResult) {
    const total = session.correct + session.wrong;
    const gt = session.gameType;

    if (session.isStory) {
      const s = session.story;
      if (s.isBoss) {
        const defeated = session.bossHP <= 0;
        dom.sumCorrect.textContent = defeated ? "WIN" : "—";
      } else {
        dom.sumCorrect.textContent = `${session.correct}/${s.target}`;
      }
    } else if (session.isDaily) {
      dom.sumCorrect.textContent = `${session.correct}/10`;
    } else if (gt === "practice") {
      dom.sumCorrect.textContent = `${session.correct}/${session.cfg.length}`;
    } else if (gt === "survival") {
      dom.sumCorrect.textContent = String(session.correct);
    } else if (gt === "sprint") {
      dom.sumCorrect.textContent = total ? `${session.correct}/${total}` : "0";
    } else {
      // zen
      dom.sumCorrect.textContent = String(session.correct);
    }
    dom.sumTime.textContent   = formatTime(session.elapsedMs);
    dom.sumStreak.textContent = String(session.bestStreak);
    dom.sumXP.textContent     = `+${session.xp}`;

    const r = total ? session.correct / total : 0;
    let title, sub, emoji;
    if (session.isStory) {
      const s = session.story;
      const stars = storyResult?.stars || 0;
      const won = stars > 0;
      emoji = won ? (stars === 3 ? "★" : stars === 2 ? "✦" : "◆") : "○";
      if (s.isBoss) {
        title = won ? `${s.bossName} defeated.` : "Defeated.";
        sub   = won ? "★".repeat(stars) + "☆".repeat(3 - stars) + " · World cleared." : "Regroup and try again.";
      } else {
        title = won ? `${s.levelName} cleared.` : `${s.levelName}`;
        sub   = won ? "★".repeat(stars) + "☆".repeat(3 - stars) : "Not enough correct answers.";
      }
    } else if (session.isDaily) {
      if (r === 1)        { title = "Daily complete.";   sub = `Perfect run · ${formatTime(session.elapsedMs)}.`; emoji = "★"; }
      else if (r >= 0.7)  { title = "Daily complete.";   sub = `${session.correct} of 10 today.`;                  emoji = "✦"; }
      else                { title = "Daily logged.";     sub = "Daily streak counted — back tomorrow.";           emoji = "◆"; }
    } else if (gt === "zen") {
      const n = session.correct;
      if (n < 10)         { title = "Mind warming up.";  sub = `${n} answered. Come back any time.`;             emoji = "○"; }
      else if (n < 30)    { title = "Deep practice.";    sub = `${n} answered in a calm flow.`;                  emoji = "◆"; }
      else                { title = "Zen achieved.";     sub = `${n} answered — superb focus.`;                  emoji = "★"; }
    } else if (gt === "survival") {
      const n = session.correct;
      if (n === 0)        { title = "Tough start.";      sub = "Try again — you'll find your rhythm.";           emoji = "○"; }
      else if (n < 5)     { title = "Keep going.";       sub = "Each run trains your recall.";                   emoji = "○"; }
      else if (n < 12)    { title = "Solid run.";        sub = `You answered ${n} in a row.`;                    emoji = "◆"; }
      else if (n < 25)    { title = "Strong run.";       sub = `${n} correct without a slip.`;                   emoji = "✦"; }
      else                { title = "Incredible.";       sub = `${n} in a row — superb focus.`;                  emoji = "★"; }
    } else if (gt === "sprint") {
      const n = session.correct;
      if (n === 0)        { title = "Warm-up done.";    sub = "Try a steadier pace next time.";                  emoji = "○"; }
      else if (n < 8)     { title = "Good start.";       sub = `${n} solved in 60 s.`;                            emoji = "○"; }
      else if (n < 15)    { title = "Quick thinking.";   sub = `${n} solved — keep that tempo.`;                  emoji = "◆"; }
      else if (n < 25)    { title = "Fast and sharp.";   sub = `${n} solved in 60 s.`;                            emoji = "✦"; }
      else                { title = "Lightning.";        sub = `${n} solved — exceptional speed.`;                emoji = "★"; }
    } else {
      // practice
      if (r === 1)        { title = "Flawless.";         sub = `All ${session.cfg.length} correct in ${formatTime(session.elapsedMs)}.`; emoji = "★"; }
      else if (r >= 0.8)  { title = "Strong session.";   sub = "You're locking these in.";                                                emoji = "✦"; }
      else if (r >= 0.5)  { title = "Steady progress.";  sub = "Tricky pairs will return more often.";                                     emoji = "◆"; }
      else                { title = "Keep going.";       sub = "Short, regular sessions add up.";                                          emoji = "○"; }
    }
    dom.summaryTitle.textContent    = title;
    dom.summarySubtitle.textContent = sub;
    dom.summaryEmoji.textContent    = emoji;

    if (beat) {
      dom.summaryBest.hidden = false;
      dom.summaryBest.textContent = "★ New personal best";
    } else {
      dom.summaryBest.hidden = true;
      dom.summaryBest.textContent = "";
    }

    renderMistakeReview();
  }

  function renderMistakeReview() {
    if (!dom.mistakeReview || !dom.mistakeList) return;
    const ms = session.mistakes;
    if (!ms.length) {
      dom.mistakeReview.hidden = true;
      dom.mistakeList.innerHTML = "";
      return;
    }
    dom.mistakeReview.hidden = false;
    dom.mistakeSummary.textContent = `Review mistakes (${ms.length})`;
    dom.mistakeList.innerHTML = "";
    for (const m of ms) {
      const li = document.createElement("li");
      li.className = "mistake";
      if (m.reverse) {
        const aTxt = m.pos === "a" ? `<b>${m.target}</b>` : String(m.a);
        const bTxt = m.pos === "b" ? `<b>${m.target}</b>` : String(m.b);
        li.innerHTML = `
          <span class="mistake__expr">${aTxt} × ${bTxt} = ${m.product}</span>
          <span class="mistake__you">you: ${m.guess}</span>
        `;
      } else {
        li.innerHTML = `
          <span class="mistake__expr">${m.a} × ${m.b} = <b>${m.product}</b></span>
          <span class="mistake__you">you: ${m.guess}</span>
        `;
      }
      dom.mistakeList.appendChild(li);
    }
  }

  function goHome() {
    cancelPendingAdvance();
    stopTimer();
    session = null;
    document.documentElement.removeAttribute("data-story-accent");
    renderHomeStats();
    renderGameType();
    renderReverseToggle();
    showView("home");
  }

  /* ─────────────────────────────  Input  ────────────────────────────────── */

  function handleKey(key) {
    if (!session || session.locked) return;
    if (key === "back") {
      if (!session.input) return;
      session.input = session.input.slice(0, -1);
      renderInput();
      return;
    }
    if (key === "enter") { submit(); return; }
    if (/^[0-9]$/.test(key)) {
      // In reverse mode the answer is a factor ≤ 20 → 2 digits suffice.
      const maxLen = session.reverse ? 2 : 3;
      if (session.input.length >= maxLen) return;
      if (session.input === "" && key === "0") return;
      session.input += key;
      renderInput();
    }
  }

  function bindKeypad() {
    dom.keypad.addEventListener("click", (e) => {
      const btn = e.target.closest(".key");
      if (!btn) return;
      handleKey(btn.dataset.key);
    });
    window.addEventListener("keydown", (e) => {
      if (!views.game || views.game.hasAttribute("hidden")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key))      { handleKey(e.key);    flashKey(e.key);    e.preventDefault(); }
      else if (e.key === "Backspace") { handleKey("back");   flashKey("back");   e.preventDefault(); }
      else if (e.key === "Enter")     { handleKey("enter");  flashKey("enter");  e.preventDefault(); }
    });
  }
  function flashKey(key) {
    const btn = dom.keypad.querySelector(`.key[data-key="${key}"]`);
    if (!btn) return;
    btn.classList.add("is-press");
    setTimeout(() => btn.classList.remove("is-press"), 120);
  }
  function haptic(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch { /* ignore */ } }
  }
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  /* ─────────────────────────────  Theme  ────────────────────────────────── */

  function applyTheme() {
    const root = document.documentElement;
    if (store.theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", store.theme);
    const isDark =
      store.theme === "dark" ||
      (store.theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const color = isDark ? "#0e0e11" : "#f6f5f1";
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      if (!m.hasAttribute("media")) m.setAttribute("content", color);
    });
  }
  function cycleTheme() {
    store.theme = store.theme === "auto"  ? "light"
                : store.theme === "light" ? "dark"
                : "auto";
    saveStore();
    applyTheme();
  }

  /* ────────────────────────────  Bootstrap  ─────────────────────────────── */

  function bindHome() {
    $$(".mode-card").forEach((card) => {
      card.addEventListener("click", () => startSession(card.dataset.mode));
    });
    dom.seg.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg__btn");
      if (!btn) return;
      const gt = btn.dataset.gametype;
      if (!gt || gt === store.gameType) return;
      store.gameType = gt;
      saveStore();
      renderGameType();
      renderHomeStats();
    });
    dom.reverseToggle?.addEventListener("click", () => {
      store.reverseMode = !store.reverseMode;
      saveStore();
      renderReverseToggle();
    });
    dom.dailyCard?.addEventListener("click", () => {
      if (store.daily.lastCompletedDate === todayKey()) return;
      startDailyChallenge();
    });
    dom.achBtn?.addEventListener("click", () => {
      renderAchievementsList();
      showView("achievements");
    });
    dom.achBack?.addEventListener("click", () => showView("home"));

    dom.shopBtn?.addEventListener("click", openShop);
    dom.shopBackBtn?.addEventListener("click", closeShop);
    dom.shopTabs?.addEventListener("click", (e) => {
      const btn = e.target.closest(".shop-tab");
      if (!btn) return;
      shopCategory = btn.dataset.cat;
      renderShop();
    });
    dom.shopGrid?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const item = ITEM_BY_ID[btn.dataset.id];
      if (!item) return;
      if (btn.dataset.action === "buy")   buyItem(item);
      else if (btn.dataset.action === "equip") equipItem(item);
    });
    dom.prestigeBtn?.addEventListener("click", performPrestige);

    // Story navigation.
    dom.storyCard?.addEventListener("click", () => {
      const next = nextStoryTarget();
      openStory(next ? next.worldIdx : 0);
    });
    dom.storyBackBtn?.addEventListener("click", () => goHome());
    dom.storyWorldTabs?.addEventListener("click", (e) => {
      const btn = e.target.closest(".story-world-tab");
      if (!btn || btn.classList.contains("is-locked")) return;
      store.story.currentWorld = parseInt(btn.dataset.world, 10);
      saveStore();
      renderStoryView();
    });
    dom.storyMap?.addEventListener("click", (e) => {
      const node = e.target.closest(".story-node");
      if (!node || node.classList.contains("is-locked")) return;
      openLevelSheet(parseInt(node.dataset.world, 10), parseInt(node.dataset.level, 10));
    });
    dom.levelSheet?.addEventListener("click", (e) => {
      if (e.target.matches("[data-sheet-close]")) closeSheet(dom.levelSheet);
    });
    dom.levelSheetStart?.addEventListener("click", () => {
      if (!pendingLevel) return;
      const { worldIdx, levelIdx } = pendingLevel;
      pendingLevel = null;
      closeSheet(dom.levelSheet);
      startStoryLevel(worldIdx, levelIdx);
    });

    dom.prefsBtn?.addEventListener("click", openPrefsSheet);
    dom.prefsSheet?.addEventListener("click", (e) => {
      if (e.target.matches("[data-sheet-close]")) closePrefsSheet();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && dom.prefsSheet?.getAttribute("aria-hidden") === "false") {
        closePrefsSheet();
      }
    });
  }

  function bindGlobal() {
    dom.themeToggle?.addEventListener("click", cycleTheme);
    dom.quitBtn?.addEventListener("click", () => {
      // Treat the back button as "end this session" so the user keeps the XP
      // and answers they earned. Daily and Practice still won't count as
      // "completed" unless they reached the full question count.
      if (session && !session.endTime) finishSession();
      else goHome();
    });
    dom.againBtn?.addEventListener("click", () => {
      if (!session) return goHome();
      if (session.isStory) {
        const s = session.story;
        const p = ensureWorldProgress(s.worldIdx);
        const passed = s.isBoss ? p.bossDefeated : !!p.levels[s.levelIdx]?.completed;
        // Passed → advance to the next level (or boss); failed → retry the same one.
        if (passed) {
          if (s.isBoss) {
            const nextWorld = s.worldIdx + 1;
            if (nextWorld < WORLDS.length && ensureWorldProgress(nextWorld).unlocked) {
              store.story.currentWorld = nextWorld;
              saveStore();
              openStory(nextWorld);
            } else {
              goHome();
            }
          } else if (s.levelIdx + 1 < WORLDS[s.worldIdx].levels.length) {
            startStoryLevel(s.worldIdx, s.levelIdx + 1);
          } else {
            // All normal levels done — point at the boss.
            startStoryLevel(s.worldIdx, -1);
          }
        } else {
          startStoryLevel(s.worldIdx, s.levelIdx);
        }
      } else if (session.isDaily) {
        goHome();
      } else {
        const last = session.mode || "1x1";
        startSession(last, { gameType: session.gameType, reverse: session.reverse });
      }
    });
    dom.homeBtn?.addEventListener("click", () => {
      // Returning home from a story summary jumps back to the world map.
      if (session?.isStory) {
        const w = session.story.worldIdx;
        session = null;
        document.documentElement.removeAttribute("data-story-accent");
        openStory(w);
      } else {
        goHome();
      }
    });
    dom.onboardStart?.addEventListener("click", () => {
      store.onboarded = true;
      saveStore();
      goHome();
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (store.theme === "auto") applyTheme();
    });
    document.addEventListener("visibilitychange", () => {
      if (!session || session.cfg.timeLimit <= 0) return;
      if (session.endTime) return;
      if (document.hidden) stopTimer();
      else if (session.timeLeftMs > 0) startTimer();
    });
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (!/^https?:/.test(location.protocol)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    });
  }

  function init() {
    applyTheme();
    applyEquipment();
    renderGameType();
    renderReverseToggle();
    renderHomeStats();
    bindHome();
    bindGlobal();
    bindKeypad();
    showView(store.onboarded ? "home" : "onboard");
    registerSW();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
