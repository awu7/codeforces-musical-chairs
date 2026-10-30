# Generating test data

The default judge mode ("Local (isolate)") judges submissions only against tests stored in
`data/tests/`. Generate them with a coding agent (e.g. Devin CLI) running in this repo on the
server machine: tell it "follow docs/test-generation.md" (optionally naming problem ids).
Afterwards click **Rescan tests** on the admin Problems tab.

Everything below is addressed to the agent.

---

You are generating judge test data for competitive programming problems. Contestant submissions
will be judged ONLY against the tests you write, so wrong expected outputs or invalid inputs make
the event unfair. Correctness matters far more than speed or test count.

## Which problems

- Problems are in `data/state.json` (or `$DATA_DIR/state.json` if the server uses `DATA_DIR`),
  in the `problems` array. Read it; never write it (the running server owns it).
- Generate for the problem ids you were given. If none were given, do every problem with
  `enabled: true` that has no `data/tests/<id>/tests/` folder yet.
- Useful fields: `id`, `name`, `contestId`, `index`, `timeLimit`, `memoryLimit`, `samples`
  (`[{ input, output }]`) and `statementHtml`. In `statementHtml`, the math is the TeX inside
  `<script type="math/tex">` tags (and any `$$$...$$$`); ignore the MathJax-rendered spans
  next to it. If `statementHtml` is null, use the statement at
  `https://codeforces.com/contest/<contestId>/problem/<index>` (`/gym/` for contestId >= 100000).
- If a limit is null, assume 2 seconds and 256 megabytes.

## Output layout

For each problem, write to `data/tests/<id>/` (create it; replace anything already there):

```
tests/001.in, tests/001.out, tests/002.in, ...   judge tests, 3-digit numbering, run in order
needs-checker                                    empty marker file, ONLY instead of tests/ (see below)
work/                                            everything else: solution.cpp, brute.cpp,
                                                 gen.py, validator.py, scripts, REPORT.md
```

The judge reads only `tests/` and `needs-checker`. Use Unix newlines and end every file with a
newline.

## Steps for each problem

1. Read the statement carefully: input format, every constraint (including sums over test cases,
   distinctness, guarantees such as "the answer exists" or "the graph is connected"), output
   format, and whether several outputs can be correct ("print any", floating-point tolerance, any
   valid construction, YES/NO in any case).

   The judge has no checker: it compares whitespace-separated tokens exactly (case-sensitive),
   except that `yes`/`no` tokens match in any case, so "YES/NO in any case" problems are fine
   (write the expected outputs in the statement's casing). If any other kind of output
   variation can be accepted (several valid answers, a floating-point tolerance, ...), STOP for
   this problem: create the empty file
   `data/tests/<id>/needs-checker`, make sure there is no `data/tests/<id>/tests/`, give the
   reason in `work/REPORT.md`, and move on to the next problem. Otherwise continue.
2. `work/solution.cpp`: a correct, efficient C++17 reference solution meant to run well within
   the time limit on maximum inputs. FIRST look up the editorial or a trusted published
   solution online — search the web for e.g. "Codeforces <contestId><index> editorial" or
   "<problem name> solution", fetch the editorial blog or a reliable write-up, and adapt its
   approach into your reference. This is the preferred way to guarantee correctness; write the
   solution from scratch only if no trustworthy reference can be found. Prefer a well-known
   approach you are confident in; avoid unproven heuristics.
3. `work/brute.cpp` (or `brute.py`): an obviously correct brute force for small inputs
   (exhaustive search, simulation, the direct definition). Write it independently of the
   reference solution's idea. You may skip this file when your reference is adapted from a
   trusted editorial or published solution — it exists only to double-check a from-scratch
   solution.
4. `work/validator.py`: reads one input on stdin and exits non-zero with a message if ANY
   constraint or format rule is violated (exact token counts, ranges, sums, distinctness,
   structural guarantees, no extra tokens). The samples must pass it.
5. `work/gen.py`: a deterministic generator taking a seed and parameters on the command line.
   Roughly 10 test files per problem is fine — make full use of multitest inputs (`t` followed
   by `t` cases, as on Codeforces) so the ~10 files still exercise many different cases:
   - the statement samples first, copied exactly, as tests 001..k;
   - edge cases: minimum values, all-equal values, sorted/reverse-sorted, single element,
     answer 0 / impossible / both YES and NO, values large enough to overflow 32-bit integers.
     Coalesce many small edge cases into ONE multitest input — a single file that exercises
     several different edge cases is ideal — but respect every sum-over-test-cases limit;
   - many small random tests, likewise packed into shared multitest files;
   - several maximum-size tests that hit the stated limits (including any sum-of-n limit), with
     structures that defeat naive or slow solutions (worst cases for quadratic algorithms;
     chains, stars and long paths for trees and graphs; anti-hash or anti-quicksort patterns
     where relevant);
   - for multitest inputs, pack many small cases per file — vary the structures, parameters
     and edge conditions across the cases within each file — plus a few files with large
     cases; always respect the sum-over-test-cases limit per file.

   Every input must pass the validator. Fix the generator, never the validator, unless the
   validator misreads the statement.
6. The reference's outputs on the samples must match the sample outputs token for token.
7. Cross-check (only when step 3's brute exists — i.e. your reference was written from
   scratch or you are unsure of it): on at least 200 small random inputs (beyond the saved
   tests), run the reference and the brute force and compare their outputs token for token.
   Any disagreement means one of them is wrong: find the bug, fix it and rerun everything. Do
   not continue until they agree on every input. If your reference comes from a trusted
   editorial or published solution, skip this step — sample matching in step 6 and validator
   checks are enough.
8. Produce `tests/NNN.out` by running the reference on each `tests/NNN.in`. Time it on the
   largest tests: it should take well under the time limit (aim for under half). If not,
   optimise it.
9. Keep each `.in` under 16 MB and the whole `tests/` folder under 64 MB.
10. `work/REPORT.md`: the approach and the editorial/reference source you used (or note that
    none was found), how many tests of each kind, the cross-check count and result when a
    cross-check was performed, the reference's time on the largest test, and anything you are
    unsure about.

If you cannot get a problem to pass every check above, do not leave a partial `tests/` folder:
delete `data/tests/<id>/tests` and explain why in `work/REPORT.md`. Finish with a summary
listing, for each problem, the number of tests (or "needs checker" / failed) and any concerns.
