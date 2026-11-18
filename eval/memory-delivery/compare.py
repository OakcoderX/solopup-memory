"""Run fresh, isolated native DSH arms and collect artifact evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time


HERE = Path(__file__).resolve().parent
BASELINE_SHA = "92b855410afe956fbb657f846c72c1fdc8520aefb926f7acdc2b9ac286e9638c"
CASES = json.loads((HERE / "cases.json").read_text())
NODE = shutil.which("node") or "/opt/homebrew/bin/node"
GIT = "/usr/bin/git"
GIT_ENV = {
    "PATH": "/usr/bin:/bin",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z",
    "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
}


def run(args, cwd=None, env=None, **kw):
    return subprocess.run(args, cwd=cwd, env=env, check=True, **kw)


def git(cwd, *args, index=None):
    env = {**GIT_ENV, **({"GIT_INDEX_FILE": str(index)} if index else {})}
    return run([GIT, *args], cwd=cwd, env=env, capture_output=True).stdout


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    path.chmod(0o600)


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def unpack(archive, sha, version, dest):
    if digest(archive) != sha:
        raise ValueError("Package checksum mismatch")
    dest.mkdir()
    run(["/usr/bin/tar", "-xzf", str(archive), "-C", str(dest)])
    package = dest / "package"
    manifest = read(package / "package.json")
    if manifest["version"] != version or manifest["name"] != "solopup-memory":
        raise ValueError("Package identity mismatch")
    return package


def create_checkout(arm, case, source=None):
    checkout = arm / "checkout"
    if source:
        git(arm, "clone", "--no-local", "--quiet", str(source), "checkout")
        baseline = read(HERE / "cattrs-base.json")
        git(checkout, "checkout", "-B", "main", baseline["sourceCommit"])
        git(checkout, "remote", "remove", "origin")
        if git(checkout, "rev-parse", "HEAD^{tree}").decode().strip() != baseline["sourceTree"]:
            raise ValueError("cattrs source tree mismatch")
    else:
        checkout.mkdir()
        git(checkout, "init", "-q", "-b", "main")
        for name, body in case["files"].items():
            path = checkout / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body)
        git(checkout, "add", "-A")
        git(checkout, "-c", "user.email=lab@example.invalid", "-c", "user.name=Evaluation",
            "commit", "-q", "-m", "Evaluation baseline")
    for key, value in {
        "user.name": "Evaluation", "user.email": "lab@example.invalid", "core.hooksPath": "/dev/null",
    }.items():
        git(checkout, "config", key, value)
    if git(checkout, "status", "--porcelain"):
        raise ValueError("Checkout must start clean")
    return git(checkout, "rev-parse", "HEAD").decode().strip()


def stage(args):
    if bool(args.cattrs_inputs) != bool(args.cattrs_source):
        raise ValueError("cattrs requires both --cattrs-inputs and --cattrs-source")
    root = Path(tempfile.mkdtemp(prefix="solopup-026-compare.", dir="/private/tmp"))
    packages = {
        "off": None,
        "released": (args.baseline, BASELINE_SHA, "0.25.0-beta.2"),
    }
    if args.candidate:
        if not args.candidate_sha or not args.candidate_version:
            raise ValueError("Candidate requires --candidate-sha and --candidate-version")
        packages["candidate"] = (args.candidate, args.candidate_sha, args.candidate_version)
    package_dirs = {
        condition: unpack(*value, root / condition)
        for condition, value in packages.items() if value
    }
    matrix = []
    picked = [("cattrs", None)] if args.cattrs_source else list(CASES.items())
    for position, (name, case) in enumerate(picked):
        cases_dir = root / name
        cases_dir.mkdir()
        prompt = cases_dir / "instruction.md"
        approved = cases_dir / "approved.json"
        raw = []
        if name == "cattrs":
            for path in (prompt, approved):
                path.write_bytes((args.cattrs_inputs / path.name).read_bytes())
            expected = read(HERE / "cattrs-base.json")
            if digest(prompt) != expected["officialPromptSha256"]:
                raise ValueError("cattrs prompt mismatch")
            raw = [args.cattrs_inputs / filename for filename in ("archive-index.md", "archive.md")]
        else:
            prompt.write_text(case["task"] + "\n")
            dump(approved, {"preferences": case["preferences"]})
        conditions = list(packages)
        # Alternate the first condition across small tasks.
        if position:
            conditions = conditions[1:] + conditions[:1]
        for condition in conditions:
            arm = Path(tempfile.mkdtemp(prefix="arm.", dir=root))
            (arm / "outside-read").write_text("sandbox boundary")
            base = create_checkout(arm, case, args.cattrs_source)
            entry = packages[condition]
            flags = [str(arg) for arg in entry] if entry else []
            run([NODE, str(HERE / "prepare-arm.mjs"), str(arm), *flags], capture_output=True)
            prefs = read(approved)["preferences"]
            markers = [{"id": p["id"], "text": p["summary"].rstrip("。")} for p in prefs]
            if case:
                markers += [{"id": "expected-output-" + str(i), "text": text}
                            for i, text in enumerate(case["scoredTexts"])]
            dump(arm / "memory-evidence.json", markers)
            if entry:
                seed = [arm, package_dirs[condition], approved, *raw]
                run([NODE, str(HERE / "seed-memory.mjs"), *map(str, seed)], capture_output=True)
            matrix.append({
                "case": name, "condition": condition, "arm": str(arm), "base": base,
                "prompt": str(prompt), "promptSha256": digest(prompt),
                "package": read(arm / "prepared.json")["plugin"],
            })
    dump(root / "matrix.json", matrix)
    print(root)


def freeze(arm, base, native):
    checkout = arm / "checkout"
    # Separate index records uncommitted artifacts without editing the model's Git state.
    index = arm / "sealed.index"
    git(checkout, "read-tree", base, index=index)
    git(checkout, "add", "-A", index=index)
    patch = arm / "model.patch"
    patch.write_bytes(git(checkout, "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", base, "--", index=index))
    patch.chmod(0o600)
    changed = git(checkout, "diff", "--cached", "--name-only", "-z", base, "--", index=index)
    return {
        "tree": git(checkout, "write-tree", index=index).decode().strip(),
        "patchSha256": digest(patch),
        "patchBytes": patch.stat().st_size,
        "changed": changed.decode().split("\0")[:-1],
        "nativeCompleted": native["state"] == "completed",
        "modelCommitted": git(checkout, "rev-parse", "HEAD").decode().strip() != base,
    }


def regular_text(path):
    if path.is_file() and not path.is_symlink() and path.stat().st_size <= 128_000:
        return path.read_text(errors="replace")
    return ""


def bounded_model_output(arm, *args):
    result = subprocess.run([
        "/usr/bin/sandbox-exec", "-f", str(arm / "scope.sb"), "/usr/bin/python3", "-I", "-B", *args
    ], cwd=arm / "checkout", env={"PATH": "/usr/bin:/bin", "HOME": str(arm / "home")},
        capture_output=True, text=True, timeout=4)
    return result.stdout if result.returncode == 0 else ""


def score(case, arm):
    target = arm / "checkout" / CASES[case]["artifact"]
    if not target.resolve().is_relative_to(arm / "checkout"):
        return {"taskPassed": False, "preferencePassed": False, "artifactOutsideCheckout": True}
    document = regular_text(target)
    current, prior = CASES[case]["scoredTexts"]
    lines = [line.strip() for line in document.splitlines() if line.strip()]
    new_present, old_present = current in lines, prior in document
    if case == "field-handoff":
        body_pass = all(re.search(pattern, document) for pattern in (
            "南工区", "器材柜[ \t]*B", "安全绳", "复核", "李工", "周五"))
        pref_pass = bool(lines and lines[-1] == current and not old_present)
    else:
        try:
            value = json.loads(bounded_model_output(arm, "meter.py", "--json"))
            body_pass = value == {"service": "meter", "ready": True} and bounded_model_output(arm, "meter.py").strip() == "ready"
        except (ValueError, subprocess.TimeoutExpired):
            body_pass = False
        pref_pass = new_present and not old_present and re.search(r"meter\.py\s+--json", document) is not None
    return {
        "taskPassed": body_pass, "preferencePassed": pref_pass, "currentPresent": new_present,
        "oldPresent": old_present, "artifactBytes": len(document.encode()),
    }


def execute(args):
    root = args.root.resolve()
    matrix = read(root / "matrix.json")
    receipts = []
    receipt_path = root / ("receipts" + ("-" + "-".join(args.condition) if args.condition else "") + ".json")
    mode = "live" if args.live else "mock"
    if args.live:
        key = sys.stdin.read().strip()
        if len(key) < 12 or any(ch.isspace() for ch in key):
            raise ValueError("Model credential must arrive via stdin")
    else:
        key = ""
    for row in matrix:
        arm = Path(row["arm"])
        if args.condition and row["condition"] not in args.condition:
            continue
        if digest(Path(row["prompt"])) != row["promptSha256"]:
            raise ValueError("Task prompt changed after staging")
        timeout = 1200 if row["case"] == "cattrs" and args.live else args.seconds
        env = {**os.environ, **({"SOLOPUP_EVAL_PYTHON": str(args.python)} if args.python else {})}
        start = time.monotonic()
        subprocess.run([NODE, str(HERE / "native-run.mjs"), str(arm), row["prompt"], mode, str(timeout * 1000)],
                       input=key, text=True, env=env, check=False)
        if not (arm / "run.json").is_file():
            raise RuntimeError("Native runner could not start. Check permission to bind the loopback relay.")
        native = read(arm / "run.json")
        grade = freeze(arm, row["base"], native)
        requests = native["requests"]
        receipt = {
            **row, **grade, "mode": mode, "runtimeSeconds": round(time.monotonic() - start, 2),
            "maxRuntimeSeconds": timeout, "timedOut": native["timeout"],
            "dsh": read(arm / "prepared.json")["version"], "pluginLoaded": native["pluginLoaded"],
            "mockWorkspaceAccessVerified": native.get("mockWorkspaceAccessVerified"),
            "firstRequestEvidence": [r["id"] for r in requests[0]["exactSourceHits"]] if requests else [],
            "firstRequestEffectiveView": bool(requests and requests[0]["effectiveView"]),
            "firstReviewCueRequest": next((r["index"] for r in requests if r["reviewCue"]), None),
            "http200": sum(r.get("upstreamStatus") == 200 for r in requests),
            "usage": {name: sum(r.get("usage", {}).get(name, 0) for r in requests)
                      for name in ("prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens")},
            "calls": [r["name"] for r in native["toolCalls"]],
        }
        if row["case"] != "cattrs" and args.live:
            receipt["outcome"] = score(row["case"], arm)
        dump(arm / "receipt.json", receipt)
        receipts.append(receipt)
        dump(receipt_path, receipts)
        print(json.dumps(receipt, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    sub = cli.add_subparsers(required=True)
    setup = sub.add_parser("stage")
    setup.add_argument("--baseline", type=lambda p: Path(p).resolve(), required=True)
    setup.add_argument("--candidate", type=lambda p: Path(p).resolve())
    setup.add_argument("--candidate-sha")
    setup.add_argument("--candidate-version")
    setup.add_argument("--cattrs-inputs", type=lambda p: Path(p).resolve())
    setup.add_argument("--cattrs-source", type=lambda p: Path(p).resolve())
    setup.set_defaults(call=stage)
    launch = sub.add_parser("run")
    launch.add_argument("root", type=Path)
    launch.add_argument("--condition", choices=["off", "released", "candidate"], action="append")
    launch.add_argument("--seconds", type=int, default=90, choices=range(10, 121), metavar="10..120")
    launch.add_argument("--python", type=lambda p: Path(p).resolve())
    launch.add_argument("--live", action="store_true")
    launch.set_defaults(call=execute)
    args = cli.parse_args()
    args.call(args)
