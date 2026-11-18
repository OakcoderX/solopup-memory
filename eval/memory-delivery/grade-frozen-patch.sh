#!/usr/bin/env bash
set -eu -o pipefail
condition="$1"
patch="$(realpath "$2")"
candidate_tree="${3:-}"
job="$4"
case "$condition" in off|on|transport) ;; *) exit 64 ;; esac
case "$job" in fm-cattrs-*) ;; *) exit 64 ;; esac
root="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$root"
task="/tmp/frontier-tasks/cattrs-compositional-changelog"
printf '%s  %s\n' e076d63ec231131c325f4cb328edc0e9c7abf702214a86fa067de15d6a6e48fd "$task/task.toml" \
  64e2cc8d229b6e38893b2a01288393882d5fc92483c28ca65cacba3b2d343cd5 "$task/tests/test.sh" \
  9f4dd9f5b27c98acdcddf4c93fe45291f1d2d66025607e2eaec60417bf19f370 "$task/environment/Dockerfile" | sha256sum -c -
entry="$root/harbor-venv/bin/harbor"
if [ ! -x "$entry" ]; then
  entry="$(find "$root/uv-cache/archive-v0" -type f -path '*/bin/harbor' -print -quit)"
fi
test -x "$entry"
args=(--ak "patch_path=$patch")
if [ -n "$candidate_tree" ]; then
  args+=(--ak "expected_output_tree=$candidate_tree")
fi
runner=(sudo -n env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8)
"${runner[@]}" "PYTHONPATH=$root" "$entry" run -p "$task" --agent pair_patch_agent:CandidatePatchAgent \
  "${args[@]}" -e docker -k 1 -n 1 --job-name "$job"
"${runner[@]}" /usr/bin/python3 "$root/read_pair_result.py" "$condition" "$root/jobs/$job" "$patch" |
  tee "$root/$job-receipt.json"
