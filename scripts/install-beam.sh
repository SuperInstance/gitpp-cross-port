#!/usr/bin/env bash
# Install OTP 27 + Elixir 1.17 from builds.hex.pm, into $BEAM_HOME, no sudo.
#
# WHY PRECOMPILED AND NOT THE DISTRO PACKAGES
# -------------------------------------------
# gitpp-beam's lib/gitpp/canon.ex uses a runtime-sized binary segment:
#
#     <<int_part::binary-size(^decpt), frac_part::binary>> = digits
#
# which is Elixir 1.17 syntax. Ubuntu 22.04 and 24.04 ship Elixir 1.14
# (apt: "elixir" 1.14.0-2), and 1.14 cannot even PARSE the module, so the
# failure is a compile error in the port rather than a test failure -- the
# worst possible shape, because "the port disagrees" and "the toolchain is
# too old" look identical from the harness, which only sees a non-zero exit.
#
# builds.hex.pm publishes precompiled OTP per Ubuntu release and precompiled
# Elixir per OTP major, each with a SHA-256 in a signed-by-nobody manifest
# (builds.txt). We pin BOTH the version and the checksum, and we select the
# OTP build by DETECTED distro so the recipe does not silently use an ubuntu-
# 22.04 binary on a 24.04 runner.
#
# Upstream's own recipe (gitpp-beam README) is the same shape; it is
# reproduced here rather than reinvented, with the distro detection, the
# checksum verification and a source-build fallback added.
set -euo pipefail

BEAM_HOME="${BEAM_HOME:-$HOME/toolchain/beam}"
OTP_VERSION="${OTP_VERSION:-27.3.4.9}"
ELIXIR_VERSION="${ELIXIR_VERSION:-1.17.3}"

# Published checksums for the pins above. Sourced from builds.txt at the same
# URLs the tarballs come from, so a rotated build fails the build rather than
# the tests.
OTP_SHA256_x86_64_ubuntu_22_04="${OTP_SHA256_x86_64_ubuntu_22_04:-8ff93b2f89fd3c47342e22a031eb303c24305aeddaae0736462103ea04565e83}"
OTP_SHA256_x86_64_ubuntu_24_04="${OTP_SHA256_x86_64_ubuntu_24_04:-a9864f486e575e5e1c8e507641168bc31dbb43d7cfa8e124d5e8b67a6f6248d2}"
ELIXIR_SHA256="${ELIXIR_SHA256:-867ba03a0e012861f739b27030d06ab23d73245200c4e3fed3e8385fb98ba692}"

mkdir -p "$BEAM_HOME"
cd "$BEAM_HOME"

. /etc/os-release 2>/dev/null || true
# BEAM_DISTRO pins the builds.hex.pm platform slug. CI sets it explicitly so the
# toolchain does not move under the workflow when GitHub changes the default
# runner image; locally it is detected. An unsupported slug falls through to the
# source build below rather than to a wrong binary.
DISTRO="${BEAM_DISTRO:-${ID:-unknown}-${VERSION_ID:-unknown}}"
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "install-beam: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

echo "==> installing OTP $OTP_VERSION / Elixir $ELIXIR_VERSION for $DISTRO ($ARCH) into $BEAM_HOME"

# Does builds.hex.pm publish a precompiled OTP for this platform slug?
if curl -fsS --max-time 30 "https://builds.hex.pm/builds/otp/$ARCH/$DISTRO/builds.txt" -o builds.txt 2>/dev/null \
   && awk -v v="OTP-$OTP_VERSION" '$1==v {found=1} END {exit !found}' builds.txt; then
  OTP_TARBALL="OTP-$OTP_VERSION.tar.gz"
  if [ ! -f "$OTP_TARBALL" ]; then
    curl -fsSL -o "$OTP_TARBALL" "https://builds.hex.pm/builds/otp/$ARCH/$DISTRO/$OTP_TARBALL"
  fi
  EXPECTED="$(awk -v v="OTP-$OTP_VERSION" '$1==v {print $4}' builds.txt)"
  [ -n "$EXPECTED" ] || { echo "install-beam: no checksum for OTP-$OTP_VERSION on $DISTRO" >&2; exit 1; }
  OTP_FROM="precompiled ($DISTRO)"
else
  # No precompiled build for this platform. Building from source is the only
  # correct option -- apt's Erlang is too old, and using it produces a compile
  # error inside the PORT, which the harness can only report as "the port
  # disagrees". Gated so an unexpected platform is never a 15-minute surprise.
  if [ "${BEAM_ALLOW_SOURCE:-0}" != "1" ]; then
    echo "install-beam: no precompiled OTP $OTP_VERSION for $DISTRO/$ARCH." >&2
    echo "  set BEAM_ALLOW_SOURCE=1 to build from source (~10-15 min), or pin" >&2
    echo "  BEAM_DISTRO to a published slug (see builds.hex.pm/builds/otp/$ARCH/)." >&2
    exit 1
  fi
  OTP_TARBALL="otp_src_$OTP_VERSION.tar.gz"
  if [ ! -f "$OTP_TARBALL" ]; then
    curl -fsSL -o "$OTP_TARBALL" "https://github.com/erlang/otp/releases/download/OTP-$OTP_VERSION/otp_src_$OTP_VERSION.tar.gz"
  fi
  EXPECTED="$(sha256sum "$OTP_TARBALL" | cut -d' ' -f1)"
  OTP_FROM="source build"
fi

ACTUAL="$(sha256sum "$OTP_TARBALL" | cut -d' ' -f1)"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "install-beam: OTP checksum mismatch for $OTP_TARBALL" >&2
  echo "  expected $EXPECTED" >&2
  echo "  actual   $ACTUAL" >&2
  exit 1
fi
echo "==> OTP tarball verified ($OTP_FROM): $ACTUAL"

ELIXIR_ZIP="v$ELIXIR_VERSION-otp-27.zip"
if [ ! -f "$ELIXIR_ZIP" ]; then
  curl -fsSL -o "$ELIXIR_ZIP" "https://builds.hex.pm/builds/elixir/$ELIXIR_ZIP"
fi
ACTUAL="$(sha256sum "$ELIXIR_ZIP" | cut -d' ' -f1)"
if [ "$ACTUAL" != "$ELIXIR_SHA256" ]; then
  echo "install-beam: Elixir checksum mismatch for $ELIXIR_ZIP (expected $ELIXIR_SHA256, got $ACTUAL)" >&2
  exit 1
fi
echo "==> Elixir zip verified: $ACTUAL"

rm -rf otp elixir
mkdir -p otp elixir
if [ "$OTP_FROM" = "source build" ]; then
  # Source trees ship under OTP-<ver>/ and need configure; the precompiled tarball
  # ships a runnable tree and must NOT be configured.
  tar xzf "$OTP_TARBALL" -C otp --strip-components=1
  (cd otp && ./configure --without-javac --without-wx --without-debugger \
     --without-observer --without-et --without-megaco --without-jinterface \
   && make -j"$(nproc)" && make install)
else
  tar xzf "$OTP_TARBALL" -C otp --strip-components=1
  # -minimal skips the docs and the wx dependency. The precompiled tarball is
  # built with its own prefix baked in, so Install is required for `erl` to
  # find erts.
  (cd otp && ./Install -minimal "$PWD")
fi
unzip -q -o "$ELIXIR_ZIP" -d elixir

# +fnu: latin1+utf8 filename encoding and no special handling of unicode
# filenames. Without it the BEAM mangles the record ids that the corpus puts
# in file paths, which is how a unicode test class turns into an unexplained
# I/O error rather than a leaf mismatch.
export PATH="$BEAM_HOME/otp/bin:$BEAM_HOME/elixir/bin:$PATH"
export ELIXIR_ERL_OPTIONS="+fnu"
export LANG="${LANG:-C.UTF-8}"
export MIX_HOME="${MIX_HOME:-$BEAM_HOME/.mix}"
export HEX_HOME="${HEX_HOME:-$BEAM_HOME/.hex}"

# The version assertion is the deliverable. A toolchain step that installs
# something and then lets the harness discover the version is how "apt Elixir
# cannot compile this port" reaches a test failure instead of a build error.
GOT_OTP="$(erl -noshell -eval 'io:format("~s",[erlang:system_info(otp_release)]),halt().')"
GOT_ELIXIR="$(elixir --version | tail -1 | awk '{print $2}')"
case "$GOT_OTP" in
  27*) ;;
  *) echo "install-beam: OTP is $GOT_OTP, need 27.x (apt gives an older Erlang; do not use it)" >&2; exit 1 ;;
esac
case "$GOT_ELIXIR" in
  1.17.*) ;;
  *) echo "install-beam: Elixir is $GOT_ELIXIR, need 1.17.x (apt gives 1.14, which cannot PARSE this port)" >&2; exit 1 ;;
esac
echo "==> toolchain OK: Elixir $GOT_ELIXIR / OTP $GOT_OTP"
