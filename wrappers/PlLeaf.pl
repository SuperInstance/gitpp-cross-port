#!/usr/bin/env perl
use strict; use warnings;
# Resolved at run time. The hardcoded /tmp path meant this port could not
# run anywhere else -- the same defect class the fold-conformance suite
# had, and the reason its CI had never executed.
use lib (($ENV{GITPP_PL_DIR} // "") ? "$ENV{GITPP_PL_DIR}/lib" : ());
use lib "/tmp/gitpp-pl/lib";   # legacy single-machine layout
use Gitpp; use JSON::PP;
local $/;
for my $r (@{Gitpp::decode_records(<STDIN>)}) { print Gitpp::record_leaf($r), "\n"; }
