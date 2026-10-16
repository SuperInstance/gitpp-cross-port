#!/usr/bin/env perl
use strict; use warnings;
use lib "/tmp/gitpp-pl/lib";
use Gitpp; use JSON::PP;
local $/;
for my $r (@{decode_json(<STDIN>)}) { print Gitpp::record_leaf($r), "\n"; }
