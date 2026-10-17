#!/usr/bin/env bash
# setup.sh -- populate the ports/ and cases/ trees that run.mjs expects.
#
# This file used to be a JavaScript program with a .sh extension: a
# near-copy of run.mjs with a live fetch added. It could not bootstrap
# anything -- neither run.mjs nor setup.sh created ports/ or cases/ --
# so the repository could not run itself. That is why it had no CI:
# there was nothing that could be automated.
#
# Usage:  ./setup.sh
# Then:   node run.mjs
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# The ports, as SIBLINGS under ports/. The paths here match run.mjs
# exactly, and the perl wrapper resolves its module from ports/lib.
clone() { # <repo> <dest>
  if [ -d "$2" ]; then echo "  have $2"; return; fi
  echo "  clone $1 -> $2"
  git clone --depth 1 "https://x-access-token:${GITHUB_TOKEN:?set GITHUB_TOKEN}@github.com/SuperInstance/$1.git" "$2"
}

mkdir -p ports
clone gitpp-c            ports/c
clone git.pp-doctor      ports/python
clone gitpp-js           ports/javascript
clone gitpp-cs          ports/csharp
clone gitpp-pl           ports/perl

# The perl port's module lives in lib/, but run.mjs invokes
# ports/perl/gitpp-pl, whose `use lib "../lib"` resolves to ports/lib.
cp -r ports/perl/lib ports/lib 2>/dev/null || true
cp -r ports/perl/bin/gitpp-pl ports/perl/gitpp-pl
chmod +x ports/perl/gitpp-pl

# Build the C port FROM SOURCE. The repo ships a prebuilt binary and a
# stale one would test the wrong build.
if [ -f ports/c/Makefile ]; then
  echo "  build ports/c"
  ( cd ports/c && make clean >/dev/null 2>&1 || true; make >/dev/null )
  export GITPP_C_BIN="$ROOT/ports/c/gitpp"
fi

# Build the C# port. run.mjs invokes `dotnet ports/csharp/Test.dll`,
# which needs the whole output directory beside it -- the runtimeconfig
# and the sibling assemblies -- not just the one dll.
if command -v dotnet >/dev/null 2>&1; then
  echo "  build ports/csharp"
  ( cd ports/csharp && dotnet build test/Test.csproj -c Release -o "$ROOT/ports/csharp" >/dev/null )
fi

# The corpus.
if [ ! -d cases ]; then
  echo "  clone the corpus"
  git clone --depth 1 "https://x-access-token:${GITHUB_TOKEN:?set GITHUB_TOKEN}@github.com/SuperInstance/gitpp-conformance.git" .conformance
  cp -r .conformance/cases cases
fi

echo "  ready: $(find cases -name '*.json' | wc -l) case(s)"
