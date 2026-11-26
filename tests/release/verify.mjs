import assert from "node:assert/strict";
import { verifyQualification, verifyRollback } from "./gate.ts";
import { loadJson, manifestAt, verifyCodexArtifact, verifyHermesArtifact } from "./native-artifact.mjs";

try {
  const [source, distribution, codexEvidenceDistribution, rollback, ...rest] = process.argv.slice(2);
  if (!source || !distribution || !codexEvidenceDistribution || !rollback || rest.length > 0) {
    throw new Error("Usage: node tests/release/verify.mjs SOURCE NATIVE_DIST CODEX_EVIDENCE_DIST ROLLBACK_JSON");
  }
  const evidence = loadJson(new URL("./evidence/v1-hosts.json", import.meta.url));
  const manifest = manifestAt(distribution);
  assert.deepEqual(manifest, loadJson(new URL("./evidence/v1-distribution.json", import.meta.url)));
  verifyQualification(evidence, manifest, source);
  const priorCodex = manifestAt(codexEvidenceDistribution);
  assert.equal(priorCodex.sourceRevision, evidence.codexEquivalence.evidenceSource, "Stale Codex equivalence source.");
  assert.equal(priorCodex.version, manifest.version);
  assert.deepEqual(priorCodex.policy, manifest.policy);
  assert.deepEqual(priorCodex.hosts.codex, manifest.hosts.codex);
  await verifyCodexArtifact(codexEvidenceDistribution, priorCodex);
  await verifyCodexArtifact(distribution, manifest);
  verifyHermesArtifact(distribution, manifest);
  verifyRollback(loadJson(rollback), manifest);
  console.log(JSON.stringify({ qualified: true, source, bundleVersion: manifest.version, hosts: Object.keys(manifest.hosts) }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}