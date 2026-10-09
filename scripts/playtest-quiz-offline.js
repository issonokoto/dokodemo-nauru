async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.unroute('https://*.supabase.co/rest/v1/rpc/*');
  await page.route('https://*.supabase.co/rest/v1/rpc/*', route => route.abort());
  await page.clock.install();
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('http://127.0.0.1:8876/game/');
  await page.locator('#start-button').waitFor({ state: 'visible' });
  await page.locator('#start-button').click();
  await page.waitForFunction(() => !document.querySelector('[data-answer="larger"]').disabled);
  assert(await page.locator('#toast').textContent() === '通信できないため、ランキング対象外で開始します', 'No offline notice');
  for (let i = 0; i < 3; i++) {
    await page.clock.runFor(14000);
  }
  await page.locator('#result-screen').waitFor({ state: 'visible' });
  assert(await page.locator('#correct-summary').textContent() === '0問', 'Offline timeouts counted as correct');
  assert(await page.locator('#final-score').textContent() === '0', 'Offline timeout earned points');
  assert(await page.locator('.review-item').count() === 3, 'Offline mode failed to stop after 3 mistakes');
  await page.locator('#ranking-submit-open-button').click();
  await page.locator('#ranking-name').fill('オフライン');
  await page.locator('#ranking-submit-button').click();
  assert(await page.locator('#ranking-form-message').textContent() === 'この記録はランキングに登録できません', 'Offline score accepted');
  await page.locator('#ranking-close-button').click();
  await page.locator('#retry-button').click();
  await page.waitForFunction(() => !document.querySelector('[data-answer="larger"]').disabled);
  assert(await page.locator('#life-indicator .is-lost').count() === 0, 'Retry did not reset lives');
  assert(await page.locator('#correct-count-live').textContent() === '0問正解', 'Retry did not reset count');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Narrow phone overflows');
  await page.screenshot({ path: 'output/playwright/survival-small-phone.png', fullPage: true });
  console.log('PASS: offline start, 3 actual timer callbacks, zero-correct result, registration rejection, retry and narrow phone');
}
