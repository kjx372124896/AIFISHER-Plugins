import { copyFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugins = ['html', 'markdown', 'panorama', 'prompt-optimizer', 'sticky-note', 'svg'];
const distDir = path.join(root, 'dist');

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const npmCli = command === 'npm' ? process.env.npm_execpath : null;
    const executable = npmCli ? process.execPath : command;
    const finalArgs = npmCli ? [npmCli, ...args] : args;
    const child = spawn(executable, finalArgs, {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with exit ${code}`));
    });
  });
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

for (const plugin of plugins) {
  await run('npm', ['--workspace', plugin, 'run', 'build']);
  const source = path.join(root, plugin, 'dist', `${plugin}.js`);
  const target = path.join(distDir, `${plugin}.js`);
  await copyFile(source, target);
  console.log(`[root-dist] ${plugin}.js`);
}

console.log(`\nBuilt ${plugins.length} plugins → ${distDir}`);
