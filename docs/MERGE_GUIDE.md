# MERGE GUIDE: When to Merge merge/infra-ready into main

## Prerequisites (both must be true before merging)
- [ ] Bot 1 (Searchbar3) has completed all phases and merged to main
- [ ] Bot 2 (Sourcing101) has completed all phases and pushed to sourcing101/main

## Step 1: Update Repo B subtree with latest changes from Bot 2
`git subtree pull --prefix=services/startup_watch sourcing101 main --squash`

## Step 2: Open PR from merge/infra-ready into main
`gh pr create --base main --head merge/infra-ready --title 'feat: Startup Watch tab + Postgres data layer'`

## Step 3: Resolve merge conflicts (expected in pages/index.js only)
- Keep Bot 1's HeadlessUI Tabs structure
- Add StartupWatchTab import + 3rd Tab + Tab.Panel

## Step 4: Set DATABASE_URL secret in GitHub repository settings
- GitHub > Settings > Secrets > Actions > New repository secret
- Name: `DATABASE_URL`
- Value: production Postgres connection string

## Step 5: Run DB migrations on production
`psql $PROD_DATABASE_URL -f infra/db/migrations/001_create_startup_signals.sql`
`psql $PROD_DATABASE_URL -f infra/db/migrations/002_create_startup_signal_meta.sql`
`psql $PROD_DATABASE_URL -f infra/db/migrations/003_create_export_jobs.sql`

## Step 6: Merge PR after CI passes

## Step 7: Verify production
- Navigate to app and click Startup Watch tab
- Manually trigger sourcing_pipeline workflow
- Verify rows appear in Startup Watch table after pipeline run
