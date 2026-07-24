(() => {
  'use strict';

  const DATA_URL = '../data/game-places.json';
  const QUESTION_COUNT = 10;
  const QUESTION_TIME_MS = 12000;
  const FEEDBACK_TIME_MS = 1450;
  const NAURU_AREA_KM2 = 21;
  const BEST_SCORE_KEY = 'nauru_area_game_best_v1';
  const SOUND_KEY = 'nauru_area_game_sound';
  const PLAYER_NAME_KEY = 'nauru_area_game_player_name_v1';
  const CLIENT_ID_KEY = 'nauru_area_game_client_id_v1';
  const TOP_PAGE_URL = 'https://issonokoto.github.io/dokodemo-nauru/';
  const SHARE_LOGO_URL = '../assets/dokodemo-nauru-logo-transparent-v3.png';
  const SHARE_MASCOT_URL = '../nauru_kun_outline.png';
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
  const RANKING_PERIOD_NOTES = {
    all: 'これまでの自己最高記録',
    weekly: '今週月曜日からの自己最高記録',
    daily: '今日0時からの自己最高記録'
  };
  const BLOCKED_NAME_TERMS = [
    'しね', '死ね', 'ころす', '殺す', 'くたばれ', 'きえろ',
    'ちんこ', 'ちんぽ', 'まんこ', 'せっくす', 'おまんこ',
    'fuck', 'shit', 'cunt', 'nigger', 'nigga', 'retard', 'kike', 'chink', 'spic'
  ];
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
    audioContext: null,
    finishedRound: null,
    rankingPeriod: 'all',
    rankingReturnScreen: 'start-screen',
    rankingRequestId: 0,
    serverSessionId: null,
    serverClientId: null,
    serverCompleted: false
  };

  const elements = {};
  const shareImageCache = new Map();
  let shareImagePromise = null;
  let shareImageBlob = null;
  let shareImageUrl = '';
  let pendingOtherShareFile = null;

  function cacheElements() {
    [
      'loading-screen', 'start-screen', 'quiz-screen', 'result-screen', 'ranking-screen', 'error-screen',
      'start-button', 'retry-button', 'share-button', 'reload-button', 'sound-toggle',
      'best-score-start', 'question-count', 'progress-bar', 'score-display', 'timer',
      'timer-ring', 'timer-number', 'category-label', 'location-label', 'place-name', 'answer-grid',
      'answer-feedback', 'feedback-mark', 'feedback-title', 'feedback-detail', 'earned-score',
      'final-score', 'result-rank', 'correct-summary', 'average-summary', 'best-summary',
      'best-summary-value', 'review-list', 'result-map-link', 'result-share-preview',
      'share-preview', 'share-preview-caption', 'x-share-button', 'share-button', 'toast',
      'ranking-open-button', 'ranking-submit-open-button', 'ranking-close-button',
      'ranking-form', 'ranking-score-value', 'ranking-name', 'ranking-name-count',
      'ranking-form-message', 'ranking-submit-button', 'ranking-period-note',
      'ranking-loading', 'ranking-list', 'ranking-reload-button'
    ].forEach(id => {
      elements[id] = document.getElementById(id);
    });
    elements.answerButtons = Array.from(document.querySelectorAll('.answer-button'));
  }

  function showScreen(id) {
    ['loading-screen', 'start-screen', 'quiz-screen', 'result-screen', 'ranking-screen', 'error-screen'].forEach(screenId => {
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

  function getStoredPlayerName() {
    try {
      return localStorage.getItem(PLAYER_NAME_KEY) || '';
    } catch (_) {
      return '';
    }
  }

  function getClientId() {
    try {
      const stored = localStorage.getItem(CLIENT_ID_KEY);
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored || '')) {
        return stored;
      }
      const generated = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_KEY, generated);
      return generated;
    } catch (_) {
      return crypto.randomUUID();
    }
  }

  function normalizePlayerName(value) {
    return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  }

  function compactPlayerName(value) {
    return normalizePlayerName(value)
      .toLowerCase()
      .replace(/[\sー・_.-]+/g, '')
      .replace(/[013457]/g, digit => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' })[digit]);
  }

  function validatePlayerName(value) {
    const name = normalizePlayerName(value);
    const length = Array.from(name).length;
    if (length < 1) return '名前を入力してください';
    if (length > 10) return '名前は10文字以内にしてください';
    if (!/^[\p{L}\p{N}々〆ヵヶー・ _.\-]+$/u.test(name)) {
      return '名前に使えない文字が含まれています';
    }
    if (/(https?:\/\/|www\.|@|[<>])/i.test(name)) return '名前を確認してください';
    const compact = compactPlayerName(name);
    if (BLOCKED_NAME_TERMS.some(term => compact.includes(compactPlayerName(term)))) {
      return 'その名前は登録できません';
    }
    return '';
  }

  function getRankingConfig() {
    const config = window.DOKODEMO_RANKING_CONFIG || {};
    const supabaseUrl = String(config.supabaseUrl || '').replace(/\/+$/, '');
    const supabaseAnonKey = String(config.supabaseAnonKey || '');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) || !supabaseAnonKey) return null;
    return { supabaseUrl, supabaseAnonKey };
  }

  async function rankingRpc(functionName, body) {
    const config = getRankingConfig();
    if (!config) throw new Error('ランキングは準備中です');
    const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`ランキング通信エラー (${response.status})`);
    return response.json();
  }

  function firstRpcRow(result) {
    return Array.isArray(result) ? result[0] : null;
  }

  function renderLeaderboard(entries) {
    const fragment = document.createDocumentFragment();
    entries.forEach(entry => {
      const item = document.createElement('li');
      item.className = 'ranking-entry';
      const position = Number(entry.rank);
      item.innerHTML = `
        <span class="ranking-position">${position <= 3 ? ['🥇', '🥈', '🥉'][position - 1] : position}</span>
        <strong class="ranking-player">${escapeHtml(entry.player_name)}</strong>
        <span class="ranking-entry-score">${escapeHtml(formatScore(entry.score))}点</span>
        <span class="ranking-entry-detail">${escapeHtml(`${entry.correct_count}/10正解・平均${(entry.average_ms / 1000).toFixed(1)}秒`)}</span>
      `;
      fragment.appendChild(item);
    });
    elements['ranking-list'].replaceChildren(fragment);
    if (!entries.length) {
      const empty = document.createElement('li');
      empty.className = 'ranking-empty';
      empty.textContent = 'まだ記録がありません。最初の挑戦者になろう！';
      elements['ranking-list'].appendChild(empty);
    }
  }

  async function loadLeaderboard(period = state.rankingPeriod) {
    state.rankingPeriod = period;
    const requestId = ++state.rankingRequestId;
    elements['ranking-loading'].textContent = 'ランキングを読み込んでいます…';
    elements['ranking-loading'].hidden = false;
    elements['ranking-list'].replaceChildren();
    elements['ranking-reload-button'].hidden = true;
    elements['ranking-period-note'].textContent = RANKING_PERIOD_NOTES[period];
    document.querySelectorAll('.ranking-tab').forEach(button => {
      const isActive = button.dataset.period === period;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    });
    try {
      const entries = await rankingRpc('get_quiz_leaderboard', { p_period: period });
      if (requestId !== state.rankingRequestId) return;
      elements['ranking-loading'].hidden = true;
      renderLeaderboard(Array.isArray(entries) ? entries : []);
    } catch (error) {
      if (requestId !== state.rankingRequestId) return;
      console.warn(error);
      elements['ranking-loading'].textContent = error.message || 'ランキングを読み込めませんでした';
      elements['ranking-reload-button'].hidden = false;
    }
  }

  function openRanking(allowSubmit, returnScreen) {
    state.rankingReturnScreen = returnScreen;
    elements['ranking-form'].hidden = !allowSubmit;
    elements['ranking-form-message'].textContent = '';
    elements['ranking-submit-button'].disabled = false;
    elements['ranking-submit-button'].textContent = '登録する';
    if (allowSubmit && state.finishedRound) {
      elements['ranking-score-value'].textContent = `${formatScore(state.finishedRound.score)}点`;
      elements['ranking-name'].value = getStoredPlayerName();
      updateRankingNameCount();
    }
    showScreen('ranking-screen');
    loadLeaderboard(state.rankingPeriod);
    (allowSubmit ? elements['ranking-name'] : elements['ranking-close-button']).focus({ preventScroll: true });
  }

  function closeRanking() {
    showScreen(state.rankingReturnScreen);
    const focusTarget = state.rankingReturnScreen === 'result-screen'
      ? elements['ranking-submit-open-button']
      : elements['ranking-open-button'];
    focusTarget.focus({ preventScroll: true });
  }

  function updateRankingNameCount() {
    const length = Array.from(normalizePlayerName(elements['ranking-name'].value)).length;
    elements['ranking-name-count'].textContent = `${length} / 10`;
  }

  async function submitRanking(event) {
    event.preventDefault();
    if (!state.finishedRound) return;
    if (!state.finishedRound.sessionId || !state.finishedRound.clientId || !state.serverCompleted) {
      elements['ranking-form-message'].textContent = 'この記録はランキングに登録できません';
      return;
    }
    const playerName = normalizePlayerName(elements['ranking-name'].value);
    const validationError = validatePlayerName(playerName);
    if (validationError) {
      elements['ranking-form-message'].textContent = validationError;
      elements['ranking-name'].focus();
      return;
    }
    elements['ranking-submit-button'].disabled = true;
    elements['ranking-form-message'].textContent = '登録しています…';
    try {
      const result = await rankingRpc('register_quiz_session_score', {
        p_session_id: state.finishedRound.sessionId,
        p_client_id: state.finishedRound.clientId,
        p_player_name: playerName,
      });
      const outcome = firstRpcRow(result);
      if (!outcome || !outcome.accepted) throw new Error(outcome?.message || '登録できませんでした');
      try {
        localStorage.setItem(PLAYER_NAME_KEY, playerName);
      } catch (_) {}
      elements['ranking-form-message'].textContent = outcome.message;
      elements['ranking-submit-button'].textContent = '登録済み';
      await loadLeaderboard(state.rankingPeriod);
    } catch (error) {
      console.warn(error);
      elements['ranking-form-message'].textContent = error.message || '登録できませんでした';
      elements['ranking-submit-button'].disabled = false;
    }
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

  async function startGame() {
    elements['start-button'].disabled = true;
    elements['retry-button'].disabled = true;
    elements['start-button'].textContent = '準備中…';
    elements['retry-button'].textContent = '準備中…';
    state.serverSessionId = null;
    state.serverClientId = null;
    state.serverCompleted = false;
    try {
      const clientId = getClientId();
      const result = await rankingRpc('start_quiz_game', { p_client_id: clientId });
      const session = firstRpcRow(result);
      if (!session?.session_id || !Array.isArray(session.question_ids) || session.question_ids.length !== QUESTION_COUNT) {
        throw new Error('ゲームセッションを開始できませんでした');
      }
      const placesById = new Map(state.data.places.map(place => [place.id, place]));
      state.questions = session.question_ids.map(id => placesById.get(id));
      if (state.questions.some(question => !question)) {
        throw new Error('出題データを確認できませんでした');
      }
      state.serverSessionId = session.session_id;
      state.serverClientId = clientId;
    } catch (error) {
      console.warn('ランキング対象セッションを開始できませんでした', error);
      try {
        state.questions = pickQuestions();
        showToast('通信できないため、ランキング対象外で開始します');
      } catch (questionError) {
        console.error(questionError);
        showScreen('error-screen');
        return;
      }
    } finally {
      elements['start-button'].disabled = false;
      elements['retry-button'].disabled = false;
      elements['start-button'].textContent = 'ゲームスタート';
      elements['retry-button'].textContent = 'もう一度あそぶ';
    }
    state.results = [];
    state.currentIndex = 0;
    state.score = 0;
    state.locked = false;
    state.finishedRound = null;
    resetShareImage();
    elements['score-display'].textContent = '0';
    playTone('start');
    showScreen('quiz-screen');
    renderQuestion();
  }

  async function renderQuestion() {
    cancelAnimationFrame(state.timerFrame);
    state.locked = true;
    elements['answer-feedback'].hidden = true;
    elements['answer-feedback'].classList.remove('wrong-feedback');
    elements.answerButtons.forEach(button => {
      button.disabled = true;
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

    if (state.serverSessionId) {
      try {
        const result = await rankingRpc('open_quiz_question', {
          p_session_id: state.serverSessionId,
          p_client_id: state.serverClientId,
          p_question_index: state.currentIndex
        });
        const opened = firstRpcRow(result);
        if (!opened?.opened || opened.question_id !== question.id) {
          throw new Error('問題を開始できませんでした');
        }
      } catch (error) {
        console.warn('サーバー計測を継続できませんでした', error);
        state.serverSessionId = null;
        state.serverClientId = null;
        state.serverCompleted = false;
        showToast('通信が切れたため、この記録はランキング対象外です');
      }
    }

    state.locked = false;
    elements.answerButtons.forEach(button => {
      button.disabled = false;
    });
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

  async function answerQuestion(answer, timedOut = false) {
    if (state.locked) return;
    state.locked = true;
    cancelAnimationFrame(state.timerFrame);
    const question = state.questions[state.currentIndex];
    const clientElapsedMs = Math.min(QUESTION_TIME_MS, Math.max(0, performance.now() - state.questionStartedAt));
    let correctOutcome = question.outcome;
    let elapsedMs = clientElapsedMs;
    let isCorrect = answer === correctOutcome;
    let earned = isCorrect
      ? 1000 + Math.floor(500 * Math.max(0, QUESTION_TIME_MS - elapsedMs) / QUESTION_TIME_MS)
      : 0;

    if (state.serverSessionId) {
      try {
        const result = await rankingRpc('answer_quiz_question', {
          p_session_id: state.serverSessionId,
          p_client_id: state.serverClientId,
          p_question_index: state.currentIndex,
          p_answer: timedOut ? null : answer
        });
        const authoritative = firstRpcRow(result);
        if (!authoritative || !OUTCOME_LABELS[authoritative.correct_outcome]) {
          throw new Error('回答結果を確認できませんでした');
        }
        const serverElapsedMs = Number(authoritative.elapsed_ms);
        const serverEarned = Number(authoritative.earned);
        const serverTotalScore = Number(authoritative.total_score);
        if (!Number.isInteger(serverElapsedMs) || serverElapsedMs < 0 || serverElapsedMs > QUESTION_TIME_MS
          || !Number.isInteger(serverEarned) || serverEarned < 0 || serverEarned > 1500
          || !Number.isInteger(serverTotalScore) || serverTotalScore < 0 || serverTotalScore > 15000) {
          throw new Error('回答結果の値を確認できませんでした');
        }
        correctOutcome = authoritative.correct_outcome;
        elapsedMs = serverElapsedMs;
        isCorrect = Boolean(authoritative.is_correct);
        earned = serverEarned;
        state.score = serverTotalScore;
        state.serverCompleted = Boolean(authoritative.completed);
        timedOut = timedOut || elapsedMs >= QUESTION_TIME_MS;
      } catch (error) {
        console.warn('サーバー回答の記録に失敗しました', error);
        state.serverSessionId = null;
        state.serverClientId = null;
        state.serverCompleted = false;
        state.score += earned;
        showToast('通信が切れたため、この記録はランキング対象外です');
      }
    } else {
      state.score += earned;
    }

    state.results.push({ question, answer, correctOutcome, isCorrect, elapsedMs, earned, timedOut });
    elements['score-display'].textContent = formatScore(state.score);

    elements.answerButtons.forEach(button => {
      button.disabled = true;
      const buttonAnswer = button.dataset.answer;
      if (buttonAnswer === correctOutcome) button.classList.add('correct');
      else if (buttonAnswer === answer) button.classList.add('wrong');
      else button.classList.add('dimmed');
    });

    const answerLabel = OUTCOME_LABELS[correctOutcome];
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
    state.finishedRound = {
      score: state.score,
      correctCount,
      averageMs: Math.round(totalElapsed / state.results.length),
      sessionId: state.serverCompleted ? state.serverSessionId : null,
      clientId: state.serverCompleted ? state.serverClientId : null
    };

    renderReview();
    const lastPlace = state.results[state.results.length - 1].question;
    elements['result-map-link'].href = buildMapUrl(lastPlace);
    showScreen('result-screen');
    renderSharePreview();
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
        <span class="review-answer">${escapeHtml(OUTCOME_LABELS[result.correctOutcome || result.question.outcome])}</span>
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

  function getResultShareData() {
    const correctCount = state.results.filter(result => result.isCorrect).length;
    const accuracy = Math.round(correctCount / QUESTION_COUNT * 100);
    const rank = getRank(state.score, correctCount);
    const text = [
      'ナウルより大きい？小さい？',
      `${formatScore(state.score)}点・正答率${accuracy}%（${correctCount}/${QUESTION_COUNT}問正解）`,
      `称号：${rank}`,
      '#どこでもナウル'
    ].join('\n');
    return {
      correctCount,
      accuracy,
      rank,
      text,
      xText: `${text}\n${TOP_PAGE_URL}`
    };
  }

  function loadShareImage(source) {
    if (shareImageCache.has(source)) return shareImageCache.get(source);
    const promise = new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`画像を読み込めませんでした: ${source}`));
      image.src = source;
    });
    shareImageCache.set(source, promise);
    return promise;
  }

  function fillRoundedRect(context, x, y, width, height, radius, fillStyle) {
    context.beginPath();
    if (typeof context.roundRect === 'function') {
      context.roundRect(x, y, width, height, radius);
    } else {
      const r = Math.min(radius, width / 2, height / 2);
      context.moveTo(x + r, y);
      context.arcTo(x + width, y, x + width, y + height, r);
      context.arcTo(x + width, y + height, x, y + height, r);
      context.arcTo(x, y + height, x, y, r);
      context.arcTo(x, y, x + width, y, r);
    }
    context.closePath();
    context.fillStyle = fillStyle;
    context.fill();
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('シェア画像を作成できませんでした'));
      }, 'image/png');
    });
  }

  async function createResultShareImageBlob() {
    const [logo, mascot] = await Promise.all([
      loadShareImage(SHARE_LOGO_URL),
      loadShareImage(SHARE_MASCOT_URL)
    ]);
    const share = getResultShareData();
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 630;
    const context = canvas.getContext('2d');
    context.fillStyle = '#7ea6cf';
    context.fillRect(0, 0, canvas.width, canvas.height);
    fillRoundedRect(context, 45, 42, 1110, 546, 30, 'rgba(255, 255, 255, 0.13)');
    context.strokeStyle = 'rgba(255, 255, 255, 0.58)';
    context.lineWidth = 3;
    context.strokeRect(64, 61, 1072, 508);

    const family = '"Yu Gothic", "Hiragino Sans", "Noto Sans JP", sans-serif';
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.fillStyle = 'rgba(255, 255, 255, 0.84)';
    context.font = `800 19px ${family}`;
    context.fillText('全10問の結果', 96, 111);
    context.fillStyle = '#061525';
    context.font = `900 40px ${family}`;
    context.fillText('ナウルより大きい？小さい？', 96, 163);
    const logoWidth = 245;
    const logoHeight = logo.naturalHeight / logo.naturalWidth * logoWidth;
    context.drawImage(logo, 866, 80, logoWidth, logoHeight);

    context.fillStyle = 'rgba(6, 21, 37, 0.65)';
    context.font = `800 18px ${family}`;
    context.fillText('SCORE', 99, 244);
    context.fillStyle = '#061525';
    context.font = `900 112px ${family}`;
    context.fillText(formatScore(state.score), 92, 358);
    const scoreWidth = context.measureText(formatScore(state.score)).width;
    context.fillStyle = '#061525';
    context.font = `900 31px ${family}`;
    context.fillText('点', 108 + scoreWidth, 352);

    fillRoundedRect(context, 91, 395, 600, 116, 18, 'rgba(6, 21, 37, 0.82)');
    context.fillStyle = 'rgba(255, 255, 255, 0.76)';
    context.font = `800 18px ${family}`;
    context.fillText('正答率', 122, 434);
    context.fillStyle = '#f5c542';
    context.font = `900 54px ${family}`;
    context.fillText(`${share.accuracy}%`, 119, 491);
    context.fillStyle = '#ffffff';
    context.font = `800 24px ${family}`;
    context.fillText(`${share.correctCount} / ${QUESTION_COUNT}問正解`, 309, 484);
    context.fillStyle = 'rgba(255, 255, 255, 0.68)';
    context.font = `800 16px ${family}`;
    context.fillText('称号', 512, 430);
    context.fillStyle = '#ffffff';
    context.font = `900 ${share.rank.length > 7 ? 25 : 29}px ${family}`;
    context.fillText(share.rank, 509, 471);

    context.fillStyle = '#061525';
    context.font = `800 18px ${family}`;
    context.fillText('#どこでもナウル', 96, 552);

    const mascotHeight = 320;
    const mascotWidth = mascot.naturalWidth / mascot.naturalHeight * mascotHeight;
    context.save();
    context.shadowColor = 'rgba(6, 21, 37, 0.24)';
    context.shadowBlur = 20;
    context.drawImage(mascot, 792, 218, mascotWidth, mascotHeight);
    context.restore();

    return canvasToBlob(canvas);
  }

  function ensureShareImageBlob() {
    if (shareImageBlob) return Promise.resolve(shareImageBlob);
    if (shareImagePromise) return shareImagePromise;
    const promise = createResultShareImageBlob()
      .then(blob => {
        if (shareImagePromise === promise) shareImageBlob = blob;
        return blob;
      })
      .finally(() => {
        if (shareImagePromise === promise && !shareImageBlob) shareImagePromise = null;
      });
    shareImagePromise = promise;
    return promise;
  }

  function resetShareImage() {
    shareImagePromise = null;
    shareImageBlob = null;
    pendingOtherShareFile = null;
    if (shareImageUrl) {
      URL.revokeObjectURL(shareImageUrl);
      shareImageUrl = '';
    }
    if (elements['result-share-preview']) elements['result-share-preview'].hidden = true;
    if (elements['share-preview']) elements['share-preview'].removeAttribute('src');
    if (elements['share-button']) elements['share-button'].textContent = 'その他の共有';
  }

  function renderSharePreview() {
    const figure = elements['result-share-preview'];
    const preview = elements['share-preview'];
    const caption = elements['share-preview-caption'];
    figure.hidden = false;
    caption.textContent = '得点と正答率入りのシェア画像を作成中…';
    const previewPromise = ensureShareImageBlob();
    previewPromise
      .then(blob => {
        if (shareImagePromise !== previewPromise) return;
        if (shareImageUrl) URL.revokeObjectURL(shareImageUrl);
        shareImageUrl = URL.createObjectURL(blob);
        preview.src = shareImageUrl;
        caption.textContent = '得点と正答率入り・Xではコピーした画像を貼り付け';
      })
      .catch(error => {
        console.warn(error);
        figure.hidden = true;
      });
  }

  async function copyImageToClipboard(blobOrPromise) {
    if (!navigator.clipboard || !window.ClipboardItem) return false;
    const pngPromise = Promise.resolve(blobOrPromise).then(blob => {
      if (!blob) throw new Error('コピーする画像がありません');
      return blob.type === 'image/png'
        ? blob
        : blob.arrayBuffer().then(buffer => new Blob([buffer], { type: 'image/png' }));
    });
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngPromise })
      ]);
      return true;
    } catch (firstError) {
      try {
        const pngBlob = await pngPromise;
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': pngBlob })
        ]);
        return true;
      } catch (error) {
        console.warn('clipboard image failed', firstError, error);
        return false;
      }
    }
  }

  function downloadShareImage(blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dokodemo-nauru-quiz-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openPendingShareWindow() {
    const popup = window.open('about:blank', '_blank');
    if (!popup) return null;
    try {
      popup.opener = null;
      popup.document.title = '共有を準備中';
      popup.document.body.textContent = '共有画像を準備しています…';
    } catch (_) {}
    return popup;
  }

  function isMobileXShare() {
    return window.matchMedia('(max-width: 820px)').matches ||
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  }

  function buildXIntentUrl(text) {
    return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
  }

  function openXComposer(popup, url) {
    if (isMobileXShare()) {
      window.location.assign(url);
      return;
    }
    if (popup && !popup.closed) popup.location.replace(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function shareResultToX() {
    const share = getResultShareData();
    const popup = isMobileXShare() ? null : openPendingShareWindow();
    showToast('得点入り画像を準備中…');
    const blobPromise = ensureShareImageBlob();
    const copyPromise = copyImageToClipboard(blobPromise);
    try {
      const [blob, copied] = await Promise.all([blobPromise, copyPromise]);
      if (!copied) downloadShareImage(blob);
      openXComposer(popup, buildXIntentUrl(share.xText));
      showToast(copied
        ? '画像をコピーしました。Xで貼り付けてください'
        : '画像を保存しました。Xで添付してください');
    } catch (error) {
      console.warn(error);
      openXComposer(popup, buildXIntentUrl(share.xText));
      showToast('Xの投稿画面を開きました');
    }
  }

  function shareOtherResult() {
    const share = getResultShareData();
    const shareFile = pendingOtherShareFile || (shareImageBlob
      ? new File([shareImageBlob], 'dokodemo-nauru-quiz-result.png', { type: 'image/png' })
      : null);
    const canShareFile = shareFile && (
      typeof navigator.canShare !== 'function' ||
      navigator.canShare({ files: [shareFile] })
    );
    if (shareFile && typeof navigator.share === 'function') {
      const payload = {
        title: 'どこでもナウル｜クイズ結果',
        text: share.text,
        url: TOP_PAGE_URL
      };
      if (canShareFile) payload.files = [shareFile];
      navigator.share(payload).then(() => {
        pendingOtherShareFile = null;
        elements['share-button'].textContent = 'その他の共有';
      }).catch(error => {
        if (error && error.name !== 'AbortError') console.warn(error);
      });
      return;
    }

    showToast('共有画像を準備中…');
    ensureShareImageBlob()
      .then(blob => {
        pendingOtherShareFile = new File(
          [blob],
          'dokodemo-nauru-quiz-result.png',
          { type: 'image/png' }
        );
        if (typeof navigator.share === 'function') {
          elements['share-button'].textContent = '共有画面を開く';
          showToast('準備できました。もう一度押してください');
          return;
        }
        return copyImageToClipboard(blob).then(copied => {
          if (!copied) downloadShareImage(blob);
          showToast(copied ? '画像をコピーしました' : '画像を保存しました');
        });
      })
      .catch(error => {
        console.warn(error);
        copyShareText(share.xText);
      });
  }

  function copyShareText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text)
        .then(() => showToast('結果をコピーしました'))
        .catch(() => showToast('結果をコピーできませんでした'));
      return;
    }
    showToast('このブラウザでは共有できません');
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
    elements['ranking-open-button'].addEventListener('click', () => openRanking(false, 'start-screen'));
    elements['ranking-submit-open-button'].addEventListener('click', () => openRanking(true, 'result-screen'));
    elements['ranking-close-button'].addEventListener('click', closeRanking);
    elements['ranking-form'].addEventListener('submit', submitRanking);
    elements['ranking-name'].addEventListener('input', updateRankingNameCount);
    elements['ranking-reload-button'].addEventListener('click', () => loadLeaderboard(state.rankingPeriod));
    document.querySelectorAll('.ranking-tab').forEach(button => {
      button.addEventListener('click', () => loadLeaderboard(button.dataset.period));
    });
    elements['x-share-button'].addEventListener('click', shareResultToX);
    elements['share-button'].addEventListener('click', shareOtherResult);
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
