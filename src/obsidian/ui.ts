/**
 * An external link styled as a call-to-action button. It must be a real
 * anchor: mobile WebViews only hand a URL to the system browser from a
 * genuine user tap on a real link — programmatic window.open is ignored.
 */
/** Spinner + label row (styles in styles.css). */
export function createBusyRow(parent: HTMLElement, text: string): HTMLElement {
  const row = parent.createDiv({ cls: 'notesky-busy-row' });
  row.createSpan({ cls: 'notesky-spinner' });
  row.createSpan({ text });
  return row;
}

export function createLinkButton(parent: HTMLElement, url: string, label: string): HTMLAnchorElement {
  const link = parent.createEl('a', { text: label, href: url });
  link.setAttr('target', '_blank');
  link.setAttr('rel', 'noopener');
  Object.assign(link.style, {
    display: 'block',
    textAlign: 'center',
    padding: '10px 16px',
    margin: '0.75em 0',
    borderRadius: 'var(--button-radius, 8px)',
    background: 'var(--interactive-accent)',
    color: 'var(--text-on-accent)',
    textDecoration: 'none',
    fontWeight: '600',
    fontSize: '1.05em',
    cursor: 'pointer',
  });
  return link;
}
