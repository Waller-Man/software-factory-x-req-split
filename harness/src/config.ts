import z from '@deepseek-ai/schemastery';
import type {Volatile} from '@deepseek-ai/cordis';

export const pluginVersion='0.4.1';
export type ModelOutput='prompt'|'json-chat'|'json-responses';
export interface Options {
  pythonPath:string;port:number;startupTimeoutMs:number;graceMs:number;
  ocrEnabled:boolean;maxSourceMb:number;splitMaxChars:number;ocrDpi:number;
  ocrMaxPages:number;ocrTimeout:number;ocrMaxRetries:number;ocrMinConfidence:number;
  modelOutput:ModelOutput;
}
export type LiveOptions={[K in keyof Options]:Volatile<Options[K]>};
export const Config=z.object({
  pythonPath:z.string().default('').description('Python 解释器绝对路径；留空使用包内 server/.venv。').volatile(),
  port:z.number().step(1).min(0).max(65535).default(0).description('后端端口，0 表示自动分配。').volatile(),
  startupTimeoutMs:z.number().step(1).min(1000).max(120000).default(30000).description('后端就绪检查超时，毫秒。').volatile(),
  graceMs:z.number().step(1).min(100).max(30000).default(3000).description('自有进程退出宽限，毫秒。').volatile(),
  ocrEnabled:z.boolean().default(true).description('启用本地 RapidOCR，不切换外部 OCR。').volatile(),
  maxSourceMb:z.number().step(1).min(1).max(200).default(200).description('文档大小上限，MB。').volatile(),
  splitMaxChars:z.number().step(1).min(1000).max(2000000).default(120000).description('进入语义拆分的文本长度上限。').volatile(),
  ocrDpi:z.number().step(1).min(72).max(600).default(180).description('PDF OCR 渲染 DPI。').volatile(),
  ocrMaxPages:z.number().step(1).min(1).max(10000).default(50).description('PDF OCR 最大处理页数。').volatile(),
  ocrTimeout:z.number().min(1).max(3600).default(60).description('单页 OCR 超时，秒。').volatile(),
  ocrMaxRetries:z.number().step(1).min(0).max(5).default(1).description('OCR 额外重试次数。').volatile(),
  ocrMinConfidence:z.number().min(0).max(1).default(0.5).description('OCR 最低置信度。').volatile(),
  modelOutput:z.union(['prompt','json-chat','json-responses']).default('prompt').description('兼容模式，或通过 Runtime 0.3.0 网关请求 JSON 对象。').volatile(),
});
/** Read once before the first await of a task. No live value escapes into Python. */
export function snapshotConfig(config:LiveOptions):Readonly<Options>{
  return Object.freeze(Object.fromEntries(Object.entries(config).map(([key,value])=>[key,value.get()])) as unknown as Options);
}
