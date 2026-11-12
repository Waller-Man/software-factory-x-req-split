// A native DSH plugin-detail form. Configuration storage and React belong to DSH.
window.__ModuleLoader__.load({
  id: 'x-dsh',
  factory(require) {
    const React = require('react'), h = React.createElement;
    const words = {
      zh: {
        title: '需求拆分配置', summary: 'Python、本地 OCR 和模型 JSON 输出设置',
        intro: '通常保留默认值即可。保存后用于新任务，运行中的任务保留原配置。无需修改配置文件。',
        pythonPath: 'Python 解释器路径（留空使用包内环境）', ocrEnabled: '启用本地 RapidOCR',
        modelOutput: '模型输出模式', prompt: '兼容模式：沿用原提示词及 JSON 解析',
        'json-chat': 'JSON 对象：Chat Completions 协议', 'json-responses': 'JSON 对象：Responses 协议',
        modelHint: '模型由 Run 选择。本设置不会切换主聊天模型。JSON 模式需 Runtime 0.3.0 和匹配的 API Key 连接；Messages（包括当前 deepseek-official）请用兼容模式。不会自动转换协议或回退模型。',
        advanced: '高级处理设置', maxSourceMb: '文档大小上限（MB）', splitMaxChars: '语义拆分文本长度上限',
        ocrDpi: 'PDF OCR 渲染 DPI', ocrMaxPages: 'OCR 最大页数', ocrTimeout: '单页 OCR 超时（秒）',
        ocrMaxRetries: 'OCR 额外重试次数', ocrMinConfidence: 'OCR 最低置信度（0–1）',
        port: '后端端口（0 自动分配）', startupTimeoutMs: '后端启动超时（毫秒）', graceMs: '进程退出宽限（毫秒）',
        backendHint: '更改 Python 或 OCR 设置后，新任务使用新后端；旧任务结束后清理旧实例。初次启动失败可在此修正设置并保存后重试，错误见 DSH 日志，后端就绪前不开放业务工具。建议端口保持 0。此表单不安装 Python 依赖。',
        save: '保存配置', saving: '正在保存…', discard: '放弃修改', saved: '已保存，无需重启；后续任务使用新设置。',
        loading: '正在读取配置…', unavailable: '未读取到本插件的配置定义。若插件已启用，请确认前后端来自同一完整发布包，并按管理器提示重启 DSH；源码安装需先构建 lib。', readOnly: '当前连接没有保存权限。',
        invalid: '请检查路径、模式及数值范围，整数项不可填写小数。', failed: '保存失败，请检查服务端提示。',
        conflict: '配置已在其他页面修改，请放弃修改后重新填写。', dirty: '有未保存的修改',
      },
      en: {
        title: 'Requirement split settings', summary: 'Python, local OCR and model JSON output settings',
        intro: 'Defaults usually suffice. Saved settings apply to new tasks. Running tasks retain their snapshot. No configuration file edits are needed.',
        pythonPath: 'Python executable (blank uses the bundled environment)', ocrEnabled: 'Enable local RapidOCR',
        modelOutput: 'Model output mode', prompt: 'Compatibility: original prompts and JSON parser',
        'json-chat': 'JSON object: Chat Completions', 'json-responses': 'JSON object: Responses',
        modelHint: 'Run selects the model. This never changes the chat model. JSON mode requires Runtime 0.3.0 and a matching API Key connection. Use compatibility mode for Messages, including the current deepseek-official route. No protocol conversion or model fallback.',
        advanced: 'Advanced processing settings', maxSourceMb: 'Document limit (MB)', splitMaxChars: 'Semantic split character limit',
        ocrDpi: 'PDF OCR render DPI', ocrMaxPages: 'OCR page limit', ocrTimeout: 'OCR timeout per page (seconds)',
        ocrMaxRetries: 'Extra OCR retries', ocrMinConfidence: 'Minimum OCR confidence (0–1)',
        port: 'Backend port (0 selects a free port)', startupTimeoutMs: 'Backend startup timeout (ms)', graceMs: 'Process shutdown grace (ms)',
        backendHint: 'New tasks use the updated Python/OCR backend; older instances retire after their tasks finish. Fix and save settings here after initial startup fails; check DSH logs for errors. The business tool remains unavailable until readiness succeeds. Prefer port 0. This form does not install Python dependencies.',
        save: 'Save settings', saving: 'Saving…', discard: 'Discard changes', saved: 'Saved without restarting. New tasks use these settings.',
        loading: 'Loading settings…', unavailable: 'This plugin’s configuration schema is unavailable. If enabled, use the Host and Client from the same complete release and restart DSH when prompted. Source installations must build lib first.', readOnly: 'This connection cannot save settings.',
        invalid: 'Check paths, output mode and numeric ranges. Integer fields cannot contain fractions.', failed: 'Could not save. Check the server message.',
        conflict: 'Another page changed these settings. Discard changes and edit again.', dirty: 'Unsaved changes',
      },
    };
    const numbers = {
      port: [0, 65535, 1], startupTimeoutMs: [1000, 120000, 1], graceMs: [100, 30000, 1],
      maxSourceMb: [1, 200, 1], splitMaxChars: [1000, 2000000, 1], ocrDpi: [72, 600, 1],
      ocrMaxPages: [1, 10000, 1], ocrTimeout: [1, 3600, 'any'], ocrMaxRetries: [0, 5, 1], ocrMinConfidence: [0, 1, 'any'],
    };
    const format = value => Object.fromEntries(Object.entries(value).map(([key, v]) => [key, key in numbers ? String(v) : v]));
    function Settings({ scope, t }) {
      const observer = React.useMemo(() => ({ subscribe: fn => scope.subscribe(fn), get: () => scope.getSnapshot() }), [scope]);
      const state = React.useSyncExternalStore(observer.subscribe, observer.get, observer.get);
      const [draft, setDraft] = React.useState(null), [baseline, setBaseline] = React.useState(null);
      const [revision, setRevision] = React.useState(), [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState(''), [notice, setNotice] = React.useState('');
      const id = React.useId(), dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(baseline);
      const conflict = dirty && revision !== state.revision;
      React.useEffect(() => {
        if (state.status === 'ready' && state.value && !dirty && !saving) {
          const next = format(state.value); setDraft(next); setBaseline(next); setRevision(state.revision);
        }
      }, [state.status, state.value, state.revision, dirty, saving]);
      const disabled = saving || !state.writable || state.status !== 'ready';
      function edit(key, value) { setDraft(previous => ({ ...previous, [key]: value })); setError(''); setNotice(''); }
      function discard() {
        const current = scope.getSnapshot(); if (!current.value) return;
        const next = format(current.value); setDraft(next); setBaseline(next); setRevision(current.revision); setError(''); setNotice('');
      }
      async function save(event) {
        event.preventDefault(); if (disabled || !dirty || conflict) return;
        const value = { ...draft, pythonPath: draft.pythonPath.trim() };
        for (const [key, [min, max, step]] of Object.entries(numbers)) {
          const n = Number(draft[key]);
          if (!String(draft[key]).trim() || !Number.isFinite(n) || n < min || n > max || (step === 1 && !Number.isInteger(n))) { setError(t('invalid')); return; }
          value[key] = n;
        }
        if (!['prompt', 'json-chat', 'json-responses'].includes(value.modelOutput)) { setError(t('invalid')); return; }
        setSaving(true); setError(''); setNotice('');
        try {
          const ops = Object.entries(value).filter(([key]) => draft[key] !== baseline[key]).map(([key, v]) => ({ op: 'set', path: [key], value: v }));
          const accepted = await scope.mutate(ops, revision);
          if (accepted) { const current = scope.getSnapshot(), next = format(current.value ?? value); setDraft(next); setBaseline(next); setRevision(current.revision); setNotice(t('saved')); }
          else setError(t(scope.getSnapshot().revision !== revision ? 'conflict' : 'failed'));
        } catch { setError(t('failed')); }
        finally { setSaving(false); }
      }
      function field(key) {
        const [min, max, step] = numbers[key];
        return h('label', { key, htmlFor: id + key }, t(key), h('input', { id: id + key, name: key, type: 'number', min, max, step,
          value: draft[key], disabled, onChange: event => edit(key, event.target.value) }));
      }
      return h('form', { className: 'req-split-settings', onSubmit: save, noValidate: true },
        h('style', null, '.req-split-settings{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary)}.req-split-settings label{display:block;margin:10px 0}.req-split-settings input:not([type=checkbox]),.req-split-settings select{display:block;box-sizing:border-box;width:100%;margin-top:6px;padding:8px;background:var(--dsw-alias-bg-layer-3);color:inherit;border:1px solid var(--dsw-alias-border-l3);border-radius:6px}.req-split-settings p{font-size:13px;color:var(--dsw-alias-label-secondary)}.req-split-settings footer{display:flex;gap:12px}.req-split-settings button{padding:8px 12px}.req-split-settings button:disabled{opacity:.45}.req-split-settings [role=alert]{color:var(--dsw-alias-label-error)}'),
        h('header', null, h('h4', null, t('title')), h('p', null, t('intro'))),
        state.status !== 'ready' || !draft ? h('p', { role: 'status' }, t(state.status === 'loading' ? 'loading' : 'unavailable')) : h(React.Fragment, null,
          !state.writable && h('p', { role: 'status' }, t('readOnly')),
          h('label', { htmlFor: id + 'pythonPath' }, t('pythonPath'), h('input', { id: id + 'pythonPath', name: 'pythonPath', value: draft.pythonPath, disabled, onChange: event => edit('pythonPath', event.target.value) })),
          h('label', null, h('input', { name: 'ocrEnabled', type: 'checkbox', checked: draft.ocrEnabled, disabled, onChange: event => edit('ocrEnabled', event.target.checked) }), ' ', t('ocrEnabled')),
          h('label', { htmlFor: id + 'modelOutput' }, t('modelOutput'), h('select', { id: id + 'modelOutput', name: 'modelOutput', value: draft.modelOutput, disabled, onChange: event => edit('modelOutput', event.target.value) },
            ...['prompt', 'json-chat', 'json-responses'].map(value => h('option', { key: value, value }, t(value))))), h('p', null, t('modelHint')),
          h('details', null, h('summary', null, t('advanced')), ...Object.keys(numbers).map(field), h('p', null, t('backendHint'))),
          (error || conflict) && h('p', { role: 'alert' }, error || t('conflict')),
          h('footer', null, h('button', { type: 'submit', disabled: disabled || !dirty || conflict }, t(saving ? 'saving' : 'save')),
            h('button', { type: 'button', disabled: saving || !dirty, onClick: discard }, t('discard'))),
          h('p', { role: 'status' }, notice || (dirty ? t('dirty') : ''))));
    }
    function Configuration({ view, t, ...props }) { return view === 'summary' ? t('summary') : h(Settings, { ...props, t }); }
    return { inject: ['slots', 'locale', 'configForms'], apply(ctx) {
      ctx.effect(() => ctx.locale.register('reqSplitSettings', words));
      const scope = ctx.configForms.get('x-req-split');
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'x-dsh',
        locale: 'reqSplitSettings', inject: () => ({ scope }) }, Configuration));
    } };
  },
});
