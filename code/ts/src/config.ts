import { readFileSync } from "node:fs";
// Non-secret local defaults. Explicit environment variables take precedence.
try {
  const config = JSON.parse(readFileSync(new URL("../../../codeatlas.config.json", import.meta.url), "utf8")) as Record<string, unknown>;
  for (const key of ["LLM_MODEL", "LLM_BASE_URL"] as const) {
    if (process.env[key] === undefined && typeof config[key] === "string") process.env[key] = config[key];
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
// A public hosted provider is usable only after its server-side secret is set.
// Leave evidence mode truthful while the owner finishes provider setup.
if (process.env.PUBLIC_DEMO === "true" && !process.env.LLM_API_KEY) process.env.LLM_MODEL = "";
