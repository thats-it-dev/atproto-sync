/** Pure ignore-pattern matching (no Obsidian imports so it stays unit-testable). */

function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

export function isIgnored(path: string, patterns: string[]): boolean {
  for (const raw of patterns) {
    const pat = raw.trim();
    if (!pat) continue;
    if (pat.includes('*')) {
      if (globToRegExp(pat).test(path)) return true;
    } else {
      const prefix = pat.endsWith('/') ? pat.slice(0, -1) : pat;
      if (path === prefix || path.startsWith(`${prefix}/`)) return true;
    }
  }
  return false;
}
