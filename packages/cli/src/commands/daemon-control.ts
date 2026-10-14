export interface StartDeps {
  /** Node binary used to spawn the daemon. */
  execPath: string;
  /** Path to the CLI entry (the built bundle) the daemon is spawned from. */
  cliPath: string;
  /** How long `start` waits for the daemon to come up (default 3000 ms). */
  waitMs?: number;
}
