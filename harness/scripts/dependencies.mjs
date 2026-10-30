/** Reuse the adjacent source build without installing or modifying host dependencies. */
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, realpath, symlink, lstat, unlink } from 'node:fs/promises';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {spawnSync} from 'node:child_process';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const host = resolve(process.env.DSH_SOURCE ?? join(root, '../../DSH-Softwarefactory'));
export const requireHost = createRequire(join(host, 'package.json'));
async function link(name, source) {
  const modules = join(root, 'node_modules'), target = resolve(modules, name), within = relative(modules, target);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Dependency link escapes this plugin');
  const wanted = await realpath(source);
  await mkdir(dirname(target), { recursive: true });
  try {
    const existing = await lstat(target);
    if (await realpath(target).catch(error => { if (error.code !== 'ENOENT') throw error; }) === wanted) return;
    if (!existing.isSymbolicLink()) throw new Error(`Refusing to replace dependency directory: ${name}`);
    await unlink(target);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await symlink(wanted, target, process.platform === 'win32' ? 'junction' : 'dir');
}
export async function prepareDependencies() {
  for (const group of await readdir(join(host, 'packages'), { withFileTypes: true })) if (group.isDirectory()) {
    for (const entry of await readdir(join(host, 'packages', group.name), { withFileTypes: true })) if (entry.isDirectory()) {
      const dir = join(host, 'packages', group.name, entry.name);
      try { const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')); await link(manifest.name, dir); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  for (const [name, dir] of [['cordis', 'cordis'], ['schemastery', 'schemastery'], ['cordis-plugin-loader', 'loader'], ['cordis-plugin-include', 'include'], ['cordis-plugin-timer', 'timer']]) await link(`@deepseek-ai/${name}`, join(host, 'vendor', dir));
  const sdk=join(root,'vendor/runtime-sdk');await mkdir(sdk,{recursive:true});
  const unpack=spawnSync('tar',['-xf',join(root,'vendor/software-factory-runtime-sdk-0.1.0.tgz'),'-C',sdk,'--strip-components=1'],{stdio:'inherit',windowsHide:true});
  if(unpack.error)throw unpack.error;
  if(unpack.status!==0)throw new Error('Cannot unpack the supplied Runtime SDK');
  await link('@software-factory/runtime-sdk',sdk);
  for (const name of ['@types/node', 'typescript']) await link(name, dirname(requireHost.resolve(`${name}/package.json`)));
}
