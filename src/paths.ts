import { homedir } from "node:os";
import { resolve } from "node:path";

// All planner persistent state lives under ~/.hydra-acp/planner/ — a
// peer of ~/.hydra-acp/sessions/ and ~/.hydra-acp/agents/. Planner owns
// this tree exclusively; nothing else under .hydra-acp/ reads or writes
// here.
//
//   ~/.hydra-acp/planner/
//   ├── projects/
//   │   └── <projectId>/
//   │       ├── board.json
//   │       └── orchestrator     (file containing the orchestrator sessionId)
//   └── archive/
//       └── <projectId>/
//           ├── board.json
//           ├── orchestrator.hydra
//           └── workers/

export function plannerHome(): string {
  return resolve(homedir(), ".hydra-acp", "planner");
}

export function projectsDir(): string {
  return resolve(plannerHome(), "projects");
}

export function archiveDir(): string {
  return resolve(plannerHome(), "archive");
}

export function projectDir(projectId: string): string {
  return resolve(projectsDir(), projectId);
}

export function boardPath(projectId: string): string {
  return resolve(projectDir(projectId), "board.json");
}

export function orchestratorPointerPath(projectId: string): string {
  return resolve(projectDir(projectId), "orchestrator");
}
