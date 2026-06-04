// Connection config for talking to the hydra-acp daemon. The planner is
// daemon-managed (registered under `transformers` in hydra's config.json)
// so HYDRA_ACP_TOKEN and HYDRA_ACP_WS_URL / HYDRA_ACP_DAEMON_URL are
// injected by the daemon when it spawns us. They're absent when the
// binary runs as the user-facing CLI.

export interface Config {
  hydraWsUrl: string;
  hydraToken: string;
  debug: boolean;
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
  return { hydraWsUrl, hydraToken, debug };
}
