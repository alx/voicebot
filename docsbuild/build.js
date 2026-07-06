const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');

const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const OUTPUT_DIR = path.join(ROOT, '_site');
const TEMPLATE_PATH = path.join(__dirname, 'template.html');

const md = new MarkdownIt({ html: true });

// Rewrite relative links to markdown files (e.g. "docs/GET_GROUP_ID.md",
// "./SETUP.md") to the flat .html slug the site actually serves them at —
// otherwise links copied from the repo's raw markdown 404 on the built site.
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const hrefIndex = token.attrIndex('href');
  if (hrefIndex >= 0) {
    const href = token.attrs[hrefIndex][1];
    if (/\.md(#.*)?$/i.test(href) && !/^[a-z]+:\/\//i.test(href)) {
      const [pathPart, hash] = href.split('#');
      const newHref = slugify(path.basename(pathPart)) + (hash ? `#${hash}` : '');
      token.attrs[hrefIndex][1] = newHref;
    }
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
      const label = page.slug === 'index.html' ? 'Home' : escapeHtml(page.title);
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
      .replace('{{TITLE}}', () => escapeHtml(page.title))
      .replace('{{NAV}}', () => nav)
      .replace('{{CONTENT}}', () => content);
    fs.writeFileSync(path.join(OUTPUT_DIR, page.slug), html, 'utf8');
  }

  console.log(`Built ${pages.length} page(s) into ${OUTPUT_DIR}`);
}

main();
