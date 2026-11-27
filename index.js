/**
 * dsh-chat-idea-jump — host 半。
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
	hiddenEditors: Schema.array(Schema.string()).default([]).description('设置页里取消勾选的编辑器 id，不进菜单'),
});

export const name = 'dsh-chat-idea-jump';
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

/** 探测 idea64.exe：显式配置优先，其次扫描 JetBrains 安装位置。 */
export function findIdeaExecutable(configured) {
	if (typeof configured === 'string' && configured.trim() && isFile(configured.trim())) return configured.trim();
	const found = scanJetBrains('IntelliJ IDEA');
	return found[0]?.path ?? null;
}

/** JetBrains 产品表：安装目录名前缀、可执行文件名、显示名。 */
const JETBRAINS_PRODUCTS = [
	['IntelliJ IDEA', 'idea64.exe', 'IntelliJ IDEA'],
	['WebStorm', 'webstorm64.exe', 'WebStorm'],
	['PyCharm', 'pycharm64.exe', 'PyCharm'],
	['GoLand', 'goland64.exe', 'GoLand'],
	['CLion', 'clion64.exe', 'CLion'],
	['PhpStorm', 'phpstorm64.exe', 'PhpStorm'],
	['RubyMine', 'rubymine64.exe', 'RubyMine'],
	['Rider', 'rider64.exe', 'Rider'],
	['DataGrip', 'datagrip64.exe', 'DataGrip'],
	['RustRover', 'rustrover64.exe', 'RustRover'],
	['Aqua', 'aqua64.exe', 'Aqua'],
	['DataSpell', 'dataspell64.exe', 'DataSpell'],
];

/** 目录里挑出 exe：命中就返回，读不了就跳过。 */
function probe(dir, exe) {
	try {
		const full = path.join(dir, exe);
		return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
	} catch { return null; }
}

/** 只读一个目录的子目录名，失败给空数组。 */
function subdirs(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch { return []; }
}

/** 扫描本机 JetBrains 安装：Program Files 下的产品目录 / JetBrains 目录，以及 Toolbox。 */
export function scanJetBrains(productName) {
	const out = [];
	const seen = new Set();
	const push = (exe, label) => {
		if (!exe) return;
		const key = exe.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ path: exe, label });
	};
	const products = productName
		? JETBRAINS_PRODUCTS.filter((row) => row[0] === productName)
		: JETBRAINS_PRODUCTS;
	const programRoots = [];
	for (const key of ['PROGRAMFILES', 'ProgramFiles(x86)']) if (process.env[key]) programRoots.push(process.env[key]);
	for (const drive of ['C', 'D', 'E', 'F']) {
		programRoots.push(`${drive}:\\Program Files`);
		programRoots.push(`${drive}:\\Program Files (x86)`);
	}
	for (const root of programRoots) {
		for (const dir of subdirs(root)) {
			for (const [product, exe, label] of products) {
				if (!new RegExp(`^${product}`, 'i').test(dir)) continue;
				push(probe(path.join(root, dir, 'bin'), exe), label);
			}
			if (!/^JetBrains$/i.test(dir)) continue;
			for (const sub of subdirs(path.join(root, dir))) {
				for (const [product, exe, label] of products) {
					if (!new RegExp(`^${product}`, 'i').test(sub)) continue;
					push(probe(path.join(root, dir, sub, 'bin'), exe), label);
				}
			}
		}
	}
	// JetBrains Toolbox：%LOCALAPPDATA%\JetBrains\Toolbox\apps\<产品>\<渠道>\<构建>\bin
	const toolbox = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'JetBrains', 'Toolbox', 'apps');
	for (const productDir of subdirs(toolbox)) {
		const match = products.find(([product]) => new RegExp(`^${product}`, 'i').test(productDir));
		if (!match) continue;
		for (const channel of subdirs(path.join(toolbox, productDir))) {
			for (const build of subdirs(path.join(toolbox, productDir, channel))) {
				push(probe(path.join(toolbox, productDir, channel, build, 'bin'), match[1]), match[2]);
			}
		}
	}
	return out;
}

/** 本机几个安装根：local（LOCALAPPDATA）与 program（Program Files 各盘）。 */
function installRoots() {
	const local = [process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')];
	const program = [];
	for (const key of ['PROGRAMFILES', 'ProgramFiles(x86)']) if (process.env[key]) program.push(process.env[key]);
	for (const drive of ['C', 'D', 'E', 'F']) {
		program.push(`${drive}:\\Program Files`);
		program.push(`${drive}:\\Program Files (x86)`);
	}
	return { local, program };
}

/** 已知编辑器：id、显示名、启动方式、候选 exe 路径。 */
const EDITOR_CATALOG = [
	{ id: 'vscode', label: 'VS Code', kind: 'vscode', paths: (r) => r.local.map((b) => path.join(b, 'Programs', 'Microsoft VS Code', 'Code.exe')).concat(r.program.map((b) => path.join(b, 'Microsoft VS Code', 'Code.exe'))) },
	{ id: 'vscode-insiders', label: 'VS Code Insiders', kind: 'vscode', paths: (r) => r.local.map((b) => path.join(b, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe')) },
	{ id: 'cursor', label: 'Cursor', kind: 'vscode', paths: (r) => r.local.map((b) => path.join(b, 'Programs', 'Cursor', 'Cursor.exe')).concat(r.program.map((b) => path.join(b, 'Cursor', 'Cursor.exe'))) },
	{ id: 'windsurf', label: 'Windsurf', kind: 'vscode', paths: (r) => r.local.map((b) => path.join(b, 'Programs', 'Windsurf', 'Windsurf.exe')) },
	{ id: 'trae', label: 'Trae CN', kind: 'vscode', paths: (r) => r.local.map((b) => path.join(b, 'Programs', 'Trae CN', 'Trae CN.exe')).concat(r.local.map((b) => path.join(b, 'Programs', 'Trae', 'Trae.exe'))) },
	{ id: 'qoder', label: 'Qoder', kind: 'vscode', paths: (r) => r.local.map((b) => path.join(b, 'Programs', 'Qoder', 'Qoder.exe')) },
	{ id: 'codebuddy', label: 'CodeBuddy', kind: 'vscode', paths: (r) => r.local.map((b) => path.join(b, 'Programs', 'CodeBuddy CN', 'CodeBuddy CN.exe')).concat(r.program.map((b) => path.join(b, 'CodeBuddy CN', 'CodeBuddy CN.exe'))) },
	{ id: 'vscodium', label: 'VSCodium', kind: 'vscode', paths: (r) => r.local.map((b) => path.join(b, 'Programs', 'VSCodium', 'VSCodium.exe')) },
	{ id: 'kiro', label: 'Kiro', kind: 'vscode', paths: (r) => r.local.map((b) => path.join(b, 'Programs', 'Kiro', 'Kiro.exe')) },
	{ id: 'zed', label: 'Zed', kind: 'vscode', paths: (r) => r.local.map((b) => path.join(b, 'Programs', 'Zed', 'zed.exe')) },
	{ id: 'sublime', label: 'Sublime Text', kind: 'sublime', paths: (r) => r.program.map((b) => path.join(b, 'Sublime Text', 'subl.exe')).concat(r.program.map((b) => path.join(b, 'Sublime Text 3', 'subl.exe'))) },
	{ id: 'notepadpp', label: 'Notepad++', kind: 'notepad', paths: (r) => r.program.map((b) => path.join(b, 'Notepad++', 'notepad++.exe')) },
	{ id: 'typora', label: 'Typora', kind: 'typora', paths: (r) => r.program.map((b) => path.join(b, 'Typora', 'Typora.exe')) },
	{ id: 'obsidian', label: 'Obsidian', kind: 'typora', paths: (r) => r.local.map((b) => path.join(b, 'Obsidian', 'Obsidian.exe')).concat(r.program.map((b) => path.join(b, 'Obsidian', 'Obsidian.exe'))) },
	{ id: 'marktext', label: 'MarkText', kind: 'typora', paths: (r) => r.local.map((b) => path.join(b, 'Programs', 'MarkText', 'MarkText.exe')).concat(r.program.map((b) => path.join(b, 'MarkText', 'MarkText.exe'))) },
	{ id: 'android-studio', label: 'Android Studio', kind: 'idea', paths: (r) => r.program.map((b) => path.join(b, 'Android', 'Android Studio', 'bin', 'studio64.exe')) },
	{ id: 'eclipse', label: 'Eclipse', kind: 'idea', paths: (r) => r.program.map((b) => path.join(b, 'eclipse', 'eclipse.exe')) },
];

/** 从「名称=exe路径」里拆出名称与路径；没有等号时名称留空。 */
function parseEditorLine(raw) {
	const text = String(raw ?? '').trim();
	if (!text) return null;
	const eq = text.indexOf('=');
	if (eq > 0) return { name: text.slice(0, eq).trim(), exe: text.slice(eq + 1).trim() };
	return { name: '', exe: text };
}

/** 按 exe 猜启动方式：不同编辑器拼参数的方式不一样。 */
function kindOfPath(exe) {
	const lower = String(exe).toLowerCase();
	if (/typora|obsidian|marktext|zettlr/.test(lower)) return 'typora';
	if (/notepad\+\+/.test(lower)) return 'notepad';
	if (/subl/.test(lower)) return 'sublime';
	if (/studio64|eclipse|idea|webstorm|pycharm|goland|rider|rustrover|phpstorm|clion|rubymine|datagrip|aqua|dataspell|fleet/.test(lower)) return 'idea';
	if (/code|trae|cursor|windsurf|qoder|codebuddy|vscodium|kiro|zed/.test(lower)) return 'vscode';
	return 'idea';
}

/**
 * 全部编辑器：自动探测 + 自定义。
 * 每项带 enabled——设置页勾选状态；未勾选的不进菜单，但设置页仍可见。
 */
/**
 * 全部编辑器清单：固定目录里的每一个都列出来（没探测到也列，path 为空、found=false），
 * 这样设置页能显示「未检测到」，用户自己填路径即可。
 * 每项字段：id / label / kind / path（探测或自定义）/ found / enabled。
 */
export function findEditors(config = {}) {
	const roots = installRoots();
	const hidden = new Set((Array.isArray(config?.hiddenEditors) ? config.hiddenEditors : []).map((v) => String(v).trim().toLowerCase()));
	const list = [];
	const byId = new Map();

	/** 登记一条：同 id 只留第一条，已有路径的不被空路径覆盖。 */
	const add = (id, label, kind, exe) => {
		const key = String(id).toLowerCase();
		const found = typeof exe === 'string' && isFile(exe);
		const existing = byId.get(key);
		if (existing) {
			if (found && !existing.path) { existing.path = exe; existing.found = true; }
			return existing;
		}
		// 默认只勾选探测到的：没装的不进菜单，用户填了路径再自己勾。
		const item = { id: key, label, kind, path: found ? exe : '', found, enabled: found && !hidden.has(key) };
		byId.set(key, item);
		list.push(item);
		return item;
	};

	// 1) JetBrains 全家族：目录里的每个产品都登记，探测到的带上路径。
	const jetbrainsFound = new Map();
	for (const row of scanJetBrains()) {
		jetbrainsFound.set(row.label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), row.path);
	}
	for (const [product, , label] of JETBRAINS_PRODUCTS) {
		const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
		add(id, label, 'idea', jetbrainsFound.get(id));
	}

	// 2) 目录里的通用编辑器：每个都登记，探测到的带上路径。
	for (const entry of EDITOR_CATALOG) {
		let hit = null;
		for (const candidate of entry.paths(roots)) {
			if (isFile(candidate)) { hit = candidate; break; }
		}
		add(entry.id, entry.label, entry.kind, hit);
	}

	// 3) 自定义行：名称命中已知 id/显示名时当作路径覆盖，否则新增一条。
	for (const raw of Array.isArray(config?.editors) ? config.editors : []) {
		const parsed = parseEditorLine(raw);
		if (!parsed) continue;
		const nameKey = parsed.name.toLowerCase();
		const target = nameKey
			? byId.get(nameKey) || list.find((item) => item.label.toLowerCase() === nameKey)
			: null;
		if (target) {
			if (isFile(parsed.exe)) {
				target.path = parsed.exe;
				target.found = true;
				// 填了路径就默认启用，否则「未检测到支持自定义」等于没做。
				target.enabled = !hidden.has(target.id);
			}
			continue;
		}
		if (!isFile(parsed.exe)) continue;
		const label = parsed.name || path.basename(parsed.exe).replace(/\.exe$/i, '');
		add(`custom-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label, kindOfPath(parsed.exe), parsed.exe);
	}

	return list;
}

/** 菜单里可用的编辑器：只取已勾选且探测到路径的；一个都没有就返回空（菜单只剩右侧栏）。 */
export function enabledEditors(config = {}) {
	return findEditors(config).filter((item) => item.enabled && item.path);
}

/** Electron 编辑器会继承 DSH 的 ELECTRON_RUN_AS_NODE=1 变成 Node 直接退出，启动前必须清掉。 */
function editorEnvironment() {
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ELECTRON_NO_ATTACH_CONSOLE;
	return env;
}

/**
 * 在系统资源管理器里定位文件：Windows 用 `explorer /select,"路径"`。
 * 不是用编辑器打开，只是把文件夹窗口弹出来并选中那个文件。
 */
export function revealInExplorer(file) {
	const child = spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore' });
	child.on('error', () => { /* 失败靠返回值兜底 */ });
	child.unref();
	return child.pid ?? null;
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
	} else if (editor.kind === 'notepad') {
		if (n) args.push(`-n${n}`);
		args.push(file);
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
			ctx.logger?.warn?.('dsh-chat-idea-jump: webServer 服务不可用，路由未挂载');
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
			const all = findEditors(config);
			sendJson(res, 200, {
				ok: true,
				ideaPath: findIdeaExecutable(config?.ideaPath),
				// 全部检测到的编辑器，带勾选状态：设置页按这个渲染清单，菜单只取 enabled 的。
				editors: all.map(({ id, label, kind, path: exe, found, enabled }) => ({
					id, label, kind, path: exe, found, enabled,
					markdownOnly: kind === 'typora' || kind === 'markdown',
				})),
				workspaceRoot: config?.workspaceRoot || '',
				roots: candidateRoots(ctx, config).slice(0, 5),
				config: {
					ideaPath: config?.ideaPath ?? '',
					workspaceRoot: config?.workspaceRoot ?? '',
					searchRoots: Array.isArray(config?.searchRoots) ? config.searchRoots : [],
					editors: Array.isArray(config?.editors) ? config.editors : [],
					hiddenEditors: Array.isArray(config?.hiddenEditors) ? config.hiddenEditors : [],
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
			if (Array.isArray(body?.hiddenEditors)) {
				// 去重：前端曾把路径框也当勾选框读，写进过重复 id。
				patch.hiddenEditors = [...new Set(body.hiddenEditors.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean))];
			}
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
					error: '文件没找到。可在 profile 的 cordis.patch.yml 里给 dsh-chat-idea-jump 配置 searchRoots（项目根数组）后重启。',
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
					error: '文件没找到。可在 profile 的 cordis.patch.yml 里给 dsh-chat-idea-jump 配置 searchRoots（项目根数组）后重启。',
					addressPath: parsed?.path ?? body?.path ?? null,
				});
				return;
			}
			// action: 'reveal' = 在资源管理器里定位文件，不用编辑器打开。
			if (body?.action === 'reveal') {
				const pid = revealInExplorer(file);
				ctx.logger?.info?.(`dsh-chat-idea-jump: 资源管理器定位 ${file}`);
				sendJson(res, 200, { ok: true, file, action: 'reveal', pid });
				return;
			}
			const editors = enabledEditors(config);
			const editor = editors.find((item) => item.id === body?.editor) || editors[0];
			if (!editor) { sendJson(res, 500, { ok: false, error: '没有可用的编辑器，请在设置里配置 ideaPath 或 editors' }); return; }
			const line = Number(body?.line);
			const pid = openInEditor(editor, file, Number.isFinite(line) ? line : undefined);
			ctx.logger?.info?.(`dsh-chat-idea-jump: ${editor.label} 打开 ${file}${Number.isFinite(line) ? `:${Math.trunc(line)}` : ''}`);
			sendJson(res, 200, { ok: true, file, line: Number.isFinite(line) ? Math.trunc(line) : null, editor: editor.label, pid, exe: editor.path });
		});
	};

	try {
		mount(ctx.get?.('webServer'));
	} catch (error) {
		ctx.logger?.warn?.(`dsh-chat-idea-jump: 挂载失败 ${String(error?.message ?? error)}`);
	}

	ctx.effect?.(() => () => {
		for (const d of disposers) { try { d?.(); } catch { /* 卸载失败不阻塞 */ } }
	});
}

export default { name, inject, Config, apply };
