#!/usr/bin/env bash
# setup-mutate.sh -- build what the MUTATION pass needs.
#
# The mutation pass and the conformance pass need DIFFERENT builds, and
# only the conformance pass had a setup. setup.sh builds the FOLD
# ports (ports/c/gitpp, ports/csharp/Test.dll). The mutator drives the
# LEAF wrappers, which are different programs in different places:
#
#   CLleaf          the C leaf wrapper, built from CLleaf.c in THIS repo
#   CsLeaf.dll      the C# leaf wrapper, built from CsLeaf/ in THIS repo
#
# So the mutator had a runner and no way to build what it runs. This
# script is that way.
#
# Everything it builds is built FROM SOURCE, and every path it uses is
# derived from where the thing actually is.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# 1. The C leaf wrapper. CLleaf.c is in this repo; the C PORT is a
#    sibling and is cloned by the caller.
if [ ! -f CLleaf.c ]; then
  echo "FATAL: CLleaf.c is not in $ROOT" >&2
  exit 1
fi
echo "  build CLleaf"
gcc -O2 -o CLleaf CLleaf.c -lm

# 2. The C# leaf wrapper. It references the gitpp-cs project, which is
#    a SIBLING of this repo. The csproj resolves that path itself, and
#    honours GITPP_CS_DIR for a layout where it is elsewhere.
if command -v dotnet >/dev/null 2>&1; then
  echo "  build CsLeaf"
  dotnet build CsLeaf -c Release
else
  echo "  NOTE: no dotnet on PATH -- the cs participant will be absent"
fi

# 3. The mutator needs a writable HOME for the C# participant, because
#    NuGet writes to it. A path that does not exist is an error, not a
#    warning, and the participant's error would say "cs: ..." with no
#    clue why.
export GITPP_FAKE_HOME="${GITPP_FAKE_HOME:-/tmp/mut-home}"
mkdir -p "$GITPP_FAKE_HOME"

echo "  ready: CLleaf=$(test -x ./CLleaf && echo yes || echo no)" \
     "CsLeaf=$(test -f CsLeaf/bin/Release/net9.0/CsLeaf.dll && echo yes || echo no)"
