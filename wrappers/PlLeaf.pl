#!/usr/bin/env perl
use strict; use warnings;
# The module path is resolved at RUN time, and the fallback is RELATIVE to
# this file -- not an absolute path to a scratch directory on one machine.
#
# It used to be:
#     use lib "/tmp/gitpp-pl/lib";
# which means:
#   * in CI, that path does not exist, so the port silently did not
#     participate -- and a run over four ports reports the same pass count
#     as a run over five;
#   * on a developer machine, that path DID exist, and it held a DIFFERENT
#     build, so the wrapper quietly tested the wrong code.
#
# That second one is worse than useless: it made a real cross-port
# disagreement look like agreement. A leaf comparison came back "the
# leaves match" when the port under test had not been loaded at all.
#
# The sibling wrappers already resolve their port at RUN time
# (CDerive.sh reads GITPP_C_BIN, JsDerive.mjs reads GITPP_JS_SRC). This
# one now does the same, with the same fallback chain.
use lib (($ENV{GITPP_PL_DIR} // "") ? "$ENV{GITPP_PL_DIR}/lib" : ());
use lib "../gitpp-pl/lib";
use lib "ports/perl/lib";
use Gitpp; use JSON::PP;
local $/;
for my $r (@{Gitpp::decode_records(<STDIN>)}) { print Gitpp::record_leaf($r), "\n"; }
