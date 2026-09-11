export const splitArgs = (argv) => ({
  flags: argv.filter((arg) => arg.startsWith("--")),
  positional: argv.filter((arg) => !arg.startsWith("--")),
});
