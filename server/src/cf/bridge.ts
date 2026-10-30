import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { Problem, Sample } from '../../../shared/types.js';
import { Store } from '../store.js';

const CF = 'https://codeforces.com';

function extractStatement(element: Element, baseUrl: string) {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelector('.header')?.remove();
  for (const node of Array.from(clone.querySelectorAll('[src], [href]'))) {
    for (const attr of ['src', 'href']) {
      const value = node.getAttribute(attr);
      if (value && !/^(?:https?:|data:|#)/i.test(value)) node.setAttribute(attr, new URL(value, baseUrl).href);
    }
  }
  const timeNode = element.querySelector('.header .time-limit');
  const memoryNode = element.querySelector('.header .memory-limit');
  let timeLimit: string | null = null;
  let memoryLimit: string | null = null;
  if (timeNode) {
    const timeClone = timeNode.cloneNode(true) as HTMLElement;
    timeClone.querySelector('.property-title')?.remove();
    timeLimit = timeClone.textContent?.trim().replace(/\s+/g, ' ') || null;
  }
  if (memoryNode) {
    const memoryClone = memoryNode.cloneNode(true) as HTMLElement;
    memoryClone.querySelector('.property-title')?.remove();
    memoryLimit = memoryClone.textContent?.trim().replace(/\s+/g, ' ') || null;
  }
  return {
    timeLimit,
    memoryLimit,
    html: clone.innerHTML,
  };
}

function extractSamples(containers: Element[]): Sample[] {
  const samples: Sample[] = [];
  for (const container of containers) {
    const inputs = Array.from(container.querySelectorAll('.input pre'));
    const outputs = Array.from(container.querySelectorAll('.output pre'));
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const output = outputs[index];
      if (input && output) samples.push({
        input: (input as HTMLElement).innerText,
        output: (output as HTMLElement).innerText,
      });
    }
  }
  return samples;
}

export class CodeforcesBridge {
  private browser: Browser | null = null;
  private contexts = new Map<string, BrowserContext>();
  private statementActive = 0;
  private statementQueue: Array<() => void> = [];
  private nextStatementAt = 0;

  constructor(private readonly store: Store) {
    this.store.state.cfBridge.connected = false;
  }

  async restart(): Promise<void> {
    for (const context of this.contexts.values()) await context.close().catch(() => undefined);
    this.contexts.clear();
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.store.state.cfBridge.connected = false;
    await this.connect();
    this.store.changed();
  }

  async connect(): Promise<Browser> {
    const config = this.store.state.cfBridge;
    if (this.browser?.isConnected()) return this.browser;
    if (config.mode === 'cdp') {
      if (!config.cdpUrl) throw new Error('Codeforces CDP URL is not configured');
      this.browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 10_000 });
    } else {
      const profile = path.join(this.store.dir, 'chrome');
      await mkdir(profile, { recursive: true });
      const executablePath = process.env.CHROME_PATH;
      if (executablePath) {
        await access(executablePath);
      }
      const context = await chromium.launchPersistentContext(profile, {
        ...(executablePath ? { executablePath } : { channel: 'chrome' }),
        headless: false,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled'],
      });
      this.browser = context.browser();
      if (!this.browser) throw new Error('Could not start Chrome');
      this.contexts.set('__persistent__', context);
    }
    this.browser.on('disconnected', () => {
      this.store.state.cfBridge.connected = false;
      this.store.changed();
    });
    this.store.state.cfBridge.connected = true;
    this.store.state.cfBridge.lastError = null;
    this.store.changed();
    return this.browser;
  }

  async fetchStatement(problem: Problem): Promise<Pick<Problem, 'statementHtml' | 'timeLimit' | 'memoryLimit' | 'samples'>> {
    await this.acquireStatement();
    try {
      const requestAt = Math.max(Date.now(), this.nextStatementAt);
      this.nextStatementAt = requestAt + 1000;
      if (requestAt > Date.now()) await new Promise((resolve) => setTimeout(resolve, requestAt - Date.now()));
      const browser = await this.connect();
      const page = await this.newPage(browser);
      try {
        const url = problem.contestId >= 100000
          ? `${CF}/gym/${problem.contestId}/problem/${problem.index}`
          : `${CF}/problemset/problem/${problem.contestId}/${problem.index}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        const statement = page.locator('.problem-statement');
        await statement.waitFor({ state: 'visible', timeout: 60_000 });
        const limits = await statement.evaluate(extractStatement, CF);
        const samples = await statement.locator('.sample-test').evaluateAll(extractSamples);
        return {
          statementHtml: limits.html,
          timeLimit: limits.timeLimit,
          memoryLimit: limits.memoryLimit,
          samples,
        };
      } finally {
        await page.close().catch(() => undefined);
      }
    } catch (error) {
      const message = (error as Error).message;
      this.store.state.cfBridge.lastError = message;
      this.store.state.cfBridge.connected = Boolean(this.browser?.isConnected());
      this.store.changed();
      throw new Error(`Could not fetch Codeforces statement: ${message}`);
    } finally {
      this.releaseStatement();
    }
  }

  async login(handle: string): Promise<void> {
    const account = this.store.state.cfAccounts.find((item) => item.handle.toLowerCase() === handle.toLowerCase());
    if (!account) throw new Error(`No Codeforces account configured for ${handle}`);
    account.status = 'logging-in';
    account.lastError = null;
    this.store.changed();
    try {
      const browser = await this.connect();
      const context = await this.accountContext(browser, account.handle);
      const page = await context.newPage();
      await page.goto(`${CF}/enter`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const loggedIn = await page.locator('#header a[href*="/profile/"]').allInnerTexts();
      if (loggedIn.some((text) => text.trim().toLowerCase() === account.handle.toLowerCase())) {
        account.status = 'ready';
      } else {
        await page.locator('#handleOrEmail').fill(account.handle);
        await page.locator('#password').fill(account.password);
        await page.locator('input[type="submit"]').first().click();
        await page.waitForTimeout(1500);
        const handles = await page.locator('#header a[href*="/profile/"]').allInnerTexts();
        if (!handles.some((text) => text.trim().toLowerCase() === account.handle.toLowerCase())) {
          const error = await page.locator('.error').allInnerTexts();
          throw new Error(error.join(' ') || 'Codeforces login was not accepted');
        }
        account.status = 'ready';
      }
      await context.storageState({ path: this.accountStatePath(account.handle) });
      account.lastError = null;
    } catch (error) {
      account.status = 'error';
      account.lastError = (error as Error).message;
      throw new Error(`Codeforces login failed for ${account.handle}: ${account.lastError}`);
    } finally {
      this.store.changed();
    }
  }

  async submit(
    handle: string,
    problem: Problem,
    source: string,
    programTypeId: number,
    srcFile: string,
    monacoLanguage: string,
  ): Promise<number> {
    const account = this.store.state.cfAccounts.find((item) => item.handle.toLowerCase() === handle.toLowerCase());
    if (!account || !account.enabled) throw new Error(`No enabled Codeforces account configured for ${handle}`);
    const browser = await this.connect();
    const context = await this.accountContext(browser, account.handle);
    const page = await context.newPage();
    try {
      const submitUrl = problem.contestId >= 100000
        ? `${CF}/gym/${problem.contestId}/submit`
        : `${CF}/problemset/submit`;
      await page.goto(submitUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const headerHandle = await page.locator('#header a[href*="/profile/"]').allInnerTexts();
      if (!headerHandle.some((text) => text.trim().toLowerCase() === account.handle.toLowerCase())) {
        throw new Error(`Codeforces account ${account.handle} is not logged in; use the account login endpoint`);
      }
      if (problem.contestId >= 100000) {
        await page.locator('input[name="submittedProblemIndex"]').fill(problem.index);
      } else {
        await page.locator('input[name="submittedProblemCode"]').fill(`${problem.contestId}${problem.index}`);
      }
      await page.locator('select[name="programTypeId"]').selectOption(String(programTypeId));
      const prefix = monacoLanguage === 'python' ? '#' : '//';
      const nonce = `\n${prefix} musical-chairs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const content = `${source}${nonce}`;
      await page.locator('input[name="sourceFile"]').setInputFiles({
        name: srcFile,
        mimeType: 'text/plain',
        buffer: Buffer.from(content),
      });
      await page.locator('input[type="submit"]').first().click();
      const errors = await page.locator('.error').allInnerTexts();
      if (errors.length) throw new Error(errors.join(' ').trim());
      await page.goto(`${CF}/problemset/my`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const row = page.locator('tr[data-submission-id]').first();
      await row.waitFor({ state: 'attached', timeout: 30_000 });
      const id = Number(await row.getAttribute('data-submission-id'));
      if (!Number.isFinite(id)) throw new Error('Codeforces did not expose a submission id');
      account.submissions += 1;
      account.lastUsedAt = Date.now();
      return id;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    for (const context of this.contexts.values()) await context.close().catch(() => undefined);
    this.contexts.clear();
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.store.state.cfBridge.connected = false;
  }

  private async accountContext(browser: Browser, handle: string): Promise<BrowserContext> {
    const key = handle.toLowerCase();
    const existing = this.contexts.get(key);
    if (existing) return existing;
    const statePath = this.accountStatePath(handle);
    let storageState: string | undefined;
    try { await access(statePath); storageState = statePath; } catch { /* first login */ }
    const context = await browser.newContext(storageState ? { storageState } : undefined);
    this.contexts.set(key, context);
    return context;
  }

  private async newPage(browser: Browser): Promise<Page> {
    if (this.store.state.cfBridge.mode === 'launch') {
      const context = this.contexts.get('__persistent__');
      if (context) return context.newPage();
    }
    const contexts = browser.contexts();
    const context = contexts[0] ?? await browser.newContext();
    return context.newPage();
  }

  private accountStatePath(handle: string): string {
    return path.join(this.store.dir, `cf-${handle.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  private async acquireStatement(): Promise<void> {
    if (this.statementActive < 2) {
      this.statementActive += 1;
      return;
    }
    this.store.state.cfBridge.queueLength += 1;
    this.store.changed();
    await new Promise<void>((resolve) => this.statementQueue.push(resolve));
    this.store.state.cfBridge.queueLength = Math.max(0, this.store.state.cfBridge.queueLength - 1);
    this.statementActive += 1;
    this.store.changed();
  }

  private releaseStatement(): void {
    this.statementActive -= 1;
    this.statementQueue.shift()?.();
    this.store.changed();
  }
}
