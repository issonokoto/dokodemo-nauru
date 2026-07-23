(() => {
  'use strict';

  const DATA_URL = '../data/game-places.json';
  const QUESTION_COUNT = 10;
  const QUESTION_TIME_MS = 12000;
  const FEEDBACK_TIME_MS = 1450;
  const NAURU_AREA_KM2 = 21;
  const BEST_SCORE_KEY = 'nauru_area_game_best_v1';
  const SOUND_KEY = 'nauru_area_game_sound';
  const CATEGORY_LABELS = {
    municipality: '市区町村',
    island: '島',
    water: '湖・池'
  };
  const OUTCOME_LABELS = {
    larger: '大きい',
    same: 'ほぼ同じ',
    smaller: '小さい'
  };
  const QUESTION_BLUEPRINT = [
    ['municipality', 'larger'],
    ['municipality', 'larger'],
    ['municipality', 'smaller'],
    ['municipality', 'same'],
    ['island', 'larger'],
    ['island', 'smaller'],
    ['island', 'same'],
    ['water', 'larger'],
    ['water', 'smaller'],
    ['water', 'smaller']
  ];

  const state = {
    data: null,
    questions: [],
    results: [],
    currentIndex: 0,
    score: 0,
    questionStartedAt: 0,
    timerFrame: 0,
    locked: false,
    soundEnabled: true,
    audioContext: null
  };

  const elements = {};

  function cacheElements() {
    [
      'loading-screen', 'start-screen', 'quiz-screen', 'result-screen', 'error-screen',
      'start-button', 'retry-button', 'share-button', 'reload-button', 'sound-toggle',
      'best-score-start', 'question-count', 'progress-bar', 'score-display', 'timer',
      'timer-ring', 'timer-number', 'category-label', 'location-label', 'place-name', 'answer-grid',
      'answer-feedback', 'feedback-mark', 'feedback-title', 'feedback-detail', 'earned-score',
      'final-score', 'result-rank', 'correct-summary', 'average-summary', 'best-summary',
      'best-summary-value', 'review-list', 'result-map-link', 'toast'
    ].forEach(id => {
      elements[id] = document.getElementById(id);
    });
    elements.answerButtons = Array.from(document.querySelectorAll('.answer-button'));
  }

  function showScreen(id) {
    ['loading-screen', 'start-screen', 'quiz-screen', 'result-screen', 'error-screen'].forEach(screenId => {
      elements[screenId].hidden = screenId !== id;
    });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function shuffle(items) {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function pickQuestions() {
    const buckets = new Map();
    state.data.places.forEach(place => {
      const key = `${place.category}:${place.outcome}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(place);
    });

    const selected = QUESTION_BLUEPRINT.map(([category, outcome]) => {
      const key = `${category}:${outcome}`;
      const candidates = buckets.get(key) || [];
      if (!candidates.length) throw new Error(`出題候補が不足しています: ${key}`);
      const index = Math.floor(Math.random() * candidates.length);
      return candidates.splice(index, 1)[0];
    });

    return shuffle(selected);
  }

  function getBestScore() {
    try {
      const value = Number(localStorage.getItem(BEST_SCORE_KEY));
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (_) {
      return 0;
    }
  }

  function saveBestScore(score) {
    try {
      localStorage.setItem(BEST_SCORE_KEY, String(score));
    } catch (_) {}
  }

  function readSoundSetting() {
    try {
      return localStorage.getItem(SOUND_KEY) !== '0';
    } catch (_) {
      return true;
    }
  }

  function updateSoundButton() {
    elements['sound-toggle'].setAttribute('aria-pressed', state.soundEnabled ? 'true' : 'false');
    elements['sound-toggle'].setAttribute('aria-label', state.soundEnabled ? '効果音をオフにする' : '効果音をオンにする');
  }

  function toggleSound() {
    state.soundEnabled = !state.soundEnabled;
    try {
      localStorage.setItem(SOUND_KEY, state.soundEnabled ? '1' : '0');
    } catch (_) {}
    updateSoundButton();
    if (state.soundEnabled) playTone('start');
  }

  function getAudioContext() {
    if (!state.soundEnabled) return null;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!state.audioContext) state.audioContext = new AudioContextClass();
    return state.audioContext;
  }

  function tone(context, frequency, start, duration, gainValue, type = 'sine') {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.03);
  }

  function playTone(kind) {
    const context = getAudioContext();
    if (!context) return;
    if (context.state === 'suspended') context.resume().catch(() => {});
    const now = context.currentTime;
    if (kind === 'correct') {
      tone(context, 523.25, now, 0.16, 0.08);
      tone(context, 659.25, now + 0.08, 0.2, 0.08);
      tone(context, 783.99, now + 0.17, 0.25, 0.07);
    } else if (kind === 'wrong') {
      tone(context, 220, now, 0.22, 0.055, 'triangle');
      tone(context, 174.61, now + 0.13, 0.3, 0.05, 'triangle');
    } else if (kind === 'finish') {
      [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
        tone(context, frequency, now + index * 0.1, 0.28, 0.065);
      });
    } else {
      tone(context, 659.25, now, 0.12, 0.04);
      tone(context, 880, now + 0.08, 0.17, 0.04);
    }
  }

  function formatScore(score) {
    return new Intl.NumberFormat('ja-JP').format(score);
  }

  function formatArea(area) {
    let maximumFractionDigits = 0;
    if (area < 0.1) maximumFractionDigits = 3;
    else if (area < 1) maximumFractionDigits = 2;
    else if (area < 100) maximumFractionDigits = 1;
    return new Intl.NumberFormat('ja-JP', { maximumFractionDigits }).format(area);
  }

  function buildMapUrl(place) {
    const url = new URL('../index.html', window.location.href);
    if (place.category !== 'municipality') {
      url.searchParams.set('category', place.category);
    }
    url.searchParams.set('compare', place.name);
    return url.href;
  }

  function renderStartScreen() {
    const best = getBestScore();
    elements['best-score-start'].hidden = best <= 0;
    if (best > 0) elements['best-score-start'].textContent = `自己ベスト ${formatScore(best)}点`;
    showScreen('start-screen');
    elements['start-button'].focus({ preventScroll: true });
  }

  function startGame() {
    try {
      state.questions = pickQuestions();
    } catch (error) {
      console.error(error);
      showScreen('error-screen');
      return;
    }
    state.results = [];
    state.currentIndex = 0;
    state.score = 0;
    state.locked = false;
    elements['score-display'].textContent = '0';
    playTone('start');
    showScreen('quiz-screen');
    renderQuestion();
  }

  function renderQuestion() {
    cancelAnimationFrame(state.timerFrame);
    state.locked = false;
    elements['answer-feedback'].hidden = true;
    elements['answer-feedback'].classList.remove('wrong-feedback');
    elements.answerButtons.forEach(button => {
      button.disabled = false;
      button.classList.remove('correct', 'wrong', 'dimmed');
    });

    const question = state.questions[state.currentIndex];
    elements['question-count'].textContent = `${state.currentIndex + 1} / ${QUESTION_COUNT}`;
    elements['progress-bar'].style.width = `${((state.currentIndex + 1) / QUESTION_COUNT) * 100}%`;
    elements['category-label'].textContent = CATEGORY_LABELS[question.category];
    elements['location-label'].textContent = question.location || '所在地不明';
    elements['place-name'].textContent = question.shortName || question.name;
    elements['timer'].classList.remove('warning');
    elements['timer-ring'].style.strokeDashoffset = '0';
    elements['timer-number'].textContent = '12';
    elements['timer'].setAttribute('aria-label', '残り12秒');
    state.questionStartedAt = performance.now();
    tickTimer(state.questionStartedAt);
    elements.answerButtons[0].focus({ preventScroll: true });
  }

  function tickTimer(now) {
    if (state.locked) return;
    const elapsed = now - state.questionStartedAt;
    const remaining = Math.max(0, QUESTION_TIME_MS - elapsed);
    const ratio = remaining / QUESTION_TIME_MS;
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    elements['timer-number'].textContent = String(seconds);
    elements['timer-ring'].style.strokeDashoffset = String(150.8 * (1 - ratio));
    elements['timer'].classList.toggle('warning', remaining <= 4000);
    elements['timer'].setAttribute('aria-label', `残り${seconds}秒`);

    if (remaining <= 0) {
      answerQuestion(null, true);
      return;
    }
    state.timerFrame = requestAnimationFrame(tickTimer);
  }

  function answerQuestion(answer, timedOut = false) {
    if (state.locked) return;
    state.locked = true;
    cancelAnimationFrame(state.timerFrame);
    const question = state.questions[state.currentIndex];
    const elapsedMs = Math.min(QUESTION_TIME_MS, Math.max(0, performance.now() - state.questionStartedAt));
    const isCorrect = answer === question.outcome;
    const earned = isCorrect
      ? 1000 + Math.floor(500 * Math.max(0, QUESTION_TIME_MS - elapsedMs) / QUESTION_TIME_MS)
      : 0;
    state.score += earned;
    state.results.push({ question, answer, isCorrect, elapsedMs, earned, timedOut });
    elements['score-display'].textContent = formatScore(state.score);

    elements.answerButtons.forEach(button => {
      button.disabled = true;
      const buttonAnswer = button.dataset.answer;
      if (buttonAnswer === question.outcome) button.classList.add('correct');
      else if (buttonAnswer === answer) button.classList.add('wrong');
      else button.classList.add('dimmed');
    });

    const answerLabel = OUTCOME_LABELS[question.outcome];
    elements['answer-feedback'].hidden = false;
    elements['answer-feedback'].classList.toggle('wrong-feedback', !isCorrect);
    elements['feedback-mark'].textContent = isCorrect ? '○' : '×';
    elements['feedback-title'].textContent = isCorrect ? '正解！' : timedOut ? '時間切れ！' : 'おしい！';
    elements['feedback-detail'].textContent =
      `${question.shortName || question.name}は${formatArea(question.areaKm2)} km²。正解は「${answerLabel}」です。`;
    elements['earned-score'].textContent = earned > 0 ? `+${formatScore(earned)}` : '+0';
    playTone(isCorrect ? 'correct' : 'wrong');

    window.setTimeout(() => {
      state.currentIndex += 1;
      if (state.currentIndex >= QUESTION_COUNT) finishGame();
      else renderQuestion();
    }, FEEDBACK_TIME_MS);
  }

  function getRank(score, correctCount) {
    if (score >= 13500 && correctCount === 10) return 'ナウル大使';
    if (score >= 11000 && correctCount >= 8) return 'ナウル博士';
    if (score >= 7500 && correctCount >= 6) return 'ナウル研究員';
    if (score >= 4000) return 'ナウル探検家';
    return 'ナウル見習い';
  }

  function finishGame() {
    cancelAnimationFrame(state.timerFrame);
    const correctCount = state.results.filter(result => result.isCorrect).length;
    const totalElapsed = state.results.reduce((sum, result) => sum + result.elapsedMs, 0);
    const averageSeconds = totalElapsed / state.results.length / 1000;
    const previousBest = getBestScore();
    const isNewBest = state.score > previousBest;
    if (isNewBest) saveBestScore(state.score);
    const best = Math.max(previousBest, state.score);

    elements['final-score'].textContent = formatScore(state.score);
    elements['result-rank'].textContent = getRank(state.score, correctCount);
    elements['correct-summary'].textContent = `${correctCount} / ${QUESTION_COUNT}`;
    elements['average-summary'].textContent = `${averageSeconds.toFixed(1)}秒`;
    elements['best-summary'].classList.toggle('is-new', isNewBest);
    elements['best-summary'].querySelector('strong').textContent = isNewBest ? '自己ベスト更新！' : '自己ベスト';
    elements['best-summary-value'].textContent = `${formatScore(best)}点`;

    renderReview();
    const lastPlace = state.results[state.results.length - 1].question;
    elements['result-map-link'].href = buildMapUrl(lastPlace);
    showScreen('result-screen');
    playTone('finish');
    elements['retry-button'].focus({ preventScroll: true });
  }

  function renderReview() {
    const fragment = document.createDocumentFragment();
    state.results.forEach((result, index) => {
      const item = document.createElement('li');
      item.className = 'review-item';
      const mapLink = buildMapUrl(result.question);
      item.innerHTML = `
        <span class="review-index">${index + 1}</span>
        <a class="review-place review-map" href="${mapLink}">
          <strong>${escapeHtml(result.question.shortName || result.question.name)}</strong>
          <small>${escapeHtml(CATEGORY_LABELS[result.question.category])}</small>
        </a>
        <span class="review-answer">${escapeHtml(OUTCOME_LABELS[result.question.outcome])}</span>
        <span class="review-area">${escapeHtml(formatArea(result.question.areaKm2))} km²</span>
        <span class="review-result ${result.isCorrect ? 'correct-result' : 'wrong-result'}" aria-label="${result.isCorrect ? '正解' : '不正解'}">${result.isCorrect ? '○' : '×'}</span>
      `;
      fragment.appendChild(item);
    });
    elements['review-list'].replaceChildren(fragment);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
  }

  function shareResult() {
    const correctCount = state.results.filter(result => result.isCorrect).length;
    const rank = getRank(state.score, correctCount);
    const text = [
      'ナウルより大きい？小さい？',
      `${correctCount}/10問正解・${formatScore(state.score)}点`,
      `称号：${rank}`,
      '#どこでもナウル'
    ].join('\n');
    const url = new URL('./', window.location.href).href;

    if (navigator.share) {
      navigator.share({ title: document.title, text, url }).catch(error => {
        if (error && error.name !== 'AbortError') copyShareText(`${text}\n${url}`);
      });
      return;
    }
    copyShareText(`${text}\n${url}`);
  }

  function copyShareText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text)
        .then(() => showToast('結果をコピーしました'))
        .catch(() => openXShare(text));
      return;
    }
    openXShare(text);
  }

  function openXShare(text) {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  let toastTimer = 0;
  function showToast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 2200);
  }

  function handleKeydown(event) {
    if (elements['quiz-screen'].hidden || state.locked) return;
    const answerByKey = { '1': 'larger', '2': 'same', '3': 'smaller' };
    const answer = answerByKey[event.key];
    if (!answer) return;
    event.preventDefault();
    answerQuestion(answer);
  }

  function bindEvents() {
    elements['start-button'].addEventListener('click', startGame);
    elements['retry-button'].addEventListener('click', startGame);
    elements['share-button'].addEventListener('click', shareResult);
    elements['reload-button'].addEventListener('click', () => window.location.reload());
    elements['sound-toggle'].addEventListener('click', toggleSound);
    elements.answerButtons.forEach(button => {
      button.addEventListener('click', () => answerQuestion(button.dataset.answer));
    });
    document.addEventListener('keydown', handleKeydown);
  }

  async function init() {
    cacheElements();
    state.soundEnabled = readSoundSetting();
    updateSoundButton();
    bindEvents();
    try {
      const response = await fetch(DATA_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || !Array.isArray(data.places) || data.places.length < 10) {
        throw new Error('出題データの形式が正しくありません');
      }
      state.data = data;
      renderStartScreen();
    } catch (error) {
      console.error('ゲームデータの読み込みに失敗しました', error);
      showScreen('error-screen');
    }
  }

  init();
})();
