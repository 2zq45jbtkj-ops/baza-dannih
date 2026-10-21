# baza-dannih site

Last verified: 2026-10-21.

## Deploy

Push to `main` → Vercel builds. **Николай runs every git command himself** —
hand him a marked copy-paste block, then verify the result with the Vercel MCP
(`list_deployments` for `prj_Jpv5XO4ATEW2xA6EJ4g8LUpysixZ`) and by fetching
prod. Do not assume a fix is live because it is on disk: on 2026-10-21 the
repertoire dark-theme fix sat uncommitted for several turns while he kept
seeing the old page, and the honest answer was "it was never deployed".

`api/` is capped at **12 functions**. `git ls-files api/ | grep -v "api/_" | wc -l`
must stay ≤ 12. A 13th file fails the *whole* deployment while the build log
still says success. Fold new endpoints into an existing route behind a query
parameter — that is how `GET /api/warmups?audio=<id>` and the progress POST on
`student-public.js` were added.

Note: the **Mini App** (`your-vocal`) is *not* bound by this — its routes are
Edge Functions (`runtime: "edge"`), which do not count against that quota. 19
of them deploy fine. Do not generalise the limit across the two projects.

## Local preview

`.claude/launch.json` → `baza-dannih-dev` (port 3000) serves `index.html` from
disk but **proxies `/api/*` to live production**. Consequences:

- Server-side changes cannot be tested locally at all. They are first executed
  only after deploy. Say so rather than implying they were verified.
- Any write performed in the preview hits real student data. Read-only probing
  only; stub `window.fetch` when a write path needs testing.

`your-vocal-clone-check` (port 8124) serves a Mini App clone — edit the `ROOT`
constant in `.claude/miniapp-clone-server.js` to point at the current clone.

## Theming trap

Light hex values hardcoded instead of `var(--…)` keep resurfacing. The whole
**Репертуар** tab had *zero* `body.dark` rules; ~20 literals were replaced with
`var(--panel) / --bg / --line / --text / --muted)` on 2026-10-21.

`body` uses `color: var(--text)`, and `body.dark` overrides `--text` — but it
does **not** override `--ink`. Anything written as `var(--ink)` stays dark-on-dark.

To find offenders, do not read CSS — compute luminance of `backgroundColor`
over every rendered element in dark mode and list the bright ones.

That sweep alone is not enough; the warm-ups player (2026-10-22) came back
clean from it and was still broken. Add two passes:
- **contrast against the painted ancestor.** A hardcoded *dark* hex picked
  against a white card collides with `--panel` in dark theme. The player sat at
  ratio 1.05 with no border — invisible as an object, yet never "bright".
- **inject a throwaway element per class and measure it.** States that only
  render on interaction (delete confirms, error banners, popovers) are absent
  from the DOM when you scan, and that is exactly where light-theme leftovers
  survive — `#E8C4B6` borders and `#7E3220` text on a dark plaque.

## У сайта нет серверной сессии — помни при любой новой ручке

`site-login.js` только сверяет пароль и отвечает `{ok:true}`; браузер кладёт в
localStorage `bd_auth_ts` — просто дату. **Сервер не может отличить залогиненный
браузер от любого запроса из интернета.** Поэтому «эта ручка под паролем сайта»
— неправда по умолчанию: всё, что отдаёт секреты, обязано требовать пароль
прямо в запросе.

Так сделан показ двойного кода админа (2026-10-22): `POST /api/admin-auth`
`{action:'reveal', password}` сверяет `SITE_PASSWORD` timing-safe и только тогда
возвращает `ADMIN_KEY_1/2`. GET намеренно не поддержан (405), при незаданном
`SITE_PASSWORD` — 503, а не утечка. Ветка добавлена **внутрь** существующего
`admin-auth.js`: в `api/` ровно 12 из 12 функций, 13-й файл уронил бы деплой.
Старый контракт мини-аппа (`{key1,key2}`) не тронут — проверено юнит-тестом.

## Data model notes

Schema is created idempotently in `api/_db.js → ensureSchema()`; every new
column is another `ALTER TABLE … ADD COLUMN IF NOT EXISTS` at the end of that
function. It already runs ~60 statements per cold start and the code comments
warn it is near the 10 s limit — add sparingly, and use `queryRaw` for hot
read paths that do not need the schema.

`students.status` values are `active` / `trial` / `paused`, plus `done`
("Завершил") added 2026-10-21, which is what closes Mini App access.

Audio: historically base64 `data:` URLs inside JSONB. New warm-up uploads go to
Vercel Blob and store a short URL in the same `dataUrl` field. One legacy row
("Дубай", 9.65 MB) still holds base64 — `/api/warmups` now strips `data:` URLs
**inside the SQL** so they never leave Postgres, flags them `inline`, and serves
them on demand. Tab load went 6097 ms → 431 ms, payload 9.65 MB → <1 KB.
Playing that one legacy file still takes ~11 s; re-uploading it would move it
to Blob.

## Mini App ↔ site

The Mini App no longer uses Notion at all (2026-10-21). Student data comes from
`GET /api/student-public?token=<uuid>`, which also returns `progressByLesson`
and `unlockedLessons`; a lesson step is posted back to the same route. The
`trial → active` promotion happens server-side there.

Notion routes were deleted; `notion-is-admin.js` was only ever an
`ADMIN_CHAT_ID` comparison and was renamed `is-admin.js`;
`notion-students-list.js` became `students-list.js` reading the Mini App's own
Postgres. `NOTION_TOKEN` removal in the Vercel dashboard is Николай's step.

Still open: the Mini App keeps a **second** Postgres (topics / assessments /
assessment_scores, the `admin-*` routes). Merging it into the site's database
is stage 2 and has not been started.
