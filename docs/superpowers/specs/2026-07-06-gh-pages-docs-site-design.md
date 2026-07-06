# GitHub Pages Documentation Site — Design

## Goal

Publish the project's existing Markdown documentation (`README.md` and `docs/*.md`) as a browsable HTML site on GitHub Pages, served from a `gh-pages` branch, that updates automatically whenever `main` changes — so no manual conversion or copy/paste step is needed when new docs are added.

## Scope

- Render `README.md` → site home page.
- Render every `docs/*.md` file → its own site page.
- Auto-generate a shared nav bar across pages, discovered from the files present at build time (no hardcoded page list to maintain).
- Auto-deploy on every push to `main` via GitHub Actions.
- Out of scope: search, versioning/multiple doc versions, non-Markdown content sources, custom domain setup.

## Components

### 1. `docsbuild/` — standalone build tool

A small, self-contained Node project, isolated from `bot/` (the WhatsApp bot's Node app) so its dependency (`markdown-it`) never touches the bot's `package.json` / `package-lock.json`.

```
docsbuild/
  package.json      # only dependency: markdown-it
  build.js          # conversion script
  template.html     # shared HTML shell (nav + basic CSS)
```

**`build.js` behavior:**
1. Read `README.md` from the repo root → render to `index.html`.
2. Glob `docs/*.md` → render each to `<slug>.html` (slug = filename lowercased, `.md` → `.html`, e.g. `GET_GROUP_ID.md` → `get_group_id.html`).
3. Build a nav list from: `Home` (index) + one entry per discovered `docs/*.md` file, using the file's first `# H1` heading as the link text (fallback to filename if no H1 found).
4. Wrap each converted page's HTML in `template.html`, injecting the nav and page content.
5. Write all output files to `_site/` at the repo root.

This means: adding a new `docs/some-feature.md` file and pushing to `main` is the *entire* workflow for publishing a new doc page — the nav updates automatically on the next build, no other file needs to change.

### 2. `.github/workflows/gh-pages.yml` — deploy workflow

Triggered on `push` to `main`. Steps:
1. Checkout repo.
2. Setup Node.
3. `npm install` inside `docsbuild/`.
4. `node docsbuild/build.js` → produces `_site/`.
5. Deploy `_site/` to the `gh-pages` branch using `peaceiris/actions-gh-pages` (creates the branch on first run if it doesn't exist; force-pushes the rendered output each time, so `gh-pages` only ever contains build artifacts, never hand-edited).

### 3. Manual one-time setup (not automatable from the repo)

After the workflow's first successful run creates the `gh-pages` branch, the repo owner must set **Settings → Pages → Source** to `gh-pages` (root) in the GitHub UI, or via `gh api` if preferred at that time. This is a one-time step per repo.

## Data Flow

```
push to main
  → workflow runs
    → docsbuild/build.js reads README.md + docs/*.md
    → renders _site/index.html + _site/<slug>.html per doc, shared nav/template
  → peaceiris/actions-gh-pages force-pushes _site/ contents to gh-pages branch
  → GitHub Pages serves gh-pages branch as the live site
```

## Error Handling

- If `docsbuild/build.js` throws (e.g. malformed Markdown causing a parse error), the workflow step fails and the deploy step is skipped — the previously published `gh-pages` content is left untouched (no partial/broken deploy).
- No docs/*.md files present is a valid state: the site would just have the `index.html` home page and an empty nav beyond "Home".

## Testing

- Manual: run `node docsbuild/build.js` locally, confirm `_site/index.html` and one page per `docs/*.md` file are produced with working nav links, by opening the files in a browser.
- No automated test suite needed for a static doc build script of this size — this matches the project's existing testing scope (Python `pytest` for pipeline logic; no equivalent harness exists for one-off Node build scripts elsewhere in this repo).
