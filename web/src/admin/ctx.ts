import { createContext, useContext } from 'react';
import type { AdminState } from '../../../shared/types';

export interface AdminCtx {
  s: AdminState;
  act: (method: string, path: string, body?: unknown) => Promise<unknown>;
}
export const Ctx = createContext<AdminCtx | null>(null);
export const useAdmin = () => useContext(Ctx)!;

export const problemUrl = (_id: string, contestId: number, index: string) =>
  contestId >= 100000 ? `https://codeforces.com/gym/${contestId}/problem/${index}` : `https://codeforces.com/problemset/problem/${contestId}/${index}`;

export const minutes = (ms: number) => (ms / 60000).toFixed(1);
