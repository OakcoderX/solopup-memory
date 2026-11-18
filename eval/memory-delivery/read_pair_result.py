import hashlib
import json
import re
import sys
from pathlib import Path

condition, job_path, patch_path = sys.argv[1:]
job = Path(job_path)
trials = sorted(p.parent for p in job.glob("cattrs-*/result.json"))
if len(trials) != 1:
    raise SystemExit(f"Expected one trial, got {len(trials)}")
trial = trials[0]

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

parsed = json.loads((trial / "result.json").read_text())
result = parsed.get("verifier_result")
raw_path = trial / "verifier" / "reward.json"
raw = json.loads(raw_path.read_text()) if raw_path.exists() else None
trace = trial / "agent" / "patch-import.txt"
trace_value = {}
if trace.is_file():
    for name in ("base", "patch_sha256", "output_tree"):
        match = re.search(rf"^{name}=([0-9a-f]{{40,64}})$", trace.read_text(), flags=re.M)
        if match:
            trace_value[name] = match.group(1)
patch_hash = sha(Path(patch_path))
if "patch_sha256" in trace_value and trace_value["patch_sha256"] != patch_hash:
    raise SystemExit("The collected input patch hash disagrees with the frozen candidate.")
allowed_names = ("documentation", "runnable_example", "changelog_entry")
grade_log = trial / "verifier" / "test-stdout.txt"
grades = {}
if grade_log.exists():
    for value, name in re.findall(r"^\[user-preference-gate\] (PASS|FAIL|ERROR|SKIP) (\w+):", grade_log.read_text(), flags=re.M):
        if name in allowed_names:
            grades[name] = value
collector_patch = trial / "artifacts" / "logs" / "artifacts" / "model.patch"
summary = {
    "condition": condition,
    "harbor": "0.24.0",
    "task": "cattrs-compositional-changelog",
    "trial": trial.name,
    "gradingModelsCalled": 0,
    "candidatePatchSha256": patch_hash,
    "patchImport": trace_value,
    "collectorPatchSha256": sha(collector_patch) if collector_patch.is_file() else None,
    "verifierEnvironment": "official separate verifier with no network",
    "accepted": isinstance(result, dict) and result.get("rewards") == raw,
    "reward": raw,
    "preferenceGates": grades,
    "exception": (parsed.get("exception_info") or {}).get("exception_type"),
}
print(json.dumps(summary, indent=2))
