import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  boardPath,
  orchestratorPointerPath,
  projectDir,
  projectsDir,
} from "./paths.js";

export const BOARD_SCHEMA_VERSION = 1;

export type TaskStatus = "pending" | "assigned" | "done" | "failed" | "blocked";
export type BoardState = "decomposing" | "running" | "done" | "failed";

export interface TaskArtifacts {
  files_changed?: string[];
  summary?: string;
  decisions?: string[];
  assumptions?: string[];
  follow_ups?: string[];
}

export interface Task {
  id: string;
  title: string;
  why?: string;
  what?: string;
  constraints?: string;
  deps: string[];
  agent?: string | null;
  model?: string | null;
  status: TaskStatus;
  assignedTo?: string | null;
  attemptCount: number;
  artifacts?: TaskArtifacts | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface Board {
  version: number;
  projectId: string;
  description: string;
  state: BoardState;
  createdAt: string;
  updatedAt: string;
  fleetDefaults: { agent: string | null; model: string | null };
  tasks: Task[];
  workers: Record<string, { currentTaskId: string | null; tasksCompleted: string[] }>;
  concurrencyCap: number;
}

// Project identifiers prefix with `proj_` so they sort/scan distinct
// from session ids (`hydra_session_…`). A short random suffix avoids
// human-name collisions; we don't slugify the description because the
// description may contain anything and slugification is lossy.
export function newProjectId(): string {
  return `proj_${randomBytes(6).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newBoard(opts: {
  description: string;
  fleetDefaults?: { agent: string | null; model: string | null };
}): Board {
  const now = nowIso();
  return {
    version: BOARD_SCHEMA_VERSION,
    projectId: newProjectId(),
    description: opts.description,
    state: "decomposing",
    createdAt: now,
    updatedAt: now,
    fleetDefaults: opts.fleetDefaults ?? { agent: null, model: null },
    tasks: [],
    workers: {},
    concurrencyCap: 1,
  };
}

export function loadBoard(projectId: string): Board | undefined {
  try {
    const raw = readFileSync(boardPath(projectId), "utf8");
    const parsed = JSON.parse(raw) as Board;
    return parsed;
  } catch {
    return undefined;
  }
}

// Atomic write: temp file → rename. Avoids partial-write corruption
// if the process is killed mid-save. Crash safety is the only
// invariant we maintain here; in-process ordering is the transformer's
// single event loop (single writer, no concurrency).
export function saveBoard(board: Board, orchestratorSessionId: string): void {
  board.updatedAt = nowIso();
  const dir = projectDir(board.projectId);
  mkdirSync(dir, { recursive: true });
  const target = boardPath(board.projectId);
  const tmp = `${target}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(board, null, 2));
  renameSync(tmp, target);
  // Persist the orchestrator session pointer so cold-start recovery can
  // reverse-map projectId -> session without scanning every session.
  writeFileSync(orchestratorPointerPath(board.projectId), `${orchestratorSessionId}\n`);
}

export interface ProjectIndexEntry {
  projectId: string;
  orchestratorSessionId: string | undefined;
  description: string;
  state: BoardState;
  tasksTotal: number;
  tasksDone: number;
  createdAt: string;
  updatedAt: string;
}

// Walk the projects directory, load each board summary. Used by the
// CLI `list` verb and by transformer cold-start recovery. Returns
// nothing about archived projects — those live under archive/ and have
// their own walk routine when needed.
export function listProjects(): ProjectIndexEntry[] {
  const dir = projectsDir();
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ProjectIndexEntry[] = [];
  for (const projectId of entries) {
    const board = loadBoard(projectId);
    if (!board) continue;
    let orchestratorSessionId: string | undefined;
    try {
      orchestratorSessionId = readFileSync(orchestratorPointerPath(projectId), "utf8")
        .trim();
    } catch {
      orchestratorSessionId = undefined;
    }
    out.push({
      projectId: board.projectId,
      orchestratorSessionId,
      description: board.description,
      state: board.state,
      tasksTotal: board.tasks.length,
      tasksDone: board.tasks.filter((t) => t.status === "done").length,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
    });
  }
  // Most-recent-first matches `hydra-acp session` and aligns with how
  // people scan project lists ("what was I working on?").
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}
