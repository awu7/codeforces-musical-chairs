# Codeforces Musical Chairs

Team competitive-programming game: every K minutes players move to the next computer (or, in lazy mode, problems and editor state rotate between the team's computers). Solved problems are replaced immediately, and unsolved ones after N rounds. Difficulty adjusts dynamically from an admin-defined Codeforces problem pool.

## Run

```sh
cd web && npm install && npm run build
cd ../server && npm install && ADMIN_PASSWORD=secret DATA_DIR=../data npm start   # http://localhost:3001
```

- Client: `/` (enter a seat code). Admin: `/admin`. Scoreboard: `/scoreboard`.
- Development: run `npm run dev` in both `server/` and `web/` (Vite on :5173 proxies to :3001).
- Run and local sample/test judging compile and execute contestant code only inside `ioi/isolate`; they do not require a Codeforces account. Codeforces statement fetching and forwarded submissions use Chrome with CDP (default `http://localhost:29229`, configurable in Judge & languages).
- `outputLimitKb` limits output shown to Run clients; `maxOutputMb` controls the sandbox's file-size limit and the full output available to local judging.
- Tests: `cd server && npx tsc --noEmit && npm run test:e2e && npx tsx test/isolate.ts && npx tsx test/cf-rate-limit.ts`.

See `docs/PROTOCOL.md` for the API and game rules.

## Installing isolate

These commands install release v2.7 and configure the cgroup v2 keeper using the upstream systemd units:

```sh
sudo apt-get update
sudo apt-get install -y build-essential git libcap-dev libsystemd-dev libseccomp-dev pkg-config
git clone --depth 1 --branch v2.7 https://github.com/ioi/isolate.git
cd isolate
make isolate
sudo make install
sudo addgroup --system isolate
sudo adduser --system --ingroup isolate --home /nonexistent --no-create-home --disabled-login isolate
sudo usermod --add-subuids 165536-231071 isolate
sudo usermod --add-subgids 165536-231071 isolate
sudo systemctl daemon-reload
sudo systemctl enable --now isolate.service
isolate --version
isolate-check-environment
```

The installed `isolate.service` and `isolate.slice` delegate the cgroup v2 hierarchy under systemd. `isolate-check-environment` verifies the cgroup controllers; it can still exit nonzero for host-wide kernel tuning warnings (ASLR, transparent hugepages, or piped core dumps). On the development VM those warnings remain, while the cgroup checks pass and an `isolate --cg` smoke run succeeds. Do not disable the kernel protections merely to silence those warnings.
