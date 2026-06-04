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

export const PROJECT_ID_PREFIX = "hydra_plan_";

// Project identifiers prefix with `hydra_plan_` to match the sibling
// `hydra_session_` convention. A short random suffix avoids human-name
// collisions; we don't slugify the description because the description
// may contain anything and slugification is lossy.
export function newProjectId(): string {
  return `${PROJECT_ID_PREFIX}${randomBytes(6).toString("hex")}`;
}

// Accept either the full id (`hydra_plan_abc123`) or the bare suffix
// (`abc123`) and return the full form. Mirrors how `hydra-acp session
// <id>` accepts both forms.
export function canonicalProjectId(input: string): string {
  return input.startsWith(PROJECT_ID_PREFIX)
    ? input
    : `${PROJECT_ID_PREFIX}${input}`;
}

// Render a project id for user-visible output (CLI lists, agent
// messages) by stripping the prefix. Symmetric with hydra's session
// listings which show the short form.
export function shortProjectId(id: string): string {
  return id.startsWith(PROJECT_ID_PREFIX)
    ? id.slice(PROJECT_ID_PREFIX.length)
    : id;
}

const HYDRA_SESSION_PREFIX = "hydra_session_";

// Strip the `hydra_session_` prefix for user-visible output. Hydra's
// own resolveCanonicalId accepts both forms as input, and `hydra-acp
// session` (the table-list view) renders the short form — so showing
// the short form in planner output is both scannable and still
// paste-able into `hydra-acp --session <id>`.
export function shortSessionId(id: string): string {
  return id.startsWith(HYDRA_SESSION_PREFIX)
    ? id.slice(HYDRA_SESSION_PREFIX.length)
    : id;
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
// Pick the next task that's ready to be assigned: status === "pending"
// AND every dep is "done". Returns undefined when nothing is eligible
// (could be because everything's done, blocked, or in flight). Walks in
// declaration order — first eligible wins, which is deterministic.
export function pickEligible(board: Board): Task | undefined {
  const byId = new Map<string, Task>(board.tasks.map((t) => [t.id, t]));
  for (const task of board.tasks) {
    if (task.status !== "pending") continue;
    const blocked = task.deps.some((d) => byId.get(d)?.status !== "done");
    if (blocked) continue;
    return task;
  }
  return undefined;
}

// All tasks are terminal (done or failed). Used to decide when to emit
// the project-complete message and to stop spawning workers.
export function allTerminal(board: Board): boolean {
  if (board.tasks.length === 0) return false;
  return board.tasks.every((t) => t.status === "done" || t.status === "failed");
}

// Number of tasks currently in `assigned` state — i.e. workers
// actively running. The scheduler uses this against board.concurrencyCap
// to decide whether to spawn another worker.
export function inFlightCount(board: Board): number {
  let n = 0;
  for (const t of board.tasks) {
    if (t.status === "assigned") n += 1;
  }
  return n;
}

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
