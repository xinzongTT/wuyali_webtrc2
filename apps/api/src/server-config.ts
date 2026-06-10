import type { AppStore, SystemSettings } from "./store.js";

type EnvironmentSettings = Partial<Pick<NodeJS.ProcessEnv, "TURN_URLS" | "TURN_USERNAME" | "TURN_CREDENTIAL">>;

export async function applyEnvironmentSettings(store: AppStore, env: EnvironmentSettings) {
  const current = await store.getSettings();
  const next: Partial<SystemSettings> = {};

  if (!current.turnUrls && env.TURN_URLS) next.turnUrls = env.TURN_URLS;
  if (!current.turnUsername && env.TURN_USERNAME) next.turnUsername = env.TURN_USERNAME;
  if (!current.turnCredential && env.TURN_CREDENTIAL) next.turnCredential = env.TURN_CREDENTIAL;

  if (Object.keys(next).length > 0) {
    await store.updateSettings(next);
  }
}
