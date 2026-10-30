import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:29229');
const p = await b.contexts()[0].newPage();
await p.goto('https://codeforces.com/enter', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(15000);
console.log('enter title:', await p.title(), p.url());
if (await p.locator('#handleOrEmail').count()) {
  await p.fill('#handleOrEmail', process.env.CF_HANDLE); await p.fill('#password', process.env.CF_PASSWORD);
  await Promise.all([p.waitForLoadState('domcontentloaded'), p.click('input[type=submit].submit')]);
  await p.waitForTimeout(4000);
}
console.log('logged in as:', await p.locator('a[href^="/profile/"]').first().textContent().catch(() => null));
for (const u of ['https://codeforces.com/contest/1850/submit/A', 'https://codeforces.com/contest/4/submit/A', 'https://codeforces.com/problemset/submit/4/A']) {
  await p.goto(u, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2000);
  const sel = await p.locator('select[name=submittedProblemIndex]').evaluate(e => e.value).catch(() => null);
  const code = await p.locator('input[name=submittedProblemCode]').evaluate(e => e.value).catch(() => null);
  console.log(u, '->', p.url(), 'title=', await p.title(), 'index=', sel, 'code=', code);
}
await p.close(); await b.close();
