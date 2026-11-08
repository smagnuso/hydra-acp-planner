import { renameSync, unlinkSync } from "node:fs";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 20;

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RenameRetryDeps {
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => void;
  unlink?: (path: string) => void;
}

// Windows refuses to rename over a file another process holds open; retry briefly.
export function renameWithRetry(from: string, to: string, deps: RenameRetryDeps = {}): void {
  const rename = deps.rename ?? renameSync;
  const sleep = deps.sleep ?? sleepSync;
  const unlink = deps.unlink ?? unlinkSync;
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRYABLE.has(code) || attempt >= MAX_ATTEMPTS) {
        try {
          unlink(from);
        } catch {
          // tmp may already be gone
        }
        throw err;
      }
      sleep(BASE_DELAY_MS * attempt);
    }
  }
}
