import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { Problem, RunResult, Sample } from '../../../shared/types.js';
import { Store } from '../store.js';

const CF = 'https://codeforces.com';

export type ParsedCustomTestResponse =
  | { kind: 'submitted'; submitId: string }
  | { kind: 'pending' }
  | { kind: 'result'; result: RunResult };

type CustomTestRequest = {
  action: string;
  csrfToken: string;
  source?: string;
  programTypeId?: number;
  input?: string;
  customTestSubmitId?: string;
};

async function customTestRequest(request: CustomTestRequest): Promise<unknown> {
  const body = new URLSearchParams();
  body.set('action', request.action);
  body.set('csrf_token', request.csrfToken);
  if (request.source !== undefined) body.set('source', request.source);
  if (request.programTypeId !== undefined) body.set('programTypeId', String(request.programTypeId));
  if (request.input !== undefined) body.set('input', request.input);
  if (request.customTestSubmitId !== undefined) body.set('customTestSubmitId', request.customTestSubmitId);
  const response = await fetch('/data/customtest', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: body.toString(),
  });
  const text = await response.text();
  if (!response.ok) return { status: 'ERROR', error: `HTTP ${response.status}: ${text}` };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { status: 'ERROR', error: text || 'Codeforces returned a non-JSON response' };
  }
}

export function parseCustomTestResponse(json: unknown): ParsedCustomTestResponse {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { kind: 'result', result: customTestError(`Unexpected Codeforces response: ${String(json)}`) };
  }
  const response = json as Record<string, unknown>;
  const nested = response.result && typeof response.result === 'object' && !Array.isArray(response.result)
    ? response.result as Record<string, unknown>
    : response;
  const submitId = response.customTestSubmitId ?? response.customtestSubmitId ?? response.submitId
    ?? nested.customTestSubmitId ?? nested.submitId;
  if (submitId !== undefined && submitId !== null) return { kind: 'submitted', submitId: String(submitId) };
  const apiStatus = String(response.status ?? nested.status ?? '').toUpperCase();
  const stats = [
    response.stats,
    nested.stats,
    typeof response.result === 'string' ? response.result : null,
    response.time,
    nested.time,
    response.memory,
    nested.memory,
    response.message,
    nested.message,
    response.error,
    nested.error,
    response.comment,
    nested.comment,
  ].filter((value): value is string => typeof value === 'string').join(' ');
  const explicitVerdict = String(response.verdict ?? nested.verdict ?? '').toUpperCase();
  const verdict = explicitVerdict || stats.match(/\bverdict\s*:\s*([A-Z_]+)/i)?.[1]?.toUpperCase() || '';
  if (/\b(QUEUED|PENDING|TESTING|RUNNING|SUBMITTED)\b/i.test(`${apiStatus} ${verdict} ${stats}`)) {
    return { kind: 'pending' };
  }

  const outputValue = response.output ?? response.stdout ?? nested.output ?? nested.stdout ?? response.programOutput;
  const exitValue = response.exitCode ?? nested.exitCode;
  const output = typeof outputValue === 'string' ? outputValue : '';
  const compilerOutput = String(
    response.compileOutput ?? response.compilerOutput ?? nested.compileOutput ?? nested.compilerOutput ?? '',
  );
  const responseError = String(response.error ?? nested.error ?? response.message ?? nested.message ?? '');
  const details = `${verdict} ${stats} ${responseError} ${compilerOutput}`;
  const hasKnownTerminalStatus = /COMPIL(E|ATION)[_ ]ERROR|COMPILATION FAILED|TIME[_ ]LIMIT|TIMED?\s+OUT|TIMEOUT|MEMORY[_ ]LIMIT|MEMORY LIMIT|RUNTIME[_ ]ERROR|RUNTIME ERROR/i.test(details);
  const hasFinalResult = Boolean(
    verdict || (exitValue !== undefined && exitValue !== null) || /exit\s*code\s*:/i.test(stats) || hasKnownTerminalStatus,
  );
  if (!hasFinalResult && (!apiStatus || ['OK', 'SUCCESS', 'DONE'].includes(apiStatus))) return { kind: 'pending' };
  if (!['OK', 'SUCCESS', 'DONE'].includes(apiStatus) && apiStatus && !hasKnownTerminalStatus) {
    const message = String(response.error ?? nested.error ?? response.message ?? nested.message ?? `Codeforces response status: ${apiStatus}`);
    return { kind: 'result', result: customTestError(message) };
  }

  const parsedExit = exitValue === undefined || exitValue === null
    ? Number(stats.match(/exit\s*code\s*:\s*(-?\d+)/i)?.[1])
    : Number(exitValue);
  const exitCode = Number.isFinite(parsedExit) ? parsedExit : null;
  const timeValue = response.timeMs ?? nested.timeMs ?? response.time ?? nested.time;
  const timeNumber = typeof timeValue === 'number' || (typeof timeValue === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(timeValue))
    ? Number(timeValue)
    : NaN;
  const timeMatch = stats.match(/\btime\s*:\s*([\d.]+)\s*(ms|msec|s|sec(?:ond)?s?)\b/i);
  const timeMs = Number.isFinite(timeNumber)
    ? timeNumber
    : timeMatch ? Number(timeMatch[1]) * (/^s/i.test(timeMatch[2]!) ? 1000 : 1) : 0;
  const stderr = String(response.stderr ?? nested.stderr ?? response.error ?? nested.error ?? '');
  let status: RunResult['status'];
  if (/COMPIL(E|ATION)[_ ]ERROR|COMPILATION FAILED/i.test(details)) status = 'compile_error';
  else if (/TIME[_ ]LIMIT|TIMED?\s+OUT|TIMEOUT/i.test(details)) status = 'timeout';
  else if (/MEMORY[_ ]LIMIT|MEMORY LIMIT/i.test(details)) status = 'memory';
  else if (/RUNTIME[_ ]ERROR|RUNTIME ERROR/i.test(details) || (exitCode !== null && exitCode !== 0)) status = 'runtime_error';
  else if (verdict === 'OK' || (['OK', 'SUCCESS', 'DONE'].includes(apiStatus) && exitCode === 0)) status = 'ok';
  else {
    return {
      kind: 'result',
      result: customTestError(String(response.error ?? nested.error ?? stats ?? 'Could not parse Codeforces custom invocation result')),
    };
  }
  return {
    kind: 'result',
    result: {
      status,
      stdout: output,
      stderr: stderr || (status === 'runtime_error' ? stats : ''),
      compileOutput: compilerOutput || (status === 'compile_error' ? responseError || stats : ''),
      timeMs,
      exitCode,
      truncated: false,
    },
  };
}

function customTestError(stderr: string): RunResult {
  return { status: 'error', stdout: '', stderr, compileOutput: '', timeMs: 0, exitCode: null, truncated: false };
}

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
  private customTestPages = new Map<string, Page>();
  private statementActive = 0;
  private statementQueue: Array<() => void> = [];
  private nextStatementAt = 0;

  constructor(private readonly store: Store) {
    this.store.state.cfBridge.connected = false;
  }

  async restart(): Promise<void> {
    for (const context of this.contexts.values()) await context.close().catch(() => undefined);
    this.contexts.clear();
    this.customTestPages.clear();
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

  async customTest(handle: string, source: string, programTypeId: number, input: string): Promise<RunResult> {
    const account = this.store.state.cfAccounts.find((item) => item.handle.toLowerCase() === handle.toLowerCase());
    if (!account || !account.enabled) throw new Error(`No enabled Codeforces account configured for ${handle}`);
    const browser = await this.connect();
    const context = await this.accountContext(browser, account.handle);
    const key = account.handle.toLowerCase();
    let page = this.customTestPages.get(key);
    if (!page || page.isClosed()) {
      page = await context.newPage();
      try {
        await page.goto(`${CF}/problemset/customtest`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (error) {
        await page.close().catch(() => undefined);
        throw error;
      }
      this.customTestPages.set(key, page);
    }
    let headerHandle = await page.locator('#header a[href*="/profile/"]').allInnerTexts();
    if (!headerHandle.some((text) => text.trim().toLowerCase() === account.handle.toLowerCase())) {
      await page.goto(`${CF}/problemset/customtest`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      headerHandle = await page.locator('#header a[href*="/profile/"]').allInnerTexts();
    }
    if (!headerHandle.some((text) => text.trim().toLowerCase() === account.handle.toLowerCase())) {
      throw new Error(`Codeforces account ${account.handle} is not logged in; use the account login endpoint`);
    }
    const csrf = page.locator('input[name="csrf_token"]').first();
    if (!(await csrf.count())) throw new Error('Codeforces custom-test page did not expose input[name="csrf_token"]');
    const csrfToken = await csrf.inputValue();
    if (!csrfToken) throw new Error('Codeforces custom-test page exposed an empty csrf_token');
    const submitted = await page.evaluate(customTestRequest, {
      action: 'submitSourceCode',
      csrfToken,
      source,
      programTypeId,
      input,
    });
    this.logCustomTestResponse(account.handle, 'submitSourceCode', submitted);
    const parsedSubmission = parseCustomTestResponse(submitted);
    if (parsedSubmission.kind !== 'submitted') {
      return parsedSubmission.kind === 'result' ? parsedSubmission.result : customTestError('Codeforces did not accept the custom invocation request');
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      const response = await page.evaluate(customTestRequest, {
        action: 'getVerdict',
        csrfToken,
        customTestSubmitId: parsedSubmission.submitId,
      });
      this.logCustomTestResponse(account.handle, 'getVerdict', response);
      const parsed = parseCustomTestResponse(response);
      if (parsed.kind === 'result') return parsed.result;
    }
    return { status: 'timeout', stdout: '', stderr: 'Codeforces custom invocation timed out after 60 seconds', compileOutput: '', timeMs: 60_000, exitCode: null, truncated: false };
  }

  async close(): Promise<void> {
    for (const context of this.contexts.values()) await context.close().catch(() => undefined);
    this.contexts.clear();
    this.customTestPages.clear();
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

  private logCustomTestResponse(handle: string, action: string, response: unknown): void {
    this.store.log('info', `Codeforces custom invocation ${handle} ${action}: ${String(JSON.stringify(response)).slice(0, 500)}`);
    this.store.changed();
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
