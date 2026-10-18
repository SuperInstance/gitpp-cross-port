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
  # The build output is NOT suppressed. An earlier version sent it to
  # /dev/null, so a build failure produced the single line
  #     build ports/csharp
  #     Process completed with exit code 1
  # and nothing else -- no diagnostic at all. A build step that hides
  # its own errors is a build step that cannot be debugged from a log.
  #
  # The DEFAULT output path is used, and the result is copied.
  #
  # It is NOT `dotnet build -o <dir>`. Pointing -o at a directory that is
  # an ANCESTOR of the project directory silently excludes the project's
  # own sources, because DefaultItemExcludes contains
  # $(BaseOutputPath)/** -- and -o sets BaseOutputPath. The compile then
  # contains only the GENERATED files:
  #
  #   obj/Release/net9.0/Test.GlobalUsings.g.cs
  #   obj/Release/net9.0/.NETCoreApp,Version=v9.0.AssemblyAttributes.cs
  #   obj/Release/net9.0/Test.AssemblyInfo.cs
  #
  # and the build fails with
  #
  #   CSC : error CS5001: Program does not contain a static 'Main' method
  #         suitable for an entry point
  #
  # which points at the WRONG THING ENTIRELY. Program.cs is right there
  # in the project. The build is fine; the output path was not.
  ( cd ports/csharp && dotnet build test/Test.csproj -c Release )
  mkdir -p ports/csharp
  cp ports/csharp/test/bin/Release/net9.0/*.dll ports/csharp/ 2>/dev/null || true
  cp ports/csharp/test/bin/Release/net9.0/*.json ports/csharp/ 2>/dev/null || true
  test -f ports/csharp/Test.dll || {
    echo "  FATAL: the C# port did not produce Test.dll"; exit 1; }
fi

# The corpus.
if [ ! -d cases ]; then
  echo "  clone the corpus"
  git clone --depth 1 "https://x-access-token:${GITHUB_TOKEN:?set GITHUB_TOKEN}@github.com/SuperInstance/gitpp-conformance.git" .conformance
  cp -r .conformance/cases cases
fi

echo "  ready: $(find cases -name '*.json' | wc -l) case(s)"
