"""Score the frozen synthetic writing fixture without exposing drafts or wire logs."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from compare import freeze, read, regular_text


def audit_review(arm, artifact, phrase):
    transcript = next((arm / 'home').rglob('session.v4.jsonl.zstd'), None)
    if transcript is None:
        return {'available': False}
    decoded = subprocess.run(['zstd', '-qdc', str(transcript)], capture_output=True, check=True, timeout=5)
    events = [json.loads(line) for line in decoded.stdout.splitlines()]
    cues = [event for event in events if event.get('type') == 'user/message' and
            event.get('data', {}).get('source', {}).get('kind') == 'solopup-delivery-review']
    first_review = cues[0]['seq'] if cues else None
    calls = {}
    reread = False
    suffix_check = False
    prefix_only = False
    edits = []
    for event in events:
        data = event.get('data', {})
        if event.get('type') == 'tool/call':
            calls[data.get('callId')] = event
            continue
        if event.get('type') != 'tool/result':
            continue
        message = data.get('message', {})
        call = calls.get(message.get('toolCallId'))
        if call is None or message.get('isError') or data.get('error'):
            continue
        tool = call['data'].get('name')
        raw = call['data'].get('arguments', {})
        try:
            args = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            continue
        if not isinstance(args, dict):
            continue
        path = args.get('file_path', args.get('path', ''))
        command = args.get('command', '')
        if not isinstance(path, str) or not isinstance(command, str):
            continue
        during_review = first_review is not None and call['seq'] > first_review
        if during_review and tool == 'read' and Path(path).name == artifact:
            reread = True
        if during_review and tool == 'bash' and re.search(r'\b(?:cat\b|tail\b|open\()[^;|\n]*' + re.escape(artifact), command):
            reread = True
            output = '\n'.join(block.get('text', '') for block in message.get('content', []) if block.get('type') == 'text')
            suffix_check |= '.endswith(' in command and 'last line ok:' in output
            prefix_only |= bool(re.search(r'\.split\([^\n]*\)\[0\]', command))
        if tool in ('edit', 'write') and Path(path).name == artifact:
            replacement = args.get('content', args.get('new_string', ''))
            if isinstance(replacement, str):
                edits.append({'tool': tool, 'duringReview': during_review,
                              'containsRetainedWording': phrase in replacement,
                              'replacementEndsWithRetainedWording': replacement.strip().endswith(phrase)})
    return {'available': True, 'noticeCount': len(cues), 'readArtifactDuringReview': reread,
            'suffixCheckResultObservedDuringReview': suffix_check,
            'reviewReadCommandSelectedPrefix': prefix_only,
            'successfulArtifactEdits': edits}


def score(row, fixture):
    arm = Path(row['arm']).resolve()
    native = read(arm / 'run.json')
    definition = fixture['frozen']
    goals, artifact = definition['goals'], definition['artifact']
    prompt = Path(row['prompt']).read_bytes()
    expected = definition['promptSha256']
    if hashlib.sha256(prompt).hexdigest() != expected or native['promptSha256'] != expected:
        raise ValueError('The task does not match the frozen prompt')
    outcome = freeze(arm, row['base'], native)
    target = arm / 'checkout' / artifact
    content = regular_text(target) if target.resolve().is_relative_to(arm / 'checkout') else ''
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    length = len(re.findall('[\u3400-\u9fff]', content))
    checks = {
        'deliverable': outcome['changed'] == [artifact] and bool(content) and 90 <= length <= 260,
        'newRoute': goals['newRoute'] in content and goals['supersededRoute'] not in content,
        'retainedEnding': bool(lines and lines[-1].rstrip('」』”"').endswith(goals['exactLastLine'])),
        'reviewEditionException': goals['reviewEditionSound'] in content and goals['supersededForEditionSound'] not in content,
    }
    requests = native['requests']
    return {
        'condition': row['condition'], 'package': row['package'], 'model': native['model'],
        'temperature': native['temperature'], 'thinking': native['thinking'], 'maxRuntimeMs': native['maxRuntimeMs'],
        'runState': native['state'], 'timedOut': native['timeout'], 'pluginLoaded': native['pluginLoaded'],
        'passed': all(checks.values()) and native['state'] == 'completed', 'checks': checks,
        'hanCharacters': length, 'artifactSha256': hashlib.sha256(content.encode()).hexdigest() if content else None,
        'changed': outcome['changed'], 'patchSha256': outcome['patchSha256'], 'requests': len(requests),
        'upstreamOk': sum(request.get('upstreamStatus') == 200 for request in requests),
        'requestsWithEffectiveView': sum(request.get('effectiveView', False) for request in requests),
        'requestsWithReviewCue': sum(request.get('reviewCue', False) for request in requests),
        'initialSourceMarkers': [marker['id'] for marker in requests[0]['exactSourceHits']] if requests else [],
        'toolCalls': dict(collections.Counter(call['name'] for call in native['toolCalls'])),
        'reviewAudit': audit_review(arm, artifact, goals['exactLastLine']),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', type=Path, help='Isolated case directory printed by compare.py stage')
    args = parser.parse_args()
    fixture = read(HERE / 'fixture.json')
    matrix = [row for row in read(args.stage / 'matrix.json') if row['case'] == 'fiction-ending']
    if not matrix:
        raise ValueError('The staged matrix does not contain the frozen creative fixture')
    completed = [row for row in matrix if (Path(row['arm']) / 'run.json').is_file()]
    if not completed:
        raise ValueError('No native run receipts are available')
    report = {'frozen': fixture['frozen'], 'results': [score(row, fixture) for row in completed],
              'unexecuted': [row['condition'] for row in matrix if row not in completed]}
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
