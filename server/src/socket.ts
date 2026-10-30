import { randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { RunRequest, RunResult } from '../../shared/types.js';
import type { Runner } from './isolate.js';
import { GameEngine } from './engine.js';
import { JudgingService } from './judging.js';
import { Store } from './store.js';
import { serializeAdminState } from './routes/admin.js';

interface SocketDependencies {
  httpServer: HttpServer;
  store: Store;
  engine: GameEngine;
  runner: Runner;
  judging: JudgingService;
  tokenValid(token: string): boolean;
}

type Ack = (result: any) => void;
type JoinedSeat = { teamId: string; seatIndex: number; code: string };

function capOutput(text: string, limitBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= limitBytes) return { text, truncated: false };
  return { text: buffer.subarray(0, limitBytes).toString('utf8'), truncated: true };
}

export function createSocketServer(deps: SocketDependencies): Server {
  const { httpServer, store, engine, runner, judging } = deps;
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
  const joined = new Map<string, JoinedSeat>();
  const activeRuns = new Set<string>();
  let adminTimer: NodeJS.Timeout | null = null;
  let previousPhase = store.state.phase;

  const pushState = () => {
    for (const [socketId, identity] of joined) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) { joined.delete(socketId); continue; }
      const team = store.state.teams.find((item) => item.id === identity.teamId);
      const seat = team?.seats[identity.seatIndex];
      if (!team || !team.enabled || !seat || seat.code !== identity.code) {
        socket.emit('seat:kicked', {
          reason: !team ? 'Team deleted' : !team.enabled ? 'Team disabled' : 'Seat code regenerated',
        });
        if (seat) {
          seat.connected = Math.max(0, seat.connected - 1);
          seat.lastSeen = Date.now();
        }
        socket.leave(`seat:${identity.teamId}:${identity.seatIndex}`);
        joined.delete(socketId);
        delete socket.data.joinedSeat;
        continue;
      }
      socket.emit('seat:view', engine.seatView(team, seat));
    }
    const phase = store.state.phase;
    if (phase !== previousPhase) {
      io.emit('clock', engine.clock());
      previousPhase = phase;
    }
    if (!adminTimer) {
      adminTimer = setTimeout(() => {
        adminTimer = null;
        io.to('admin').emit('admin:state', serializeAdminState(store, engine));
      }, 250);
      adminTimer.unref();
    }
  };

  const snapshotClock = setInterval(() => io.emit('clock', engine.clock()), 10_000);
  snapshotClock.unref();
  store.on('change', pushState);

  io.on('connection', (socket) => {
    const token = String(socket.handshake.auth?.adminToken ?? '');
    socket.data.isAdmin = token.length > 0 && deps.tokenValid(token);
    if (socket.data.isAdmin) socket.join('admin');

    socket.on('admin:subscribe', (ack?: Ack) => {
      if (!socket.data.isAdmin) {
        ack?.({ ok: false, error: 'Admin authentication required' });
        return;
      }
      ack?.({ ok: true, state: serializeAdminState(store, engine) });
      socket.emit('admin:state', serializeAdminState(store, engine));
    });

    socket.on('seat:join', (payload: unknown, ack?: Ack) => {
      const code = String((payload as { code?: unknown })?.code ?? '').trim().toUpperCase();
      const found = engine.findSeat(code);
      if (!found || !found.team.enabled) {
        ack?.({ ok: false, error: 'Invalid seat code' });
        return;
      }
      const previous = joined.get(socket.id);
      if (previous) {
        const previousSeat = store.state.teams.find((item) => item.id === previous.teamId)?.seats[previous.seatIndex];
        if (previousSeat) {
          previousSeat.connected = Math.max(0, previousSeat.connected - 1);
          previousSeat.lastSeen = Date.now();
        }
        socket.leave(`seat:${previous.teamId}:${previous.seatIndex}`);
      }
      const identity: JoinedSeat = { teamId: found.team.id, seatIndex: found.seat.index, code };
      joined.set(socket.id, identity);
      socket.data.joinedSeat = identity;
      socket.join(`seat:${identity.teamId}:${identity.seatIndex}`);
      found.seat.connected += 1;
      found.seat.lastSeen = Date.now();
      store.changed();
      ack?.({ ok: true, view: engine.seatView(found.team, found.seat) });
    });

    socket.on('slot:update', (payload: unknown, ack?: Ack) => {
      const identity = joined.get(socket.id);
      if (!identity) { ack?.({ ok: false, error: 'Join a seat first' }); return; }
      const data = (payload ?? {}) as { slotId?: string; lang?: string; code?: string; input?: string };
      const found = data.slotId ? engine.findSlot(data.slotId) : undefined;
      if (!found || found.team.id !== identity.teamId) { ack?.({ ok: false, error: 'Slot not found for this team' }); return; }
      const currentSeat = found.slot.seatIndex === identity.seatIndex;
      if (!currentSeat && !engine.acceptsLateFlush(found.slot.id, identity.seatIndex)) {
        ack?.({ ok: false, error: 'Slot is no longer at this seat' });
        return;
      }
      if (store.state.phase === 'setup' || store.state.phase === 'finished') {
        ack?.({ ok: false, error: `Editing is unavailable while ${store.state.phase}` });
        return;
      }
      if (store.state.lock.locked) { ack?.({ ok: false, error: 'Clients are locked by admin' }); return; }
      const lang = data.lang ?? found.slot.lang;
      if (data.lang && !store.state.config.allowLanguageSwitch && data.lang !== found.slot.lang) {
        ack?.({ ok: false, error: 'Language switching is disabled' });
        return;
      }
      if (data.lang && !store.state.languages.some((item) => item.id === data.lang && item.enabled)) {
        ack?.({ ok: false, error: 'Language is not enabled' });
        return;
      }
      if (data.lang) found.slot.lang = data.lang;
      if (data.code !== undefined) found.slot.code[lang] = data.code;
      if (data.input !== undefined) found.slot.input = data.input;
      found.slot.updatedAt = Date.now();
      store.changed();
      ack?.({ ok: true });
    });

    socket.on('run', async (payload: RunRequest, ack?: Ack) => {
      const identity = joined.get(socket.id);
      const error = (message: string) => ({ status: 'error', stdout: '', stderr: message, compileOutput: '', timeMs: 0, memoryKb: null, exitCode: null, truncated: false });
      if (!identity) { ack?.(error('Join a seat first')); return; }
      if (!store.state.config.allowLocalRun) { ack?.(error('Local runs are disabled')); return; }
      if (store.state.lock.locked) { ack?.(error('Clients are locked by admin')); return; }
      if (store.state.phase !== 'running') { ack?.(error('Run is only available while the game is running')); return; }
      const found = engine.findSlot(payload?.slotId ?? '');
      if (!found || found.team.id !== identity.teamId || found.slot.seatIndex !== identity.seatIndex) {
        ack?.(error('Slot is not at this seat'));
        return;
      }
      const seatKey = `${identity.teamId}:${identity.seatIndex}`;
      if (activeRuns.has(seatKey)) { ack?.(error('A run is already active for this seat')); return; }
      const language = store.state.languages.find((item) => item.id === payload.lang && item.enabled);
      if (!language) { ack?.(error('Language is not enabled')); return; }
      activeRuns.add(seatKey);
      try {
        const result: RunResult = await runner.run(language, payload.code, payload.input, {
          timeMs: store.state.config.runTimeLimitMs,
          memoryMb: store.state.config.runMemoryMb,
        });
        const displayLimitBytes = Math.max(1, Math.floor(store.state.config.outputLimitKb)) * 1024;
        const stdout = capOutput(result.stdout, displayLimitBytes);
        const stderr = capOutput(result.stderr, displayLimitBytes);
        const compileOutput = capOutput(result.compileOutput, displayLimitBytes);
        ack?.({
          ...result,
          stdout: stdout.text,
          stderr: stderr.text,
          compileOutput: compileOutput.text,
          truncated: result.truncated || stdout.truncated || stderr.truncated || compileOutput.truncated,
        });
      } catch (caught) {
        ack?.(error((caught as Error).message));
      } finally {
        activeRuns.delete(seatKey);
      }
    });

    socket.on('submit', (payload: unknown, ack?: Ack) => {
      const identity = joined.get(socket.id);
      if (!identity) { ack?.({ ok: false, error: 'Join a seat first' }); return; }
      if (store.state.lock.locked) { ack?.({ ok: false, error: 'Clients are locked by admin' }); return; }
      if (store.state.phase !== 'running') { ack?.({ ok: false, error: 'Submissions are only accepted while running' }); return; }
      if (store.state.config.judgeMode === 'cf_self') {
        ack?.({ ok: false, error: 'Submit on Codeforces from your browser in self-submit mode' });
        return;
      }
      const data = (payload ?? {}) as { slotId?: string; lang?: string; code?: string };
      const found = data.slotId ? engine.findSlot(data.slotId) : undefined;
      if (!found || found.team.id !== identity.teamId || found.slot.seatIndex !== identity.seatIndex) {
        ack?.({ ok: false, error: 'Slot is not at this seat' });
        return;
      }
      const attempt = engine.activeAttempt(found.slot);
      if (!attempt) { ack?.({ ok: false, error: 'No active problem in this slot' }); return; }
      const langId = data.lang ?? found.slot.lang;
      const language = store.state.languages.find((item) => item.id === langId && item.enabled);
      if (!language) { ack?.({ ok: false, error: 'Language is not enabled' }); return; }
      if (!store.state.config.allowLanguageSwitch && langId !== found.slot.lang) {
        ack?.({ ok: false, error: 'Language switching is disabled' });
        return;
      }
      const cooldownKey = `${identity.teamId}:${identity.seatIndex}`;
      const previous = store.state.lastSubmissionAt[cooldownKey] ?? 0;
      const waitMs = store.state.config.submissionCooldownSeconds * 1000 - (Date.now() - previous);
      if (waitMs > 0) { ack?.({ ok: false, error: `Submission cooldown: ${Math.ceil(waitMs / 1000)}s` }); return; }
      const count = store.state.submissions.filter((item) => item.attemptId === attempt.id).length;
      const max = store.state.config.maxSubmissionsPerProblem;
      if (max !== null && count >= max) { ack?.({ ok: false, error: 'Maximum submissions reached for this problem' }); return; }
      store.state.lastSubmissionAt[cooldownKey] = Date.now();
      const submission = {
        id: randomBytes(10).toString('base64url'),
        teamId: identity.teamId,
        slotId: found.slot.id,
        seatIndex: identity.seatIndex,
        attemptId: attempt.id,
        problemId: attempt.problemId,
        lang: langId,
        code: data.code ?? found.slot.code[langId] ?? '',
        createdAt: Date.now(),
        judge: store.state.config.judgeMode,
        source: 'server' as const,
        status: 'queued' as const,
        verdict: null,
        passedTests: null,
        failedTest: null,
        timeMs: null,
        memoryKb: null,
        cfSubmissionId: null,
        cfAccount: null,
        message: null,
        overridden: false,
      };
      store.state.submissions.push(submission);
      store.log('info', `Submission ${submission.id} queued for ${attempt.problemId}`);
      store.changed();
      void judging.judge(submission);
      ack?.({ ok: true, submissionId: submission.id });
    });

    socket.on('disconnect', () => {
      const identity = joined.get(socket.id);
      if (!identity) return;
      joined.delete(socket.id);
      const team = store.state.teams.find((item) => item.id === identity.teamId);
      const seat = team?.seats[identity.seatIndex];
      if (seat) {
        seat.connected = Math.max(0, seat.connected - 1);
        seat.lastSeen = Date.now();
      }
      store.changed();
    });
  });

  io.on('close', () => {
    clearInterval(snapshotClock);
    if (adminTimer) clearTimeout(adminTimer);
    store.off('change', pushState);
  });
  return io;
}
