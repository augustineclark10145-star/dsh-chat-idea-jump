/**
 * @local/chat-idea-jump — client 半 v3。
 *
 * 核心策略：不猜 DSH 内部渲染（芯片不是锚点、openFile 在 React 内部），
 * 改为按「元素文本长得像文件引用」识别：正文里任何短文本元素匹配
 *   文件名.扩展名[:行号]  →  点击弹选择框
 *   「IDEA 打开」   → POST {path,line}，host 按文件名在项目里搜索定位
 *   「右侧栏打开」  → 回放原始点击，走 DSH 原生流程（已验证可用）
 * 保留：openResource 包装、真锚点拦截、官方右键菜单（file 目标）三路兜底。
 */
window.__ModuleLoader__.load({
	id: '@local/chat-idea-jump',
	factory(require) {
		const React = require('react');
		const E = React.createElement;
		const FILE_PREFIX = 'dsh-resource://file/';
		const EXT = new Set(['java','ts','tsx','js','jsx','mjs','cjs','vue','py','md','sql','xml','yml','yaml','json','properties','html','css','scss','less','kt','go','rb','c','h','cpp','hpp','sh','bat','ps1','txt','gradle','toml','ini','conf','env','proto','graphql','log','lock','csv','iml','bak']);
		/**
		 * 元素文本 → {path,line,lineEnd}。
		 * 路径字符放宽到任意非空白（支持中文/括号/盘符），扩展名白名单把门；
		 * 无扩展名但带行号的（如 mgr-启动日志:6653-7408）要求名字含连字符或中文，防误伤。
		 */
		function parseFileText(raw) {
			const text = String(raw ?? '').trim();
			if (!text || text.length > 160) return null;
			let path, line, lineEnd;
			const withExt = text.match(/^[@#~"'\s]*([^\s]+?)\.([A-Za-z0-9]{1,6})(?:[:：]+(\d+))?(?:\s*[-–~]\s*(\d+))?\s*$/u);
			const noExt = text.match(/^[@#~"'\s]*([^\s:：]+?)[:：](\d+)(?:\s*[-–~]\s*(\d+))?\s*$/u);
			if (withExt) {
				path = `${withExt[1]}.${withExt[2]}`;
				const ext = withExt[2].toLowerCase();
				if (!EXT.has(ext)) return null;
				line = withExt[3] ? +withExt[3] : null;
				lineEnd = withExt[4] ? +withExt[4] : null;
				if (line == null && lineEnd != null) { line = lineEnd; lineEnd = null; }
			} else if (noExt) {
				path = noExt[1];
				line = +noExt[2];
				lineEnd = noExt[3] ? +noExt[3] : null;
				if (!/[-\u4e00-\u9fa5]/.test(path)) return null; // redis:20001 这类不放行
			} else {
				return null;
			}
			path = path.replace(/^["'@#~]+/, '').trim();
			if (!path) return null;
			return { path, line, lineEnd };
		}

		/**
		 * 锚点 href → 目标。支持 DSH 资源地址和 file:///C:/... 绝对路径，
		 * 后者的路径是准的，绝不能再退化成按文件名搜。
		 */
		function parseFileHref(href) {
			const raw = String(href ?? '');
			const m = raw.match(/#L(\d+)(?:-L?(\d+))?/);
			const line = m ? +m[1] : null;
			const lineEnd = m && m[2] ? +m[2] : null;
			if (raw.startsWith(FILE_PREFIX)) return { address: raw, line, lineEnd };
			if (!/^file:\/\//i.test(raw)) return null;
			try {
				const url = new URL(raw);
				let p = decodeURIComponent(url.pathname);
				if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
				if (url.host) p = `//${url.host}${p}`;
				p = p.replace(/\//g, '\\');
				return { path: p, line, lineEnd };
			} catch {
				return null;
			}
		}

		function svc(ctx, key) {
			try {
				const s = ctx?.get?.(key);
				if (s !== undefined && s !== null) return s;
			} catch { /* 某些宿主对未知 key 会抛错 */ }
			return ctx?.[key];
		}

		/** 当前在屏会话 id（双探测：sessions.current → DOM 属性），来自 sidenote 的成熟做法 */
		function currentSessionIdOf(ctx) {
			try {
				const current = ctx.sessions?.list?.getSnapshot?.().current;
				if (typeof current === 'string' && current !== '') return current;
			} catch { /* 旧版无 current 字段 */ }
			try {
				return document.querySelector('[data-conversation-session]')?.dataset?.conversationSession ?? '';
			} catch { return ''; }
		}

		function basenameOf(address) {
			try {
				const end = address.search(/[?#]/);
				const body = address.slice(FILE_PREFIX.length, end === -1 ? undefined : end);
				const parts = body.split('/').filter(Boolean).map(decodeURIComponent);
				return parts.length ? parts[parts.length - 1] : '';
			} catch { return ''; }
		}

		function toast(text, bad) {
			const t = document.createElement('div');
			t.textContent = text;
			t.style.cssText = [
				'position:fixed', 'left:50%', 'bottom:28px', 'transform:translateX(-50%)',
				'z-index:2147483647', 'padding:8px 14px', 'border-radius:8px', 'font-size:12.5px',
				'font-family:inherit', 'pointer-events:none', 'max-width:70vw', 'overflow:hidden',
				'text-overflow:ellipsis', 'white-space:nowrap',
				`background:${bad ? '#b3261e' : 'var(--dsw-alias-bg-layer-2, #1f2328)'}`,
				`color:${bad ? '#fff' : 'var(--dsw-alias-label-primary, #eee)'}`,
				'box-shadow:0 4px 16px rgba(0,0,0,.25)',
			].join(';');
			document.body.appendChild(t);
			setTimeout(() => t.remove(), 3200);
		}

		async function ideaOpen(payload) {
			try {
				const res = await fetch('/api/chat-idea-jump/open', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});
				const data = await res.json().catch(() => ({}));
				if (data.ok) toast(`已在 IDEA 打开 ${data.file}${data.line ? `:${data.line}` : ''}`);
				else toast(`IDEA 打开失败：${data.error || res.status}`, true);
			} catch (error) {
				toast(`请求失败：${String(error?.message ?? error)}`, true);
			}
		}

		function buildMenu() {
			const m = document.createElement('div');
			m.style.cssText = [
				'position:fixed', 'z-index:2147483647', 'min-width:210px',
				'background:var(--dsw-alias-bg-layer-2, #fff)',
				'color:var(--dsw-alias-label-primary, #222)',
				'border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
				'border-radius:10px', 'padding:6px', 'font-size:13px', 'font-family:inherit',
				'box-shadow:0 8px 28px rgba(0,0,0,.22)', 'user-select:none',
			].join(';');
			return m;
		}

		function menuItem(m, label, hint, onClick, primary) {
			const b = document.createElement('button');
			b.textContent = label;
			b.style.cssText = [
				'display:flex', 'align-items:center', 'justify-content:space-between', 'gap:10px',
				'width:100%', 'padding:7px 10px', 'margin:1px 0', 'border:none', 'border-radius:7px',
				'cursor:pointer', 'font-size:13px', 'font-family:inherit', 'text-align:left',
				'background:transparent', 'color:inherit',
				primary ? 'font-weight:600' : '',
			].join(';');
			b.addEventListener('mouseenter', () => { b.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))'; });
			b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
			if (hint) {
				const h = document.createElement('span');
				h.textContent = hint;
				h.style.cssText = 'font-size:11px;opacity:.6;white-space:nowrap';
				b.appendChild(h);
			}
			b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
			m.appendChild(b);
		}

		return {
			inject: ['sessions', 'slots', 'configForms', 'contextMenus', 'sidebarRight'],
			apply(ctx) {
				let menu = null;
				let cleanups = [];
				let lastMouse = { x: 200, y: 200 };

				document.addEventListener('mousemove', (e) => { lastMouse = { x: e.clientX, y: e.clientY }; }, { passive: true });

				function closeMenu() {
					if (menu) { menu.remove(); menu = null; }
					for (const fn of cleanups) { try { fn(); } catch { /* 忽略 */ } }
					cleanups = [];
				}

				function showChooser(x, y, title, actions) {
					closeMenu();
					menu = buildMenu();
					const head = document.createElement('div');
					head.textContent = title;
					head.style.cssText = 'padding:5px 10px 7px;font-size:11px;opacity:.55;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
					menu.appendChild(head);
					for (const [label, hint, fn, primary] of actions) menuItem(menu, label, hint, () => { closeMenu(); fn(); }, primary);
					document.body.appendChild(menu);
					const r = menu.getBoundingClientRect();
					menu.style.left = `${Math.min(Math.max(8, x), window.innerWidth - r.width - 12)}px`;
					menu.style.top = `${Math.min(Math.max(8, y + 6), window.innerHeight - r.height - 12)}px`;
					const onDocDown = (ev) => { if (menu && !menu.contains(ev.target)) closeMenu(); };
					const onKey = (ev) => { if (ev.key === 'Escape') closeMenu(); };
					const onScroll = () => closeMenu();
					document.addEventListener('mousedown', onDocDown, true);
					document.addEventListener('keydown', onKey, true);
					window.addEventListener('scroll', onScroll, true);
					cleanups = [
						() => document.removeEventListener('mousedown', onDocDown, true),
						() => document.removeEventListener('keydown', onKey, true),
						() => window.removeEventListener('scroll', onScroll, true),
					];
				}

				/** 右侧栏打开：优先用锚点原地址；只有纯文本/绝对路径才回 host 解析后拼地址。 */
				async function openRight(info) {
					try {
						let address = info.address || '';
						if (!address) {
							const sid = currentSessionIdOf(ctx);
							const res = await fetch('/api/chat-idea-jump/resolve', {
								method: 'POST', headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ path: info.path, sessionId: sid }),
							});
							const data = await res.json().catch(() => ({}));
							if (!data.ok) { toast(`右侧栏打开失败：${data.error || res.status}`, true); return; }
							const abs = String(data.file).replace(/\\/g, '/');
							const encodeSeg = (s) => encodeURIComponent(s).replace(/%3A/gi, ':');
							if (/^[A-Za-z]:\//.test(abs)) {
								address = FILE_PREFIX + 'absolute/' + abs.split('/').map(encodeSeg).join('/');
							} else {
								if (!sid) { toast('拿不到当前会话 id，无法定位侧栏', true); return; }
								address = FILE_PREFIX + 'session/' + encodeURIComponent(sid) + '/' + abs.split('/').map(encodeSeg).join('/');
							}
						}
						const sidebar = svc(ctx, 'sidebarRight');
						const origOpen = sidebar?.__cijOrig ?? sidebar?.openResource?.bind(sidebar);
						if (typeof origOpen !== 'function') { toast('右侧栏服务不可用', true); return; }
						origOpen(address, { params: info.line ? { line: info.line } : undefined, revealIfOpened: true });
					} catch (error) {
						toast(`右侧栏打开失败：${String(error?.message ?? error)}`, true);
					}
				}

				/** 主路径：文本模式识别。返回 true 表示已拦截。 */
				function tryTextIntercept(e) {
					if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
					const sel = window.getSelection?.();
					if (sel && !sel.isCollapsed) return false; // 正在选中文本不拦
					let el = e.target;
					if (!el || el.nodeType !== 1) return false;
					if (el.closest?.('input,textarea,[contenteditable="true"],[contenteditable=""]')) return false;
					// 找最近的短文本可点容器：DSH 引用芯片 → 链接/按钮/行内代码/普通 span
					el = el.closest?.('[data-ref-chip]') || el.closest?.('a,button,[role="button"],code,span') || el;
					if (!el || !el.isConnected) return false;
					// ReferenceChip 把原始引用放在 title 里（常是 file:///C:/... 绝对路径），优先用它
					let info = null;
					const titleAttr = el.getAttribute?.('title') || '';
					if (titleAttr) {
						info = parseFileHref(titleAttr);
						if (!info) {
							const urlText = titleAttr.match(/file:\/\/[^\s)\]"']+/i)?.[0];
							if (urlText) info = parseFileHref(urlText);
						}
						if (!info) info = parseFileText(titleAttr);
					}
					const textInfo = parseFileText(el.textContent);
					if (!info) info = textInfo;
					else if (info.line == null && textInfo?.line) { info.line = textInfo.line; info.lineEnd = textInfo.lineEnd; }
					if (!info) return false;
					e.preventDefault();
					e.stopPropagation();
					const title = `${info.path}${info.line ? `:${info.line}${info.lineEnd ? `-${info.lineEnd}` : ''}` : ''}`;
					showChooser(e.clientX, e.clientY, title, [
						['IDEA 打开', info.line ? `--line ${info.line}` : '', () => {
							void ideaOpen({ path: info.path, line: info.line, lineEnd: info.lineEnd, sessionId: currentSessionIdOf(ctx) });
						}, true],
						['右侧栏打开', info.line ? `定位 ${info.line} 行` : '', () => { void openRight({ path: info.path, line: info.line }); }],
					]);
					return true;
				}

				/** 锚点路径：DSH 资源链接或 file:/// 绝对路径 */
				function tryAnchorIntercept(e) {
					const a = e.target?.closest?.('a[href]');
					if (!a) return false;
					const href = a.getAttribute('href');
					const info = parseFileHref(href);
					if (!info) return false;
					if (info.line == null) {
						const textInfo = parseFileText(a.textContent);
						if (textInfo?.line) { info.line = textInfo.line; info.lineEnd = textInfo.lineEnd; }
					}
					e.preventDefault();
					e.stopPropagation();
					const label = info.path ? basenameOf('dsh-resource://file/' + info.path.replace(/\\/g, '/')) : basenameOf(info.address);
					showChooser(e.clientX, e.clientY, `${label}${info.line ? `:${info.line}` : ''}`, [
						['右侧栏打开', info.line ? `定位 ${info.line} 行` : '', () => { void openRight(info); }, true],
						['IDEA 打开', info.line ? `--line ${info.line}` : '', () => {
							void ideaOpen(info.address
								? { address: info.address, line: info.line, lineEnd: info.lineEnd }
								: { path: info.path, line: info.line, lineEnd: info.lineEnd, sessionId: currentSessionIdOf(ctx) });
						}],
					]);
					return true;
				}

				const onClick = (e) => {
					if (e.defaultPrevented || e.button !== 0) return;
					if (e.target?.__cijReplay) return; // 我自己回放的点击，放行给原生
					if (tryAnchorIntercept(e)) return;
					tryTextIntercept(e);
				};
				document.addEventListener('click', onClick, true);

				/** 兜底：包装 sidebarRight.openResource（若服务可达且未被包装） */
				function wrapOpenResource() {
					const sidebar = svc(ctx, 'sidebarRight');
					if (!sidebar || typeof sidebar.openResource !== 'function') return false;
					if (sidebar.__cijWrapped) return true;
					const orig = sidebar.openResource.bind(sidebar);
					sidebar.__cijOrig = orig; // 右侧栏打开/锚点路径用它，绕开自身包装
					const wrapped = (url, options) => {
						if (typeof url === 'string' && url.startsWith(FILE_PREFIX)) {
							const line = options?.params?.line;
							showChooser(lastMouse.x, lastMouse.y, `${basenameOf(url)}${line ? `:${line}` : ''}`, [
								['右侧栏打开', line ? `定位 ${line} 行` : '', () => { try { orig(url, options); } catch (error) { toast(`打开失败：${String(error?.message ?? error)}`, true); } }, true],
								['IDEA 打开', line ? `--line ${line}` : '', () => { void ideaOpen({ address: url, line: Number.isFinite(line) ? line : null }); }],
							]);
							return Promise.resolve();
						}
						return orig(url, options);
					};
					try {
						sidebar.openResource = wrapped;
						if (sidebar.openResource !== wrapped) throw new Error('assign failed');
					} catch {
						try { Object.defineProperty(sidebar, 'openResource', { value: wrapped, writable: true, configurable: true }); }
						catch { return false; }
					}
					sidebar.__cijWrapped = true;
					return true;
				}
				if (!wrapOpenResource()) {
					let tries = 0;
					const timer = setInterval(() => { tries += 1; if (wrapOpenResource() || tries > 60) clearInterval(timer); }, 250);
					ctx.effect?.(() => () => clearInterval(timer));
				}

				/** 官方右键菜单贡献：文件芯片右键 →「在 IDEA 中打开」 */
				try {
					if (ctx.contextMenus && typeof ctx.contextMenus.register === 'function') {
						ctx.effect(() => ctx.contextMenus.register({
							id: 'chat-idea-jump-idea',
							target: 'file',
							order: 500,
							resolve(target) {
								const value = target?.value ?? {};
								const line = Number.isFinite(value.line) ? value.line : null;
								return {
									id: 'cij-open-in-idea',
									label: line ? `在 IDEA 中打开（${line} 行）` : '在 IDEA 中打开',
									run: () => { void ideaOpen(value.address ?? null, line, null, value.path); },
								};
							},
						}));
					}
				} catch { /* 菜单服务不可用就只保留点击选择框 */ }

				/** 设置 → 插件 页的配置卡片（plugins.bundle.config 插槽，契约同 gitbash-shell） */
				try {
					if (ctx.slots && typeof ctx.slots.inject === 'function') {
						const formScope = svc(ctx, 'configForms')?.get?.('@local/chat-idea-jump') ?? null;
						ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
							name: 'plugins.bundle.config',
							key: '@local/chat-idea-jump',
							inject: () => ({ scope: formScope }),
						}, function BundleConfigCard(props) {
							const scope = props?.scope;
							const readSnap = () => { try { return scope?.getSnapshot?.() ?? {}; } catch { return {}; } };
							const [snap, setSnap] = React.useState(() => readSnap());
							const [draft, setDraft] = React.useState(null);
							const [status, setStatus] = React.useState('');
							React.useEffect(() => {
								if (typeof scope?.subscribe !== 'function') return undefined;
								const un = scope.subscribe(() => { try { setSnap(readSnap()); } catch { /* 忽略 */ } });
								return typeof un === 'function' ? un : undefined;
							}, [scope]);
							const cfg = snap.value && typeof snap.value === 'object' ? snap.value : {};
							const snapRoots = Array.isArray(cfg.searchRoots) ? cfg.searchRoots : [];
							const value = (key, fallback) => draft && key in draft ? draft[key] : fallback;
							const ideaDraft = value('ideaPath', cfg.ideaPath ?? '');
							const rootDraft = value('workspaceRoot', cfg.workspaceRoot ?? '');
							const rootsDraft = value('searchRootsText', snapRoots.join('\n'));
							const edit = (key, v) => setDraft({
								ideaPath: ideaDraft, workspaceRoot: rootDraft, searchRootsText: rootsDraft, [key]: v,
							});
							const save = async () => {
								if (!scope || typeof scope.set !== 'function') { setStatus('保存不可用：scope 缺失'); return; }
								const searchRoots = String(rootsDraft).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
								const entries = [['ideaPath', String(ideaDraft).trim()], ['workspaceRoot', String(rootDraft).trim()], ['searchRoots', searchRoots]];
								try {
									for (const [key, v] of entries) {
										const accepted = await Promise.resolve(scope.set(key, v));
										if (accepted !== true) { setStatus(`保存被拒绝：${key}`); return; }
									}
									setStatus('已保存，插件正在重启生效…');
									setDraft(null);
									setTimeout(() => setStatus(''), 4000);
								} catch (error) {
									setStatus(`保存失败：${String(error?.message ?? error)}`);
								}
							};
							const inputStyle = 'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));border-radius:6px;font-size:12.5px;font-family:inherit;background:var(--dsw-alias-bg-layer-1, #fff);color:var(--dsw-alias-label-primary, #222)';
							return E('div', { style: { display: 'grid', gap: '10px', padding: '4px 2px', fontSize: '12.5px', fontFamily: 'inherit' } },
								E('div', null,
									E('div', { style: { marginBottom: 4, opacity: .75 } }, 'idea64.exe 路径（留空自动探测）'),
									E('input', { style: inputStyle, value: ideaDraft, placeholder: '例如 E:\\Program Files\\IntelliJ IDEA 2026.1.1\\bin\\idea64.exe', onChange: (ev) => edit('ideaPath', ev.target.value) })),
								E('div', null,
									E('div', { style: { marginBottom: 4, opacity: .75 } }, '会话相对路径解析根（可选）'),
									E('input', { style: inputStyle, value: rootDraft, placeholder: '例如 C:\\Users\\your-name\\Desktop\\bss', onChange: (ev) => edit('workspaceRoot', ev.target.value) })),
								E('div', null,
									E('div', { style: { marginBottom: 4, opacity: .75 } }, '文件名搜索的附加项目根（每行一个）'),
									E('textarea', { style: { ...{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))', borderRadius: 6, fontSize: '12.5px', fontFamily: 'inherit', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #222)' }, minHeight: 64 }, value: rootsDraft, onChange: (ev) => edit('searchRootsText', ev.target.value) })),
								E('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
									E('button', {
										style: 'padding:6px 16px;border:none;border-radius:7px;cursor:pointer;font-size:12.5px;font-family:inherit;background:var(--dsw-alias-button-primary-fill, #0f1115);color:var(--dsw-alias-label-primary-foreground, #fff)',
										onClick: save,
									}, '保存'),
									status ? E('span', { style: { opacity: .75 } }, status) : null),
							);
						})));
					}
				} catch { /* 设置页插槽不可用时跳过，不影响主功能 */ }

				/** 设置导航项（settings.section，契约同 sidenote）+ 配置表单 */
				try {
					if (ctx.slots && typeof ctx.slots.inject === 'function') {
						function ConfigSection() {
							const [form, setForm] = React.useState(null);
							const [snap, setSnap] = React.useState({});
							const [draft, setDraft] = React.useState(null);
							const [status, setStatus] = React.useState('');
							React.useEffect(() => {
								let un;
								try {
									const forms = ctx.get?.('configForms');
									const f = typeof forms?.get === 'function' ? forms.get('@local/chat-idea-jump') : null;
									if (f && typeof f.getSnapshot === 'function') {
										setForm(f);
										setSnap(f.getSnapshot() ?? {});
										if (typeof f.subscribe === 'function') un = f.subscribe(() => { try { setSnap(f.getSnapshot() ?? {}); } catch { /* 忽略 */ } });
									} else {
										setStatus('设置域不可用：configForms 缺失或找不到本插件的表单');
									}
								} catch (error) { setStatus(String(error?.message ?? error)); }
								return typeof un === 'function' ? un : undefined;
							}, []);
							const cfg = snap.value && typeof snap.value === 'object' ? snap.value : {};
							const snapRoots = Array.isArray(cfg.searchRoots) ? cfg.searchRoots : [];
							const value = (key, fallback) => draft && key in draft ? draft[key] : fallback;
							const ideaDraft = value('ideaPath', cfg.ideaPath ?? '');
							const rootDraft = value('workspaceRoot', cfg.workspaceRoot ?? '');
							const rootsDraft = value('searchRootsText', snapRoots.join('\n'));
							const edit = (key, v) => setDraft({
								ideaPath: ideaDraft, workspaceRoot: rootDraft, searchRootsText: rootsDraft, [key]: v,
							});
							const save = async () => {
								if (!form || typeof form.set !== 'function') { setStatus('保存不可用：表单缺失'); return; }
								const searchRoots = String(rootsDraft).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
								const entries = [['ideaPath', String(ideaDraft).trim()], ['workspaceRoot', String(rootDraft).trim()], ['searchRoots', searchRoots]];
								try {
									for (const [key, v] of entries) {
										const accepted = await Promise.resolve(form.set(key, v));
										if (accepted !== true) { setStatus(`保存被拒绝：${key}`); return; }
									}
									setStatus('已保存，插件正在重启生效…');
									setDraft(null);
									setTimeout(() => setStatus(''), 4000);
								} catch (error) {
									setStatus(`保存失败：${String(error?.message ?? error)}`);
								}
							};
							const box = { width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))', borderRadius: 6, fontSize: '12.5px', fontFamily: 'inherit', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #222)' };
							return E('div', { style: { display: 'grid', gap: '12px', maxWidth: 560, fontSize: '12.5px', fontFamily: 'inherit' } },
								status ? E('div', { style: { opacity: .8, color: status.startsWith('已保存') ? 'inherit' : 'var(--dsw-alias-state-error-primary, #b3261e)' } }, status) : null,
								E('div', null,
									E('div', { style: { marginBottom: 4, opacity: .75 } }, 'idea64.exe 路径（留空自动探测）'),
									E('input', { style: box, value: ideaDraft, placeholder: '例如 E:\\Program Files\\IntelliJ IDEA 2026.1.1\\bin\\idea64.exe', onChange: (ev) => edit('ideaPath', ev.target.value) })),
								E('div', null,
									E('div', { style: { marginBottom: 4, opacity: .75 } }, '会话相对路径解析根（可选）'),
									E('input', { style: box, value: rootDraft, placeholder: '例如 C:\\Users\\your-name\\Desktop\\bss', onChange: (ev) => edit('workspaceRoot', ev.target.value) })),
								E('div', null,
									E('div', { style: { marginBottom: 4, opacity: .75 } }, '文件名搜索的附加项目根（每行一个）'),
									E('textarea', { style: { ...box, minHeight: 72 }, value: rootsDraft, onChange: (ev) => edit('searchRootsText', ev.target.value) })),
								E('button', {
									style: 'justify-self:start;padding:6px 16px;border:none;border-radius:7px;cursor:pointer;font-size:12.5px;font-family:inherit;background:var(--dsw-alias-button-primary-fill, #0f1115);color:var(--dsw-alias-label-primary-foreground, #fff)',
									onClick: save,
								}, '保存'),
							);
						}
						ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
							name: 'settings.section',
							id: 'chat-idea-jump',
							label: '聊天跳IDEA',
							order: 81,
							registrant: '@local/chat-idea-jump',
						}, () => E(ConfigSection))));
						ctx.effect(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
							name: 'settings.section.icon',
							id: 'chat-idea-jump',
							registrant: '@local/chat-idea-jump',
						}, ({ size } = {}) => E('span', { style: { fontSize: size ?? 16, lineHeight: 1 } }, '🦤'))));
					}
				} catch { /* 设置导航不可用时跳过，插件页卡片仍是备选 */ }

				ctx.effect?.(() => () => {
					document.removeEventListener('click', onClick, true);
					closeMenu();
				});
			},
		};
	},
});
