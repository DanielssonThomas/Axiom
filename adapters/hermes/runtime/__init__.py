"""Hermes native registration and a bridge to the Axiom check runtime."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from ruamel.yaml import YAML
from hermes_constants import get_hermes_home


SECTION_LIMIT = 4000
SESSION_LIMIT = 8000
SESSION_ID = re.compile(r"[a-zA-Z0-9_-]{1,128}")


def _report(folder, filename, observation):
    folder.mkdir(mode=0o700, exist_ok=True)
    descriptor, staged = tempfile.mkstemp(dir=folder)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as out:
            json.dump(observation, out)
        os.replace(staged, folder / filename)
    finally:
        Path(staged).unlink(missing_ok=True)


def _description(skill):
    frontmatter = skill.read_text(encoding="utf-8").split("\n---\n", 1)
    if len(frontmatter) != 2 or not frontmatter[0].startswith("---\n"):
        raise ValueError("Expected canonical skill frontmatter.")
    return YAML(typ="safe").load(frontmatter[0][4:])["description"]


def _hook(bundle, folder, identity, checker_digest):
    def pre_tool_call(**kwargs):
        node = os.environ.get("AXIOM_HERMES_NODE") or shutil.which("node") or ""
        checker = bundle / "checker.mjs"
        archive = os.environ.get("AXIOM_HERMES_ARCHIVE", str(folder / "evidence"))
        session = str(kwargs.get("session_id") or "")
        outcome = {"status": "blocked", "reason": "Axiom's shared Hermes check is unavailable."}
        if Path(node).is_absolute() and Path(archive).is_absolute():
            try:
                if checker.resolve() != checker or "sha256:" + hashlib.sha256(checker.read_bytes()).hexdigest() != checker_digest:
                    raise ValueError("Installed Axiom checker differs from its bundle inventory.")
                result = subprocess.run(
                    [node, str(checker), str(bundle), archive, "pre-tool", session],
                    stdin=subprocess.DEVNULL, capture_output=True, text=True,
                    timeout=1, check=True,
                )
                returned = json.loads(result.stdout)
                if returned["status"] == "passed":
                    return None
                if returned["status"] in ("failed", "blocked") and isinstance(returned["reason"], str):
                    outcome = returned
            except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                pass
        if SESSION_ID.fullmatch(session):
            try:
                _report(folder, f"pre-tool-{outcome['status']}-{session}.json", {
                    "digest": identity, "session": session, "outcome": outcome,
                })
            except OSError:
                return {"action": "block", "message": "Axiom's Hermes hook disposition could not be recorded."}
        return {"action": "block", "message": outcome["reason"]}

    return pre_tool_call


def _observe_request(folder, identity, frames, fingerprints):
    def observe(request, session_id="", **_kwargs):
        if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
            return
        messages = request.get("messages", []) if isinstance(request, dict) else []
        system = [
            message["content"] for message in (messages or [])
            if isinstance(message, dict) and message.get("role") == "system"
            and isinstance(message.get("content"), str)
        ]
        covered = bool(frames) and any(all(frame in content for frame in frames) for content in system)
        _report(folder, "loaded-" + session_id + ".json", {
            "stage": "loaded" if covered else "incomplete",
            "digest": identity,
            "session": session_id,
            "mechanism": "llm_request",
            "sections": fingerprints if covered else [],
        })

    return observe


def register(ctx):
    bundle = Path(__file__).resolve().parent
    profile = Path(get_hermes_home()).resolve()
    if bundle != profile / "plugins" / "axiom" or profile.parent.name != "profiles":
        raise ValueError("Axiom requires installation in the selected named Hermes profile.")
    manifest = json.loads((bundle / "axiom-bundle.json").read_text(encoding="utf-8"))
    identity = manifest["digest"]
    checker_digest = next(record["digest"] for record in manifest["files"] if record["path"] == "checker.mjs")

    folder = profile / ".axiom-hermes"
    if folder.exists() and folder.resolve() != folder:
        raise ValueError("Axiom observation storage cannot be redirected outside the selected profile.")
    for skill in manifest["skills"]:
        name = skill["id"]
        entrypoint = bundle / "skills" / name / "SKILL.md"
        ctx.register_skill(name, entrypoint, description=_description(entrypoint))

    core = (bundle / "core" / "AXIOMS.md").read_text(encoding="utf-8")
    profiles = [
        (bundle / "profiles" / reference["id"] / "PROFILE.md").read_text(encoding="utf-8")
        for reference in manifest["policy"]["profiles"]
    ]
    content = "\n\n".join([f"Axiom policy digest {manifest['policy']['digest']}", core, *profiles])
    sections = []
    while content:
        end = len(content)
        if end > SECTION_LIMIT:
            boundary = content.rfind("\n\n", 0, SECTION_LIMIT + 1)
            end = boundary if boundary > 0 else SECTION_LIMIT
        sections.append(content[:end].strip())
        content = content[end:].lstrip()

    observation = {"stage": "registered", "digest": identity, "sections": []}
    frames = [
        f"## Plugin Context: axiom.policy-{index:03}\n<!-- hermes-plugin-section-chars:{len(section)} -->\n\n{section}"
        for index, section in enumerate(sections)
    ]
    framed_length = len("<!-- hermes-plugin-sections:start -->\n\n<!-- hermes-plugin-sections:end -->") + len("\n\n".join(frames))
    if framed_length > SESSION_LIMIT:
        observation["missingReason"] = "Selected Axiom policy exceeds Hermes' aggregate prompt-section limit."
        frames = []
    else:
        for index, section in enumerate(sections):
            key = f"axiom.policy-{index:03}"
            ctx.register_system_prompt_section(key, section, max_chars=SECTION_LIMIT)
            observation["sections"].append(
                {"id": key, "digest": "sha256:" + hashlib.sha256(section.encode()).hexdigest()})
    ctx.register_hook("pre_tool_call", _hook(bundle, folder, identity, checker_digest))
    ctx.register_middleware("llm_request", _observe_request(folder, identity, frames, observation["sections"]))
    _report(folder, "registered.json", observation)
