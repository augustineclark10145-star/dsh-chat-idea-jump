# dsh插件-聊天跳IDEA（@local/chat-idea-jump）

聊天里的文件引用（`dsh-resource://file/…` 链接）点击后弹出选择框：

- **右侧栏打开** —— DSH 自带预览，带行号定位
- **IDEA 打开** —— 调 `idea64.exe --line N <文件>`，直接跳到那一行

Esc 或点击空白关闭选择框；Ctrl/Shift/Alt/Meta + 点击不拦截，保留默认行为。

## 已完成（2026-11-23）

- 已注册进 desktop profile（package.json 依赖 + bundles + junction 链接 + lockfile）
- 自测通过：地址解析（session/absolute）、IDEA 自动探测（命中 `E:\Program Files\IntelliJ IDEA 2026.1.1\bin\idea64.exe`）、相对路径解析与文件名兜底搜索
- 待验证：DSH 完全重启后点击聊天文件引用实测两条链路

## 配置（v0.7.4 起）

**设置（左下角齿轮）→ 左侧导航「聊天跳IDEA」→ 配置页**，四个字段，改完保存插件自动重启生效：

| 字段 | 默认 | 说明 |
|---|---|---|
| `ideaPath` | 空 = 自动探测 | 探测顺序：Program Files 下 JetBrains/* 与 IntelliJ IDEA *（C/D/E/F 盘）|
| `workspaceRoot` | 空 = 自动 | 会话相对路径的解析根 |
| `searchRoots` | 空 | 文件名搜索的附加项目根数组（多项目各加一行）|
| `editors` | 空 | 额外编辑器，每项格式：`名称=exe路径` |

菜单会自动列出本机检测到的 IDEA、VS Code、Trae CN、Cursor、Qoder、CodeBuddy、Sublime Text；没有检测到的编辑器可以按 `editors` 格式自己加。

解析顺序：`file:///C:/...` 绝对路径直接用；relative 路径先按当前会话 cwd 解析；最后才按文件名搜索。默认还会搜 `~/Desktop`（深度 24，跳过 node_modules/.git/target 等）；全名搜不到时按前缀模糊兜底（`mgr-启动日志` 能命中 `mgr-启动日志(dev覆盖authBaseUrl).log`）。

等价写法：cordis.patch.yml 里 `@local/chat-idea-jump` 行的 `config` 也可直接改。

## 排障

- `GET /api/chat-idea-jump/state`：看 ideaPath 是否探测到、候选根目录列表
- IDEA 打开报「文件没找到」：把项目根填进 `workspaceRoot`
- 链接点击没弹选择框：确认 bundles 里有 `@local/chat-idea-jump` 且 DSH 是完全退出后重启的
