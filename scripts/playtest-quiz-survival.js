async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const base = 'http://127.0.0.1:8876';
  const places = (await (await page.request.get(`${base}/data/game-places.json`)).json()).places;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let score = 0, correct = 0, mistakes = 0, registration = null;
  await page.route('https://*.supabase.co/rest/v1/rpc/*', async route => {
    const method = route.request().url().split('/').pop();
    const body = route.request().postDataJSON();
    let response;
    if (method === 'start_quiz_survival_game') {
      score = 0; correct = 0; mistakes = 0;
      response = [{ session_id: 'test-session', rules_version: 'survival-v2' }];
    } else if (method === 'open_quiz_survival_question') {
      response = [{ opened: true, question_id: places[body.p_question_index].id }];
    } else if (method === 'answer_quiz_survival_question') {
      const outcome = places[body.p_question_index].outcome;
      const isCorrect = outcome === body.p_answer;
      correct += isCorrect ? 1 : 0;
      mistakes += isCorrect ? 0 : 1;
      const elapsed = body.p_answer === null ? 12000 : 1000;
      const earned = isCorrect ? 1183 : 0;
      score += earned;
      response = [{ correct_outcome: outcome, is_correct: isCorrect, elapsed_ms: elapsed,
        earned, total_score: score, correct_total: correct, mistakes, completed: mistakes === 3 }];
    } else if (method === 'register_quiz_survival_score') {
      registration = body;
      response = [{ accepted: true, message: 'ランキングに登録しました' }];
    } else if (method === 'get_quiz_survival_leaderboard') {
      response = [{ rank: 1, player_name: '動作テスト', score, correct_count: correct }];
    } else throw new Error(`Unexpected RPC: ${method}`);
    await route.fulfill({ json: response });
  });
  await page.goto(`${base}/game/`);
  await page.locator('#start-button').waitFor({ state: 'visible' });
  await page.evaluate(() => {
    localStorage.setItem('nauru_area_game_best_v1', '15000');
    localStorage.setItem('nauru_area_game_sound', '0');
  });
  await page.reload();
  await page.locator('#start-button').waitFor({ state: 'visible' });
  assert(await page.evaluate(() => localStorage.getItem('nauru_area_game_best_v1') === null), 'Old best was not reset');
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: 'output/playwright/survival-start-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: 'output/playwright/survival-start-mobile.png', fullPage: true });
  await page.locator('#start-button').click();
  const ready = async index => {
    await page.waitForFunction(({ index }) =>
      document.querySelector('#question-count').textContent === `第${index + 1}問`
        && !document.querySelector('[data-answer="larger"]').disabled, { index });
  };
  for (let index = 0; index < 21; index++) {
    await ready(index);
    if (index === 10) {
      assert(await page.locator('#correct-count-live').textContent() === '10問正解', 'Does not survive question 10');
      await page.screenshot({ path: 'output/playwright/survival-question-mobile.png', fullPage: true });
    }
    await page.locator(`[data-answer="${places[index].outcome}"]`).click();
    if (index === 9) {
      await page.locator('#milestone-feedback').waitFor({ state: 'visible' });
      assert(await page.locator('#milestone-feedback').isVisible(), 'No 10-correct celebration');
      await page.screenshot({ path: 'output/playwright/survival-milestone-mobile.png', fullPage: true });
    }
  }
  for (let index = 21; index < 23; index++) {
    await ready(index);
    await page.locator(`[data-answer="${places[index].outcome === 'larger' ? 'smaller' : 'larger'}"]`).click();
  }
  await ready(23);
  assert(await page.locator('#quiz-screen').evaluate(e => e.classList.contains('last-life')), 'Missing last-life state');
  await page.screenshot({ path: 'output/playwright/survival-last-life-mobile.png', fullPage: true });
  // The third mistake is an actual 12-second browser deadline, not a forced state change.
  await page.locator('#result-screen').waitFor({ state: 'visible', timeout: 17000 });
  assert(await page.locator('#correct-summary').textContent() === '21問', 'Wrong result count');
  assert(await page.locator('#final-score').textContent() === '24,843', 'Wrong score');
  assert(await page.locator('.review-item').count() === 24, 'Wrong review length');
  await page.locator('#share-preview').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#share-preview').naturalWidth === 1200);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile horizontal overflow');
  await page.screenshot({ path: 'output/playwright/survival-result-mobile.png', fullPage: true });
  await page.locator('#ranking-submit-open-button').click();
  await page.locator('#ranking-name').fill('動作テスト');
  await page.locator('#ranking-submit-button').click();
  await page.waitForFunction(() => document.querySelector('#ranking-submit-button').textContent === '登録済み');
  assert(registration?.p_player_name === '動作テスト', 'Ranking registration failed');
  assert(await page.locator('.ranking-entry-detail').textContent() === '21問正解', 'Ranking misses count');
  assert(!(await page.locator('#ranking-list').textContent()).includes('/10'), 'Legacy ranking display remains');
  await page.screenshot({ path: 'output/playwright/survival-ranking-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('#ranking-close-button').click();
  await page.screenshot({ path: 'output/playwright/survival-result-desktop.png', fullPage: true });
  assert(errors.length === 0, `Browser errors: ${errors.join(', ')}`);
  console.log('PASS: desktop/mobile, legacy best reset, 21 correct answers, milestone, last life, real timeout, result/share image and ranking registration');
}
