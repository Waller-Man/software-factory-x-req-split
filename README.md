# 需求文档拆分

在 DSH 网页中提交需求文档或文本，通过软件工厂 Run 执行原有转换与需求拆分算法，生成需求 ZIP 和汇总 Markdown，保留本地 RapidOCR 及中间材料。

| 项目 | 说明 |
|---|---|
| 插件版本 | 0.3.0 |
| 包名 / 插件条目 | `x-dsh` / `x-req-split` |
| 业务入口 | `split_requirement_document` |
| 输入 | PDF、DOCX、XLSX、XLSM 或需求文本 |
| 输出 | 需求 ZIP、汇总 Markdown、结构化结果 |

## 环境与依赖

| 组件 | 要求 |
| --- | --- |
| DSH | `0.2.1-alpha.2`，提供 Tool 和子进程管理服务 |
| Cordis / Node.js | `4.0.5-alpha.1` / Node.js 24+ |
| 软件工厂 Runtime | `0.1.0`，先安装并启用，提供 `sfRuntime` 服务 |
| Python | 建议 3.12，需可用的 venv 和 pip |
| 文档依赖 | PyMuPDF、pymupdf4llm、python-docx、openpyxl、Pillow |
| 后端与 OCR | FastAPI、uvicorn、httpx、rapidocr-onnxruntime；详见 `server/requirements.txt` |

DSH 中还需配置可用模型，并选择可写工作区。本插件通过 DSH 调用模型，无需单独配置 Python 模型 API Key；仅转换模式不需要模型。

## 新环境快速安装

以下步骤使用维护者提供的完整发布包，在 **运行 DSH 的电脑**上执行。从 Git 克隆源码时，先完成文末“从源码构建”，再执行本节。

### 1. 准备插件文件

将 Runtime 和本插件发布包解压到长期保留的目录，例如：

```text
D:\DSH-plugins\software-factory-runtime\
D:\DSH-plugins\x-dsh\
```

两个目录无需相邻。每个安装目录应直接包含 `package.json` 和 `cordis.patch.yml`；多了一层文件夹时进入内层。本插件目录还应有 `lib/`、`scripts/prepare-python.mjs`、`server/src/` 和 `server/requirements.txt`。

本插件交付包为 `x-dsh-0.3.0.zip` 或 `x-dsh-0.3.0.tgz`，使用 TGZ 时同样先解压。新电脑使用预编译包无需构建 TypeScript 或单独安装 SDK；**发布包不含 Python 环境，需要完成下一步**。尚未发布 Release 时，请联系维护者获取完整发布包。

### 2. 准备 Python 环境

在 PowerShell 中执行，将插件目录和基础 Python 路径替换为本机实际位置：

```powershell
Set-Location 'D:\DSH-plugins\x-dsh'
$env:PYTHON = 'C:\Python312\python.exe'
node .\scripts\prepare-python.mjs
```

脚本会在插件目录创建 `server/.venv`，安装 `server/requirements.txt` 中的依赖并检查导入，需要能访问 Python 包源。**无需再手工执行 pip install，也无需激活 venv。** 新电脑重新创建环境，不复制旧电脑的 `.venv`。

看到以下输出且命令成功结束，表示环境准备通过，可以继续安装：

```text
Python environment ready
Prepared interpreter: <实际解释器绝对路径>
```

默认使用包内 `server/.venv`，**无需填写 `pythonPath`**。若不知道基础 Python 路径，安装了 Windows Python Launcher 时可执行：

```powershell
py -3.12 -c "import sys; print(sys.executable)"
```

Linux 先准备 Python 3.12 及对应的 venv/pip 组件，再在解压目录执行：

```bash
cd /opt/dsh-plugins/x-dsh
export PYTHON=/usr/bin/python3.12
node scripts/prepare-python.mjs
```

路径按实际位置调整；脚本通过环境变量 `PYTHON` 选择基础解释器，不使用命令行位置参数。如出现 pip 或导入错误，先解决错误再继续。

### 3. 在 DSH 中安装

1. 打开 DSH 网页，进入 **插件 → 添加插件 → 安装第三方插件**。
2. 安装来源填写 Runtime 的完整目录路径，按提示安装并启用。
3. 同样填写本插件目录，例如 `D:\DSH-plugins\x-dsh`，安装并启用组合包及 `x-req-split` 插件条目。
4. 保持默认配置，确认没有激活错误；管理器提示需要重启时，重启原 DSH 服务。

两个插件应安装在同一个 DSH 网页所管理的配置环境中。安装来源是**包含 `package.json` 的目录**；无需查询内部 profile 或 node_modules 路径。本地目录安装后，不要删除、移动或改名。

浏览器与 DSH 在两台电脑上时，安装路径指 **DSH 所在电脑**的目录，浏览器不会上传本机目录。安装器仍可能解析包依赖，不承诺完全离线安装。

按上述步骤准备环境后，`pythonPath` 留空，端口等配置保持默认即可。仅在使用外部虚拟环境时，在 DSH 插件原生配置中将 `pythonPath` 改为该环境解释器的绝对路径。无需手改 YAML 或填写 Tool 允许名单。

### 4. 日常启动

**只启动 DSH，不需要手动启动 Python、uvicorn 或 run.sh，也无需每次运行环境准备脚本。** 本插件启用时自动启动一个受管 Python HTTP 后端，通过健康和就绪检查后登记入口，多次任务复用该后端。

若使用 DSH 源码部署，在已准备好自身依赖的 **DSH 主项目目录**执行：

```powershell
Set-Location 'D:\work\DSH-Softwarefactory'
pnpm.cmd dsh web
```

路径替换为本机 DSH 主项目位置，不在本插件目录运行。Linux 使用 `pnpm dsh web`；已有 DSH 服务沿用其正常启动方式。

## 使用

在 DSH 网页选择一个可写工作区，进入普通聊天。

### 检查安装

向 DSH 发送：

> 请调用 sf_runtime_get_tool_contract，参数为 {"toolId":"split_requirement_document"}。仅检查接口，不启动任务。

返回 `supportsRun: true` 表示入口支持 Run。这一步不执行转换或拆分，也不能证明任务目录可写。

### 启动任务

要求 DSH 调用 `sf_runtime_run_tool`，将以下示例文本替换为实际需求：

```json
{
  "toolId": "split_requirement_document",
  "input": {
    "text": "# 订单查询\n用户可以查看订单状态。",
    "title": "订单需求",
    "mode": "split"
  }
}
```

处理文档时，将 `text` 替换为 `path`，填写 **DSH 服务端当前工作区内**文档的绝对路径；`text` 和 `path` 二选一。`title` 可省略，`mode` 默认为 `split`。

首次检查可将 `mode` 改为 `convert`，仅转换、不调用模型。成功受理后返回 `runId`，查询至 `completed` 并成功下载 ZIP，才表示转换和交付链验证通过。

默认使用发起聊天的模型。如需单独指定，在启动参数顶层增加 `"model": {"provider":"实际提供方ID","model":"实际模型ID"}`。模型必须已在 DSH 中配置；任务启动后固定使用该模型，主聊天模型不会被切换。

### 查看结果或取消任务

将下面的 ID 替换为任务返回的实际值：

| 操作 | Tool | 参数 |
|---|---|---|
| 查看状态和结果 | `sf_runtime_get_run` | `{"runId":"任务ID"}` |
| 等待任务更新 | `sf_runtime_wait_run` | `{"runId":"任务ID","waitMs":15000}` |
| 获取文件下载链接 | `sf_runtime_get_artifact` | `{"runId":"任务ID","artifactId":"文件ID"}` |
| 取消任务 | `sf_runtime_cancel_run` | `{"runId":"任务ID"}` |

文件 ID 从查询结果的 `result.files` 各项的 `artifactId` 获取。主要下载项为需求 ZIP 和汇总 Markdown，下载经过 DSH 认证；所有业务执行均通过 Run 发起，不直接调用业务 Tool。

## 交付文件

| 文件（相对任务的 `final/` 目录） | 内容 |
|---|---|
| `requirements.zip` | 最终结果整包，包含需求目录、Markdown、图片、报告及结构化结果，保留图片相对引用 |
| `requirements/final.md` | 汇总 Markdown，可单独下载 |
| `result.json` | 结构化处理结果 |

文件保存在发起聊天所属工作区：

```text
<工作区>/outputs/runs/<runId>/
```

最终文件位于 `final/`，转换结果、图片、模型往返及快照保存在 `intermediate/`、`snapshots/` 等目录。ZIP 只打包最终结果；失败或取消后保留已有材料，不自动删除。主要下载项为 ZIP 和汇总 Markdown，其余已登记文件从任务的 `artifacts` 查询。

## 常见问题

| 问题 | 处理方法 |
|---|---|
| 找不到 Run 工具或业务入口 | 确认 Runtime 和 `x-req-split` 已在同一 DSH 配置环境启用，检查插件激活错误 |
| Python 不存在或缺依赖 | 在实际插件目录重跑准备脚本；使用外部环境时核对 `pythonPath` |
| `BACKEND_START_FAILED` | 查看错误中的 Python 日志，检查依赖及端口；通常保持 `port: 0` |
| `MODEL_REQUIRED` / `MODEL_UNAVAILABLE` | 检查 DSH 模型配置及模型 ID，或先用 `mode: convert` 验证 |
| `SOURCE_PATH` / `INVALID_INPUT` | 使用服务端当前工作区内的文档绝对路径；`path` 和非空 `text` 二选一 |
| 工作区或目录写入失败 | 选择可写工作区，检查 DSH 服务账户的现有权限 |
| 更新后仍执行旧代码 | 按插件管理器提示完整重启原 DSH 服务；仅刷新网页或切换启用开关可能不足 |

## 从源码构建

Git 源码不包含 `lib/`、`dist/`、虚拟环境或本地 Skill，不能直接当预编译插件安装。需要 Node.js 24+、可用的 `tar`，以及一份兼容且已按自身说明准备好依赖的 **DSH 源码**；当前构建会复用其中的 TypeScript、tsdown 和宿主依赖。

在本插件仓库根目录执行，路径按实际位置替换：

```powershell
Set-Location 'D:\work\x-req-split'
$env:DSH_SOURCE = 'D:\work\DSH-Softwarefactory'
node harness/scripts/typecheck.mjs
node harness/scripts/build.mjs
New-Item -ItemType Directory -Force dist | Out-Null
Set-Location harness
npm.cmd pack --pack-destination ../dist
```

未设置 `DSH_SOURCE` 时默认寻找相邻的 `DSH-Softwarefactory`。SDK 原 TGZ 已保存在 `harness/vendor/`；无需用通用 `npm install` 代替上述构建流程。Linux 使用 `export DSH_SOURCE=/实际/DSH源码路径`、相同的 Node 命令、`mkdir -p dist` 和 `npm pack`。

构建成功会输出 `Built Run backend plugin and copied original Python algorithms.`，生成 `harness/lib/index.js`、`harness/server/` 等运行文件；打包成功生成 `dist/x-dsh-0.3.0.tgz`，不会自动生成 ZIP。

可以直接将构建后的 **`harness/` 目录**作为前述插件安装目录，也可以解压 TGZ 后使用其中包含 `package.json` 的目录。随后按“新环境快速安装”准备该目录的 Python 环境并安装；构建和打包不会创建 venv 或安装 Runtime。更新已安装的源码目录前，应结束任务并停用插件。
