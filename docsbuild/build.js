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
