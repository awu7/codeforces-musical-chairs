import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { GameConfig, Language, Problem, Submission, Team } from '../../../shared/types.js';
import { excludeSolvedProblems } from '../judging.js';
import { getProblemset, problemFromCf, problemIdentifier } from '../cf/api.js';
import { CodeforcesBridge } from '../cf/bridge.js';
import { GameEngine } from '../engine.js';
import { JudgingService } from '../judging.js';
import { Store, mergeConfig } from '../store.js';

export interface AdminDependencies {
  store: Store;
  engine: GameEngine;
  bridge: CodeforcesBridge;
  judging: JudgingService;
  tokenValid(token: string): boolean;
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

function route(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch((error: unknown) => {
      res.status(400).json({ error: (error as Error).message || 'Request failed' });
    });
  };
}

function requireTeam(store: Store, id: string): Team {
  const team = store.state.teams.find((item) => item.id === id);
  if (!team) throw new Error(`Team ${id} not found`);
  return team;
}

function requireProblem(store: Store, id: string): Problem {
  const problem = store.state.problems.find((item) => item.id === id);
  if (!problem) throw new Error(`Problem ${id} not found`);
  return problem;
}

function requireSubmission(store: Store, id: string): Submission {
  const submission = store.state.submissions.find((item) => item.id === id);
  if (!submission) throw new Error(`Submission ${id} not found`);
  return submission;
}

export function serializeAdminState(store: Store, engine: GameEngine) {
  const submissions = [...store.state.submissions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  return {
    config: store.state.config,
    clock: engine.clock(),
    lock: store.state.lock,
    announcement: store.state.announcement,
    teams: store.state.teams,
    attempts: store.state.attempts,
    submissions: submissions.map((item) => engine.submissionForClient(item)),
    problems: store.state.problems.map(({ statementHtml: _html, extraTests: _tests, ...problem }) => problem),
    languages: store.state.languages,
    cfAccounts: store.state.cfAccounts.map(({ password: _password, ...account }) => account),
    cfBridge: store.state.cfBridge,
    scoreboard: engine.scoreboard(),
    log: store.state.log,
  };
}

function publicSubmission(submission: Submission) {
  const { code: _code, cfAccount: _account, ...result } = submission;
  return result;
}

function enqueueStatement(problem: Problem, deps: AdminDependencies): void {
  problem.fetchStatus = 'pending';
  problem.fetchError = null;
  void deps.bridge.fetchStatement(problem).then((result) => {
    Object.assign(problem, result, { fetchStatus: 'ok', fetchError: null, fetchedAt: Date.now() });
    deps.store.log('info', `Fetched statement for ${problem.id}`);
    deps.engine.retryEmptySlots();
  }).catch((error: unknown) => {
    problem.fetchStatus = 'error';
    problem.fetchError = (error as Error).message;
    deps.store.log('warn', `Statement fetch failed for ${problem.id}: ${problem.fetchError}`);
    deps.engine.changed();
  });
}

function makeRouter(deps: AdminDependencies): Router {
  const router = Router();
  const { store, engine, bridge, judging } = deps;

  router.get('/state', (_req, res) => res.json(serializeAdminState(store, engine)));
  router.put('/config', route(async (req, res) => {
    const patch = req.body as Partial<GameConfig>;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Expected a config object');
    if (patch.roundMinutes !== undefined && !(Number(patch.roundMinutes) > 0)) throw new Error('roundMinutes must be positive');
    if (patch.selfSubmitPollSeconds !== undefined && !(Number(patch.selfSubmitPollSeconds) > 0)) throw new Error('selfSubmitPollSeconds must be positive');
    if (patch.selfSubmitColdPollSeconds !== undefined && !(Number(patch.selfSubmitColdPollSeconds) > 0)) throw new Error('selfSubmitColdPollSeconds must be positive');
    if (patch.selfSubmitHotMinutes !== undefined && !(Number(patch.selfSubmitHotMinutes) >= 0)) throw new Error('selfSubmitHotMinutes must be non-negative');
    if (patch.selfSubmitGraceSeconds !== undefined && !(Number(patch.selfSubmitGraceSeconds) >= 0)) throw new Error('selfSubmitGraceSeconds must be non-negative');
    const wasFrozen = store.state.config.freezeScoreboard;
    if (patch.freezeScoreboard && !wasFrozen) store.state.frozenScoreboard = engine.scoreboard();
    const config = mergeConfig(store.state.config, patch);
    if (!config.difficulty.step || config.difficulty.step < 1) throw new Error('difficulty.step must be positive');
    store.state.config = config;
    if (patch.lazyMode !== undefined) {
      for (const team of store.state.teams) team.lazyMode = Boolean(patch.lazyMode);
    }
    if (!config.freezeScoreboard) store.state.frozenScoreboard = null;
    store.log('info', 'Configuration updated');
    engine.changed();
    res.json(config);
  }));

  router.post('/game/start', route(async (_req, res) => { engine.start(); res.json({ ok: true }); }));
  router.post('/game/pause', route(async (_req, res) => { engine.pause(); res.json({ ok: true }); }));
  router.post('/game/resume', route(async (_req, res) => { engine.resume(); res.json({ ok: true }); }));
  router.post('/game/next-round', route(async (_req, res) => { engine.nextRound(); res.json({ ok: true }); }));
  router.post('/game/skip-transition', route(async (_req, res) => { engine.skipTransition(); res.json({ ok: true }); }));
  router.post('/game/start-round', route(async (_req, res) => { engine.startRound(); res.json({ ok: true }); }));
  router.post('/game/end', route(async (_req, res) => { engine.end(); res.json({ ok: true }); }));
  router.post('/game/reset', route(async (req, res) => {
    engine.reset(Boolean(req.body?.keepTeams), Boolean(req.body?.keepPool));
    res.json({ ok: true });
  }));
  router.post('/game/add-time', route(async (req, res) => {
    const seconds = Number(req.body?.seconds);
    if (!Number.isFinite(seconds)) throw new Error('seconds must be a number');
    engine.addTime(seconds);
    res.json({ ok: true, clock: engine.clock() });
  }));
  router.post('/game/set-remaining', route(async (req, res) => {
    const seconds = Number(req.body?.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('seconds must be non-negative');
    engine.setRemaining(seconds);
    res.json({ ok: true, clock: engine.clock() });
  }));
  router.post('/lock', route(async (req, res) => {
    store.state.lock = { locked: Boolean(req.body?.locked), message: String(req.body?.message ?? '') };
    store.log('info', store.state.lock.locked ? 'Clients locked by admin' : 'Client lock removed');
    engine.changed();
    res.json(store.state.lock);
  }));
  router.post('/announce', route(async (req, res) => {
    store.state.announcement = req.body?.text === null ? null : String(req.body?.text ?? '');
    engine.changed();
    res.json({ announcement: store.state.announcement });
  }));

  router.post('/teams', route(async (req, res) => {
    const team = engine.createTeam(String(req.body?.name ?? ''), Number(req.body?.size));
    res.status(201).json(team);
  }));
  router.post('/teams/bulk', route(async (req, res) => {
    const count = Number(req.body?.count);
    const size = Number(req.body?.size);
    const prefix = String(req.body?.prefix ?? 'Team');
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('count must be between 1 and 100');
    const teams = Array.from({ length: count }, (_, i) => engine.createTeam(`${prefix} ${i + 1}`, size));
    res.status(201).json(teams);
  }));
  router.put('/teams/:id', route(async (req, res) => {
    const team = requireTeam(store, String(req.params.id));
    const body = req.body as Partial<Team>;
    if (body.name !== undefined) team.name = String(body.name).trim();
    if (body.size !== undefined && Number(body.size) !== team.size) engine.resizeTeam(team, Number(body.size));
    if (body.rating !== undefined) team.rating = Number(body.rating);
    if (body.startRating !== undefined) team.startRating = body.startRating === null ? null : Number(body.startRating);
    if (body.lazyMode !== undefined) team.lazyMode = Boolean(body.lazyMode);
    if (body.enabled !== undefined) team.enabled = Boolean(body.enabled);
    engine.changed();
    res.json(team);
  }));
  router.delete('/teams/:id', route(async (req, res) => {
    const id = String(req.params.id);
    if (!store.state.teams.some((team) => team.id === id)) throw new Error(`Team ${id} not found`);
    store.state.teams = store.state.teams.filter((team) => team.id !== id);
    for (const attempt of store.state.attempts) {
      if (attempt.teamId === id && attempt.outcome === 'active') engine.finishAttempt(attempt, 'expired');
    }
    store.log('info', `Deleted team ${id}`);
    engine.changed();
    res.json({ ok: true });
  }));
  router.post('/teams/:id/regenerate-codes', route(async (req, res) => {
    const team = requireTeam(store, String(req.params.id));
    engine.regenerateCodes(team);
    res.json(team.seats);
  }));
  router.put('/teams/:id/seats/:index', route(async (req, res) => {
    const team = requireTeam(store, String(req.params.id));
    const index = Number(req.params.index);
    const seat = team.seats[index];
    if (!seat) throw new Error('Seat not found');
    seat.label = String(req.body?.label ?? '').trim() || seat.label;
    if (req.body?.cfHandle !== undefined) {
      const cfHandle = String(req.body.cfHandle).trim();
      if (cfHandle && !/^[A-Za-z0-9_.-]{3,24}$/.test(cfHandle)) throw new Error('Codeforces handle must be 3–24 letters, numbers, underscores, dots, or hyphens');
      seat.cfHandle = cfHandle || undefined;
    }
    engine.changed();
    res.json(seat);
  }));

  router.post('/slots/:id/replace', route(async (req, res) => {
    const found = engine.findSlot(String(req.params.id));
    if (!found) throw new Error('Slot not found');
    const active = engine.activeAttempt(found.slot);
    const oldTeamRating = found.team.rating;
    const oldSlotRating = found.slot.nextRating;
    if (active) engine.finishAttempt(active, 'skipped');
    if (req.body?.countAsSkip === false) {
      found.team.rating = oldTeamRating;
      found.slot.nextRating = oldSlotRating;
    }
    engine.drawReplacement(found.team, found.slot,
      req.body?.problemId ? String(req.body.problemId) : undefined,
      req.body?.rating === undefined ? undefined : Number(req.body.rating));
    engine.changed();
    res.json(found.slot);
  }));
  router.post('/slots/:id/solve', route(async (req, res) => {
    const found = engine.findSlot(String(req.params.id));
    if (!found) throw new Error('Slot not found');
    const attempt = engine.solve(found.slot, req.body?.seatIndex === undefined ? null : Number(req.body.seatIndex));
    if (!attempt) throw new Error('No active attempt on slot');
    res.json(attempt);
  }));
  router.put('/slots/:id', route(async (req, res) => {
    const found = engine.findSlot(String(req.params.id));
    if (!found) throw new Error('Slot not found');
    const body = req.body ?? {};
    if (body.nextRating !== undefined) found.slot.nextRating = Number(body.nextRating);
    if (body.roundsShown !== undefined) {
      const attempt = engine.activeAttempt(found.slot);
      if (attempt) attempt.roundsShown = Number(body.roundsShown);
    }
    if (body.lang !== undefined) found.slot.lang = String(body.lang);
    if (body.code !== undefined) found.slot.code = { ...body.code };
    if (body.input !== undefined) found.slot.input = String(body.input);
    found.slot.updatedAt = Date.now();
    engine.changed();
    res.json(found.slot);
  }));
  router.post('/slots/:id/clear-code', route(async (req, res) => {
    const found = engine.findSlot(String(req.params.id));
    if (!found) throw new Error('Slot not found');
    found.slot.code = {};
    found.slot.input = '';
    found.slot.updatedAt = Date.now();
    engine.changed();
    res.json(found.slot);
  }));

  router.get('/problems/export', (_req, res) => res.json({ problems: store.state.problems }));
  router.get('/problems', (_req, res) => res.json(store.state.problems));
  router.get('/problems/:id', route(async (req, res) => {
    res.json(requireProblem(store, String(req.params.id)));
  }));
  router.post('/problems', route(async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) throw new Error('ids must be an array');
    const cfProblems = await getProblemset();
    const added: Problem[] = [];
    const missing: string[] = [];
    for (const raw of ids) {
      const parsed = problemIdentifier(String(raw));
      if (!parsed) { missing.push(String(raw)); continue; }
      const meta = cfProblems.find((item) => item.contestId === parsed.contestId && item.index?.toUpperCase() === parsed.index);
      if (!meta) { missing.push(String(raw)); continue; }
      const problem = problemFromCf(meta);
      const duplicate = store.state.problems.find((item) => item.id === problem.id);
      if (duplicate) {
        if (req.body.rating !== undefined) duplicate.rating = Number(req.body.rating);
        added.push(duplicate);
        continue;
      }
      if (req.body.rating !== undefined) problem.rating = Number(req.body.rating);
      store.state.problems.push(problem);
      added.push(problem);
      enqueueStatement(problem, deps);
    }
    store.log('info', `Added ${added.length} Codeforces problems`);
    engine.changed();
    res.status(missing.length ? 207 : 201).json({ added, missing });
  }));
  router.post('/problems/manual', route(async (req, res) => {
    const body = req.body ?? {};
    const id = String(body.id ?? `manual-${randomBytes(5).toString('hex')}`);
    if (store.state.problems.some((item) => item.id === id)) throw new Error(`Problem ${id} already exists`);
    const [contestText, ...indexParts] = id.match(/^\d+[A-Za-z].*$/) ? [id.match(/^\d+/)?.[0] ?? '0', id.replace(/^\d+/, '')] : ['0', id];
    const problem: Problem = {
      id, contestId: Number(body.contestId ?? contestText) || 0,
      index: String(body.index ?? (indexParts.join('') || 'A')),
      name: String(body.name ?? id),
      rating: Number(body.rating ?? 800), cfRating: body.cfRating === undefined ? null : Number(body.cfRating),
      tags: Array.isArray(body.tags) ? body.tags.map(String) : [], enabled: body.enabled !== false,
      source: 'manual',
      statementHtml: body.statementHtml === undefined ? null : String(body.statementHtml),
      timeLimit: body.timeLimit === undefined ? null : String(body.timeLimit),
      memoryLimit: body.memoryLimit === undefined ? null : String(body.memoryLimit),
      samples: Array.isArray(body.samples) ? body.samples : [],
      extraTests: Array.isArray(body.extraTests) ? body.extraTests : [],
      fetchStatus: 'ok', fetchError: null, fetchedAt: Date.now(),
    };
    store.state.problems.push(problem);
    store.log('info', `Added manual problem ${id}`);
    engine.retryEmptySlots();
    engine.changed();
    res.status(201).json(problem);
  }));
  router.put('/problems/:id', route(async (req, res) => {
    const problem = requireProblem(store, String(req.params.id));
    const editable = ['name', 'rating', 'cfRating', 'tags', 'enabled', 'statementHtml', 'timeLimit', 'memoryLimit', 'samples', 'extraTests'] as const;
    for (const key of editable) if (req.body?.[key] !== undefined) {
      (problem as unknown as Record<string, unknown>)[key] = req.body[key];
    }
    engine.retryEmptySlots();
    engine.changed();
    res.json(problem);
  }));
  router.delete('/problems/:id', route(async (req, res) => {
    const id = String(req.params.id);
    requireProblem(store, id);
    store.state.problems = store.state.problems.filter((item) => item.id !== id);
    engine.changed();
    res.json({ ok: true });
  }));
  router.post('/problems/:id/refetch', route(async (req, res) => {
    const problem = requireProblem(store, String(req.params.id));
    enqueueStatement(problem, deps);
    engine.changed();
    res.json(problem);
  }));
  router.post('/problems/fetch-missing', route(async (_req, res) => {
    const missing = store.state.problems.filter((item) => item.source !== 'manual' && item.fetchStatus !== 'ok');
    for (const problem of missing) enqueueStatement(problem, deps);
    engine.changed();
    res.json({ queued: missing.length });
  }));
  router.post('/problems/bulk', route(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    let affected = 0;
    if (req.body?.delete) {
      store.state.problems = store.state.problems.filter((problem) => {
        if (!ids.includes(problem.id)) return true;
        affected += 1;
        return false;
      });
    } else for (const problem of store.state.problems) if (ids.includes(problem.id)) {
      if (req.body.enabled !== undefined) problem.enabled = Boolean(req.body.enabled);
      if (req.body.rating !== undefined) problem.rating = Number(req.body.rating);
      affected += 1;
    }
    engine.retryEmptySlots();
    engine.changed();
    res.json({ affected });
  }));
  router.post('/problems/bulk-add', route(async (req, res) => {
    const minRating = Number(req.body?.minRating);
    const maxRating = Number(req.body?.maxRating);
    const perRating = Number(req.body?.perRating);
    if (![minRating, maxRating, perRating].every(Number.isFinite) || perRating < 1) throw new Error('Invalid rating range or perRating');
    const pool = await getProblemset();
    const solved = req.body?.excludeSolvedBy?.length ? await excludeSolvedProblems(req.body.excludeSolvedBy.map(String)) : new Set<string>();
    const existing = new Set(store.state.problems.map((item) => item.id));
    const added: string[] = [];
    const include: string[] = Array.isArray(req.body?.includeTags) ? req.body.includeTags.map(String) : [];
    const exclude: string[] = Array.isArray(req.body?.excludeTags) ? req.body.excludeTags.map(String) : [];
    for (let rating = minRating; rating <= maxRating; rating += 100) {
      const candidates = pool.filter((item) => {
        if (item.rating !== rating || !item.contestId || !item.index) return false;
        if (req.body?.minContestId && item.contestId < Number(req.body.minContestId)) return false;
        if (include.length && !include.some((tag) => item.tags?.includes(tag))) return false;
        if (exclude.some((tag) => item.tags?.includes(tag))) return false;
        const id = `${item.contestId}${item.index}`;
        if (solved.has(id) || (req.body?.excludeExisting !== false && existing.has(id))) return false;
        return true;
      });
      for (let i = candidates.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
      }
      for (const item of candidates.slice(0, perRating)) {
        const problem = problemFromCf(item);
        store.state.problems.push(problem);
        existing.add(problem.id);
        added.push(problem.id);
        enqueueStatement(problem, deps);
      }
    }
    engine.changed();
    res.status(201).json({ added });
  }));
  router.post('/problems/import', route(async (req, res) => {
    if (!Array.isArray(req.body?.problems)) throw new Error('problems must be an array');
    let imported = 0;
    for (const problem of req.body.problems as Problem[]) {
      if (!problem?.id || !problem.name || store.state.problems.some((item) => item.id === problem.id)) continue;
      store.state.problems.push({
        ...problem,
        statementHtml: problem.statementHtml ?? null,
        extraTests: problem.extraTests ?? [],
        fetchStatus: problem.source === 'manual' ? 'ok' : problem.fetchStatus ?? 'none',
      });
      imported += 1;
    }
    engine.retryEmptySlots();
    engine.changed();
    res.status(201).json({ imported });
  }));

  router.get('/submissions/:id', route(async (req, res) => {
    res.json(requireSubmission(store, String(req.params.id)));
  }));
  router.post('/submissions/:id/rejudge', route(async (req, res) => {
    const submission = requireSubmission(store, String(req.params.id));
    await judging.rejudge(submission);
    res.json(publicSubmission(submission));
  }));
  router.post('/submissions/:id/verdict', route(async (req, res) => {
    const submission = requireSubmission(store, String(req.params.id));
    const verdict = String(req.body?.verdict ?? '').trim();
    if (!verdict) throw new Error('verdict is required');
    judging.override(submission, verdict);
    res.json(publicSubmission(submission));
  }));
  router.put('/languages', route(async (req, res) => {
    if (!Array.isArray(req.body)) throw new Error('Expected a language array');
    store.state.languages = req.body as Language[];
    engine.changed();
    res.json(store.state.languages);
  }));

  router.post('/cf/accounts', route(async (req, res) => {
    const handle = String(req.body?.handle ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!handle || !password) throw new Error('handle and password are required');
    if (store.state.cfAccounts.some((account) => account.handle.toLowerCase() === handle.toLowerCase())) {
      throw new Error(`Codeforces account ${handle} already exists`);
    }
    const account = {
      handle, password, enabled: true, status: 'idle' as const, lastError: null,
      submissions: 0, lastUsedAt: null,
    };
    store.state.cfAccounts.push(account);
    engine.changed();
    const { password: _password, ...publicAccount } = account;
    res.status(201).json(publicAccount);
  }));
  router.put('/cf/accounts/:handle', route(async (req, res) => {
    const account = store.state.cfAccounts.find((item) => item.handle.toLowerCase() === String(req.params.handle).toLowerCase());
    if (!account) throw new Error('Codeforces account not found');
    if (req.body?.enabled !== undefined) account.enabled = Boolean(req.body.enabled);
    if (req.body?.password !== undefined) account.password = String(req.body.password);
    engine.changed();
    const { password: _password, ...publicAccount } = account;
    res.json(publicAccount);
  }));
  router.delete('/cf/accounts/:handle', route(async (req, res) => {
    const handle = String(req.params.handle);
    store.state.cfAccounts = store.state.cfAccounts.filter((item) => item.handle.toLowerCase() !== handle.toLowerCase());
    engine.changed();
    res.json({ ok: true });
  }));
  router.post('/cf/accounts/:handle/login', route(async (req, res) => {
    await bridge.login(String(req.params.handle));
    const account = store.state.cfAccounts.find((item) => item.handle.toLowerCase() === String(req.params.handle).toLowerCase());
    if (!account) throw new Error('Codeforces account not found');
    const { password: _password, ...publicAccount } = account;
    res.json(publicAccount);
  }));
  router.put('/cf/bridge', route(async (req, res) => {
    if (req.body?.mode !== 'cdp' && req.body?.mode !== 'launch') throw new Error('mode must be cdp or launch');
    store.state.cfBridge = {
      ...store.state.cfBridge,
      mode: req.body.mode,
      cdpUrl: req.body.cdpUrl === undefined ? store.state.cfBridge.cdpUrl : String(req.body.cdpUrl),
    };
    engine.changed();
    res.json(store.state.cfBridge);
  }));
  router.post('/cf/bridge/restart', route(async (_req, res) => {
    await bridge.restart();
    res.json(store.state.cfBridge);
  }));

  router.get('/export/results.csv', (_req, res) => {
    const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [
      ['teamId', 'teamName', 'slotId', 'problemId', 'rating', 'outcome', 'startRound', 'endRound', 'activeMs', 'wrongSubmissions'],
      ...store.state.attempts.map((attempt) => {
        const team = store.state.teams.find((item) => item.id === attempt.teamId);
        return [attempt.teamId, team?.name, attempt.slotId, attempt.problemId, attempt.rating, attempt.outcome,
          attempt.startRound, attempt.endRound, attempt.activeMs, attempt.wrongSubmissions];
      }),
    ];
    res.type('text/csv').send(rows.map((row) => row.map(escape).join(',')).join('\n'));
  });
  router.get('/export/state.json', (_req, res) => res.json(store.state));
  router.post('/import/state', route(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || !req.body.config || !Array.isArray(req.body.teams)) {
      throw new Error('Invalid state import');
    }
    const imported = req.body as typeof store.state;
    store.state = imported;
    store.log('info', 'State imported');
    engine.changed();
    res.json({ ok: true });
  }));
  return router;
}

export function adminRouter(deps: AdminDependencies): Router {
  return makeRouter(deps);
}

export function adminTokenIsValid(deps: AdminDependencies, authorization: string | undefined): boolean {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  return deps.tokenValid(token);
}
