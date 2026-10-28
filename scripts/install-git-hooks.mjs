import { execFileSync } from 'node:child_process';

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: process.cwd(),
  stdio: 'inherit'
});

console.log('Hooks de seguranca instalados em .githooks.');
