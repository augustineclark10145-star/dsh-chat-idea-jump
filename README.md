# dsh插件-聊天跳IDEA（dsh-chat-idea-jump）

聊天里的文件引用（`dsh-resource://file/…` 链接或文本里的 `路径:行号`）点击后弹出选择框：

- **右侧栏打开** —— DSH 自带预览，带行号定位
- **在资源管理器中定位** —— 弹出文件所在文件夹并选中它（`explorer /select`），不用编辑器打开
- **任意编辑器打开** —— 调对应 exe 直接跳到那一行

Esc 或点击空白关闭选择框；Ctrl/Shift/Alt/Meta + 点击不拦截，保留默认行为。

## 配置（v0.8.0 起，v0.9.0 加资源管理器定位）

**设置（左下角齿轮）→ 左侧导航「聊天跳IDEA」**，改完保存插件自动重启生效。

页面是一张编辑器清单，每行三格：**勾选框 / 名称 / exe 路径**。

- 打勾 = 显示在右键菜单里，不打勾 = 只留在清单里
- 探测到的编辑器路径已自动填好；**没探测到的也会列出来**，路径格显示「未检测到，可填 exe 路径」，填上即可用
- 清单外的编辑器写在最下面的「其他编辑器」，每行 `名称=exe路径`

内置清单（29 项）：IntelliJ IDEA、WebStorm、PyCharm、GoLand、CLion、PhpStorm、RubyMine、Rider、DataGrip、RustRover、Aqua、DataSpell、VS Code、VS Code Insiders、Cursor、Windsurf、Trae CN、Qoder、CodeBuddy、VSCodium、Kiro、Zed、Sublime Text、Notepad++、Typora、Obsidian、MarkText、Android Studio、Eclipse。

探测范围：`%LOCALAPPDATA%\Programs\*`、各盘 `Program Files`、`Program Files (x86)`、JetBrains Toolbox 的 `apps\*\*\*\bin`。

### 启动参数按类型区分

| 类型 | 命令 |
|---|---|
| JetBrains（IDEA 等） | `exe --line N 文件` |
| VS Code 系（Cursor、Trae、Qoder…） | `exe --goto 文件:N` |
| Sublime | `exe 文件:N` |
| Notepad++ | `exe -nN 文件` |
| Markdown（Typora、Obsidian…） | `exe 文件`，只在目标本身是 `.md` 时出现在菜单里 |

### 配置文件字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `ideaPath` | 空 = 自动探测 | idea64.exe 的显式路径，优先级最高 |
| `editors` | 空 | 清单外的编辑器，或用来覆盖清单里的路径，格式 `名称=exe路径` |
| `hiddenEditors` | 空 | 设置页里取消勾选的编辑器 id，不进菜单 |

解析顺序：`file:///C:/...` 绝对路径直接用；只有纯文本里的相对路径才按当前会话 cwd 解析，最后按文件名搜索。

等价写法：cordis.patch.yml 里 `dsh-chat-idea-jump` 行的 `config` 也可直接改。

## 排障

- `GET /api/chat-idea-jump/state`：返回全部编辑器清单（含 `found` / `enabled` / `path`）与候选根目录
- 链接点击没弹选择框：确认 bundles 里有 `dsh-chat-idea-jump` 且 DSH 是完全退出后重启的
- 菜单里没有某个编辑器：设置页确认它打了勾、路径格不为空
