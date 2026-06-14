// Connection config for talking to the hydra-acp daemon. The planner is
// daemon-managed (registered under `transformers` in hydra's config.json)
// so HYDRA_ACP_TOKEN and HYDRA_ACP_WS_URL / HYDRA_ACP_DAEMON_URL are
// injected by the daemon when it spawns us. They're absent when the
// binary runs as the user-facing CLI.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Config {
  hydraWsUrl: string;
  hydraToken: string;
  debug: boolean;
  // Worker-lane floor: when a task's resolved agent is null, fall back
  // to this id instead of letting the daemon pick (which inherits the
  // orchestrator's agent — typically the user's "talking" agent like
  // opus). Orchestrator-lane tasks are unaffected.
  defaultAgent?: string;
  // Per-agent floor model. Passed via _meta["hydra-acp"].model on
  // child_session/spawn so the worker is born on this model instead
  // of the agent's default. The task's resolved model (if any) still
  // wins via the post-spawn set_model call — this is the safety net
  // for "agent gave me a bad model id" or "no per-task model set".
  defaultModels?: Record<string, string>;
}

// Disk layout: ~/.hydra-acp/planner.json (sibling of the daemon's
// config.json). Shape:
//   { "defaultAgent": "claude", "defaultModels": { "claude": "claude-sonnet-4-5" } }
// Env vars (HYDRA_ACP_PLANNER_DEFAULT_AGENT, HYDRA_ACP_PLANNER_DEFAULT_MODELS)
// override the file when both are present, so one-off overrides don't
// require editing the file. HYDRA_ACP_PLANNER_CONFIG=<path> selects a
// different file (test fixtures, alternate profile).
interface PlannerFileConfig {
  defaultAgent?: string;
  defaultModels?: Record<string, string>;
}

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return "wss://" + httpUrl.slice("https://".length).replace(/\/$/, "") + "/acp";
  }
  if (httpUrl.startsWith("http://")) {
    return "ws://" + httpUrl.slice("http://".length).replace(/\/$/, "") + "/acp";
  }
  throw new Error(
    `HYDRA_ACP_DAEMON_URL must start with http:// or https://: ${httpUrl}`,
  );
}

const TRUTHY = new Set(["1", "true", "yes", "on", "t"]);

function plannerConfigPath(): string {
  const override = process.env.HYDRA_ACP_PLANNER_CONFIG;
  if (override && override.length > 0) {
    return override;
  }
  const home = process.env.HYDRA_ACP_HOME ?? path.join(os.homedir(), ".hydra-acp");
  return path.join(home, "planner.json");
}

function loadPlannerFile(): PlannerFileConfig {
  const file = plannerConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    process.stderr.write(
      `hydra-acp-planner: cannot read ${file}: ${(err as Error).message}\n`,
    );
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `hydra-acp-planner: ignoring ${file} — invalid JSON: ${(err as Error).message}\n`,
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    process.stderr.write(
      `hydra-acp-planner: ignoring ${file} — expected JSON object at top level\n`,
    );
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const out: PlannerFileConfig = {};
  if (typeof obj.defaultAgent === "string" && obj.defaultAgent.length > 0) {
    out.defaultAgent = obj.defaultAgent;
  }
  const models = sanitizeModelMap(obj.defaultModels, `${file}:defaultModels`);
  if (models) {
    out.defaultModels = models;
  }
  return out;
}

function sanitizeModelMap(raw: unknown, source: string): Record<string, string> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    process.stderr.write(
      `hydra-acp-planner: ignoring ${source} — expected object of agentId → modelId\n`,
    );
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseEnvModels(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `hydra-acp-planner: ignoring HYDRA_ACP_PLANNER_DEFAULT_MODELS — invalid JSON: ${(err as Error).message}\n`,
    );
    return undefined;
  }
  return sanitizeModelMap(parsed, "HYDRA_ACP_PLANNER_DEFAULT_MODELS");
}

export function loadTransformerConfig(): Config {
  const hydraDaemonUrl = process.env.HYDRA_ACP_DAEMON_URL ?? "http://127.0.0.1:55514";
  const hydraToken = process.env.HYDRA_ACP_TOKEN ?? "";
  if (!hydraToken) {
    throw new Error(
      "Missing HYDRA_ACP_TOKEN env var. When run as a hydra transformer, " +
        "hydra injects this automatically.",
    );
  }
  const hydraWsUrl = process.env.HYDRA_ACP_WS_URL ?? deriveWsUrl(hydraDaemonUrl);
  const debug = TRUTHY.has((process.env.DEBUG ?? "").toLowerCase());

  const file = loadPlannerFile();
  const envAgent = process.env.HYDRA_ACP_PLANNER_DEFAULT_AGENT || undefined;
  const envModels = parseEnvModels(process.env.HYDRA_ACP_PLANNER_DEFAULT_MODELS);

  // Env wins over file. defaultModels merges per-key (env keys override
  // file keys, file keys untouched by env survive).
  const defaultAgent = envAgent ?? file.defaultAgent;
  let defaultModels: Record<string, string> | undefined;
  if (file.defaultModels || envModels) {
    defaultModels = { ...(file.defaultModels ?? {}), ...(envModels ?? {}) };
  }

  return { hydraWsUrl, hydraToken, debug, defaultAgent, defaultModels };
}
