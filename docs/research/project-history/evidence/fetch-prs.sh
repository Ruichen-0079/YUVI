#!/bin/bash
# Re-create the PR research cache used by this study.
# Usage: fetch-prs.sh <cache_dir>
# Produces <cache_dir>/all_pulls.json, <cache_dir>/index_rows.json and
# <cache_dir>/prs/<N>/{pr,comments,reviews,review_comments,commits,files,files2}.json
set -euo pipefail
CACHE=${1:?cache dir}
API=https://api.github.com/repos/Ruichen-0079/YUVI
mkdir -p "$CACHE/pulls" "$CACHE/prs"
get() { [ -s "$2" ] && return 0; curl -sS -f -H 'Accept: application/vnd.github+json' "$1" -o "$2"; }
for p in 1 2 3 4; do
  get "$API/pulls?state=all&per_page=100&page=$p&sort=created&direction=asc" "$CACHE/pulls/page$p.json"
done
python3 - "$CACHE" <<'PY'
import glob, json, sys
c = sys.argv[1]
allp = []
for f in sorted(glob.glob(f'{c}/pulls/page*.json')):
    allp += json.load(open(f))
json.dump(allp, open(f'{c}/all_pulls.json', 'w'))
print('\n'.join(str(p['number']) for p in allp), file=open(f'{c}/numbers.txt', 'w'))
PY
for N in $(cat "$CACHE/numbers.txt"); do
  D="$CACHE/prs/$N"; mkdir -p "$D"
  get "$API/pulls/$N" "$D/pr.json"
  get "$API/issues/$N/comments?per_page=100" "$D/comments.json"
  get "$API/pulls/$N/reviews?per_page=100" "$D/reviews.json"
  get "$API/pulls/$N/comments?per_page=100" "$D/review_comments.json"
  get "$API/pulls/$N/commits?per_page=100" "$D/commits.json"
  get "$API/pulls/$N/files?per_page=100" "$D/files.json"
  get "$API/pulls/$N/files?per_page=100&page=2" "$D/files2.json" || true
done
python3 - "$CACHE" <<'PY'
import json, os, sys
c = sys.argv[1]
rows = []
for n in [int(x) for x in open(f'{c}/numbers.txt').read().split()]:
    d = f'{c}/prs/{n}'
    pr = json.load(open(f'{d}/pr.json'))
    st = 'merged' if pr['merged_at'] else pr['state']
    rows.append(dict(n=n, title=pr['title'], state=st, created=pr['created_at'][:10],
        merged=(pr['merged_at'] or '')[:10], closed=(pr['closed_at'] or '')[:10],
        user=pr['user']['login'], body_len=len(pr['body'] or ''),
        ncom=len(json.load(open(f'{d}/comments.json'))), nrev=len(json.load(open(f'{d}/reviews.json'))),
        nrc=len(json.load(open(f'{d}/review_comments.json'))), ncommits=len(json.load(open(f'{d}/commits.json'))),
        nfiles=pr['changed_files'], add=pr['additions'], dele=pr['deletions'],
        head=pr['head']['ref'], base=pr['base']['ref'], draft=pr['draft']))
json.dump(rows, open(f'{c}/index_rows.json', 'w'), ensure_ascii=False)
PY
