#!/usr/bin/env bash
#
# Replaces the user facing product name everywhere it is plain text:
#
#   tools/rebrand.sh Scheduler "New Name"
#
# Static pages are rewritten in place rather than filled in at startup, so they stay ordinary files
# with ordinary ETags. Only whole, case sensitive matches change, which leaves the lowercase
# scheduler.sdw.dev host and the GitHub repo path alone, and every internal DraftPoll name too.
# It does not touch images, the domain, or anything under deploy/. Work through the rebrand
# checklist in CLAUDE.md afterwards, then read the diff before committing.
set -euo pipefail

if [ $# -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo "usage: tools/rebrand.sh OLD NEW" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

OLD=$1 NEW=$2 python3 - <<'PY'
import os, re, glob

old, new = os.environ["OLD"], os.environ["NEW"]
pattern = re.compile(r"(?<![\w.-])" + re.escape(old) + r"(?![\w-])")

files = ["Site.cs", "wwwroot/site.js", "tests/e2e.sh", "README.md"] + sorted(glob.glob("wwwroot/*.html"))
for path in files:
    with open(path, encoding="utf-8") as f:
        text = f.read()
    # Site.cs mentions the name in comments too, so only the constant itself changes there.
    if path == "Site.cs":
        updated, count = re.subn(r'(public const string Name = )"' + re.escape(old) + '"',
                                 lambda m: m.group(1) + '"' + new + '"', text)
    else:
        updated, count = pattern.subn(new, text)
    if count:
        with open(path, "w", encoding="utf-8") as f:
            f.write(updated)
        print(f"{count:4d}  {path}")
PY

echo
echo "Still to do by hand: og.png, the alternative page copy (check a/an before the new name),"
echo "and the rest of the rebrand checklist in CLAUDE.md."
