import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function isInsideGitTree(dir: string): boolean {
  let cur = dir;
  for (;;) {
    if (existsSync(join(cur, ".git"))) {
      return true;
    }
    const parent = dirname(cur);
    if (parent === cur) {
      return false;
    }
    cur = parent;
  }
}
