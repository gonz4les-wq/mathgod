/* =========================================================================
   Mathgod — app logic
   - 3 difficulties (1×1, 1×2, 2×2 up to 20)
   - 3 game types: Practice (10 questions), Survival (until wrong), Sprint (60s)
   - Weighted question selection driven by per-pair mastery
   - Per (difficulty × game type) best-record tracking
   - LocalStorage persistence
   - PWA: registers the service worker
   ========================================================================= */

(() => {
  "use strict";

  /* ────────────────────────────  Constants  ─────────────────────────────── */

  const STORAGE_KEY     = "mathgod:v1";
  const XP_PER_CORRECT  = 10;
  const XP_STREAK_BONUS = 2;
  const SPRINT_DURATION_MS = 60_000;
  const LOW_TIME_THRESHOLD_MS = 10_000;

  const MODES = {
    "1x1": { aRange: [2, 9],   bRange: [2, 9]   },
    "1x2": { aRange: [2, 9],   bRange: [10, 20] },
    "2x2": { aRange: [10, 20], bRange: [10, 20] },
  };

  /**
   * Game types govern when a session ends and what record to track.
   *   - length    : question count limit (Infinity = no limit)
   *   - lives     : wrong-answer budget before game over
   *   - timeLimit : ms timer for the whole session (0 = none)
   *   - recordKey : which field is tracked per (gameType × mode) for best
   *   - cmp       : "min" (smaller is better, e.g. time) or "max" (larger)
   */
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
  };

  const FEEDBACK_CORRECT = ["Nice.", "Got it.", "Clean.", "Sharp.", "Smooth."];
  const FEEDBACK_WRONG   = (a, b) => `${a} × ${b} = ${a * b}`;

  /* ─────────────────────────────  Storage  ──────────────────────────────── */

  const defaults = () => ({
    onboarded: false,
    theme: "auto",
    gameType: "practice",
    totalXP: 0,
    totalSessions: 0,
    bestStreak: 0,
    mastery: {},  // "AxB" -> { seen, correct, lastSeen }
    records: {},  // "gameType:mode" -> { timeMs|streak|count }
  });

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw);
      return {
        ...defaults(),
        ...parsed,
        mastery: parsed.mastery || {},
        records: parsed.records || {},
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

  /* ─────────────────────────  Runtime session state  ────────────────────── */

  let session = null;

  function freshSession(mode, gameType) {
    const cfg = GAME_TYPES[gameType];
    return {
      mode,
      gameType,
      cfg,
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

  function pickQuestion(mode, avoidKey) {
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
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        const [a, b] = pool[i];
        return { a, b, answer: a * b };
      }
    }
    const [a, b] = pool[pool.length - 1];
    return { a, b, answer: a * b };
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
    let totalSeen = 0;
    let weighted = 0;
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

  /** Returns true if `value` beat the previous best. */
  function tryBeatRecord(gameType, mode, value) {
    if (value == null || Number.isNaN(value)) return false;
    const cfg = GAME_TYPES[gameType];
    const slot = recordSlot(gameType, mode);
    const prev = slot[cfg.recordKey];
    const better = prev == null
      ? true
      : (cfg.cmp === "min" ? value < prev : value > prev);
    if (better) slot[cfg.recordKey] = value;
    return better;
  }

  function formatRecord(gameType, mode) {
    const slot = recordSlot(gameType, mode);
    const cfg  = GAME_TYPES[gameType];
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
    home:    $('[data-view="home"]'),
    game:    $('[data-view="game"]'),
    summary: $('[data-view="summary"]'),
    onboard: $('[data-view="onboard"]'),
  };

  const dom = {
    qA:           $("#qA"),
    qB:           $("#qB"),
    answer:       $(".answer"),
    answerValue:  $("#answerValue"),
    feedback:     $("#feedback"),
    questionCard: $("#questionCard"),
    progressWrap: $("#progressWrap"),
    progressFill: $("#progressFill"),
    timerBadge:   $("#timerBadge"),
    streakBadge:  $("#streakBadge"),
    streakNum:    $("#streakBadge [data-streak]"),
    keypad:       $("#keypad"),
    themeToggle:  $("#themeToggle"),
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
    seg:          $("#gameTypeSeg"),
    segHint:      $("#gameTypeHint"),
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
    $('[data-stat="xp"]').textContent = formatCount(store.totalXP);
    $('[data-stat="streak"]').textContent = String(store.bestStreak);
    $('[data-stat="sessions"]').textContent = String(store.totalSessions);
    for (const mode of Object.keys(MODES)) {
      const pct = Math.round(modeMastery(mode) * 100);
      const fillEl = document.querySelector(`[data-fill="${mode}"]`);
      if (fillEl) fillEl.style.width = pct + "%";
      const bestEl = document.querySelector(`[data-best="${mode}"]`);
      if (bestEl) bestEl.textContent = formatRecord(store.gameType, mode);
    }
  }

  function renderGameType() {
    $$(".seg__btn", dom.seg).forEach((btn) => {
      const active = btn.dataset.gametype === store.gameType;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    dom.segHint.textContent = GAME_TYPES[store.gameType].hint;
  }

  function renderQuestion() {
    if (!session?.question) return;
    dom.qA.textContent = String(session.question.a);
    dom.qB.textContent = String(session.question.b);
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

  /** Update the topbar progress / timer based on the current game type. */
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
    } else { // survival
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
  }

  /* ───────────────────────────  Sprint timer  ───────────────────────────── */

  function startTimer() {
    if (!session || session.cfg.timeLimit <= 0) return;
    // Anchor "start" to whatever time has already elapsed so this also handles
    // resuming a paused sprint after the tab regains visibility.
    const alreadyElapsed = session.cfg.timeLimit - session.timeLeftMs;
    session.timerStart = performance.now() - alreadyElapsed;
    const tick = (t) => {
      if (!session) return;
      const elapsed = t - session.timerStart;
      session.timeLeftMs = Math.max(0, session.cfg.timeLimit - elapsed);
      renderProgress();
      if (session.timeLeftMs <= 0) {
        finishSession();
        return;
      }
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

  function startSession(mode) {
    cancelPendingAdvance();
    stopTimer();
    session = freshSession(mode, store.gameType);
    session.startTime = Date.now();
    nextQuestion();
    renderStreak();
    renderProgress();
    showView("game");
    if (session.cfg.timeLimit > 0) startTimer();
  }

  function nextQuestion() {
    session.input = "";
    session.locked = false;
    session.question = pickQuestion(session.mode, session.lastKey);
    session.lastKey = `${session.question.a}x${session.question.b}`;
    renderQuestion();
  }

  function submit() {
    if (!session || session.locked || !session.input) return;
    const guess = parseInt(session.input, 10);
    if (Number.isNaN(guess)) return;
    const { a, b, answer } = session.question;
    const correct = guess === answer;

    session.locked = true;
    recordResult(a, b, correct);

    if (correct) {
      session.correct += 1;
      session.streak += 1;
      session.bestStreak = Math.max(session.bestStreak, session.streak);
      const gained = XP_PER_CORRECT + Math.min(session.streak, 10) * XP_STREAK_BONUS;
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
      if (session.livesLeft !== Infinity) session.livesLeft -= 1;
      dom.answer.classList.add("is-wrong");
      dom.feedback.textContent = FEEDBACK_WRONG(a, b);
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

  /**
   * Commit the just-answered question to progress and decide what comes next.
   * Practice ends when the question count is reached. Survival ends on the
   * first wrong answer. Sprint only ends from the timer tick.
   */
  function advance(lastWasCorrect) {
    if (!session) return;
    session.index += 1;
    renderProgress();
    const done =
      (session.gameType === "survival" && !lastWasCorrect) ||
      (session.gameType === "practice" && session.index >= session.cfg.length);
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

    // Update per-session global stats.
    store.totalXP += session.xp;
    store.totalSessions += 1;
    store.bestStreak = Math.max(store.bestStreak, session.bestStreak);

    // Try to beat the relevant record for this (gameType × difficulty).
    const cfg = session.cfg;
    let beat = false;
    if (cfg.recordKey === "timeMs") {
      // Only count time-based records for completed practice sessions.
      const completed = session.gameType === "practice" && session.index + 1 >= cfg.length;
      if (completed) beat = tryBeatRecord(session.gameType, session.mode, session.elapsedMs);
    } else if (cfg.recordKey === "streak") {
      beat = tryBeatRecord(session.gameType, session.mode, session.bestStreak);
    } else if (cfg.recordKey === "count") {
      beat = tryBeatRecord(session.gameType, session.mode, session.correct);
    }
    saveStore();

    renderSummary(beat);
    showView("summary");
  }

  function renderSummary(beat) {
    const total = session.correct + session.wrong;
    const gt = session.gameType;

    // "Correct" stat depends on the game type so the number is meaningful.
    if (gt === "practice") {
      dom.sumCorrect.textContent = `${session.correct}/${session.cfg.length}`;
    } else if (gt === "survival") {
      dom.sumCorrect.textContent = String(session.correct);
    } else { // sprint
      dom.sumCorrect.textContent = total
        ? `${session.correct}/${total}`
        : "0";
    }
    dom.sumTime.textContent   = formatTime(session.elapsedMs);
    dom.sumStreak.textContent = String(session.bestStreak);
    dom.sumXP.textContent     = `+${session.xp}`;

    // Title / subtitle tailored to mode and performance.
    const r = total ? session.correct / total : 0;
    let title, sub, emoji;
    if (gt === "survival") {
      const n = session.correct;
      if (n === 0)      { title = "Tough start.";   sub = "Try again — you'll find your rhythm."; emoji = "○"; }
      else if (n < 5)   { title = "Keep going.";    sub = "Each run trains your recall.";          emoji = "○"; }
      else if (n < 12)  { title = "Solid run.";     sub = `You answered ${n} in a row.`;           emoji = "◆"; }
      else if (n < 25)  { title = "Strong run.";    sub = `${n} correct without a slip.`;          emoji = "✦"; }
      else              { title = "Incredible.";    sub = `${n} in a row — superb focus.`;         emoji = "★"; }
    } else if (gt === "sprint") {
      const n = session.correct;
      if (n === 0)      { title = "Warm-up done."; sub = "Try a steadier pace next time.";        emoji = "○"; }
      else if (n < 8)   { title = "Good start.";   sub = `${n} solved in 60 s.`;                  emoji = "○"; }
      else if (n < 15)  { title = "Quick thinking.";sub = `${n} solved — keep that tempo.`;        emoji = "◆"; }
      else if (n < 25)  { title = "Fast and sharp.";sub = `${n} solved in 60 s.`;                  emoji = "✦"; }
      else              { title = "Lightning.";    sub = `${n} solved — exceptional speed.`;      emoji = "★"; }
    } else { // practice
      if (r === 1)       { title = "Flawless.";        sub = `All ${session.cfg.length} correct in ${formatTime(session.elapsedMs)}.`; emoji = "★"; }
      else if (r >= 0.8) { title = "Strong session.";  sub = "You're locking these in.";                                                emoji = "✦"; }
      else if (r >= 0.5) { title = "Steady progress."; sub = "Tricky pairs will return more often.";                                     emoji = "◆"; }
      else               { title = "Keep going.";      sub = "Short, regular sessions add up.";                                          emoji = "○"; }
    }
    dom.summaryTitle.textContent = title;
    dom.summarySubtitle.textContent = sub;
    dom.summaryEmoji.textContent = emoji;

    if (beat) {
      dom.summaryBest.hidden = false;
      dom.summaryBest.textContent = "★ New personal best";
    } else {
      dom.summaryBest.hidden = true;
      dom.summaryBest.textContent = "";
    }
  }

  function goHome() {
    cancelPendingAdvance();
    stopTimer();
    session = null;
    renderHomeStats();
    renderGameType();
    showView("home");
  }

  /* ─────────────────────────────  Input  ────────────────────────────────── */

  function handleKey(key) {
    if (!session) return;
    if (session.locked) return;
    if (key === "back") {
      if (!session.input) return;
      session.input = session.input.slice(0, -1);
      renderInput();
      return;
    }
    if (key === "enter") { submit(); return; }
    if (/^[0-9]$/.test(key)) {
      if (session.input.length >= 3) return;
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
      if (/^[0-9]$/.test(e.key))   { handleKey(e.key);  flashKey(e.key);  e.preventDefault(); }
      else if (e.key === "Backspace") { handleKey("back");  flashKey("back");  e.preventDefault(); }
      else if (e.key === "Enter")     { handleKey("enter"); flashKey("enter"); e.preventDefault(); }
    });
  }

  function flashKey(key) {
    const btn = dom.keypad.querySelector(`.key[data-key="${key}"]`);
    if (!btn) return;
    btn.classList.add("is-press");
    setTimeout(() => btn.classList.remove("is-press"), 120);
  }

  function haptic(pattern) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* ignore */ }
    }
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
      renderHomeStats();   // best-record labels reflect the selected type
    });
  }

  function bindGlobal() {
    dom.themeToggle?.addEventListener("click", cycleTheme);
    dom.quitBtn?.addEventListener("click", goHome);
    dom.againBtn?.addEventListener("click", () => {
      const last = session?.mode || "1x1";
      startSession(last);
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
    // Pause the sprint timer while the tab is hidden, then resume on return.
    document.addEventListener("visibilitychange", () => {
      if (!session || session.cfg.timeLimit <= 0) return;
      if (session.endTime) return; // session is over; nothing to resume
      if (document.hidden) stopTimer();
      else if (session.timeLeftMs > 0) startTimer();
    });
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (!/^https?:/.test(location.protocol)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./service-worker.js")
        .catch(() => { /* offline still works once cached */ });
    });
  }

  function init() {
    applyTheme();
    renderGameType();
    renderHomeStats();
    bindHome();
    bindGlobal();
    bindKeypad();
    showView(store.onboarded ? "home" : "onboard");
    registerSW();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
