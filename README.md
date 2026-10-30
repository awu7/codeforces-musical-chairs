# Codeforces Musical Chairs

Team competitive-programming game: every K minutes players move to the next computer (or, in lazy mode, problems and editor state rotate between the team's computers). Solved problems are replaced immediately, and unsolved ones after N rounds. Difficulty adjusts dynamically from an admin-defined Codeforces problem pool.

## Run

```sh
cd web && npm install && npm run build
cd ../server && npm install && ADMIN_PASSWORD=secret DATA_DIR=../data npm start   # http://localhost:3001
```

- Client: `/` (enter a seat code). Admin: `/admin`. Scoreboard: `/scoreboard`.
- Development: run `npm run dev` in both `server/` and `web/` (Vite on :5173 proxies to :3001).
- Run and sample-based judging use Codeforces custom invocation and require an enabled, logged-in Codeforces account configured in Admin → Judge. Contestant code is never executed on the server.
- Codeforces statement fetching, custom invocation, and submission forwarding need Chrome with CDP (default `http://localhost:29229`, configurable in Judge & languages).
- Tests: `cd server && npx tsc --noEmit && npm run test:e2e && npx tsx test/customtest-parse.ts` (`npm run test:cf` needs CDP Chrome).

See `docs/PROTOCOL.md` for the API and game rules.
