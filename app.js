/* =========================================================================
   Mathgod — app logic
   - 3 modes (1×1, 1×2, 2×2 up to 20)
   - Weighted question selection driven by per-question mastery
   - LocalStorage persistence
   - PWA: registers the service worker
   ========================================================================= */

(() => {
  "use strict";

  /* ────────────────────────────  Constants  ─────────────────────────────── */

  const STORAGE_KEY    = "mathgod:v1";
  const SESSION_LENGTH = 10;
  const XP_PER_CORRECT = 10;
  const XP_STREAK_BONUS = 2;   // extra XP per current-streak step

  const MODES = {
    "1x1": { aRange: [2, 9],  bRange: [2, 9]  },
    "1x2": { aRange: [2, 9],  bRange: [10, 20] },
    "2x2": { aRange: [10, 20], bRange: [10, 20] },
  };

  const FEEDBACK_CORRECT = ["Nice.", "Got it.", "Clean.", "Sharp.", "Smooth."];
  const FEEDBACK_WRONG   = (a, b) => `${a} × ${b} = ${a * b}`;

  /* ─────────────────────────────  Storage  ──────────────────────────────── */

  /** Returns the default persisted shape. */
  const defaults = () => ({
    onboarded: false,
    theme: "auto",          // "auto" | "light" | "dark"
    totalXP: 0,
    totalSessions: 0,
    bestStreak: 0,
    mastery: {},            // key -> { seen, correct, lastSeen }
  });

  /** Read state from localStorage, merging with defaults. */
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw);
      return { ...defaults(), ...parsed, mastery: parsed.mastery || {} };
    } catch {
      return defaults();
    }
  }

  /** Persist state to localStorage. Failures are silent (e.g. private mode). */
  function saveStore() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }
    catch { /* ignore */ }
  }

  const store = loadStore();

  /* ─────────────────────────  Runtime session state  ────────────────────── */

  /** Ephemeral, per-session game state. Reset on each new session. */
  let session = null;

  function freshSession(mode) {
    return {
      mode,
      index: 0,                  // 0..SESSION_LENGTH-1
      input: "",
      streak: 0,
      bestStreak: 0,
      correct: 0,
      wrong: 0,
      xp: 0,
      question: null,
      locked: false,             // true while feedback is showing
      lastKey: null,             // avoid immediate repeat questions
    };
  }

  /* ──────────────────────────  Question engine  ─────────────────────────── */

  /** Build the pool of [a, b] pairs valid for a given mode. */
  function poolFor(mode) {
    const { aRange, bRange } = MODES[mode];
    const out = [];
    for (let a = aRange[0]; a <= aRange[1]; a++) {
      for (let b = bRange[0]; b <= bRange[1]; b++) {
        out.push([a, b]);
      }
    }
    return out;
  }

  /** Per-pair record, lazily initialized. */
  function getRecord(key) {
    return store.mastery[key] || { seen: 0, correct: 0, lastSeen: 0 };
  }

  /**
   * Choose a question, weighted so that error-prone and rarely seen pairs
   * surface more often. Returns { a, b, answer }.
   */
  function pickQuestion(mode, avoidKey) {
    const pool = poolFor(mode);
    const now = Date.now();

    // Compute weights.
    const weights = pool.map(([a, b]) => {
      const key = `${a}x${b}`;
      if (key === avoidKey) return 0;
      const r = getRecord(key);
      const accuracy = r.seen ? r.correct / r.seen : 0.5;
      // Lower accuracy → larger weight; clamp to keep tail responsive.
      const errorWeight = Math.max(0.15, 1.25 - accuracy);
      // Boost rarely-seen pairs so the full pool is explored quickly.
      const familiarity = Math.min(r.seen, 4) / 4;        // 0..1
      const noveltyBoost = 1 + (1 - familiarity) * 0.8;
      // Mild recency bias: prefer pairs we haven't seen in a while.
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

  /** Update the per-pair mastery after an answer. */
  function recordResult(a, b, wasCorrect) {
    const key = `${a}x${b}`;
    const r = { ...getRecord(key) };
    r.seen += 1;
    if (wasCorrect) r.correct += 1;
    r.lastSeen = Date.now();
    store.mastery[key] = r;
  }

  /** Aggregate mastery for a mode in [0..1]. */
  function modeMastery(mode) {
    const pool = poolFor(mode);
    let totalSeen = 0;
    let weighted = 0;
    for (const [a, b] of pool) {
      const r = getRecord(`${a}x${b}`);
      if (r.seen === 0) continue;
      totalSeen += 1;
      const acc = r.correct / r.seen;
      // Treat anything below 3 attempts as partial credit.
      const confidence = Math.min(1, r.seen / 3);
      weighted += acc * confidence;
    }
    if (totalSeen === 0) return 0;
    // Coverage matters too: scale by fraction of the pool we've touched.
    const coverage = totalSeen / pool.length;
    return Math.min(1, (weighted / totalSeen) * Math.sqrt(coverage));
  }

  /* ───────────────────────────────  DOM  ────────────────────────────────── */

  const $ = (sel, root = document) => root.querySelector(sel);
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
    progressFill: $("#progressFill"),
    streakBadge:  $("#streakBadge"),
    streakNum:    $("#streakBadge [data-streak]"),
    keypad:       $("#keypad"),
    themeToggle:  $("#themeToggle"),
    quitBtn:      $("#quitBtn"),
    againBtn:     $("#againBtn"),
    homeBtn:      $("#homeBtn"),
    onboardStart: $("#onboardStart"),
    sumCorrect:   $("#sumCorrect"),
    sumStreak:    $("#sumStreak"),
    sumXP:        $("#sumXP"),
    summaryTitle: $("#summaryTitle"),
    summarySubtitle: $("#summarySubtitle"),
    summaryEmoji: $("#summaryEmoji"),
  };

  /** Switch the currently visible view. */
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
      const el = document.querySelector(`[data-fill="${mode}"]`);
      if (el) el.style.width = pct + "%";
    }
  }

  function formatCount(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return Math.round(n / 1000) + "k";
  }

  function renderQuestion() {
    if (!session?.question) return;
    dom.qA.textContent = String(session.question.a);
    dom.qB.textContent = String(session.question.b);
    renderInput();
    dom.feedback.textContent = "";
    dom.feedback.className = "feedback";
    dom.questionCard.classList.remove("swap-in");
    // Force reflow so the animation replays on subsequent questions.
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
    const pct = (session.index / SESSION_LENGTH) * 100;
    dom.progressFill.style.width = pct + "%";
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

  /* ──────────────────────────────  Flow  ────────────────────────────────── */

  function startSession(mode) {
    session = freshSession(mode);
    nextQuestion();
    renderProgress();
    renderStreak();
    showView("game");
  }

  function nextQuestion() {
    session.input = "";
    session.locked = false;
    session.question = pickQuestion(session.mode, session.lastKey);
    session.lastKey = `${session.question.a}x${session.question.b}`;
    renderQuestion();
  }

  /** Called when the user submits an answer. */
  function submit() {
    if (session.locked || !session.input) return;
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
      dom.answer.classList.add("is-wrong");
      dom.feedback.textContent = FEEDBACK_WRONG(a, b);
      dom.feedback.classList.add("is-wrong");
      dom.questionCard.classList.add("flash-wrong");
      renderStreak();
      haptic([12, 40, 12]);
    }

    setTimeout(cleanupFlash, 700);
    setTimeout(advance, correct ? 700 : 1500);
  }

  function cleanupFlash() {
    dom.questionCard.classList.remove("flash-correct", "flash-wrong");
  }

  function advance() {
    session.index += 1;
    renderProgress();
    if (session.index >= SESSION_LENGTH) {
      finishSession();
      return;
    }
    nextQuestion();
  }

  function finishSession() {
    // Commit session totals to persistent store.
    store.totalXP += session.xp;
    store.totalSessions += 1;
    store.bestStreak = Math.max(store.bestStreak, session.bestStreak);
    saveStore();

    dom.sumCorrect.textContent = `${session.correct}/${SESSION_LENGTH}`;
    dom.sumStreak.textContent  = String(session.bestStreak);
    dom.sumXP.textContent      = `+${session.xp}`;

    const ratio = session.correct / SESSION_LENGTH;
    let title, sub, emoji;
    if (ratio === 1)       { title = "Flawless.";        sub = "Every answer correct.";              emoji = "★"; }
    else if (ratio >= 0.8) { title = "Strong session.";  sub = "You're locking these in.";           emoji = "✦"; }
    else if (ratio >= 0.5) { title = "Steady progress."; sub = "Tricky pairs will return more often.";emoji = "◆"; }
    else                   { title = "Keep going.";      sub = "Short, regular sessions add up.";    emoji = "○"; }
    dom.summaryTitle.textContent = title;
    dom.summarySubtitle.textContent = sub;
    dom.summaryEmoji.textContent = emoji;

    showView("summary");
  }

  function goHome() {
    session = null;
    renderHomeStats();
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
    if (key === "enter") {
      submit();
      return;
    }
    // Digit. Cap at 4 chars (max possible answer is 20×20=400).
    if (/^[0-9]$/.test(key)) {
      if (session.input.length >= 3) return;
      // Disallow leading zero unless first character.
      if (session.input === "" && key === "0") return;
      session.input += key;
      renderInput();
    }
  }

  /** Bind keypad clicks. Uses pointerdown for snappier feedback on iOS. */
  function bindKeypad() {
    dom.keypad.addEventListener("click", (e) => {
      const btn = e.target.closest(".key");
      if (!btn) return;
      handleKey(btn.dataset.key);
    });
    // Hardware keyboard support (useful for desktop testing).
    window.addEventListener("keydown", (e) => {
      if (!views.game || views.game.hasAttribute("hidden")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key))   { handleKey(e.key); flashKey(e.key); e.preventDefault(); }
      else if (e.key === "Backspace") { handleKey("back"); flashKey("back"); e.preventDefault(); }
      else if (e.key === "Enter")     { handleKey("enter"); flashKey("enter"); e.preventDefault(); }
    });
  }

  function flashKey(key) {
    const btn = dom.keypad.querySelector(`.key[data-key="${key}"]`);
    if (!btn) return;
    btn.classList.add("is-press");
    setTimeout(() => btn.classList.remove("is-press"), 120);
  }

  /** Best-effort tactile feedback (Android Chrome / supporting browsers). */
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

    // Update the iOS status bar theme color to match.
    const isDark =
      store.theme === "dark" ||
      (store.theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const color = isDark ? "#0e0e11" : "#f6f5f1";
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      if (!m.hasAttribute("media")) m.setAttribute("content", color);
    });
  }

  function cycleTheme() {
    // auto → light → dark → auto
    store.theme = store.theme === "auto" ? "light"
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
    // React to OS theme changes when in auto mode.
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (store.theme === "auto") applyTheme();
    });
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    // Only attempt on http(s); skips when opened via file://.
    if (!/^https?:/.test(location.protocol)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./service-worker.js")
        .catch(() => { /* silent; offline still works once cached */ });
    });
  }

  function init() {
    applyTheme();
    renderHomeStats();
    bindHome();
    bindGlobal();
    bindKeypad();
    showView(store.onboarded ? "home" : "onboard");
    registerSW();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
