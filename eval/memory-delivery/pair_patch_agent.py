"""Harbor worker that replays a candidate patch without model calls."""
import hashlib
import re
import shlex
from pathlib import Path

from harbor.agents.base import BaseAgent

EXPECTED_BASE = "6bc4708fb9b2ac52d9a18997e923da6a58916102"
EXPECTED_TREE = "2ebd2041c8a5625c3a52328a98375fea398eb848"


class CandidatePatchAgent(BaseAgent):
    def __init__(self, *args, patch_path: str, expected_output_tree: str = "", **kwargs):
        super().__init__(*args, **kwargs)
        self.local_patch = Path(patch_path).resolve(strict=True)
        if not self.local_patch.is_file():
            raise ValueError("The patch argument must be a file")
        if expected_output_tree and not re.fullmatch("[0-9a-f]{40}", expected_output_tree):
            raise ValueError("Invalid candidate Git tree ID")
        self.expected_output_tree = expected_output_tree

    @staticmethod
    def name() -> str:
        return "solopup-candidate-patch"

    def version(self) -> str:
        return "1"

    async def setup(self, environment) -> None:
        pass

    async def run(self, instruction, environment, context) -> None:
        patch = self.local_patch.read_bytes()
        patch_hash = hashlib.sha256(patch).hexdigest()
        remote_patch = "/tmp/solopup-candidate.patch"
        await environment.upload_file(source_path=self.local_patch, target_path=remote_patch)
        expected_output_tree = shlex.quote(self.expected_output_tree)
        result = await environment.exec(f"""
set -eu
cd /app
git_repo() {{ git -c safe.directory=/app "$@"; }}
test "$(git_repo rev-parse HEAD)" = "{EXPECTED_BASE}"
test "$(git_repo rev-parse HEAD^{{tree}})" = "{EXPECTED_TREE}"
test -z "$(git_repo status --porcelain=v1 --untracked-files=all)"
test "$(sha256sum {remote_patch} | cut -d' ' -f1)" = "{patch_hash}"
if [ -s {remote_patch} ]; then
  git_repo -c core.autocrlf=false apply --index --whitespace=nowarn {remote_patch}
  git_repo -c user.email=solopup-lab@example.invalid -c user.name="SoloPup paired evaluator" \\
    -c commit.gpgsign=false commit --no-verify -m "Import frozen DSH submission" >/dev/null
fi
tree="$(git_repo rev-parse HEAD^{{tree}})"
expected_tree={expected_output_tree}
test -z "$expected_tree" || test "$tree" = "$expected_tree"
printf "base=%s\\npatch_sha256=%s\\noutput_tree=%s\\n" "{EXPECTED_BASE}" "{patch_hash}" "$tree"
""", cwd="/app")
        log = "\n".join(x for x in (result.stdout, result.stderr) if x)
        (self.logs_dir / "patch-import.txt").write_text(log)
        if result.return_code != 0:
            raise RuntimeError(f"Candidate patch import failed ({result.return_code})")
