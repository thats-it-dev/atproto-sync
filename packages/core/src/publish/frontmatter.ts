/**
 * Public-note state lives in frontmatter (`notesky_public: true`) so it is
 * visible in the editor and survives without the sync index. Pure string
 * handling — no YAML library, no Obsidian imports.
 */

const PUBLIC_KEY = 'notesky_public';
const SLUG_KEY = 'notesky_slug';
const FM_RE = /^---\n([\s\S]*?)\n?---\n?/;

function splitFrontmatter(content: string): { fm: string[] | null; body: string } {
  const m = content.match(FM_RE);
  if (!m) return { fm: null, body: content };
  const fm = m[1] === '' ? [] : m[1].split('\n');
  return { fm, body: content.slice(m[0].length) };
}

function joinFrontmatter(fm: string[], body: string): string {
  if (fm.length === 0) return body.replace(/^\n/, '');
  return `---\n${fm.join('\n')}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

export function isPublicNote(content: string): boolean {
  const { fm } = splitFrontmatter(content);
  return fm !== null && fm.some((line) => line.match(new RegExp(`^${PUBLIC_KEY}:\\s*true\\s*$`)));
}

export function getPublicSlug(content: string): string | undefined {
  const { fm } = splitFrontmatter(content);
  const line = fm?.find((l) => l.startsWith(`${SLUG_KEY}:`));
  return line?.slice(SLUG_KEY.length + 1).trim() || undefined;
}

export function setPublicFlag(content: string, slug?: string): string {
  const { fm, body } = splitFrontmatter(content);
  const lines = (fm ?? []).filter(
    (l) => !l.startsWith(`${PUBLIC_KEY}:`) && !l.startsWith(`${SLUG_KEY}:`)
  );
  lines.push(`${PUBLIC_KEY}: true`);
  if (slug) lines.push(`${SLUG_KEY}: ${slug}`);
  return joinFrontmatter(lines, fm === null ? `\n${body}` : body);
}

export function removePublicFlag(content: string): string {
  const { fm, body } = splitFrontmatter(content);
  if (fm === null) return content;
  const lines = fm.filter(
    (l) => !l.startsWith(`${PUBLIC_KEY}:`) && !l.startsWith(`${SLUG_KEY}:`)
  );
  return joinFrontmatter(lines, body);
}

/** Vault-internal embed targets: ![[target]] and ![alt](relative/path). */
export function extractEmbedTargets(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    out.push(m[1].trim());
  }
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = m[1].trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) out.push(target); // skip absolute URLs
  }
  return out;
}
