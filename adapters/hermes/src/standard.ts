import { randomUUID } from "node:crypto";
import { lstat, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkBackend, EvidenceOutcome } from "@axiom/contracts";
import { HermesBenchmarkBackend } from "./backend.js";
import { changeHermesPlugin, profileDirectory } from "./profile.js";
import { runHermes } from "./process.js";
import { hermesVersion } from "./bundle.js";

interface AccountBackendOptions {
  executable: string;
  authHome: string;
  archiveDirectory: string;
  bundle: string;
  /** Credential-free native loopback tests only. The user command never supplies this. */
  loopback?: string;
}

const guard = fileURLToPath(new URL("../dist/standard-tool-guard.js", import.meta.url));
const provider = "openai-codex";
const unmetered = { metering: "unknown", reason: "Hermes account execution did not return an attempt usage record." } as const;

export function createHermesAccountBackend(options: AccountBackendOptions): BenchmarkBackend {
  return { async run(request, signal) {
    const started = performance.now();
    const blocked = (reason: string) => ({ requestId: request.id, durationMs: performance.now() - started,
      outcome: { status: "blocked", reason } as EvidenceOutcome, artifacts: [], usage: unmetered });
    if (signal.aborted || request.host.os !== "linux" || request.host.version !== hermesVersion ||
        !isAbsolute(options.authHome) || !isAbsolute(options.executable)) return blocked("Hermes account execution requires the pinned Linux CLI and an absolute auth root.");
    const home = await realpath(options.authHome).catch(() => undefined);
    if (!home || !await lstat(join(home, "auth.json")).then((item) => item.isFile(), () => false)) {
      return blocked("Select the Hermes default auth root with an existing OpenAI Codex login.");
    }
    const profile = "axiom-bench-" + randomUUID().slice(0, 12);
    const selectedProvider = options.loopback ? "custom" : provider;
    const remaining = () => Math.max(0, request.timeoutMs - (performance.now() - started));
    const env = { PATH: process.env.PATH, HOME: home, HERMES_HOME: home,
      HERMES_DISABLE_AUTO_UPDATE: "1", HERMES_DISABLE_LAZY_INSTALLS: "1",
      HERMES_TUI_GATEWAY_URL: "", HERMES_WRITE_SAFE_ROOT: request.workspace,
      HERMES_CODEX_BASE_URL: "https://chatgpt.com/backend-api/codex",
      ...(options.loopback && { OPENAI_API_KEY: "loopback-only" }) };
    const command = { executable: options.executable, cwd: request.workspace, env,
      deadline: started + request.timeoutMs, signal };
    let directory: string | undefined;
    try {
      const version = await runHermes({ ...command, args: ["--profile", "default", "--version"] });
      if (version.code !== 0 || /Hermes Agent v([^\s)]+)/.exec(version.stdout)?.[1] !== hermesVersion) {
        return blocked("The installed Hermes CLI differs from the pinned version.");
      }
      const created = await runHermes({ ...command, args: ["--profile", "default", "profile", "create", profile,
        "--no-alias", "--no-credentials", "--no-skills"] });
      // A cancelled create may have reached the filesystem. Clean up only the generated name.
      directory = (() => { try { return profileDirectory({ home, profile }); } catch { return undefined; } })();
      if (created.code !== 0 || !directory) return blocked("The disposable Hermes profile could not be created.");
      await writeFile(join(directory, "config.yaml"), JSON.stringify({
        _config_version: 54, gateway: { standalone: true }, hooks_auto_accept: true,
        // The native launch guard checks the named profile's configuration before resolving the default OAuth login.
        model: { provider: selectedProvider, default: request.host.model },
        hooks: { pre_tool_call: [{ command: [process.execPath, guard, request.workspace].map((part) => JSON.stringify(part)).join(" "),
          timeout: 5, fail_closed: true }] },
      }), { mode: 0o600 });
      const auth = await runHermes({ ...command, args: ["--profile", profile, "auth", "status", provider] });
      if (auth.code !== 0 || !/^openai-codex: logged in\s*$/m.test(auth.stdout)) {
        return blocked("The disposable Hermes profile could not use the default profile’s OpenAI Codex login.");
      }
      if (request.mode === "with_axiom" && changeHermesPlugin({ home, profile }, { kind: "install", bundle: options.bundle }).outcome.status !== "passed") {
        return blocked("The disposable Hermes profile could not install the Axiom bundle.");
      }
      if (signal.aborted || remaining() < 1) return blocked("Hermes account execution was cancelled or exhausted its time limit.");
      const backend = new HermesBenchmarkBackend({
        executable: options.executable, profile: { home, profile }, archiveDirectory: options.archiveDirectory,
        provider: selectedProvider, maxTurns: 8, standalone: true, toolsets: ["file", "skills"], environment: env,
        ...(options.loopback && { baseUrl: options.loopback }),
      });
      return await backend.run({ ...request, timeoutMs: Math.floor(remaining()) }, signal);
    } catch {
      return blocked("The disposable Hermes account attempt could not be staged or executed.");
    } finally {
      if (directory) {
        if (signal.aborted || remaining() < 1) {
          await rm(directory, { recursive: true, force: true });
        } else {
          const cleanup = await runHermes({ ...command, deadline: performance.now() + 5_000,
            args: ["--profile", "default", "profile", "delete", profile, "--yes"] });
          if (cleanup.code !== 0) await rm(directory, { recursive: true, force: true });
        }
      }
    }
  } };
}
