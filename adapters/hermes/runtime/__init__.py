"""Hermes native registration and a bridge to the Axiom check runtime."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from uuid import uuid4

from ruamel.yaml import YAML
from hermes_constants import get_hermes_home


SECTION_LIMIT = 4000
SESSION_LIMIT = 8000
SESSION_ID = re.compile(r"[a-zA-Z0-9_-]{1,128}")
PROFILE_ID = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*")


def _report(folder, filename, observation, *, replace=True):
    folder.mkdir(mode=0o700, exist_ok=True)
    descriptor, staged = tempfile.mkstemp(dir=folder)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as out:
            json.dump(observation, out)
        if replace:
            os.replace(staged, folder / filename)
        else:
            os.link(staged, folder / filename)
    finally:
        Path(staged).unlink(missing_ok=True)


def _description(skill):
    frontmatter = skill.read_text(encoding="utf-8").split("\n---\n", 1)
    if len(frontmatter) != 2 or not frontmatter[0].startswith("---\n"):
        raise ValueError("Expected canonical skill frontmatter.")
    return YAML(typ="safe").load(frontmatter[0][4:])["description"]


def _installation(bundle):
    path = bundle / ".axiom-install-instance"
    if not path.exists():
        try:
            _report(bundle, path.name, str(uuid4()), replace=False)
        except FileExistsError:
            pass
    if path.resolve() != path:
        raise ValueError("Axiom installation identity cannot be redirected.")
    return json.loads(path.read_text(encoding="utf-8"))


def _hook(bundle, folder, identity, instance, checker_digest):
    def pre_tool_call(**kwargs):
        node = os.environ.get("AXIOM_HERMES_NODE") or shutil.which("node") or ""
        checker = bundle / "checker.mjs"
        archive = os.environ.get("AXIOM_HERMES_ARCHIVE", str(folder / "evidence"))
        session = str(kwargs.get("session_id") or "")
        outcome = {"status": "blocked", "reason": "Axiom's shared Hermes check is unavailable."}
        if Path(node).is_absolute() and Path(archive).is_absolute():
            try:
                if checker.resolve() != checker or _digest(checker.read_bytes()) != checker_digest:
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
                    "digest": identity, "instance": instance, "session": session, "outcome": outcome,
                })
            except OSError:
                return {"action": "block", "message": "Axiom's Hermes hook disposition could not be recorded."}
        return {"action": "block", "message": outcome["reason"]}

    return pre_tool_call


def _digest(content):
    return "sha256:" + hashlib.sha256(content).hexdigest()


def _profile_reads(messages, skills):
    """Match exact native profile reads to their tool results in the same provider request."""
    pending = {}
    observed = {}
    for message in messages:
        if not isinstance(message, dict):
            continue
        if message.get("role") == "assistant" and isinstance(message.get("tool_calls"), list):
            for call in message["tool_calls"]:
                try:
                    function = call["function"]
                    if function["name"] != "skill_view" or not isinstance(call["id"], str):
                        continue
                    args = json.loads(function["arguments"])
                    if isinstance(args, dict) and args.get("file_path") == "PROFILE.md" and args.get("name") in skills:
                        pending[call["id"]] = args["name"]
                except (KeyError, TypeError, ValueError):
                    continue
        elif message.get("role") == "tool" and isinstance(message.get("tool_call_id"), str):
            name = pending.pop(message["tool_call_id"], None)
            if name is None:
                continue
            try:
                result = json.loads(message["content"])
                if (isinstance(result, dict) and result.get("success") is True and result.get("name") == name
                        and result.get("file") == "PROFILE.md" and isinstance(result.get("content"), str)):
                    observed[skills[name]] = _digest(result["content"].encode("utf-8"))
            except (KeyError, TypeError, ValueError):
                continue
    return [{"id": profile_id, "digest": digest} for profile_id, digest in sorted(observed.items())]


def _observe_request(folder, identity, instance, frames, fingerprints, profile_skills):
    def observe(request, session_id="", **_kwargs):
        if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
            return
        messages = request.get("messages") if isinstance(request, dict) else None
        messages = messages if isinstance(messages, list) else []
        system = [
            message["content"] for message in messages
            if isinstance(message, dict) and message.get("role") == "system"
            and isinstance(message.get("content"), str)
        ]
        covered = bool(frames) and any(all(frame in content for frame in frames) for content in system)
        _report(folder, "loaded-" + session_id + ".json", {
            "stage": "loaded" if covered else "incomplete",
            "digest": identity,
            "instance": instance,
            "session": session_id,
            "mechanism": "llm_request",
            "sections": fingerprints if covered else [],
            "profiles": _profile_reads(messages, profile_skills) if covered and profile_skills else [],
        })

    return observe


def _profile_index(ctx, bundle, manifest):
    skills = {}
    for reference in manifest["policy"]["profiles"]:
        profile_id = reference["id"]
        if not isinstance(profile_id, str) or not PROFILE_ID.fullmatch(profile_id):
            raise ValueError("Invalid Hermes profile identity in the bundle.")
        name = f"profile-{profile_id}"
        if any(skill["id"] == name for skill in manifest["skills"]):
            raise ValueError("A Hermes profile reference conflicts with a canonical skill name.")
        ctx.register_skill(name, bundle / "profiles" / profile_id / "PROFILE.md",
                           description=f"Complete canonical Axiom {profile_id} profile requirements.")
        skills[f"axiom:{name}"] = profile_id

    if not skills:
        return skills, ""
    index = [
        "## Selected Axiom profile references",
        "Before planning or acting on work covered by a selected profile, use the listed Hermes skill_view calls "
        "to retrieve and apply its complete canonical requirements and any inherited profile requirements. "
        "If applicable requirements cannot be retrieved, report their verification as blocked.",
        *(f'- skill_view(name="{name}", file_path="PROFILE.md")' for name in skills),
    ]
    return skills, "\n\n".join(index)


def _split_sections(content):
    sections = []
    while len(content) > SECTION_LIMIT:
        boundary = content.rfind("\n\n", 0, SECTION_LIMIT + 2)
        if boundary <= 0:
            return []
        sections.append(content[:boundary])
        content = content[boundary + 2:]
    sections.append(content)
    # Hermes strips section boundary whitespace. Refuse a split if that would change the content.
    return sections if all(section == section.strip() for section in sections) else []


def register(ctx):
    bundle = Path(__file__).resolve().parent
    profile = Path(get_hermes_home()).resolve()
    if bundle != profile / "plugins" / "axiom" or profile.parent.name != "profiles":
        raise ValueError("Axiom requires installation in the selected named Hermes profile.")
    manifest = json.loads((bundle / "axiom-bundle.json").read_text(encoding="utf-8"))
    identity = manifest["digest"]
    instance = _installation(bundle)
    checker_digest = next(record["digest"] for record in manifest["files"] if record["path"] == "checker.mjs")

    folder = profile / ".axiom-hermes"
    if folder.exists() and folder.resolve() != folder:
        raise ValueError("Axiom observation storage cannot be redirected outside the selected profile.")
    for skill in manifest["skills"]:
        name = skill["id"]
        entrypoint = bundle / "skills" / name / "SKILL.md"
        ctx.register_skill(name, entrypoint, description=_description(entrypoint))

    profile_skills, index = _profile_index(ctx, bundle, manifest)
    core = (bundle / "core" / "AXIOMS.md").read_text(encoding="utf-8").rstrip("\n")
    parts = [f"Axiom policy digest {manifest['policy']['digest']}", core]
    if index:
        parts.append(index)
    sections = _split_sections("\n\n".join(parts))

    observation = {"stage": "registered", "digest": identity, "instance": instance, "sections": []}
    frames = [
        f"## Plugin Context: axiom.policy-{index:03}\n<!-- hermes-plugin-section-chars:{len(section)} -->\n\n{section}"
        for index, section in enumerate(sections)
    ]
    framed_length = len("<!-- hermes-plugin-sections:start -->\n\n<!-- hermes-plugin-sections:end -->") + len("\n\n".join(frames))
    if not sections or framed_length > SESSION_LIMIT:
        observation["missingReason"] = "The complete Axiom core and profile index exceed Hermes' prompt-section limits."
        frames = []
    else:
        for index, section in enumerate(sections):
            key = f"axiom.policy-{index:03}"
            ctx.register_system_prompt_section(key, section, max_chars=SECTION_LIMIT)
            observation["sections"].append(
                {"id": key, "digest": _digest(section.encode("utf-8"))})
    ctx.register_hook("pre_tool_call", _hook(bundle, folder, identity, instance, checker_digest))
    ctx.register_middleware("llm_request",
                            _observe_request(folder, identity, instance, frames, observation["sections"], profile_skills))
    _report(folder, "registered.json", observation)
