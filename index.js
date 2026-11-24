/**
 * @local/chat-idea-jump — host 半。
 *
 * 接收 file:/// 绝对路径或 dsh-resource://file/ 地址（+行号），解析成本地文件，
 * 用 IDEA / VS Code / Trae / Sublime 等已装编辑器打开。
 * 路由：POST /api/chat-idea-jump/open、POST /api/chat-idea-jump/resolve、GET /api/chat-idea-jump/state。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Schema from '@deepseek-ai/schemastery';

/**
 * 设置页表单（设置 → 聊天跳IDEA）。普通字段：修改后插件自动重启生效。
 * ideaPath 留空 = 自动探测；editors 是额外编辑器，每行「名称=exe路径」。
 */
export const Config = Schema.object({
	ideaPath: Schema.string().default('').description('idea64.exe 路径，留空自动探测'),
	workspaceRoot: Schema.string().default('').description('会话相对路径的解析根'),
	searchRoots: Schema.array(Schema.string()).default([]).description('文件名搜索的附加根目录'),
	editors: Schema.array(Schema.string()).default([]).description('额外编辑器，每项格式：名称=exe路径'),
});

export const name = '@local/chat-idea-jump';
export const inject = ['webServer'];

const PREFIX = '/api/chat-idea-jump';
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'build', 'out', '.git', '.idea', '.venv']);

/** 解析 dsh-resource://file/ 地址（语法与 DSH 右侧栏一致，见 file-address 注释）。 */
export function parseFileAddress(address) {
	if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
	try {
		const end = address.search(/[?#]/);
		const body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end);
		const [scope, ...rest] = body.split('/');
		if (scope === 'session') {
			const [id, ...segments] = rest;
			if (id === undefined || id === '' || segments.length === 0) return undefined;
			return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') };
		}
		if (scope === 'absolute') {
			const unc = rest[0] === '' && rest.length > 1;
			const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
			if (segments.length === 0 || segments[0] === '') return undefined;
			if (unc) return { scope, path: `//${segments.join('/')}` };
			return { scope, path: /^[A-Za-z]:$/.test(segments[0]) ? segments.join('/') : `/${segments.join('/')}` };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

async function readJson(req) {
	const direct = req?.body;
	if (direct && typeof direct === 'object' && !Buffer.isBuffer(direct)) return direct;
	if (typeof direct === 'string' && direct) {
		try { return JSON.parse(direct); } catch { return {}; }
	}
	if (Buffer.isBuffer(direct) && direct.length) {
		try { return JSON.parse(direct.toString('utf8')); } catch { return {}; }
	}
	if (req?.readableEnded) return {};
	const chunks = [];
	try {
		for await (const chunk of req) {
			chunks.push(Buffer.from(chunk));
			if (chunks.reduce((t, c) => t + c.length, 0) > 1_000_000) break;
		}
	} catch {
		return {};
	}
	try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.end(body);
}

/** 与 DSH 自带 web 鉴权一致：Origin 必须与 Host 同源。头信息缺失时放行（本地路由）。 */
function requestRejection(req) {
	const headers = req?.headers;
	if (!headers) return undefined;
	const get = typeof headers.get === 'function' ? (name) => headers.get(name) : (name) => headers[name];
	const origin = get('origin');
	if (!origin) return undefined;
	let originHost;
	try { originHost = new URL(origin).host; } catch { return 403; }
	const host = get('host');
	if (!host || originHost !== host) return 403;
	return undefined;
}

/** 探测 idea64.exe：显式配置优先，其次扫描常见 JetBrains 安装位置。 */
export function findIdeaExecutable(configured) {
	const candidates = [];
	if (typeof configured === 'string' && configured.trim()) candidates.push(configured.trim());
	const roots = [];
	for (const key of ['PROGRAMFILES', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
		if (process.env[key]) roots.push(process.env[key]);
	}
	for (const drive of ['C', 'D', 'E', 'F']) roots.push(`${drive}:\\Program Files`);
	const dirs = [];
	for (const root of roots) {
		let entries;
		try { entries = fs.readdirSync(root); } catch { continue; }
		for (const entry of entries) {
			const full = path.join(root, entry);
			if (/^JetBrains$/i.test(entry)) {
				try {
					for (const sub of fs.readdirSync(full)) dirs.push(path.join(full, sub));
				} catch { /* 目录不可读就跳过 */ }
			} else if (/IntelliJ IDEA/i.test(entry)) {
				dirs.push(full);
			}
		}
	}
	for (const dir of dirs) {
		const exe = path.join(dir, 'bin', 'idea64.exe');
		try { if (fs.existsSync(exe)) return exe; } catch { /* 继续 */ }
	}
	return null;
}

/** 常见编辑器：显式配置优先，其次自动探测本机安装位置。 */
export function findEditors(config = {}) {
	const list = [];
	const add = (id, label, exe, kind) => {
		if (typeof exe !== 'string' || !isFile(exe)) return;
		const key = exe.toLowerCase();
		if (list.some((item) => item.path.toLowerCase() === key)) return;
		list.push({ id, label, path: exe, kind });
	};
	const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
	const programDirs = [process.env.PROGRAMFILES, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'D:\\Program Files', 'E:\\Program Files'].filter(Boolean);
	add('idea', 'IDEA', findIdeaExecutable(config?.ideaPath), 'idea');
	for (const root of programDirs) add('vscode', 'VS Code', path.join(root, 'Microsoft VS Code', 'Code.exe'), 'vscode');
	for (const root of [local, ...programDirs]) {
		add('vscode', 'VS Code', path.join(root, 'Programs', 'Microsoft VS Code', 'Code.exe'), 'vscode');
		add('trae', 'Trae CN', path.join(root, 'Programs', 'Trae CN', 'Trae CN.exe'), 'vscode');
		add('trae', 'Trae', path.join(root, 'Programs', 'Trae', 'Trae.exe'), 'vscode');
		add('cursor', 'Cursor', path.join(root, 'Programs', 'Cursor', 'Cursor.exe'), 'vscode');
		add('qoder', 'Qoder', path.join(root, 'Programs', 'Qoder', 'Qoder.exe'), 'vscode');
		add('codebuddy', 'CodeBuddy', path.join(root, 'Programs', 'CodeBuddy CN', 'CodeBuddy CN.exe'), 'vscode');
	}
	add('sublime', 'Sublime Text', 'C:\\Program Files\\Sublime Text\\subl.exe', 'sublime');
	// Markdown 专用编辑器：Typora 常见装在 C:/E: 的 Program Files (x86) 或 Program Files。
	for (const root of ['C:\\Program Files\\Typora', 'E:\\Program Files (x86)\\Typora', 'C:\\Program Files (x86)\\Typora', 'D:\\Program Files (x86)\\Typora', 'D:\\Program Files\\Typora', 'E:\\Program Files\\Typora']) {
		add('typora', 'Typora', path.join(root, 'Typora.exe'), 'typora');
	}
	for (const raw of Array.isArray(config?.editors) ? config.editors : []) {
		const text = String(raw ?? '').trim();
		if (!text) continue;
		const eq = text.indexOf('=');
		const label = (eq > 0 ? text.slice(0, eq).trim() : path.basename(text)).replace(/\.exe$/i, '');
		const exe = eq > 0 ? text.slice(eq + 1).trim() : text;
		const lower = exe.toLowerCase();
		const kind = /typora|marktext|zettlr|obsidian/.test(lower) ? 'markdown' : /subl/.test(lower) ? 'sublime' : /idea|webstorm|pycharm|goland|rider|rustrover|phpstorm/.test(lower) ? 'idea' : /code|trae|cursor|windsurf|qoder|codebuddy/.test(lower) ? 'vscode' : 'idea';
		add(`custom-${list.length}`, label || '自定义编辑器', exe, kind);
	}
	return list;
}

/** Electron 编辑器会继承 DSH 的 ELECTRON_RUN_AS_NODE=1 变成 Node 直接退出，启动前必须清掉。 */
function editorEnvironment() {
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ELECTRON_NO_ATTACH_CONSOLE;
	return env;
}

/** 按编辑器类型拼命令行：JetBrains 用 --line，VS Code 系用 --goto file:line，Sublime 用 file:line。 */
export function openInEditor(editor, file, line) {
	const args = [];
	const n = Number.isFinite(line) && line > 0 ? Math.trunc(line) : null;
	if (editor.kind === 'vscode') {
		if (n) args.push('--goto', `${file}:${n}`);
		else args.push(file);
	} else if (editor.kind === 'markdown' || editor.kind === 'typora') {
		args.push(file);
	} else if (editor.kind === 'sublime') {
		args.push(n ? `${file}:${n}` : file);
	} else {
		if (n) args.push('--line', String(n));
		args.push(file);
	}
	const child = spawn(editor.path, args, { detached: true, stdio: 'ignore', env: editorEnvironment() });
	child.on('error', () => { /* 失败靠返回值兜底，不让进程崩溃 */ });
	child.unref();
	return child.pid ?? null;
}

/** 收集候选根目录：显式配置 → 当前会话 cwd → DSH 工作区/工作目录服务 → 进程 cwd。 */
function candidateRoots(ctx, config, sessionId) {
	const bases = [];
	if (typeof config?.workspaceRoot === 'string' && config.workspaceRoot.trim()) bases.push(config.workspaceRoot.trim());
	if (sessionId) {
		let session;
		try { session = ctx?.get?.('sessions')?.get?.(sessionId); } catch { session = undefined; }
		if (session) {
			try { if (session.header?.cwd) bases.push(session.header.cwd); } catch { /* 忽略 */ }
			try {
				const dir = ctx?.get?.('workingDirectory')?.get?.(session);
				if (typeof dir === 'string' && dir) bases.push(dir);
			} catch { /* 忽略 */ }
		}
	}
	for (const key of ['workingDirectory', 'workspace']) {
		let svc;
		try { svc = ctx?.get?.(key); } catch { svc = undefined; }
		if (!svc) continue;
		const shapes = [];
		try { shapes.push(svc.current, svc.path, svc.root); } catch { /* 属性访问失败忽略 */ }
		try { if (typeof svc.cwd === 'function') shapes.push(svc.cwd()); } catch { /* 调用失败忽略 */ }
		try { if (typeof svc.get === 'function') shapes.push(svc.get()); } catch { /* 调用失败忽略 */ }
		for (const shape of shapes) if (typeof shape === 'string' && shape) bases.push(shape);
	}
	if (process.cwd()) bases.push(process.cwd());
	return [...new Set(bases)];
}

function isFile(p) {
	try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** 按文件名在根目录下搜索（深度 14，跳过依赖/构建目录），逐根尝试直到命中。 */
export function searchByName(dir, name, depth = 0) {
	if (depth > 24) return null;
	const probe = name.toLowerCase();
	const state = { exact: null, prefix: null };
	(function walk(d, level) {
		if (state.exact || level > 24) return;
		let entries;
		try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (!e.isFile()) continue;
			const lower = e.name.toLowerCase();
			if (lower === probe) { state.exact = path.join(d, e.name); return; }
			if (!state.prefix && lower.startsWith(probe)) state.prefix = path.join(d, e.name);
		}
		if (state.exact) return;
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
			walk(path.join(d, e.name), level + 1);
			if (state.exact) return;
		}
	})(dir, depth);
	// 单趟扫描：精确命中立即返回，否则退回前缀命中（mgr-启动日志 → mgr-启动日志(xxx).log）
	return state.exact ?? state.prefix;
}

/** 地址 → 本地绝对路径；相对路径依次试候选根，最后按文件名兜底搜索。 */
export function resolveTarget(ctx, config, parsed, sessionId = parsed?.sessionId) {
	if (!parsed) return null;
	const raw = parsed.path.replace(/\\/g, '/');
	// absolute 作用域：path 以 / 开头时可能是 Windows 盘符的冗余斜杠
	if (parsed.scope === 'absolute') {
		const stripped = /^\/[A-Za-z]:\//.test(raw) ? raw.slice(1) : raw;
		const win = stripped.replace(/\//g, '\\');
		if (isFile(win)) return win;
		return null;
	}
	const rel = raw.replace(/^\/+/, '');
	for (const base of candidateRoots(ctx, config, sessionId)) {
		const abs = path.isAbsolute(rel) ? rel : path.join(base, rel);
		if (isFile(abs)) return abs;
	}
	// 直接拼不出来：按文件名在所有候选根 + 桌面里搜
	const name = path.basename(rel);
	const roots = [...candidateRoots(ctx, config, sessionId)];
	try { roots.push(path.join(os.homedir(), 'Desktop')); } catch { /* 忽略 */ }
	if (Array.isArray(config?.searchRoots)) for (const r of config.searchRoots) if (typeof r === 'string' && r) roots.push(r);
	for (const root of roots) {
		try { if (!fs.statSync(root).isDirectory()) continue; } catch { continue; }
		const hit = searchByName(root, name);
		if (hit) return hit;
	}
	return null;
}

export function apply(ctx, config = {}) {
	const disposers = [];
	const mount = (rawServer) => {
		const server = rawServer?.register ? rawServer : ctx.get?.('webServer');
		if (!server || typeof server.register !== 'function') {
			ctx.logger?.warn?.('@local/chat-idea-jump: webServer 服务不可用，路由未挂载');
			return;
		}
		const route = (method, sub, handler) => {
			const guarded = async (req, res) => {
				try {
					const rejection = requestRejection(req);
					if (rejection !== undefined) { sendJson(res, rejection, { ok: false, error: 'unauthorized' }); return; }
					await handler(req, res);
				} catch (error) {
					// 异常堆栈落盘，方便从宿主外定位（toast 只显示一行 message）
					try {
						fs.appendFileSync(path.join(os.homedir(), '.dsh', 'chat-idea-jump-error.log'),
							`[${new Date().toISOString()}] ${method} ${sub} :: ${error?.message}\n${error?.stack}\n\n`);
					} catch { /* 日志失败不阻塞 */ }
					sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
				}
			};
			disposers.push(server.register({ kind: 'exact', path: `${PREFIX}/${sub}`, handler: guarded }));
		};

		route('GET', 'state', (_req, res) => {
			const editors = findEditors(config);
			sendJson(res, 200, {
				ok: true,
				ideaPath: findIdeaExecutable(config?.ideaPath),
				editors: editors.map(({ id, label, kind }) => ({ id, label, kind, markdownOnly: kind === 'typora' || kind === 'markdown' })),
				workspaceRoot: config?.workspaceRoot || '',
				roots: candidateRoots(ctx, config).slice(0, 5),
				config: {
					ideaPath: config?.ideaPath ?? '',
					workspaceRoot: config?.workspaceRoot ?? '',
					searchRoots: Array.isArray(config?.searchRoots) ? config.searchRoots : [],
					editors: Array.isArray(config?.editors) ? config.editors : [],
				},
			});
		});

		/** 保存配置：走 DSH configEditor，插件会按 Loader 正常生命周期重启。 */
		route('POST', 'config', async (req, res) => {
			const body = await readJson(req);
			const editor = ctx.get?.('configEditor');
			const entry = ctx.fiber?.entry;
			if (!editor || typeof editor.edit !== 'function' || !entry) throw new Error('configEditor 不可用，无法保存配置');
			const patch = {};
			if (typeof body?.ideaPath === 'string') patch.ideaPath = body.ideaPath.trim();
			if (typeof body?.workspaceRoot === 'string') patch.workspaceRoot = body.workspaceRoot.trim();
			if (Array.isArray(body?.searchRoots)) patch.searchRoots = body.searchRoots.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
			if (Array.isArray(body?.editors)) patch.editors = body.editors.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
			await editor.edit(entry, (current) => ({ ...current, ...patch }));
			sendJson(res, 200, { ok: true });
		});

		/** 统一解析：body.path（文本/相对/绝对/file:// URL）→ body.address（dsh-resource 地址） */
		function resolveFromPayload(ctx, config, body) {
			let file = null;
			let parsed = null;
			const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined;
			if (typeof body?.path === 'string' && body.path.trim()) {
				let rawPath = body.path.trim();
				// file:///C:/... 这类绝对 URL 直接转成本地路径，绝不按文件名去搜
				if (/^file:\/\//i.test(rawPath)) {
					try { rawPath = fileURLToPath(rawPath); } catch { /* 非法 URL 再按原样试 */ }
				}
				if (isFile(rawPath)) {
					file = rawPath;
				} else {
					const win = rawPath.replace(/\//g, '\\');
					const stripped = /^\\[A-Za-z]:\\/.test(win) ? win.slice(1) : win;
					if (isFile(stripped)) file = stripped;
					else if (isFile(win.replace(/^\\+/, ''))) file = win.replace(/^\\+/, '');
					else file = resolveTarget(ctx, config, { scope: 'session', path: rawPath.replace(/\\/g, '/') }, sessionId);
				}
			}
			if (!file && body?.address) {
				parsed = parseFileAddress(body.address);
				if (parsed) file = resolveTarget(ctx, config, parsed, sessionId);
			}
			return { file, parsed };
		}

		route('POST', 'resolve', async (req, res) => {
			const body = await readJson(req);
			const { file, parsed } = resolveFromPayload(ctx, config, body);
			if (!file) {
				sendJson(res, 404, {
					ok: false,
					error: '文件没找到。可在 profile 的 cordis.patch.yml 里给 @local/chat-idea-jump 配置 searchRoots（项目根数组）后重启。',
					addressPath: parsed?.path ?? body?.path ?? null,
				});
				return;
			}
			sendJson(res, 200, { ok: true, file });
		});

		route('POST', 'open', async (req, res) => {
			const body = await readJson(req);
			const { file, parsed } = resolveFromPayload(ctx, config, body);
			if (!file) {
				sendJson(res, 404, {
					ok: false,
					error: '文件没找到。可在 profile 的 cordis.patch.yml 里给 @local/chat-idea-jump 配置 searchRoots（项目根数组）后重启。',
					addressPath: parsed?.path ?? body?.path ?? null,
				});
				return;
			}
			const editors = findEditors(config);
			const editor = editors.find((item) => item.id === body?.editor) || editors[0];
			if (!editor) { sendJson(res, 500, { ok: false, error: '没有可用的编辑器，请在设置里配置 ideaPath 或 editors' }); return; }
			const line = Number(body?.line);
			const pid = openInEditor(editor, file, Number.isFinite(line) ? line : undefined);
			ctx.logger?.info?.(`@local/chat-idea-jump: ${editor.label} 打开 ${file}${Number.isFinite(line) ? `:${Math.trunc(line)}` : ''}`);
			sendJson(res, 200, { ok: true, file, line: Number.isFinite(line) ? Math.trunc(line) : null, editor: editor.label, pid, exe: editor.path });
		});
	};

	try {
		mount(ctx.get?.('webServer'));
	} catch (error) {
		ctx.logger?.warn?.(`@local/chat-idea-jump: 挂载失败 ${String(error?.message ?? error)}`);
	}

	ctx.effect?.(() => () => {
		for (const d of disposers) { try { d?.(); } catch { /* 卸载失败不阻塞 */ } }
	});
}

export default { name, inject, Config, apply };
