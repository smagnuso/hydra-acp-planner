#!/usr/bin/env node
// Single binary, two modes:
//
//   1. Transformer mode — when spawned by the hydra-acp daemon, the env
//      var HYDRA_ACP_TRANSFORMER_NAME is set. We connect to the daemon
//      over WSS, register intercepts, and run the planner's scheduling
//      loop until shutdown.
//
//   2. CLI mode — invoked from the user's shell (typically via
//      `hydra-acp planner ...` which execs us per the git-style
//      subcommand fallback). We parse argv and dispatch to the
//      user-facing commands defined in cli.ts.

import { loadTransformerConfig } from "./config.js";
import { PlannerBridge } from "./bridge.js";
import { runCli } from "./cli.js";
import { logger, setDebug } from "./util/log.js";

const log = logger("main");

async function runTransformer(): Promise<void> {
  const config = loadTransformerConfig();
  setDebug(config.debug);

  const bridge = new PlannerBridge({
    daemonWsUrl: config.hydraWsUrl,
    token: config.hydraToken,
    defaultAgent: config.defaultAgent,
    defaultModels: config.defaultModels,
  });
  bridge.start();

  const shutdown = (sig: string): void => {
    log.info(`${sig} received — shutting down`);
    bridge.stop();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info(`hydra-acp-planner up; daemon=${config.hydraWsUrl}`);
}

async function main(): Promise<void> {
  if (process.env.HYDRA_ACP_TRANSFORMER_NAME) {
    await runTransformer();
    return;
  }
  runCli(process.argv.slice(2));
}

main().catch((err) => {
  process.stderr.write(`hydra-acp-planner: ${(err as Error).message}\n`);
  process.exit(1);
});
