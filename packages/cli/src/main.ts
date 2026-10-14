import { main } from './cli';

const argv = process.argv.slice(2);
main(argv).then((code) => {
  // The daemon resolves only after shutdown; exit explicitly so no stray handle keeps it alive.
  if (argv[0] === 'daemon') process.exit(code);
  process.exitCode = code;
});
