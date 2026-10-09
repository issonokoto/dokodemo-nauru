(function (root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  else root.NauruQuizRules = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 'survival-v2';
  const MAX_MISTAKES = 3;
  const QUESTION_TIME_MS = 12000;
  const OUTCOMES = ['larger', 'smaller', 'same'];

  function difficulty(place) {
    const ratio = Number(place.areaKm2) / 21;
    if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('面積データを確認してください');
    if (place.outcome === 'same') return 2;
    const distance = Math.abs(Math.log(ratio));
    return distance >= Math.log(3) ? 0 : distance >= Math.log(1.5) ? 1 : 2;
  }

  function stage(correctCount) {
    return Math.min(2, Math.floor(correctCount / 10));
  }

  function earnedPoints(correct, elapsedMs) {
    const elapsed = Math.min(QUESTION_TIME_MS, Math.max(0, elapsedMs));
    return correct && elapsed < QUESTION_TIME_MS
      ? 1000 + Math.floor(200 * (QUESTION_TIME_MS - elapsed) / QUESTION_TIME_MS)
      : 0;
  }

  function pickNext(places, usedIds, correctCount, random = Math.random) {
    let available = places.filter(place => !usedIds.has(place.id));
    if (!available.length) {
      usedIds.clear();
      available = places.slice();
    }
    if (!available.length) throw new Error('出題候補が不足しています');
    // Select the answer first so the many large municipalities cannot dominate.
    const roll = random();
    const preferredOutcome = roll < 0.45 ? 'larger' : roll < 0.9 ? 'smaller' : 'same';
    const outcomePool = available.filter(place => place.outcome === preferredOutcome);
    if (outcomePool.length) available = outcomePool;
    const level = stage(correctCount);
    const difficultyRoll = random();
    const weights = [[0.8, 0.95], [0.3, 0.8], [0.1, 0.4]][level];
    const preferredDifficulty = difficultyRoll < weights[0] ? 0 : difficultyRoll < weights[1] ? 1 : 2;
    const difficultyPool = available.filter(place => difficulty(place) === preferredDifficulty);
    if (difficultyPool.length) available = difficultyPool;
    const categories = [...new Set(available.map(place => place.category))];
    const category = categories[Math.floor(random() * categories.length)];
    const candidates = available.filter(place => place.category === category);
    const selected = candidates[Math.floor(random() * candidates.length)];
    usedIds.add(selected.id);
    return selected;
  }

  return Object.freeze({ VERSION, MAX_MISTAKES, QUESTION_TIME_MS, OUTCOMES,
    difficulty, stage, earnedPoints, pickNext });
});
