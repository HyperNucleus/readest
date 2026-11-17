import { buildClientUnrestricted } from './build.mjs';

// Passwords arrive through stdin, never command arguments or a temporary file.
try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { profile, local, version, passwords } = JSON.parse(input);
  await buildClientUnrestricted(profile, local, version, passwords);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
