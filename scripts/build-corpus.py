#!/usr/bin/env python3
"""Copy a local "real" round-trip corpus into tests/corpus/fixtures/real/.

The committed corpus (tests/fixtures/docs and tests/corpus/fixtures/synthetic) is synthetic. To also exercise the
round-trip and suggestion gates on your own Markdown, point MDR_CORPUS_WORKSPACE at a folder of .md files you are happy
to copy locally; every .md under it is byte-copied (no newline translation, no BOM handling) into the gitignored
fixtures/real/ folder. Without MDR_CORPUS_WORKSPACE the script says so and exits 0: `npm run corpus` then runs the
synthetic set and prints "real: skipped".

Usage: MDR_CORPUS_WORKSPACE=~/notes python3 scripts/build-corpus.py [--limit N]
"""
import os, shutil, sys

WS = os.environ.get("MDR_CORPUS_WORKSPACE")
if not WS or not os.path.isdir(os.path.expanduser(WS)):
    print("build-corpus: set MDR_CORPUS_WORKSPACE to a folder of .md files to build a local real corpus. Skipping.",
          file=sys.stderr)
    sys.exit(0)
WS = os.path.expanduser(WS)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "corpus", "fixtures", "real")
SKIP_DIRS = {".git", "node_modules", ".review"}


def main() -> int:
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 200
    os.makedirs(OUT, exist_ok=True)
    n = 0
    for d, dirs, files in os.walk(WS):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        for f in sorted(files):
            if not f.endswith(".md") or n >= limit:
                continue
            rel = os.path.relpath(os.path.join(d, f), WS)
            shutil.copyfile(os.path.join(d, f), os.path.join(OUT, "real__" + rel.replace(os.sep, "__")))
            n += 1
    print(f"copied {n} real files -> {os.path.normpath(OUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
