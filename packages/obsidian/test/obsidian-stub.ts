/**
 * Runtime stand-in for the `obsidian` package (which ships types only) so the
 * vault adapter can be unit-tested. Only what src/vault-adapter.ts touches.
 */
export class TAbstractFile {
  path = '';
}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {
  isRoot(): boolean {
    return this.path === '/' || this.path === '';
  }
}
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}
