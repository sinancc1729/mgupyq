# MGU PYQ Hub

A web application where students of **Mahatma Gandhi University (Kerala)** can browse and download **FYUGP previous-year question papers and schemes of valuation**, organised by department, semester and course.

Administrators can:

- upload PDFs by hand,
- run a **background importer** that finds PDFs on the official source (`https://assist.mgu.ac.in/schema/`), reads **page 1 of every candidate** and matches it against a configured list of course codes,
- review, correct and confirm the extracted metadata in one **review queue** before anything is published.

Stack: React + TypeScript + Vite · Tailwind CSS + shadcn/ui · TanStack Query · React Hook Form + Zod · Supabase (Postgres, Auth, Storage, Edge Functions) · pdfjs-dist · JSZip / fflate · a small Node.js worker · Vitest, Testing Library, Playwright and pgTAP.

> **Status of the MGU source adapter.** The crawler for `assist.mgu.ac.in/schema/` could **not** be checked against the live site while it was being built, because the site was unreachable from the build environment. It is a conservative, configurable index crawler: it handles normal HTML pages, directory listings, iframes, `<option>` pickers and pagination links. Before your first import, run `npm run crawler:probe` from a normal internet connection. See [docs/SOURCE_ADAPTER.md](docs/SOURCE_ADAPTER.md). If the site relies on forms or JavaScript, adjust the adapter there; the rest of the application stays as it is.

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Install dependencies](#2-install-dependencies)
3. [Create a Supabase project](#3-create-a-supabase-project)
4. [Run the database migrations](#4-run-the-database-migrations)
5. [Storage buckets](#5-storage-buckets)
6. [Row Level Security](#6-row-level-security)
7. [Set up the first administrator](#7-set-up-the-first-administrator)
8. [Configure the target course-code list](#8-configure-the-target-course-code-list)
9. [Run the frontend locally](#9-run-the-frontend-locally)
10. [Deploy the Edge Function](#10-deploy-the-supabase-edge-function)
11. [Deploy the background worker](#11-deploy-the-background-worker)
12. [Deploy the frontend](#12-deploy-the-frontend)
13. [Connect the repository to GitHub](#13-connect-the-repository-to-github)
14. [Run the automated tests](#14-run-the-automated-tests)
15. [Run an import](#15-run-an-import)
16. [Architecture and project layout](#16-architecture-and-project-layout)
17. [Operations: cleanup, troubleshooting, limits](#17-operations)

---

## 1. Prerequisites

- **Node.js 20+** and npm (`node -v`)
- A free **Supabase** account: <https://supabase.com>
- **Supabase CLI** (for migrations and Edge Functions): `npm i -g supabase` or see <https://supabase.com/docs/guides/cli>
- Git and a GitHub account
- Optional: Docker (to run the worker as a container or run Supabase locally)

## 2. Install dependencies

```bash
git clone https://github.com/<you>/mgu-pyq-hub.git
cd mgu-pyq-hub
npm install
cp .env.example .env
```

`.env.example` lists every setting. Values starting with **`VITE_`** are bundled into the public website, so they must be safe for anyone to see. Everything else is **server-only** and must never be prefixed with `VITE_`.

## 3. Create a Supabase project

1. Go to supabase.com → **New project**. Choose a region close to Kerala, for example Mumbai (`ap-south-1`).
2. When it is ready, open **Project Settings → API** and copy:
   - **Project URL** → `VITE_SUPABASE_URL` and `SUPABASE_URL`
   - **Publishable key** (or the legacy **anon** key) → `VITE_SUPABASE_PUBLISHABLE_KEY`
   - **Secret key** (or the legacy **service_role** key) → `SUPABASE_SERVICE_ROLE_KEY`. This one is server-only, for the worker and scripts. **Never** put it in a `VITE_` variable, the frontend, or Git.
3. **Authentication → Sign In / Providers**: keep **Email** enabled and **turn off "Allow new users to sign up"**. Students never need accounts, and administrators are invited (see step 7).
4. **Authentication → URL Configuration**: set the Site URL to your deployed site and add `https://<your-site>/admin` to the redirect URLs, so email sign-in links work.

## 4. Run the database migrations

The migrations live in `supabase/migrations/`:

| File | Contents |
| --- | --- |
| `…000000_core_schema.sql` | enums, tables, constraints, indexes, triggers |
| `…000100_functions_and_views.sql` | `is_admin()`, listing views, `search_courses`, `publish_paper`, import-job RPCs |
| `…000200_rls_policies.sql` | Row Level Security policies and grants |
| `…000300_storage.sql` | the `papers` and `staging` buckets and their policies |

Apply them with the CLI:

```bash
supabase login
supabase link --project-ref <your-project-ref>   # ref is in the project URL
supabase db push
```

Alternatively, paste each file **in order** into **SQL Editor → New query → Run**.

## 5. Storage buckets

The storage migration creates both buckets for you:

| Bucket | Public? | Purpose |
| --- | --- | --- |
| `papers` | **public read** | Approved, published PDFs. Students download from here. |
| `staging` | private | Candidate PDFs waiting for review (worker uploads, admin reads). |

Both buckets accept only `application/pdf` up to 25 MB, and only administrators may upload, replace or delete files. To create them by hand instead, go to **Storage → New bucket** with the same names, the same public/private setting, *Allowed MIME types* `application/pdf` and *File size limit* 25 MB, then run the policy statements from `…000300_storage.sql`.

Published objects use stable, hash-suffixed paths:
`<department-slug>/<course-code>/<year>/<kind>-<month>-<sha256 prefix>.pdf`.
The database stores the **path** (`papers.file_path`). Public URLs are derived from that path when a page loads, so they never expire.

> A public bucket only makes reads public. Database writes are protected separately, by RLS and by `publish_paper()` checking `is_admin()`.

## 6. Row Level Security

RLS is enabled on every table by `…000200_rls_policies.sql`:

- **Anyone** may *read* `departments`, `courses`, `papers` and the listing views.
- **Only administrators**, meaning users listed in `admin_roles` and checked by `public.is_admin()`, may write catalogue data, read or modify the review queue, start or cancel imports, or manage course codes.
- `admin_roles` has **no** insert, update or delete policy, so nobody can grant themselves admin through the API.
- The worker uses the service role key, which bypasses RLS by design and therefore runs **only on your server**.

Check it under **Database → Policies**. Every table should show "RLS enabled".

## 7. Set up the first administrator

Being signed in is **not** enough to be an admin. See [docs/ADMIN_SETUP.md](docs/ADMIN_SETUP.md) for the full guide. In short:

1. **Authentication → Users → Add user → Send invitation** (or *Create new user* with a strong password) for your email.
2. In **SQL Editor**, run:
   ```sql
   insert into public.admin_roles (user_id, granted_by)
   select id, 'initial setup' from auth.users where email = 'you@example.com';
   ```
3. Open `/admin` on your site and sign in.

## 8. Configure the target course-code list

The importer only treats a PDF as a match when its **first-page text** contains one of your target course codes. There are two ways to supply the list, and they can be combined:

**a) Config file (versioned with the code)**: `config/target-course-codes.json`

```json
{
  "codes": ["MG1DSC…", "MG2MDC…"]
}
```

The file ships with an **empty** list on purpose, so no course codes are assumed. Add your real codes, then run `npm run codes:sync`, or simply start the worker, which syncs them on start-up. Use `npm run codes:sync -- --prune` to deactivate codes you have removed from the file.

**b) Admin dashboard**: `/admin/codes`. Paste codes, or upload a **CSV** (first column; a `code` header is ignored) or **JSON** (`["…"]` or `{"codes": [...]}`). You can deactivate codes there without deleting them.

Codes are normalised by trimming, removing whitespace, upper-casing and applying Unicode NFKC. Nothing else is stripped, so `mg1 dsc mat 100` equals `MG1DSCMAT100`, but punctuation stays meaningful.

The extraction rules (code pattern, scheme/question phrases) are in `config/extraction-rules.json`. The subject-code → department hints are in `config/departments.json`. **Check those department mappings against the official syllabi.** They are only used as evidence, and every value is confirmed by an admin.

## 9. Run the frontend locally

```bash
npm run dev          # http://localhost:5173
```

You need `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`. The public site works immediately; it will be empty until you publish papers.

To use a fully local Supabase instead (requires Docker): `supabase start`, then `supabase db reset` applies the migrations. Use the printed local URL and keys.

## 10. Deploy the Supabase Edge Function

`supabase/functions/course-zip` streams large "Download all" ZIPs on the server with bounded memory. Small collections are zipped in the browser instead.

```bash
supabase functions deploy course-zip --no-verify-jwt
# optional limits (defaults: 300 files / 800 MB)
supabase secrets set ZIP_MAX_FILES=300 ZIP_MAX_TOTAL_MB=800
```

`--no-verify-jwt` is intentional. The function serves only published, public papers, and it reads them with the anon key under RLS. Before streaming, it checks its limits and confirms every file exists. It **never** returns a truncated ZIP: over the limit you get `413`, a missing file gives `409`, and a failure mid-stream aborts the download.

> The browser switches to this server path above `VITE_CLIENT_ZIP_MAX_FILES` files or `VITE_CLIENT_ZIP_MAX_MB` megabytes.

## 11. Deploy the background worker

Supabase Edge Functions have short execution limits. That is unsuitable for a polite, sequential crawl that may download hundreds of PDFs with delays between requests. Imports therefore run in a small **Node.js worker** (`worker/`). The worker:

- claims queued jobs atomically (`claim_import_job`, `FOR UPDATE SKIP LOCKED`),
- persists every step, sends heartbeats, and **resumes** jobs whose heartbeat goes stale (crash, redeploy),
- retries transient errors with exponential backoff, and marks items `failed` after `WORKER_MAX_ITEM_ATTEMPTS`,
- stores candidates in the private `staging` bucket and creates review-queue rows.

Pick **one** of these ways to run it. All of them need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

**A. GitHub Actions on a schedule (no server needed).** `.github/workflows/import-worker.yml` runs `npm run worker:once` every 30 minutes and on demand (*Actions → Import worker → Run workflow*). Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` under *Settings → Secrets and variables → Actions*. A job queued from `/admin/import` is picked up on the next run, so start it manually if you are in a hurry.

**B. Always-on container** (Render, Railway, Fly.io, a VPS…):

```bash
docker build -f worker/Dockerfile -t mgu-pyq-worker .
docker run -d --restart unless-stopped --env-file worker/.env mgu-pyq-worker
# with optional OCR:  docker build -f worker/Dockerfile --build-arg WITH_OCR=true -t mgu-pyq-worker .
```

On Render or Railway, create a **Background Worker** from this repo with the Dockerfile `worker/Dockerfile` and set the environment variables in their dashboard.

**C. Any machine with Node 20:** `npm ci && npm run worker` (use pm2 or systemd to keep it running).

Useful worker settings (see `.env.example`): `CRAWLER_DELAY_MS` (minimum gap between requests, default 1.5 s), `CRAWLER_TIMEOUT_MS`, `CRAWLER_MAX_PAGES`, `CRAWLER_MAX_DEPTH`, `CRAWLER_MAX_DOWNLOADS_PER_JOB`, `MAX_PDF_BYTES`, `CRAWLER_RESPECT_ROBOTS` (default `true`), and `SOURCE_ALLOWED_HOSTS` (the SSRF allow-list).

**Optional OCR.** Set `OCR_ENABLED=true` and install `tesseract` and `pdftoppm` (poppler-utils). OCR runs only when page 1 has no readable text. Its output is labelled *"Text obtained by OCR"* in the review queue. When OCR is disabled, the review queue states that no OCR was performed.

## 12. Deploy the frontend

The frontend is a static single-page app (`npm run build` → `dist/`).

**Vercel**: *Import Project* → framework **Vite**. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in *Environment Variables*. `vercel.json` already rewrites all routes to `index.html`.

**Netlify**: *Add new site → Import from Git*, build `npm run build`, publish directory `dist`, and the same env vars. `public/_redirects` handles SPA routing.

**GitHub Pages**: build with `VITE_BASE_PATH=/<repo-name>/ npm run build`, copy `dist/index.html` to `dist/404.html` so deep links work, then publish `dist`. The included workflow `.github/workflows/pages.yml` does exactly this. Enable it under *Settings → Pages → Source: GitHub Actions* and add the two `VITE_` values as repository **variables**.

Finally, add your production URL to Supabase **Authentication → URL Configuration**.

## 13. Connect the repository to GitHub

```bash
git init            # if you downloaded a ZIP
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/mgu-pyq-hub.git
git push -u origin main
```

`.gitignore` already excludes `.env*` (except `.env.example`), PDFs, ZIPs, build output and test artefacts. **Never commit real keys.** If you ever do, rotate them in Supabase immediately.

The CI workflow (`.github/workflows/ci.yml`) runs type-checking, linting, unit tests, the build, Playwright end-to-end tests and the pgTAP database tests on every push.

## 14. Run the automated tests

```bash
npm test               # Vitest: extraction, matching, crawler, retries/resume, hashing, ZIP, UI auth guard
npm run lint           # ESLint
npm run typecheck      # TypeScript (strict)
npm run test:e2e       # Playwright (mocked Supabase; first run: npx playwright install chromium)
supabase test db       # pgTAP RLS/authorization/publishing tests against local Supabase
# …or without the Supabase CLI, against any PostgreSQL ≥ 15 with pgTAP:
PGHOST=localhost PGUSER=postgres ./scripts/test-db.sh
```

Test fixtures are **synthetic**. PDFs are generated during the tests with `pdf-lib`, and no copyrighted MGU documents are committed.

## 15. Run an import

1. Make sure the worker is deployed (step 11) and your course codes are configured (step 8).
2. Optional but recommended: `npm run crawler:probe` shows what the crawler sees on the live source page.
3. In `/admin/import`, optionally enter a **department keyword** and extra codes, then click **Start import**.
   - The **course codes decide what counts as a match**, and the match must come from the PDF's first-page text.
   - The keyword only narrows which links are downloaded. A link that mentions one of your codes is downloaded even if it does not contain the keyword.
4. Watch the progress counts: discovered, downloaded, matched, duplicates, unmatched, failed, pending review. You can close the tab; the job runs on the server.
5. Confirm candidates in the job's candidate table or in **Review queue**. Check the *Evidence & first-page text*, fix anything uncertain (kind, semester, department…), then **Confirm & publish**.
6. **Unmatched** PDFs (readable, but carrying a code that is not on your list) have their own tab and can still be published after checking. **Failed** downloads can be retried with *Import history → Resume / retry failed*.

---

## 16. Architecture and project layout

```text
mgu-pyq-hub/
├── config/                     # target course codes, extraction rules, department hints
├── shared/                     # pure TypeScript used by BOTH browser and worker
│   ├── courses/courseCode.ts   #   normalisation, discovery, matching against targets
│   ├── pdf/extractMetadata.ts  #   deterministic first-page metadata extraction
│   ├── pdf/pageText.ts         #   pdf.js page-1 text → reading-order lines
│   ├── files/                  #   SHA-256, PDF validation, storage paths & filenames
│   ├── crawl/url.ts            #   SSRF-safe URL validation
│   ├── review/schema.ts        #   Zod schema for publishable metadata
│   └── zip/plan.ts             #   browser-vs-server ZIP decision
├── src/                        # React app
│   ├── app/                    #   providers, router, lazily loaded admin routes
│   ├── components/{ui,layout,search,departments,papers,admin,common}
│   ├── pages/ (+ pages/admin)  #   Home, Browse, Department, Semester, Course; admin screens
│   ├── services/               #   Supabase queries, publish pipeline, downloads, pdf.js loader
│   ├── hooks/ lib/ types/ styles/
├── worker/                     # Node.js background importer
│   └── src/{crawler,jobs}/     #   polite fetcher, robots.txt, link parser, adapter, job runner
├── supabase/
│   ├── migrations/             # schema, functions, RLS, storage
│   ├── functions/course-zip/   # streaming ZIP Edge Function (Deno)
│   └── tests/                  # pgTAP tests (+ stubs for plain-Postgres CI)
├── scripts/                    # codes:sync, storage:orphans, test-db.sh
├── tests/{unit,e2e,fixtures}/  # Vitest + Playwright; synthetic fixtures only
└── docs/                       # ADMIN_SETUP, SOURCE_ADAPTER, ARCHITECTURE
```

The data model, including why each extra table exists, the import pipeline and the security model are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 17. Operations

**Orphaned storage objects.** `publish_paper` runs in a single transaction, and the client deletes its upload if that transaction fails. A crash at exactly the wrong moment can still leave a stray file behind. Check with:

```bash
npm run storage:orphans            # report
npm run storage:orphans -- --delete
```

Staging copies are removed after publishing. Rejected items keep their staging copy for audit; the orphan script removes staging objects that no *open* review item refers to.

**Troubleshooting**

| Symptom | Likely cause |
| --- | --- |
| "Not authorised" after sign-in | The user is not in `admin_roles` (step 7). |
| Import stays *Queued* | No worker is running or scheduled (step 11). |
| Import completes with 0 candidates | The source structure changed or access is blocked. Run `npm run crawler:probe` and read the job log. |
| Many items *No readable text* | Scanned PDFs. Enable OCR (step 11) or fill in the metadata by hand. |
| `course_conflict` when publishing | The course already exists with a different department, semester or type. Use the existing values (the edit dialog fills them in when you leave the course-code field). |
| `duplicate_session` | That course already has a paper of this kind for the same exam month and year. |

**Limits and politeness.** One request at a time, at least `CRAWLER_DELAY_MS` apart, with robots.txt (and its Crawl-delay) honoured. Only one import job can be queued or running at a time, with at most six jobs per hour (enforced in the database). The crawler never submits forms, runs JavaScript, logs in or attempts to get past access controls. If the source returns 401 or 403, the item is marked failed with that reason.

## Licence

MIT for the source code (see `LICENSE`). Question papers and schemes belong to Mahatma Gandhi University. Publish only documents you are permitted to redistribute.
