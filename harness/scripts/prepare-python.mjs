/** Explicit installation-time preparation. Never imported by the plugin runtime. */
import {spawnSync} from 'node:child_process';
import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const server=fileURLToPath(new URL('../server/',import.meta.url));
// This script is shipped in scripts/; the payload is ../server/.
const venv=join(server,'.venv'),python=join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
function run(command,args){const result=spawnSync(command,args,{stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)throw new Error('Python preparation failed');}
await access(join(server,'requirements.txt')).catch(()=>{throw new Error('先执行 npm run build，或在已安装的插件包中准备环境。');});
try{await access(python);}catch{run(process.env.PYTHON??(process.platform==='win32'?'python':'python3'),['-m','venv',venv]);}
run(python,['-m','pip','install','--disable-pip-version-check','-r',join(server,'requirements.txt')]);
run(python,['-c','import fastapi,uvicorn,httpx,pymupdf,pymupdf4llm,docx,openpyxl,PIL,rapidocr_onnxruntime; print("Python environment ready")']);
console.log('Prepared interpreter:',python);
