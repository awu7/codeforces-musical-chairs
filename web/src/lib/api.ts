import { io, Socket } from 'socket.io-client';
import type { GameClock } from '../../../shared/types';

export function makeSocket(auth?: Record<string, string>): Socket {
  return io({ path: '/socket.io', auth, transports: ['websocket', 'polling'] });
}

export function emitAck<T>(s: Socket, ev: string, payload?: unknown, timeoutMs = 60000): Promise<T> {
  return new Promise((resolve, reject) => {
    s.timeout(timeoutMs).emit(ev, payload, (err: unknown, res: T) => (err ? reject(new Error('timeout')) : resolve(res)));
  });
}

const TOKEN_KEY = 'mc_admin_token';
export const adminToken = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string | null) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY)),
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const t = adminToken.get();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) throw new ApiError(r.status, (data as { error?: string })?.error ?? `${r.status} ${r.statusText}`);
  return data as T;
}

export async function download(path: string, filename: string) {
  const t = adminToken.get();
  const r = await fetch(`/api${path}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (!r.ok) throw new Error(`${r.status}`);
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Server clock offset tracking
let offset = 0;
export function syncClock(c: GameClock) {
  offset = c.serverNow - Date.now();
}
export const serverNow = () => Date.now() + offset;

export function remainingMs(c: GameClock | null): number | null {
  if (!c) return null;
  if (c.phase === 'running' && c.roundEndsAt) return Math.max(0, c.roundEndsAt - serverNow());
  if (c.phase === 'paused') return c.pausedRemainingMs;
  if (c.phase === 'transition' && c.transitionEndsAt) return Math.max(0, c.transitionEndsAt - serverNow());
  return null;
}

export function fmtMs(ms: number | null): string {
  if (ms == null) return '--:--';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

export const fmtTime = (t: number | null) => (t ? new Date(t).toLocaleTimeString() : '');
export const verdictShort: Record<string, string> = {
  OK: 'AC',
  WRONG_ANSWER: 'WA',
  TIME_LIMIT_EXCEEDED: 'TLE',
  MEMORY_LIMIT_EXCEEDED: 'MLE',
  RUNTIME_ERROR: 'RE',
  COMPILATION_ERROR: 'CE',
  IDLENESS_LIMIT_EXCEEDED: 'ILE',
  PRESENTATION_ERROR: 'PE',
  CHALLENGED: 'HACKED',
  SKIPPED: 'SKIP',
  FAILED: 'FAIL',
  PARTIAL: 'PART',
  REJECTED: 'REJ',
};
