#!/usr/bin/env bash
# setup.sh — install the 4 ports' CLIs into ./ports/ for the cross-port test
#
# This script clones the port repos at the pinned versions known to pass
# the cross-port test. Run once, then run.mjs will use the local CLIs.

set -e

mkdir -p ports
cd ports

# Python (referee from git.pp-ng)
if [ ! -d "python" ]; then
  git clone --depth 1 https://github.com/patchwork-quilt/git.pp-ng.git python-src
  cp python-src/referee/gitpp_doctor.py python/gitpp_doctor.py
  rm -rf python-src
fi

# JavaScript
if [ ! -d "javascript" ]; then
  git clone --depth 1 https://github.com/SuperInstance/gitpp-js.git javascript
fi

# C# — copy the pre-built test artifact
if [ ! -d "csharp" ]; then
  git clone --depth 1 https://github.com/SuperInstance/gitpp-cs.git csharp-src
  HOME=/tmp/fake-home mkdir -p /tmp/fake-home
  HOME=/tmp/fake-home dotnet build csharp-src/test/Test.csproj 2>&1 | tail -2
  cp csharp-src/test/bin/Debug/net9.0/Test.dll csharp/Test.dll
  cp csharp-src/test/bin/Debug/net9.0/Gitpp.dll csharp/Gitpp.dll
  cp csharp-src/test/bin/Debug/net9.0/Test.deps.json csharp/Test.deps.json
  cp csharp-src/test/bin/Debug/net9.0/Test.runtimeconfig.json csharp/Test.runtimeconfig.json
  rm -rf csharp-src
fi

# Perl
if [ ! -d "perl" ]; then
  git clone --depth 1 https://github.com/SuperInstance/gitpp-pl.git perl-src
  mkdir -p perl
  cp -r perl-src/bin perl/bin
  cp -r perl-src/lib perl/lib
  rm -rf perl-src
fi

# Conformance cases
if [ ! -d "../cases" ]; then
  git clone --depth 1 https://github.com/SuperInstance/gitpp-conformance.git ../cases-src
  cp -r ../cases-src/cases ../cases
  rm -rf ../cases-src
fi

echo ""
echo "Setup complete. Run: node run.mjs"
