# GitHub Pages Documentation Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `README.md` and `docs/*.md` as a browsable HTML site on GitHub Pages (`gh-pages` branch), rebuilt automatically on every push to `main`.

**Architecture:** A standalone Node build tool (`docsbuild/`) renders `README.md` and every top-level `docs/*.md` file to HTML pages with a shared nav/template, writing output to `_site/`. A GitHub Actions workflow runs this build on push to `main` and force-pushes `_site/` to the `gh-pages` branch via `peaceiris/actions-gh-pages`.

**Tech Stack:** Node.js, `markdown-it` (Markdown→HTML), GitHub Actions, `peaceiris/actions-gh-pages`.

## Global Constraints

- `docsbuild/` must be a fully separate Node project from `bot/` — its `package.json`/`node_modules` must never touch or be listed as a dependency of `bot/package.json` (per spec: "isolated from `bot/`... so its dependency never touches the bot's package.json / package-lock.json").
- Only top-level `docs/*.md` files are rendered (not nested subdirectories like `docs/superpowers/`) — matches spec's "every `docs/*.md` file."
- Nav link text for each doc page comes from that file's first `# H1` heading, falling back to the filename if no H1 is found.
- Slug rule: `<filename-lowercased>.md` → `<filename-lowercased>.html` (e.g. `GET_GROUP_ID.md` → `get_group_id.html`).
- Build output directory is `_site/` at repo root; this directory is a build artifact and must not be committed to `main` (add to `.gitignore`).
- On any build error, the workflow must fail before the deploy step runs, leaving the previously published `gh-pages` content untouched (no partial deploy).

---

### Task 1: Build tool — `docsbuild/`

**Files:**
- Create: `docsbuild/package.json`
- Create: `docsbuild/template.html`
- Create: `docsbuild/build.js`
- Modify: `.gitignore` (add `_site/`)

**Interfaces:**
- Produces: `_site/index.html` (from `README.md`) and `_site/<slug>.html` (one per top-level `docs/*.md` file), each page containing a nav bar linking every generated page.
- Consumes: nothing from other tasks (first task).

- [ ] **Step 1: Create `docsbuild/package.json`**

```json
{
  "name": "docsbuild",
  "private": true,
  "version": "1.0.0",
  "description": "Static site build tool for the project's GitHub Pages documentation",
  "dependencies": {
    "markdown-it": "^14.1.0"
  }
}
```

- [ ] **Step 2: Create `docsbuild/template.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; max-width: 860px; margin: 0 auto; padding: 2rem 1.5rem; line-height: 1.6; color: #1a1a1a; }
  nav { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #ddd; }
  nav a { margin-right: 1rem; text-decoration: none; color: #0969da; }
  nav a:hover { text-decoration: underline; }
  pre { background: #f6f8fa; padding: 1rem; overflow-x: auto; border-radius: 6px; }
  code { background: #f6f8fa; padding: 0.2em 0.4em; border-radius: 4px; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  h1, h2, h3 { line-height: 1.25; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: 0.5rem; }
  img { max-width: 100%; }
</style>
</head>
<body>
<nav>{{NAV}}</nav>
<main>{{CONTENT}}</main>
</body>
</html>
```

- [ ] **Step 3: Create `docsbuild/build.js`**

```js
const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');

const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const OUTPUT_DIR = path.join(ROOT, '_site');
const TEMPLATE_PATH = path.join(__dirname, 'template.html');

const md = new MarkdownIt({ html: true });

function slugify(filename) {
  return filename.replace(/\.md$/i, '').toLowerCase() + '.html';
}

function extractTitle(markdownSource, fallback) {
  const match = markdownSource.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function findDocFiles() {
  if (!fs.existsSync(DOCS_DIR)) return [];
  return fs
    .readdirSync(DOCS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

function buildPages() {
  const readmeSource = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const docFiles = findDocFiles();

  const pages = [
    { slug: 'index.html', title: extractTitle(readmeSource, 'Home'), source: readmeSource },
    ...docFiles.map((filename) => {
      const source = fs.readFileSync(path.join(DOCS_DIR, filename), 'utf8');
      return { slug: slugify(filename), title: extractTitle(source, filename), source };
    }),
  ];

  return pages;
}

function buildNav(pages) {
  return pages
    .map((page) => {
      const label = page.slug === 'index.html' ? 'Home' : page.title;
      return `<a href="${page.slug}">${label}</a>`;
    })
    .join('\n');
}

function main() {
  const pages = buildPages();
  const nav = buildNav(pages);
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const page of pages) {
    const content = md.render(page.source);
    const html = template
      .replace('{{TITLE}}', page.title)
      .replace('{{NAV}}', nav)
      .replace('{{CONTENT}}', content);
    fs.writeFileSync(path.join(OUTPUT_DIR, page.slug), html, 'utf8');
  }

  console.log(`Built ${pages.length} page(s) into ${OUTPUT_DIR}`);
}

main();
```

- [ ] **Step 4: Add `_site/` to `.gitignore`**

Append to `.gitignore`:

```
# Generated docs site (built by docsbuild/, deployed to gh-pages branch)
_site/
```

- [ ] **Step 5: Install the build tool's dependency**

Run: `cd docsbuild && npm install`
Expected: creates `docsbuild/node_modules/` and `docsbuild/package-lock.json`, no errors.

- [ ] **Step 6: Run the build and verify output**

Run: `node docsbuild/build.js`
Expected output: `Built 2 page(s) into /home/alx/voicebot/_site` (1 for `README.md` + 1 for `docs/GET_GROUP_ID.md`; nested `docs/superpowers/**/*.md` files must NOT be counted).

Then verify:
```bash
ls _site/
# expect: index.html  get_group_id.html
grep -c '<a href=' _site/index.html
# expect: 2 (Home + Get Group Id)
grep -o '<title>[^<]*</title>' _site/get_group_id.html
```
Confirm the title reflects the H1 from `docs/GET_GROUP_ID.md`, and open `_site/index.html` and `_site/get_group_id.html` in a browser to confirm both pages render with working nav links between them.

- [ ] **Step 7: Commit**

```bash
git add docsbuild/package.json docsbuild/template.html docsbuild/build.js docsbuild/package-lock.json .gitignore
git commit -m "feat: add docsbuild tool to render docs to a static HTML site"
```

---

### Task 2: GitHub Actions workflow — auto-deploy to `gh-pages`

**Files:**
- Create: `.github/workflows/gh-pages.yml`

**Interfaces:**
- Consumes: `docsbuild/package.json` and `docsbuild/build.js` from Task 1 (runs `npm install` then `node docsbuild/build.js`, expects `_site/` as output).
- Produces: on push to `main`, the `gh-pages` branch is created/updated with the contents of `_site/`.

- [ ] **Step 1: Create `.github/workflows/gh-pages.yml`**

```yaml
name: Deploy docs to GitHub Pages

on:
  push:
    branches:
      - main

permissions:
  contents: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install docsbuild dependencies
        run: npm install
        working-directory: docsbuild

      - name: Build docs site
        run: node docsbuild/build.js

      - name: Deploy to gh-pages
        uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./_site
```

- [ ] **Step 2: Validate the workflow YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/gh-pages.yml'))" && echo OK`
Expected: `OK` (no `yaml.scanner.ScannerError` or similar).

If `python3 -c "import yaml"` fails because `pyyaml` isn't installed, instead run: `node -e "require('js-yaml') || true"` is not guaranteed available either — in that case just visually re-check indentation against the block above (2-space indents, `steps:` items each start with `- name:`) since correctness here matters more than the exact validation tool.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/gh-pages.yml
git commit -m "ci: auto-deploy docs site to gh-pages on push to main"
```

- [ ] **Step 4: Push and verify the live deploy**

Run: `git push origin main`

Then check the deploy ran:
```bash
gh run list --workflow=gh-pages.yml --limit=1
```
Expected: a run with status `completed` / conclusion `success`. If it fails, run `gh run view --log-failed` to inspect the failing step.

Confirm the `gh-pages` branch now exists:
```bash
git fetch origin gh-pages && git log origin/gh-pages -1 --stat
```
Expected: a commit containing `index.html` and `get_group_id.html`.

---

### Task 3: Enable GitHub Pages (manual, one-time)

**Files:** none (GitHub repo settings only).

**Interfaces:**
- Consumes: the `gh-pages` branch created by Task 2.
- Produces: a live public URL serving the site.

- [ ] **Step 1: Set the Pages source via `gh api`**

Run:
```bash
gh api -X POST repos/alx/voicebot/pages -f source[branch]=gh-pages -f source[path]=/
```
Expected: JSON response describing the new Pages site, or (if Pages was already enabled with a different source) a response confirming the update. If this returns a 409/"already exists" error, instead run:
```bash
gh api -X PUT repos/alx/voicebot/pages -f source[branch]=gh-pages -f source[path]=/
```

- [ ] **Step 2: Verify the site is live**

Run:
```bash
gh api repos/alx/voicebot/pages --jq '.html_url, .status'
```
Expected: a `github.io` URL and status `built` (may show `building` briefly right after enabling — re-run after a minute if so).

- [ ] **Step 3: Manually confirm in a browser**

Open the URL from Step 2 and confirm the rendered README content and nav appear, then click through to the "Get Group Id" page and confirm it renders too.

No commit needed for this task (no repo files changed).
