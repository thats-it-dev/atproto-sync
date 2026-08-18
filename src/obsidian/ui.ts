/**
 * An external link styled as a call-to-action button. It must be a real
 * anchor: mobile WebViews only hand a URL to the system browser from a
 * genuine user tap on a real link — programmatic window.open is ignored.
 */
import { addIcon } from 'obsidian';

/**
 * Notesky's custom mark: a cloud with note lines. Drawn on the Lucide 24px
 * grid (stroke 2, round caps) so it sits flush beside Obsidian's own icons;
 * addIcon wraps content in a 0 0 100 100 viewBox, hence the scale.
 */
export const NOTESKY_ICON = 'notesky-cloud';

export function registerNoteskyIcon(): void {
  addIcon(
    NOTESKY_ICON,
    '<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>' +
      '<path d="M8 13h7"/><path d="M8 16h5"/>' +
      '</g>'
  );
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
