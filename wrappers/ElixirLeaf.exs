#!/usr/bin/env elixir
# Elixir/OTP leaf wrapper for patchwork-quilt/gitpp-beam (the BEAM port).
#
# Interface, identical to wrappers/PlLeaf.pl and CsLeaf: read a JSON array of
# records on STDIN, print one lowercase hex SHA-256 leaf per line, one line per
# record, in input order.
#
#   elixir -pa <ebin> wrappers/ElixirLeaf.exs < records.json
#
# WHY THE LEAF IS COMPOSED HERE AND NOT CALLED
# ---------------------------------------------
# gitpp-beam has NO public leaf function. `Gitpp.Fold.leaf/1` is `defp`
# (private); the port's own leaf_check.exs says so in as many words --
# "verbatim body of lib/gitpp/fold.ex leaf/1, via public API only" -- and
# re-derives it from `Fold.canonical_record/1` + `Gitpp.Canon.encode!/1`. This
# wrapper does the same composition, which makes it a *consumer* of the port
# rather than a copy of its internals: canonicalise, sort parents, encode,
# hash.
#
# Because the composition is duplicated, "did I duplicate it correctly?" is a
# real question, and it is answerable with public API only. For any record r
# whose closure is complete, `Fold.checkpoint_root(records, r.id)` is defined
# as sha256(join over the closure of `id <> ":" <> leaf(record)`), so for a
# SINGLE-record closure it is exactly sha256(id <> ":" <> leaf). This wrapper
# therefore asserts its own leaf against the port's own closure root on every
# run. If the port's private leaf/1 and this composition ever diverge, the
# wrapper refuses to report leaves at all instead of quietly emitting the
# wrong bytes. Set EX_LEAF_SELFTEST=all to check every record of every batch.
#
# The port is loaded from a COMPILED ebin directory (GITPP_EX_EBIN), not by
# running mix per batch: every other wrapper here resolves its port at RUN
# time from an environment variable with a sibling-checkout default, and this
# follows the same convention. A port that cannot be found is a LOUD failure
# (exit 2) -- never a silent empty result, which is the defect class this repo
# exists to catch.

defmodule ElixirLeaf do
  alias Gitpp.Fold
  alias Gitpp.Canon

  @selftest_mode System.get_env("EX_LEAF_SELFTEST", "first")

  # Fold.checkpoint_root/2 re-canonicalises the whole batch per call, so
  # checking every record in a batch is O(n^2). The harnesses batch at 250-2000
  # and never notice; piping a whole 29,222-record corpus into the wrapper did
  # notice -- it hung for minutes with no output. Capped, and the cap is
  # printed rather than silent, because "checked 1000 of 29222" is a weaker
  # claim than "checked all of them" and must not look like the latter.
  @selftest_max (case System.get_env("EX_LEAF_SELFTEST_MAX") do
                  nil -> 1000
                  n -> String.to_integer(n)
                end)

  # The port's leaf, composed from public API only. Byte-for-byte the body of
  # Gitpp.Fold.leaf/1: normalise parents (unique, code-point sorted), then
  # canonical-encode the five-field projection and SHA-256 it.
  def leaf(record) do
    n = Fold.canonical_record(record)

    canon =
      %{"id" => n["id"],
        "parents" => n["parents"] |> Enum.uniq() |> Enum.sort(),
        "kind" => n["kind"],
        "effects" => n["effects"],
        "reason" => n["reason"]}
      |> Canon.encode!()

    :crypto.hash(:sha256, canon) |> Base.encode16(case: :lower)
  end

  # Prove the composition above IS the port's leaf, using public API only.
  #
  # `Fold.checkpoint_root(records, at)` is defined as
  #   sha256( join over the closure of `id <> ":" <> leaf(record)` )
  # so for a record whose closure is EXACTLY {id} -- which the port's own
  # closure walk guarantees for any record with an empty `parents` -- it
  # reduces to sha256(id <> ":" <> leaf). Equality there is a real check.
  #
  # Records with parents are SKIPPED, not approximated: the closure is not
  # exposed by public API, so assuming {id} for them would compare two
  # different digests and report a divergence that is an artefact of the
  # wrapper. An earlier draft of this file made exactly that mistake and
  # failed on spec §3.5 case-2, whose record has parents ["a"] -- a wrapper
  # bug, not a port bug. Skipping is reported as "skipped", never as "passed".
  def self_check(records, leaves) do
    # Duplicate ids are SKIPPED. Fold.checkpoint_root/2 indexes records by id,
    # so a batch holding the same id twice checks the second record against the
    # first record's root and reports a divergence that is an artefact of the
    # batch, not of the port. Found by pointing this wrapper at a hand-built
    # NFC/NFD twin pair, which uses one id for both records; neither corpus
    # does that, and a check that is only sound on well-formed input has to say
    # so rather than cry wolf.
    dupes = records |> Enum.map(& &1["id"]) |> Enum.frequencies()

    records
    |> Enum.zip(leaves)
    |> Enum.reduce({0, 0, nil}, fn {record, leaf}, {checked, skipped, first_error} ->
      n = Fold.canonical_record(record)
      id = n["id"]

      cond do
        n["parents"] != [] ->
          # The closure is not {id}, so the reduction does not apply.
          {checked, skipped + 1, first_error}

        dupes[id] != 1 ->
          {checked, skipped + 1, first_error}

        true ->
          case Fold.checkpoint_root(records, id) do
            nil ->
              {checked, skipped + 1, first_error}

            root ->
              mine = :crypto.hash(:sha256, id <> ":" <> leaf) |> Base.encode16(case: :lower)

              if mine == root do
                {checked + 1, skipped, first_error}
              else
                msg =
                  "wrapper leaf for #{inspect(id)} disagrees with the port's own " <>
                    "checkpoint_root (wrapper #{mine}, port #{root}) -- the port's private " <>
                    "leaf/1 and this composition have diverged; refusing to report leaves"

                {checked, skipped, first_error || msg}
              end
          end
      end
    end)
  end

  def run(payload) do
    records = :json.decode(payload)
    leaves = Enum.map(records, &leaf/1)

    case @selftest_mode do
      "off" ->
        :ok

      "all" ->
        verify!(Enum.take(records, @selftest_max), Enum.take(leaves, @selftest_max))

      _ ->
        if length(leaves) > 0, do: verify!(Enum.take(records, @selftest_max), Enum.take(leaves, @selftest_max))
    end

    IO.write(Enum.join(leaves, "\n") <> "\n")
  end

  defp verify!(records, leaves) do
    case self_check(records, leaves) do
      {_checked, _skipped, nil} ->
        :ok

      {_checked, _skipped, msg} ->
        IO.puts(:stderr, "ElixirLeaf: SELF-CHECK FAILED: " <> msg)
        System.halt(3)
    end
  end
end

# ---------------------------------------------------------------------------

argv = System.argv()

# Keep this in step with ElixirLeaf's @selftest_max.
selftest_max = fn ->
  case System.get_env("EX_LEAF_SELFTEST_MAX") do
    nil -> 1000
    n -> String.to_integer(n)
  end
end

cond do
  "--version" in argv ->
    IO.puts("ElixirLeaf: elixir #{System.version()} / OTP #{System.otp_release()}")

  "--selftest" in argv ->
    # Reads records on STDIN and additionally verifies every leaf against the
    # port's own closure root. Used by CI as a standalone gate.
    payload = IO.read(:stdio, :eof) || ""
    records = :json.decode(payload)
    leaves = Enum.map(records, &ElixirLeaf.leaf/1)

    # Same O(n^2) bound as the default mode; --selftest is a gate, not a
    # bulk operation.
    {checked, skipped, first_error} =
      ElixirLeaf.self_check(Enum.take(records, selftest_max.()), Enum.take(leaves, selftest_max.()))

    IO.puts(
      "ElixirLeaf selftest: #{checked}/#{min(length(records), selftest_max.())} leaves verified against " <>
        "Fold.checkpoint_root/2 (#{skipped} skipped: records whose closure is not {id} -- " <>
        "they have parents, or their id appears more than once in this batch)"
    )

    if first_error do
      IO.puts(:stderr, "ElixirLeaf: SELF-CHECK FAILED: " <> first_error)
      System.halt(3)
    end

  true ->
    payload = IO.read(:stdio, :eof) || ""

    if String.trim(payload) == "" do
      IO.puts(:stderr, "ElixirLeaf: empty payload on STDIN")
      System.halt(2)
    end

    try do
      ElixirLeaf.run(payload)
    rescue
      e ->
        # One legible line, because the harness prints only the last stderr
        # line and a 40-line Elixir stacktrace in a CI log is not a diagnosis.
        top =
          Exception.format_stacktrace(__STACKTRACE__)
          |> String.split("\n")
          |> Enum.take(3)
          |> Enum.join(" | ")

        IO.puts(:stderr, "ElixirLeaf: #{inspect(e.__struct__)}: #{Exception.message(e)}")
        IO.puts(:stderr, "ElixirLeaf: " <> top)
        System.halt(1)
    end
end
