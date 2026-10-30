/** Host-only build. SDK is bundled from the supplied distribution; no Client module. */
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {root,requireHost,prepareDependencies} from './dependencies.mjs';
await prepareDependencies();
const {build}=await import(pathToFileURL(requireHost.resolve('tsdown')));
await mkdir(join(root,'lib'),{recursive:true});
await build({config:false,entry:{index:join(root,'src/index.ts')},outDir:join(root,'lib'),platform:'node',format:'esm',clean:true,dts:false,
  deps:{neverBundle:[/^@deepseek-ai\//],alwaysBundle:['@software-factory/runtime-sdk']},outputOptions:{entryFileNames:'[name].js'}});
await cp(join(root,'../server/src'),join(root,'server/src'),{recursive:true,filter:path=>!path.includes('__pycache__')});
await cp(join(root,'../server/requirements.txt'),join(root,'server/requirements.txt'));
await writeFile(join(root,'README.md'),await readFile(join(root,'../README.md'),'utf8'));
console.log('Built Run backend plugin and copied original Python algorithms.');
