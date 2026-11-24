import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { digestSchema, evidenceOutcomeSchema, taskBriefSchema } from "@axiom/contracts";
import type { EvidenceOutcome, PolicyIdentity, TaskBrief } from "@axiom/contracts";
import { digest, readBundle, verifyBundle } from "./bundle.js";

export interface HermesProfile {
  /** Hermes launch root with a profiles directory. */
  home: string;
  profile: string;
}

type Change = { kind: "install" | "update"; bundle: string } | { kind: "disable" | "uninstall" };

interface PluginChange {
  outcome: EvidenceOutcome;
  changed: boolean;
}

const ownerFile = "axiom-installed.json";
const pluginName = "axiom";
const sessionId = /^[a-z0-9_-]{1,128}$/i;

function blocked(reason: string): EvidenceOutcome {
  return { status: "blocked", reason };
}

export function profileDirectory(target: HermesProfile): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.profile) || target.profile === "default") {
    throw new Error("Select an explicit named Hermes profile.");
  }
  const directory = join(realpathSync(target.home), "profiles", target.profile);
  if (realpathSync(directory) !== directory) throw new Error("A Hermes profile path cannot redirect through a symlink.");
  return directory;
}

function configAt(profile: string) {
  const path = join(profile, "config.yaml");
  let contents: string | undefined;
  let mode = 0o600;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || realpathSync(path) !== path) throw new Error("A Hermes config path must be a regular profile file.");
    contents = readFileSync(path, "utf8");
    mode = stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const doc = parseDocument(contents ?? "");
  if (doc.errors.length > 0 || (!isMap(doc.contents) && doc.contents !== null)) throw new Error("Invalid Hermes config.yaml.");
  const plugins = doc.get("plugins", true);
  if (plugins !== undefined && !isMap(plugins)) throw new Error("Hermes plugins configuration must be a mapping.");
  for (const key of ["enabled", "disabled"]) {
    const node = doc.getIn(["plugins", key], true);
    if (node !== undefined && (!isSeq(node) || node.items.some((item) => !isScalar(item) || typeof item.value !== "string"))) {
      throw new Error(`Hermes plugins.${key} must be a list of names.`);
    }
  }
  return { doc, path, contents, mode };
}

function configured(doc: ReturnType<typeof parseDocument>, key: "enabled" | "disabled") {
  const values = doc.getIn(["plugins", key], true);
  return isSeq(values) && values.items.some((item) => isScalar(item) && item.value === pluginName);
}

function setConfigured(doc: ReturnType<typeof parseDocument>, key: "enabled" | "disabled", include: boolean): boolean {
  const path = ["plugins", key];
  const sequence = doc.getIn(path, true);
  if (!isSeq(sequence)) {
    if (include) doc.setIn(path, [pluginName]);
    return include;
  }
  const matches = sequence.items.flatMap((item, index) => isScalar(item) && item.value === pluginName ? [index] : []);
  if (include) {
    if (matches.length > 0) return false;
    sequence.add(pluginName);
  } else {
    for (const index of matches.reverse()) sequence.delete(index);
    if (matches.length === 0) return false;
  }
  return true;
}

function ownedBundle(directory: string, profile: string) {
  if (!existsSync(directory)) return;
  if (realpathSync(directory) !== directory) throw new Error("The Axiom plugin path redirects outside its installed directory.");
  const manifest = readBundle(directory);
  const marker = join(directory, ownerFile);
  if (realpathSync(marker) !== marker) throw new Error("The Hermes ownership marker cannot be redirected.");
  const ownership = JSON.parse(readFileSync(marker, "utf8"));
  if (ownership?.owner !== pluginName || ownership.profile !== profile || ownership.digest !== manifest.digest) {
    throw new Error("The existing Axiom plugin entry is not owned by this profile.");
  }
  return manifest;
}

function replaceConfig(path: string, contents: string, previous: string | undefined, mode: number): void {
  const staged = join(dirname(path), `.axiom-config-${randomUUID()}`);
  try {
    writeFileSync(staged, contents, { flag: "wx", mode });
    if (configAt(dirname(path)).contents !== previous) throw new Error("Hermes config changed during the operation.");
    renameSync(staged, path);
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Change only the named profile's Axiom plugin directory and exact enable/disable entries. */
export function changeHermesPlugin(target: HermesProfile, change: Change): PluginChange {
  const done = (changed: boolean): PluginChange => ({ outcome: { status: "passed" }, changed });
  try {
    const profile = profileDirectory(target);
    const { doc, path: config, contents, mode } = configAt(profile);
    const plugins = join(profile, "plugins");
    if (existsSync(plugins) && realpathSync(plugins) !== plugins) throw new Error("The Hermes plugins directory cannot be redirected.");
    const installed = join(plugins, pluginName);
    const current = ownedBundle(installed, target.profile);
    if (!current && change.kind === "uninstall") return done(false);
    if (!current && change.kind !== "install") throw new Error("Axiom is not installed in the selected profile.");
    if (!current && (configured(doc, "enabled") || configured(doc, "disabled"))) {
      throw new Error("The selected profile already has an unowned Axiom plugin setting.");
    }

    if (change.kind === "disable") {
      const removed = setConfigured(doc, "enabled", false);
      const added = setConfigured(doc, "disabled", true);
      if (removed || added) replaceConfig(config, doc.toString(), contents, mode);
      return done(removed || added);
    }

    const source = "bundle" in change ? realpathSync(change.bundle) : undefined;
    const next = source ? readBundle(source) : undefined;
    if (source && next) verifyBundle(source, next);
    if (current?.digest === next?.digest && current) return done(false);
    if (current && change.kind === "install") throw new Error("Use update to replace the installed Axiom bundle.");

    const enabledChanged = !current && setConfigured(doc, "enabled", true);
    const removedEnabled = change.kind === "uninstall" && setConfigured(doc, "enabled", false);
    const removedDisabled = change.kind === "uninstall" && setConfigured(doc, "disabled", false);
    mkdirSync(plugins, { recursive: true });
    const scratch = mkdtempSync(join(plugins, ".axiom-change-"));
    const backup = join(scratch, "previous");
    let published = false;
    let preserveBackup = false;
    try {
      if (source && next) {
        const payload = join(scratch, "payload");
        for (const file of [...next.files.map(({ path }) => path), "axiom-bundle.json"]) {
          const destination = join(payload, file);
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(join(source, file), destination);
        }
        writeFileSync(join(payload, ownerFile), JSON.stringify({ owner: pluginName, profile: target.profile, digest: next.digest }) + "\n");
        verifyBundle(payload, next);
      }
      if (current) renameSync(installed, backup);
      if (next) {
        renameSync(join(scratch, "payload"), installed);
        published = true;
      }
      if (enabledChanged || removedEnabled || removedDisabled) replaceConfig(config, doc.toString(), contents, mode);
      return done(true);
    } catch (error) {
      preserveBackup = existsSync(backup);
      if (published) rmSync(installed, { recursive: true, force: true });
      if (preserveBackup) {
        renameSync(backup, installed);
        preserveBackup = false;
      }
      throw error;
    } finally {
      if (!preserveBackup) rmSync(scratch, { recursive: true, force: true });
    }
  } catch (error) {
    return { outcome: blocked(error instanceof Error ? error.message : "Hermes profile change could not complete."), changed: false };
  }
}

export interface HermesActivation {
  installed: EvidenceOutcome;
  discoverable: EvidenceOutcome;
  /** Complete core and any selected profile retrieval instructions in the system prompt. */
  coreLoaded: EvidenceOutcome;
  /** Per-profile transport evidence from native skill_view results in the provider request. */
  profileLoads: (PolicyIdentity["profiles"][number] & { outcome: EvidenceOutcome })[];
  /** Core and all selected profile documents observed in the same provider request. */
  loaded: EvidenceOutcome;
  enabled: boolean;
  policy?: PolicyIdentity;
  bundleDigest?: string;
}

interface Registration {
  instance: string;
  sections: { id: string; digest: string }[];
  missingReason?: string;
}

function currentInstallation(directory: string): string | undefined {
  const path = join(directory, ".axiom-install-instance");
  if (!existsSync(path)) return;
  if (realpathSync(path) !== path) throw new Error("The Hermes installation identity cannot be redirected.");
  const instance = JSON.parse(readFileSync(path, "utf8"));
  if (typeof instance !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(instance)) {
    throw new Error("The Hermes installation identity is malformed.");
  }
  return instance;
}

function observedRegistration(profile: string, packageDigest: string, instance: string): Registration | undefined {
  const path = join(profile, ".axiom-hermes", "registered.json");
  if (!existsSync(path)) return;
  if (realpathSync(path) !== path) throw new Error("Hermes registration observation cannot be redirected.");
  const observation = JSON.parse(readFileSync(path, "utf8"));
  if (observation.digest !== packageDigest || observation.instance !== instance || observation.stage !== "registered"
    || !Array.isArray(observation.sections)) return;
  for (const section of observation.sections) {
    if (!/^axiom\.policy-\d{3}$/.test(section?.id) || !digestSchema.safeParse(section?.digest).success) return;
  }
  return {
    instance,
    sections: observation.sections,
    ...(typeof observation.missingReason === "string" && { missingReason: observation.missingReason }),
  };
}

function observedLoad(
  profile: string, packageDigest: string, registration: Registration | undefined, session?: string,
): { core: EvidenceOutcome; profiles: Map<string, string> } {
  const pending: EvidenceOutcome = { status: "not_run", reason: "No selected Hermes session observation." };
  const unread = (core: EvidenceOutcome) => ({ core, profiles: new Map<string, string>() });
  if (registration?.missingReason) return unread(blocked(registration.missingReason));
  if (!registration || !session || !sessionId.test(session)) return unread(pending);
  const path = join(profile, ".axiom-hermes", `loaded-${session}.json`);
  if (!existsSync(path)) return unread(pending);
  if (realpathSync(path) !== path) return unread(blocked("The Hermes request observation cannot be redirected."));
  try {
    const observation = JSON.parse(readFileSync(path, "utf8"));
    if (observation.stage === "loaded" && observation.mechanism === "llm_request"
      && observation.digest === packageDigest && observation.session === session
      && observation.instance === registration.instance
      && Array.isArray(observation.sections) && registration.sections.length > 0
      && observation.sections.length === registration.sections.length
      && registration.sections.every((section, index) =>
        observation.sections[index]?.id === section.id && observation.sections[index]?.digest === section.digest)) {
      const result = unread({ status: "passed" });
      if (Array.isArray(observation.profiles)) {
        for (const profile of observation.profiles) {
          if (typeof profile?.id === "string" && digestSchema.safeParse(profile?.digest).success) {
            result.profiles.set(profile.id, profile.digest);
          }
        }
      }
      return result;
    }
    return unread(blocked("The observed Hermes request does not contain the complete Axiom core and profile index."));
  } catch {
    return unread(blocked("The native Hermes session observation could not be read."));
  }
}

export function inspectHermesActivation(target: HermesProfile, session?: string): HermesActivation {
  try {
    const profile = profileDirectory(target);
    const { doc } = configAt(profile);
    const installed = join(profile, "plugins", pluginName);
    const pending: EvidenceOutcome = { status: "not_run", reason: "No Axiom bundle is installed in this profile." };
    if (!existsSync(installed)) return {
      installed: pending, discoverable: pending, coreLoaded: pending, profileLoads: [], loaded: pending, enabled: false,
    };
    if (realpathSync(installed) !== installed) throw new Error("Axiom's installed directory cannot be redirected.");
    const bundle = readBundle(installed);
    verifyBundle(installed, bundle);
    const enabled = configured(doc, "enabled") && !configured(doc, "disabled");
    const disabled = blocked("Axiom is disabled in the selected Hermes profile.");
    const instance = enabled ? currentInstallation(installed) : undefined;
    const registered = instance ? observedRegistration(profile, bundle.digest, instance) : undefined;
    const observed = enabled ? observedLoad(profile, bundle.digest, registered, session) : undefined;
    const coreLoaded = observed?.core ?? disabled;
    const profileLoads: HermesActivation["profileLoads"] = bundle.policy.profiles.map((selected) => {
      if (coreLoaded.status !== "passed") return { ...selected, outcome: coreLoaded };
      const actual = observed?.profiles.get(selected.id);
      const expected = bundle.files.find(({ path }) => path === `profiles/${selected.id}/PROFILE.md`)?.digest;
      const outcome: EvidenceOutcome = actual === undefined
        ? { status: "not_run", reason: "The current Hermes request has no complete native retrieval of this profile." }
        : actual === expected ? { status: "passed" } : blocked("The retrieved profile content differs from the installed policy.");
      return { ...selected, outcome };
    });
    const loaded = coreLoaded.status === "passed" && profileLoads.some(({ outcome }) => outcome.status !== "passed")
      ? blocked("The current Hermes request lacks complete retrieval of the selected Axiom profiles.")
      : coreLoaded;
    return {
      installed: { status: "passed" }, policy: bundle.policy, bundleDigest: bundle.digest, enabled,
      discoverable: !enabled ? disabled : registered ? { status: "passed" }
        : { status: "not_run", reason: "Hermes has not reported registration of this bundle." },
      coreLoaded, profileLoads, loaded,
    };
  } catch {
    const invalid = blocked("The selected Hermes profile or bundle could not be verified.");
    return { installed: invalid, discoverable: invalid, coreLoaded: invalid, profileLoads: [], loaded: invalid, enabled: false };
  }
}

export function formatHermesWorkerContext(brief: TaskBrief): string {
  const expected = taskBriefSchema.parse(brief);
  if (!expected.parentId) throw new Error("An Axiom worker brief needs a parent task ID.");
  return "Axiom scoped worker brief:\n" + JSON.stringify(expected);
}

function inspectWorker(
  target: HermesProfile, parentSession: string, workerId: string, brief: TaskBrief, verifyProfiles: boolean,
): { childSession?: string; outcome: EvidenceOutcome } {
  const unavailable = (reason: string) => ({ outcome: blocked(reason) });
  try {
    const activation = inspectHermesActivation(target);
    const expected = taskBriefSchema.parse(brief);
    if (typeof parentSession !== "string" || !sessionId.test(parentSession)
        || typeof workerId !== "string" || !sessionId.test(workerId) || !expected.parentId || !activation.enabled
        || !activation.bundleDigest || !isDeepStrictEqual(activation.policy, expected.policy)) {
      return unavailable("The selected Hermes policy, parent session, or worker identity could not be verified.");
    }
    if (!verifyProfiles && expected.policy.profiles.length > 0) {
      return unavailable("First-request worker delivery of selected Hermes profiles is unverified.");
    }
    if (verifyProfiles && expected.policy.profiles.length === 0) return unavailable("No Hermes worker profiles were selected for retrieval.");
    const profile = profileDirectory(target);
    const installed = join(profile, "plugins", pluginName);
    const instance = currentInstallation(installed);
    const observations = join(profile, ".axiom-hermes");
    const path = join(observations, `delegated-${workerId}.json`);
    if (!instance || !existsSync(path) || realpathSync(path) !== path) {
      return unavailable("No current Hermes worker request observation was available.");
    }
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    const { childSession } = receipt;
    if (receipt.digest !== activation.bundleDigest || receipt.instance !== instance || receipt.mechanism !== "first_llm_execution"
        || receipt.parentSession !== parentSession || receipt.workerId !== workerId || typeof childSession !== "string"
        || !sessionId.test(childSession) || childSession === parentSession || receipt.inspectable !== true
        || typeof receipt.coreLoaded !== "boolean" || (receipt.briefDigest !== null && !digestSchema.safeParse(receipt.briefDigest).success)) {
      return unavailable("The first Hermes worker request could not be matched to the selected policy and native spawn.");
    }
    if (!receipt.coreLoaded || receipt.briefDigest !== digest(formatHermesWorkerContext(expected))) {
      return { childSession, outcome: { status: "failed", reason: "The first observed Hermes worker request omitted the complete core or staged task brief." } };
    }
    if (!verifyProfiles) return { childSession, outcome: { status: "passed" } };

    const profilePath = join(observations, `delegated-profiles-${workerId}.json`);
    if (!existsSync(profilePath) || realpathSync(profilePath) !== profilePath) {
      return { childSession, outcome: blocked("No completed Hermes worker request was observed after the initial request.") };
    }
    const retrieval = JSON.parse(readFileSync(profilePath, "utf8"));
    const bundle = readBundle(installed);
    if (bundle.digest !== activation.bundleDigest || retrieval.digest !== bundle.digest || retrieval.instance !== instance
        || retrieval.mechanism !== "subsequent_llm_execution" || retrieval.workerId !== workerId
        || retrieval.parentSession !== parentSession || retrieval.childSession !== childSession || !Array.isArray(retrieval.profiles)) {
      return { childSession, outcome: blocked("The Hermes profile retrieval could not be matched to the selected policy and native worker.") };
    }
    const observed = new Map<string, string>();
    for (const entry of retrieval.profiles) {
      if (!expected.policy.profiles.some(({ id }) => id === entry?.id) || observed.has(entry.id)
          || !digestSchema.safeParse(entry.digest).success) {
        return { childSession, outcome: blocked("The Hermes worker profile retrieval observation is malformed.") };
      }
      observed.set(entry.id, entry.digest);
    }
    const complete = expected.policy.profiles.every(({ id }) => observed.get(id) !== undefined
      && observed.get(id) === bundle.files.find(({ path }) => path === `profiles/${id}/PROFILE.md`)?.digest);
    return { childSession, outcome: complete ? { status: "passed" }
      : { status: "failed", reason: "No completed Hermes worker request showed exact retrieval of every selected profile." } };
  } catch {
    return unavailable("The Hermes worker request observation could not be verified.");
  }
}

/** Verify the scoped brief and complete core in the first request of one native worker. */
export function inspectHermesWorkerDelivery(target: HermesProfile, parentSession: string, workerId: string, brief: TaskBrief) {
  return inspectWorker(target, parentSession, workerId, brief, false);
}

/** Verify first-request core and brief, followed by exact native profile retrieval in the same worker. */
export function inspectHermesWorkerProfileRetrieval(target: HermesProfile, parentSession: string, workerId: string, brief: TaskBrief) {
  return inspectWorker(target, parentSession, workerId, brief, true);
}

/** Retain a native veto even when Hermes completes the conversation after a tool was blocked. */
export function inspectHermesHookFailure(target: HermesProfile, packageDigest: string, session: string): EvidenceOutcome | undefined {
  if (!sessionId.test(session)) return blocked("Hermes did not provide an inspectable session identity.");
  const profile = profileDirectory(target);
  const instance = currentInstallation(join(profile, "plugins", pluginName));
  for (const status of ["failed", "blocked"] as const) {
    const path = join(profile, ".axiom-hermes", `pre-tool-${status}-${session}.json`);
    if (!existsSync(path)) continue;
    if (realpathSync(path) !== path) return blocked("The Hermes hook observation cannot be redirected.");
    try {
      const observed = JSON.parse(readFileSync(path, "utf8"));
      const outcome = evidenceOutcomeSchema.parse(observed.outcome);
      if (instance && observed.digest === packageDigest && observed.instance === instance
        && observed.session === session && outcome.status === status) return outcome;
    } catch { /* Malformed observations must not permit success. */ }
    return blocked("The Hermes hook observation could not be verified.");
  }
}
