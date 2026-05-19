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
  });

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw);
      const d = defaults();
      // Shallow merge plus careful sub-object merges.
      return {
        ...d,
        ...parsed,
        mastery: parsed.mastery || {},
        records: parsed.records || {},
        achievements: parsed.achievements || {},
        daily: { ...d.daily, ...(parsed.daily || {}) },
        tried: { ...d.tried, ...(parsed.tried || {}) },
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
    const cfg = GAME_TYPES[gameType];
    return {
      mode,                          // null when isDaily (mixed pool)
      gameType,
      cfg,
      reverse: !!opts.reverse,
      isDaily: !!opts.isDaily,
      dailyQuestions: opts.dailyQuestions || null,
      dailyIdx: 0,
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
    statsStreak:   $('[data-stat="streak"]'),
    statsStreakLbl: $('[data-stat-label="streak"]'),
  };

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
  }

  function renderGameType() {
    $$(".seg__btn", dom.seg).forEach((btn) => {
      const active = btn.dataset.gametype === store.gameType;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    dom.segHint.textContent = GAME_TYPES[store.gameType].hint;
  }

  function renderReverseToggle() {
    dom.reverseToggle.classList.toggle("is-on", store.reverseMode);
    dom.reverseToggle.setAttribute("aria-pressed", store.reverseMode ? "true" : "false");
  }

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

  function renderProgress() {
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
      const gained = (XP_PER_CORRECT + Math.min(session.streak, 10) * XP_STREAK_BONUS) * multiplier;
      session.xp += gained;
      dom.answer.classList.add("is-correct");
      dom.feedback.textContent = pick(FEEDBACK_CORRECT);
      dom.feedback.classList.add("is-correct");
      dom.questionCard.classList.add("flash-correct");
      renderStreak(true);
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
    const done =
      (session.gameType === "survival" && !lastWasCorrect) ||
      (session.gameType === "practice" && session.index >= session.cfg.length) ||
      (session.isDaily && session.dailyIdx >= session.dailyQuestions.length);
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

    // Persistent counters.
    store.totalXP += session.xp;
    store.totalSessions += 1;
    store.totalCorrect += session.correct;
    store.bestStreak = Math.max(store.bestStreak, session.bestStreak);

    // Daily streak: only update for sessions that genuinely "happened".
    if (session.correct > 0) {
      updateDailyStreak();
    }
    // Daily-challenge completion: mark today as done.
    if (session.isDaily && completedFully) {
      store.daily.lastCompletedDate = todayKey();
    }

    // Beat per-record bests (non-daily, non-zen).
    let beat = false;
    if (!session.isDaily && cfg.recordKey) {
      if (cfg.recordKey === "timeMs") {
        if (completedFully) beat = tryBeatRecord(session.gameType, session.mode, session.elapsedMs);
      } else if (cfg.recordKey === "streak") {
        beat = tryBeatRecord(session.gameType, session.mode, session.bestStreak);
      } else if (cfg.recordKey === "count") {
        beat = tryBeatRecord(session.gameType, session.mode, session.correct);
      }
    }

    // Achievements — evaluate after counters update.
    const ctx = {
      gameType: session.gameType,
      reverse: session.reverse,
      isDaily: session.isDaily,
      correct: session.correct,
      bestStreak: session.bestStreak,
      completed: completedFully,
    };
    const unlocked = unlockAchievements(ctx);

    saveStore();
    renderSummary(beat);
    showView("summary");
    unlocked.forEach(queueToast);
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

  function renderSummary(beat) {
    const total = session.correct + session.wrong;
    const gt = session.gameType;

    if (session.isDaily) {
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
    if (session.isDaily) {
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
      // Repeat the same kind of session (including reverse/daily).
      if (session.isDaily) {
        // After completing the daily, "Again" goes home (it's once per day).
        goHome();
      } else {
        const last = session.mode || "1x1";
        startSession(last, { gameType: session.gameType, reverse: session.reverse });
      }
    });
    dom.homeBtn?.addEventListener("click", goHome);
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
