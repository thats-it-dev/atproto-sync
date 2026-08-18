/**
 * An external link styled as a call-to-action button. It must be a real
 * anchor: mobile WebViews only hand a URL to the system browser from a
 * genuine user tap on a real link — programmatic window.open is ignored.
 */
import { setIcon } from 'obsidian';

/**
 * setIcon with a fallback: newer Lucide names (cloud-sync, cloud-check,
 * cloud-alert) may be absent from older Obsidian builds, which render nothing.
 */
export function setIconWithFallback(el: HTMLElement, icon: string, fallback: string): void {
  setIcon(el, icon);
  if (!el.querySelector('svg')) setIcon(el, fallback);
}

/** Spinner + label row (styles in styles.css). */
export function createBusyRow(parent: HTMLElement, text: string): HTMLElement {
  const row = parent.createDiv({ cls: 'notesky-busy-row' });
  row.createSpan({ cls: 'notesky-spinner' });
  row.createSpan({ text });
  return row;
}

export function createLinkButton(parent: HTMLElement, url: string, label: string): HTMLAnchorElement {
  const link = parent.createEl('a', { text: label, href: url, cls: 'notesky-link-button' });
  link.setAttr('target', '_blank');
  link.setAttr('rel', 'noopener');
  return link;
}
