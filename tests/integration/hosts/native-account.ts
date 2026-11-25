export const shellLiteral = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function nativeAccountFixture(agent: "codex" | "hermes", program: string, endpoint: string, mode: "read" | "write" = "write") {
  if (agent === "hermes") return {
    auth: { version: 1, credential_pool: { "openai-codex": [{ id: "fixture", label: "Fixture login", auth_type: "oauth",
      priority: 0, source: "manual:device_code", access_token: "fixture-oauth", refresh_token: "fixture-refresh" }] } },
    launcher: `#!/bin/sh\nexport HERMES_CODEX_BASE_URL=${shellLiteral(endpoint + "/backend-api/codex")}\nexec ${shellLiteral(program)} "$@"\n`,
  };
  const jwt = [Buffer.from('{"typ":"JWT","alg":"none"}').toString("base64url"), Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_plan_type: "plus" },
  })).toString("base64url"), "fixture-signature"].join(".");
  const route = `model_providers.fixture={name="Fixture",base_url=${JSON.stringify(endpoint)},wire_api="responses",requires_openai_auth=true,request_max_retries=0,stream_max_retries=0}`;
  const permissions = `permissions.axiom-benchmark.filesystem={":minimal"="read",":workspace_roots"="${mode}",${mode === "read" ? '"/usr/bin/cat"="read","/usr/bin/sed"="read","/usr/bin/ls"="read","/usr/bin/readlink"="read",' : ""}${JSON.stringify(program)}="read"}`;
  return {
    auth: { auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
      tokens: { id_token: jwt, access_token: jwt, refresh_token: "fixture-only", account_id: "fixture-account" } },
    launcher: `#!/bin/sh\nexec ${shellLiteral(program)} -c ${shellLiteral('model_provider="fixture"')} -c ${shellLiteral(route)} -c ${shellLiteral(permissions)} "$@"\n`,
  };
}
