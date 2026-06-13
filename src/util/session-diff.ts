// Minimal stub. Repo HEAD references this module from bridge.ts but the
// file is missing in HEAD (presumed lost between earlier tasks). Out of
// scope for T6; this is the smallest surface that lets bridge.ts compile
// and tests run. Replace with the real diff implementation.

export interface DiffHunk {
  header: string;
  lines: string[];
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
}

export function httpBaseFromWsUrl(wsUrl: string): string {
  if (wsUrl.startsWith("wss://")) {
    return "https://" + wsUrl.slice("wss://".length);
  }
  if (wsUrl.startsWith("ws://")) {
    return "http://" + wsUrl.slice("ws://".length);
  }
  return wsUrl;
}

export async function fetchSessionDiff(
  _sessionId: string,
  _opts: { daemonHttpBase: string; token: string },
): Promise<DiffFile[] | undefined> {
  return undefined;
}

export function summarizeDiff(diff: DiffFile[]): string {
  if (diff.length === 0) {
    return "";
  }
  const first = diff[0]!;
  const head = `${first.path}: ${first.hunks.length} hunk(s)`;
  return diff.length === 1 ? head : `${head} (+${diff.length - 1} more)`;
}
