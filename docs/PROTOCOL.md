# Server protocol & behaviour

Types: `shared/types.ts`. Server: Node 22 + TypeScript (run with `tsx`), Express + socket.io, port `PORT` (default 3001).
Persistence: whole state in `DATA_DIR/state.json` (default `./data`), written atomically (tmp + rename), debounced ~1s and on shutdown. Restart must resume a running game (clock in epoch ms).
Production: server serves `web/dist` statically with SPA fallback (`/`, `/admin`, `/scoreboard`).

## Auth
- Admin: `ADMIN_PASSWORD` env (default `admin`, log a warning). `POST /api/admin/login {password}` -> `{token}` (random, persisted). All `/api/admin/*` require `Authorization: Bearer <token>`. Admin sockets connect with `auth: {adminToken}` and join room `admin`.
- Seats: each seat has a 6-char uppercase code (no 0/O/1/I). Client socket emits `seat:join {code}`.

## Socket.io events
Client -> server (all with ack callbacks):
- `seat:join {code}` -> `{ok:true, view: SeatView} | {ok:false, error}`. Multiple sockets per seat allowed.
- `slot:update {slotId, lang?, code?, input?}` (`code` is the text for `lang`, or for slot.lang if lang omitted) -> `{ok, error?}`. Accept if the slot is currently at the sender's seat, OR during the first 3s of a transition / after a lazy rotation if the slot was at the sender's seat at the end of the previous round (late flush). If a late flush is applied and the slot now sits at another seat, push a fresh SeatView to that seat. Reject edits while phase is setup/finished.
- `run RunRequest` -> `RunResult` (or `{status:'error', stderr:msg}`). Only if allowLocalRun and phase running. Max 1 concurrent run per seat; global concurrency and resource limits come from `GameConfig`. Contestant source is compiled and run only inside `ioi/isolate`; there is no unsandboxed fallback.
- `submit {slotId, lang, code}` -> `{ok, submissionId?, error?}`. Checks: phase running, slot at seat, lang enabled, cooldown, maxSubmissionsPerProblem, attempt active.
- `admin:subscribe` (admin sockets) -> `AdminState`.

Server -> client:
- `seat:view SeatView` full view; push whenever anything in it changes (slot problem, lock, clock phase, submissions, announcement, config). Clients replace their state wholesale; editor contents are only overwritten when `slot.id` changes or the server pushes after a late flush (include a field-free approach: client compares slot.id + rev).
- `seat:kicked {reason}` when the seat code is regenerated / team deleted.
- `admin:state AdminState` to room `admin`, throttled to <= 4/s, on any change.
- `clock GameClock` broadcast to everyone on phase changes and every 10s (drift correction).

## REST (`/api`)
Public: `GET /health`, `GET /scoreboard` -> `{eventName, clock, rows: ScoreRow[] }` (403 if !showScoreboardToClients and no admin token; frozen rows if freezeScoreboard — freeze = snapshot at the moment it was enabled).

Admin (`/api/admin`), JSON bodies, errors `{error}` with 4xx:
- `GET /state` -> AdminState
- `PUT /config` partial GameConfig (deep-merge `difficulty`) -> GameConfig
- Game: `POST /game/start` (setup -> running round 1; draws a problem for every slot), `/game/pause`, `/game/resume`, `/game/next-round` (end current round now -> transition), `/game/skip-transition` (end transition now), `/game/start-round` (when autoAdvance=false and waiting), `/game/end` (-> finished), `/game/reset {keepTeams?:bool, keepPool?:bool}` (-> setup, clears attempts/submissions/code), `/game/add-time {seconds}` (negative allowed; works in running and paused), `/game/set-remaining {seconds}`
- `POST /lock {locked, message}` manual lock of all clients; `POST /announce {text|null}`
- Teams: `POST /teams {name, size}`, `POST /teams/bulk {count, size, prefix}`, `PUT /teams/:id {name?, size?, rating?, startRating?, enabled?}` (size change only in setup), `DELETE /teams/:id`, `POST /teams/:id/regenerate-codes`, `PUT /teams/:id/seats/:index {label}`
- Slots: `POST /slots/:id/replace {problemId?, rating?, countAsSkip?=true}` ends active attempt as `skipped` (applies skippedDelta unless rating given) and draws a new one; `POST /slots/:id/solve` marks active attempt solved (as if OK); `PUT /slots/:id {nextRating?, roundsShown?, lang?, code?, input?}`; `POST /slots/:id/clear-code`
- Problems: `GET /problems` -> Problem[] (full), `GET /problems/:id`, `POST /problems {ids: string[], rating?}` (accepts "1850A", "1850 A", CF URLs incl. gym; fills metadata from CF API `problemset.problems` (cached 1h), queues statement fetch), `POST /problems/manual Problem-like`, `PUT /problems/:id {...editable fields}`, `DELETE /problems/:id`, `POST /problems/:id/refetch`, `POST /problems/fetch-missing`, `POST /problems/bulk-add {minRating, maxRating, perRating, includeTags?: string[], excludeTags?: string[], minContestId?: number, excludeSolvedBy?: string[] (CF handles; API user.status), excludeExisting=true}` -> `{added: string[]}`, `POST /problems/bulk {ids, enabled?, rating?, delete?}`, `GET /problems/export` (JSON with statements), `POST /problems/import {problems: Problem[]}`
- Submissions: `GET /submissions/:id` (with code), `POST /submissions/:id/rejudge`, `POST /submissions/:id/verdict {verdict}` (sets overridden; OK on an active attempt solves it; also a manual-judge decision)
- Languages: `PUT /languages Language[]`
- CF: `POST /cf/accounts {handle, password}`, `PUT /cf/accounts/:handle {enabled?, password?}`, `DELETE /cf/accounts/:handle`, `POST /cf/accounts/:handle/login` (test login), `PUT /cf/bridge {mode, cdpUrl}`, `POST /cf/bridge/restart`
- Export: `GET /export/results.csv` (one row per attempt), `GET /export/state.json`, `POST /import/state` (full state replace)

## Game engine
- Round r runs `roundMinutes`; at 0 -> rotation, then phase `transition` for `transitionSeconds` (lazy: `lazyTransitionSeconds`, default 0 => go straight to next round). After transition: if `autoAdvance` start round r+1, else phase stays `transition` with `transitionEndsAt=null` (lock reason `waiting`) until `/game/start-round`. If `totalRounds` reached, -> `finished` instead.
- Rotation happens at the START of the transition (so clients show the lock immediately; in lazy mode the new slot is visible after the lock). Lazy mode: every slot's `seatIndex = (seatIndex - dir + size) % size`. Physical mode: slots don't move (people do).
- Expiry, at each rotation, for each slot with an active attempt: if `roundsShown >= maxRounds` (`maxRoundsPerProblem ?? team.size`, clamped to <= team.size) -> outcome `expired`, draw new problem; else `roundsShown++`. New attempts start with `roundsShown = 1`.
- `activeMs` accrues only while phase is `running`.
- Solve (verdict OK on an active attempt): outcome `solved`, `solvedBySeat`, immediately draw a new problem for that slot (fresh editor: code reset to language templates, input cleared). Submissions for an attempt that is no longer active are still judged and recorded but do not score.
- Next rating when an attempt ends: base = (scope slot ? attempt.rating : team.rating); delta = solved ? first rule with minutes <= maxMinutes (else slowSolveDelta) : expired ? unsolvedDelta : skippedDelta; clamp to [min,max], round to step. scope team -> write team.rating; scope slot -> slot.nextRating. Initial: team.startRating ?? difficulty.startRating.
- Draw: candidates = enabled problems with rating == target, statement fetched OK (or source manual), not used (uniqueness team: any attempt of this team, incl. active; global: any attempt of any team). If empty, search outward by step according to `fallback` (nearest: alternate lower/higher, prefer lower first on ties) within [minRating,maxRating]. Random pick. None -> slot.attemptId = null, log warn; retry drawing for empty slots whenever problems are added/enabled and at every rotation.
- Score: count = #solved attempts; rating = sum of solved ratings; minus `wrongSubmissionPenalty * wrongSubmissions` on solved attempts. Sort points desc, then earlier last-solve time.
- Log every significant event to `log` (game phase changes, draws, solves, expiries, judge errors, admin actions).

## Judges
- `auto-accept`: verdict OK after 1s. `manual`: status `judging` until admin sets a verdict.
- `local`: compile/run each sample + extra test in an isolated box and compare tokens (ignoring whitespace); problem time/memory limits override the sandbox defaults when present. Verdicts include OK / WRONG_ANSWER / TIME_LIMIT_EXCEEDED / RUNTIME_ERROR / COMPILATION_ERROR / MEMORY_LIMIT_EXCEEDED, failedTest 1-based. Run results are capped by `outputLimitKb`; concurrency is bounded by the configured isolate box pool.
- `codeforces` (vjudge-style): queue; pick an enabled account round-robin and serialize browser submissions per account. Cloudflare blocks plain HTTP from servers, so use `playwright-core` driving a real Chrome: `mode: 'cdp'` connects to `cdpUrl` (default `http://localhost:29229`), `mode: 'launch'` launches Chrome headed (`channel: 'chrome'` or `CHROME_PATH`) with a persistent profile in `DATA_DIR/chrome`. One BrowserContext per account (cookies persisted to `DATA_DIR/cf-<handle>.json`). Login via `/enter` (`#handleOrEmail`, `#password`, submit); detect logged-in via the header handle link. Submit via `/problemset/submit` (gym: `/gym/<id>/submit`), fill `submittedProblemCode`/`submittedProblemIndex`, `programTypeId`, upload code via `input[name=sourceFile]` (setInputFiles buffer). Append a unique comment nonce to the code to dodge "You have submitted exactly the same code before". Read errors from `.error` spans. Get submission id from first `tr[data-submission-id]` on the my-status page. All Codeforces API calls are serialized with at least 2.1s between requests; one poller per handle fetches `user.status?handle=H&from=1&count=50` and resolves all finished pending submissions from each response. Timeout 10min -> error. Errors -> status error + message, admin can rejudge.
- Statement fetching uses the same bridge (no login needed): `/problemset/problem/<c>/<i>` (gym: `/gym/<c>/problem/<i>`), wait for `.problem-statement`; extract time/memory limits from `.header .time-limit` / `.memory-limit` (text minus the title div), samples from `.sample-test .input pre` / `.output pre` (use innerText, which handles `.test-example-line` divs), statementHtml = innerHTML of `.problem-statement` with `.header` removed, relative `src`/`href` absolutised to https://codeforces.com. Fetch queue concurrency 2, ~1s between requests.

## Isolate sandbox
Run and `local` judging use `server/src/isolate.ts`, which acquires a configured box id, initializes isolate with cgroup limits, runs compiler and program inside the same box, and cleans the box in `finally`. A missing/unusable sandbox produces an error; code is never run outside isolate. `GameConfig` provides `runTimeLimitMs`, `runMemoryMb`, `compileTimeLimitMs`, `maxConcurrentRuns`, `isolateBoxBase`, and `outputLimitKb`. `RunResult.memoryKb` reports cgroup memory usage when available. Language `compile` and `run` arrays are argument vectors with `{src}` / `{exe}` placeholders, not shell commands.
