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
WORKER_BRIEF = "Axiom scoped worker brief:\n"


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


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part["text"] for part in content if isinstance(part, dict)
                       and part.get("type") in ("text", "input_text") and isinstance(part.get("text"), str))
    return ""


def _request_content(request):
    """A Hermes Chat Completions or Responses request, with role-bearing policy text."""
    if not isinstance(request, dict):
        return None
    if isinstance(request.get("messages"), list):
        return request["messages"], [
            _text(message.get("content")) for message in request["messages"]
            if isinstance(message, dict) and message.get("role") == "system"
        ]
    if isinstance(request.get("input"), list):
        return request["input"], [_text(request.get("instructions"))] + [
            _text(item.get("content")) for item in request["input"] if isinstance(item, dict)
            and item.get("type") == "message" and item.get("role") in ("developer", "system")
        ]
    return None


def _contains_policy(system, frames):
    return bool(frames) and any(all(frame in content for frame in frames) for content in system)


def _profile_reads(messages, skills, inherits):
    """Match exact native profile reads to their tool results in the same provider request."""
    pending = {}
    observed = {}
    for message in messages:
        if not isinstance(message, dict):
            continue
        calls = []
        if message.get("role") == "assistant" and isinstance(message.get("tool_calls"), list):
            calls = [(call.get("id"), call.get("function")) for call in message["tool_calls"] if isinstance(call, dict)]
        elif message.get("type") == "function_call":
            calls = [(message.get("call_id"), message)]
        if calls:
            for call_id, function in calls:
                try:
                    if function["name"] != "skill_view" or not isinstance(call_id, str):
                        continue
                    args = json.loads(function["arguments"])
                    if isinstance(args, dict) and args.get("file_path") == "PROFILE.md" and args.get("name") in skills:
                        pending[call_id] = args["name"]
                except (KeyError, TypeError, ValueError):
                    continue
        elif message.get("role") == "tool" or message.get("type") == "function_call_output":
            call_id = message.get("tool_call_id", message.get("call_id"))
            name = pending.pop(call_id, None) if isinstance(call_id, str) else None
            if name is None:
                continue
            try:
                result = json.loads(_text(message.get("content", message.get("output"))))
                if (isinstance(result, dict) and result.get("success") is True and result.get("name") == name
                        and result.get("file") == "PROFILE.md" and isinstance(result.get("content"), str)):
                    profile = skills[name]
                    observed[profile] = _digest(result["content"].encode("utf-8"))
                    inherited = result.get("inherited_profiles", [])
                    if isinstance(inherited, list):
                        for entry in inherited:
                            if (isinstance(entry, dict) and entry.get("id") in inherits[profile]
                                    and isinstance(entry.get("content"), str)):
                                observed[entry["id"]] = _digest(entry["content"].encode("utf-8"))
            except (KeyError, TypeError, ValueError):
                continue
    return [{"id": profile_id, "digest": digest} for profile_id, digest in sorted(observed.items())]


def _observe_request(folder, identity, instance, frames, fingerprints, profile_skills, inherits):
    def observe(request, session_id="", **_kwargs):
        if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
            return
        messages, system = _request_content(request) or ([], [])
        covered = _contains_policy(system, frames)
        _report(folder, "loaded-" + session_id + ".json", {
            "stage": "loaded" if covered else "incomplete",
            "digest": identity,
            "instance": instance,
            "session": session_id,
            "mechanism": "llm_request",
            "sections": fingerprints if covered else [],
            "profiles": _profile_reads(messages, profile_skills, inherits) if covered and profile_skills else [],
        })

    return observe


def _worker_brief_digest(messages):
    contexts = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        text = _text(message.get("content"))
        if not text.startswith("CONTEXT:\n" + WORKER_BRIEF):
            continue
        context, separator, _ = text.removeprefix("CONTEXT:\n").partition("\n\nTASK:\n")
        if separator:
            contexts.append(context)
    return _digest(contexts[0].encode("utf-8")) if len(contexts) == 1 else None


def _observe_worker_delivery(ctx, folder, identity, instance, frames, profile_skills, inherits, profile_fingerprints):
    pending = {}

    def started(parent_session_id=None, child_session_id=None, child_subagent_id=None, **_kwargs):
        identifiers = (parent_session_id, child_session_id, child_subagent_id)
        if parent_session_id != child_session_id and all(
            isinstance(item, str) and SESSION_ID.fullmatch(item) for item in identifiers
        ):
            pending.setdefault(child_session_id, {
                "parentSession": parent_session_id, "workerId": child_subagent_id, "first": True,
            })

    def stopped(child_session_id=None, **_kwargs):
        if isinstance(child_session_id, str):
            pending.pop(child_session_id, None)

    def observe(request, next_call, session_id="", **_kwargs):
        worker = pending.get(session_id) if isinstance(session_id, str) else None
        if not worker:
            return next_call()
        first = worker.pop("first", False)
        if not first and not worker.get("observeProfiles"):
            return next_call()
        content = _request_content(request)
        messages, system = content or ([], [])
        core_loaded = _contains_policy(system, frames)
        observation = {
            "digest": identity, "instance": instance, "parentSession": worker["parentSession"],
            "childSession": session_id, "workerId": worker["workerId"],
        }
        if first:
            observation.update(mechanism="first_llm_execution", inspectable=content is not None,
                               coreLoaded=core_loaded, briefDigest=_worker_brief_digest(messages))
        elif core_loaded:
            observation.update(mechanism="subsequent_llm_execution", profiles=_profile_reads(messages, profile_skills, inherits))
        # Only a successful provider execution can establish each observation.
        response = next_call()
        if first:
            try:
                _report(folder, f"delegated-{worker['workerId']}.json", observation, replace=False)
            except FileExistsError:
                return response
            # A failed first call cannot let a later retry attest the first request.
            worker["observeProfiles"] = core_loaded and bool(profile_skills)
        elif core_loaded:
            _report(folder, f"delegated-profiles-{worker['workerId']}.json", observation)
            # Keep the first full observation from a single accepted request, without combining turns.
            if observation["profiles"] == profile_fingerprints:
                worker["observeProfiles"] = False
        return response

    ctx.register_hook("subagent_start", started)
    ctx.register_hook("subagent_stop", stopped)
    ctx.register_middleware("llm_execution", observe)


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
        "Before planning or acting on work covered by a selected profile, use its listed Hermes skill_view call. "
        "A profile read includes its inherited requirements. Apply them together and load any other applicable profile. "
        "If applicable requirements cannot be retrieved, report their verification as blocked.",
        *(f'- skill_view(name="{name}", file_path="PROFILE.md")' for name in skills),
    ]
    return skills, "\n\n".join(index)


def _inherited_profiles(bundle, profile_ids, files):
    extends = {}
    for name in profile_ids:
        if not isinstance(name, str) or not PROFILE_ID.fullmatch(name):
            raise ValueError("Invalid Hermes profile identity in the bundle.")
        relative = f"profiles/{name}/profile.json"
        path = bundle / relative
        if path.resolve() != path or not path.is_file():
            raise ValueError("Hermes profile definition is not an installed bundle file.")
        contents = path.read_bytes()
        if _digest(contents) != files[relative]:
            raise ValueError("Hermes profile definition differs from the bundle inventory.")
        definition = json.loads(contents)
        parents = definition.get("extends", [])
        if (definition.get("id") != name or not isinstance(parents, list)
                or any(not isinstance(parent, str) or parent not in profile_ids for parent in parents)):
            raise ValueError("Invalid Hermes profile inheritance.")
        extends[name] = parents
    inherited = {}
    for name in extends:
        parents = set()
        pending = list(extends[name])
        while pending:
            parent = pending.pop()
            if parent == name:
                raise ValueError("Cyclic Hermes profile inheritance.")
            if parent not in parents:
                parents.add(parent)
                pending.extend(extends[parent])
        inherited[name] = sorted(parents)
    return inherited


def _include_inherited_profiles(bundle, skills, inherits, files):
    def include(tool_name, args, result, **_kwargs):
        if tool_name != "skill_view" or args.get("file_path") != "PROFILE.md" or not isinstance(result, str):
            return
        name = args.get("name")
        profile = skills.get(name) if isinstance(name, str) else None
        if profile is None or not inherits[profile]:
            return
        try:
            response = json.loads(result)
            if not (isinstance(response, dict) and response.get("success") is True and response.get("name") == name
                    and response.get("file") == "PROFILE.md" and isinstance(response.get("content"), str)
                    and _digest(response["content"].encode("utf-8")) == files[f"profiles/{profile}/PROFILE.md"]):
                return
            parents = []
            for parent in inherits[profile]:
                relative = f"profiles/{parent}/PROFILE.md"
                content = (bundle / relative).read_bytes()
                if _digest(content) != files[relative]:
                    return
                parents.append({"id": parent, "content": content.decode("utf-8")})
            return json.dumps({**response, "inherited_profiles": parents}, ensure_ascii=False)
        except (OSError, KeyError, TypeError, ValueError):
            return
    return include


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
    files = {record["path"]: record["digest"] for record in manifest["files"]}
    profile_ids = [reference["id"] for reference in manifest["policy"]["profiles"]]
    inherits = _inherited_profiles(bundle, profile_ids, files)

    folder = profile / ".axiom-hermes"
    if folder.exists() and folder.resolve() != folder:
        raise ValueError("Axiom observation storage cannot be redirected outside the selected profile.")
    for skill in manifest["skills"]:
        name = skill["id"]
        entrypoint = bundle / "skills" / name / "SKILL.md"
        ctx.register_skill(name, entrypoint, description=_description(entrypoint))

    profile_skills, index = _profile_index(ctx, bundle, manifest)
    profile_fingerprints = [{"id": profile_id, "digest": files[f"profiles/{profile_id}/PROFILE.md"]}
                            for profile_id in sorted(profile_skills.values())]
    core = (bundle / "core" / "AXIOMS.md").read_text(encoding="utf-8").rstrip("\n")
    parts = [f"Axiom policy digest {manifest['policy']['digest']}", core]
    if any(skill["id"] == "delegate" for skill in manifest["skills"]):
        parts.append("Before calling delegate_task, read the authoritative task and open the axiom:delegate skill. "
                     "Carry the full worker brief in each task's context.")
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
    if any(inherits.values()):
        ctx.register_hook("transform_tool_result", _include_inherited_profiles(bundle, profile_skills, inherits, files))
    ctx.register_middleware("llm_request",
                            _observe_request(folder, identity, instance, frames, observation["sections"], profile_skills, inherits))
    _observe_worker_delivery(ctx, folder, identity, instance, frames, profile_skills, inherits, profile_fingerprints)
    _report(folder, "registered.json", observation)
