"""Stage public history for the isolated cattrs policy comparison."""
import argparse
from hashlib import sha256
from html import unescape
import json
from pathlib import Path
import re


FIXTURE = Path(__file__).resolve().parent
SOURCE_MANIFEST = FIXTURE / "cattrs-sources.json"
SOURCES = [
    ("02.129", "Keep changelog and release-note files untouched unless explicitly asked for an entry.", None),
    ("06.128", "For a new public API, show a minimal copyable example using the actual API that runs as-is.", None),
    ("08.72", "By default, add a concise changelog entry for user-facing behavior changes.", "02.129"),
]


def digest(data):
    return sha256(data).hexdigest()


def stage(downloads, prompt, out):
    manifest = json.loads(SOURCE_MANIFEST.read_text())
    baseline = json.loads((FIXTURE / "cattrs-base.json").read_text())
    if digest(prompt.read_bytes()) != baseline["officialPromptSha256"]:
        raise ValueError("Official prompt hash mismatch")
    turns = {}
    for row in manifest["sources"]:
        name = row["url"].rstrip("/").rsplit("/", 1)[1]
        html = (downloads / (name + ".html")).read_bytes()
        if digest(html) != row["sha256"]:
            raise ValueError(f"Archived public source hash mismatch: {name}")
        ordered = re.findall(r'<article class="trace-step role-user">(.*?)</article>', html.decode(), re.S)
        if len(ordered) != row["historicalUserTurns"]:
            raise ValueError(f"Public source turn count mismatch: {name}")
        for section in ordered:
            step = re.search(r'<span class="index">(\d+)</span>', section).group(1)
            body = re.findall(r'<section>\s*<pre>(.*?)</pre>\s*</section>', section, re.S)
            if len(body) != 1:
                raise ValueError(f"Malformed user turn: {name}.{step}")
            turns[f"{row['order']:02d}.{step}"] = unescape(body[0]).strip()
    if len(turns) != manifest["historicalUserTurns"]:
        raise ValueError("Duplicate public source turn")
    out.mkdir()
    (out / "instruction.md").write_bytes(prompt.read_bytes())
    source_rows = [
        dict(id=turn, quote=turns[turn], summary=rule, **({"supersedes": old} if old else {}))
        for turn, rule, old in SOURCES
    ]
    (out / "approved.json").write_text(json.dumps({
        "sourceSession": "frontier-cattrs-public-history", "preferences": source_rows
    }, ensure_ascii=False, indent=2) + "\n")
    references = "\n".join(f"- {row['order']:02d}: {row['url']}" for row in manifest["sources"])
    archive = "# Full historical user messages\n\n" + references + "\n\n"
    archive += "\n\n".join(f"## User {turn}\n\n{text}" for turn, text in turns.items()) + "\n"
    if digest(archive.encode()) != manifest["topicSha256"]:
        raise ValueError("Full transcript archive hash mismatch")
    (out / "archive.md").write_text(archive)
    (out / "archive-index.md").write_text(
        "## Historical archive\n"
        "- [reference] Archived public conversation evidence, including superseded statements. — reference.md\n"
    )
    (out / "sources-receipt.json").write_text(json.dumps({
        "archiveSha256": digest(archive.encode()),
        "rawTurnCount": len(turns),
        "approved": [
            {"id": row["id"], "sourceSha256": digest(row["quote"].encode()), "supersedes": row.get("supersedes")}
            for row in source_rows
        ],
        "sourceManifestSha256": digest(SOURCE_MANIFEST.read_bytes()),
    }, indent=2) + "\n")


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    for argument in ("downloads", "prompt", "out"):
        cli.add_argument(argument, type=Path)
    args = cli.parse_args()
    stage(args.downloads, args.prompt, args.out)
