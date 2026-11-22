# pi-memory

给 pi 加一个**跨会话的项目记忆**：一个 `MEMORY.md` 索引 + 一主题一文件的正文，模型用内建的 `read`/`write`/`edit` 自己维护，插件只负责注入、设闸和搬家。

设计目标是**省 context**：常驻提示词约 290 tokens，30 条索引的完整注入约 730 tokens。对比：Claude Code 2.1.88 的同类提示词是 ~12.5KB / ~3.1k tokens。

## 它做什么

| 层 | 内容 | 谁决定 |
|---|---|---|
| 常驻 | 10 行规则 + `MEMORY.md` 全文 | 插件每轮注入 |
| 按需 | 主题文件正文 | 模型看到索引钩子后自己 `read` |
| 深挖 | `grep -rn "<term>" <dir> --include="*.md"` | 规则里给了一条命令 |

没有 embedding、没有 LLM 召回、没有后台提取、没有 autoDream。这些都被有意排除——索引 + 按需读取本身就是渐进式披露，再加一层模型选择器只会把 token 和延迟花在每一条用户消息上。

## 安装

```sh
pi install npm:@aoshizuku/pi-memory                # 从 npm 安装
pi install git:github.com/AoShizuku/pi-memory     # 或从 GitHub 安装
pi install ./pi-memory
```

`package.json` 里已经声明了 `pi.extensions`，本地路径安装即可。

## 配置

插件**不往仓库里写任何配置**。每个仓库在本机有一份记录，路径是 `~/.pi/agent/memory/.projects/<仓库根路径的 hash>.json`：

```json
{
  "id": "repo-7c3f9a1b2d4e",
  "location": "local",
  "repoRoot": "/path/to/repo",
  "updatedAt": "2026-11-11T08:00:00.000Z"
}
```

| 键 | 取值 | 说明 |
|---|---|---|
| `location` | `"project"` \| `"local"` | 默认 `local`，只由 `/memory switch` 修改 |
| `id` | `repo-<hash>` \| `path-<hash>` | 第一次遇到这个仓库时生成，之后不再重算 |

- **仓库的确定**：用 `git rev-parse --show-toplevel` 找到仓库根，所以从任何子目录启动都对应同一份记录、同一份记忆。不在 git 仓库里时，以 cwd 为准。
- **`id` 的派生**：有 `origin` remote 时用 remote URL 的 hash，否则用仓库根路径的 hash。记录生成之后，加删 remote 不会让 id 变化；重新 clone 或者把带 remote 的仓库搬到别的目录，也会算出同一个 id，local 记忆照样能找到。
- **代价**：没有 remote 的仓库搬目录之后会算出新的 id，原来的 local 记忆不会被删，只是不再关联。需要时把旧目录手动挪到新 id 下即可。

为什么不写进 `.pi/settings.json`：
- pi 把这个文件当作需要项目信任的资源，插件一旦写入，下次启动 pi 就会弹出信任确认；没有 UI 的模式会直接按不信任处理。
- 项目记忆会被注入 system prompt。如果位置写在仓库里，一个仓库就能自己选择 `project`，把仓库作者写的文本塞进你的提示词。现在选择权只在本机用户手里。

目录位置：
- `project` → `<repo>/.pi/memory/`
- `local` → `~/.pi/agent/memory/<id>/`

**旧版迁移**：旧版本把 `{ location, id }` 写在 `.pi/settings.json` 的 `pi-memory` 键里。第一次遇到这个仓库时，插件会把它导入本机记录并提示一次；之后那个键不再读取，可以删掉（如果文件里没有别的内容，连同文件一起删，pi 就不会再要求信任这个项目）。

**仓库自带记忆**：如果仓库里已经提交了 `.pi/memory/MEMORY.md`，第一次打开时会提示一次，执行 `/memory switch project` 就会接管这份记忆，不会自动启用。

`PI_MEMORY_AGENT_DIR` 可以覆盖 agent 目录（测试和小众安装用）。

## 命令

```
/memory                        记忆面板：浏览、搜索、看全文、删除；Tab 切到 Issues 页
/memory status                 显示位置、路径、文件数、索引占用
/memory open                   在编辑器里改 MEMORY.md
/memory doctor                 打开面板的 Issues 页：悬空索引、孤儿文件、重复描述、超长钩子、索引超限、疑似密钥、过期回收站副本
/memory switch [project|local] 在两个位置之间搬家
```

`/memory` 面板（设计见 `DESIGN.md`）：

| 键 | Memories 页 | Issues 页 |
|---|---|---|
| 打字 | 按标题、钩子、文件名、正文搜索 | 按问题搜索 |
| `enter` | 浮层看全文 | 跳到这个问题说的那条记忆 |
| `ctrl+d ctrl+d` | 删除：文件进回收站，同时删掉索引行 | 永久删除一条过期的回收站副本 |
| `tab` / `esc` | 切页 / 先清空搜索，再按一次关闭 | 同左 |

面板只读，不改记忆内容，改内容交给模型。非 TUI 模式（RPC、print）下不开面板，`/memory` 和 `/memory doctor` 用通知输出纯文本。所有输出都不进模型上下文。

## 搬家是安全的

`/memory switch` 在 TUI 里打开一个位置面板，列出两个位置的路径，按两次 `enter` 才搬家。命令里写了目标时，面板会预先选中它；非 TUI 模式下，写明的目标本身就是确认。搬家前先看两边的情况：

| 当前目录 | 目标目录 | 行为 |
|---|---|---|
| 没有记忆 | 没有记忆 | 只改位置 |
| 没有记忆 | 已有记忆 | **接管**：只改位置，直接用目标里的记忆（例如队友提交的 `.pi/memory`） |
| 有记忆 | 非空 | 拒绝，不 merge，先手动挪走一边 |
| 有记忆 | 空或不存在 | 搬家，见下 |

搬家的顺序固定：

1. 预检：拒绝路径嵌套（Windows 下忽略大小写）
2. 拷到同级 `*.tmp-<时间戳>/`
3. 逐文件校验 `size + sha256`，不一致就中止，源目录不动
4. `rename` 就位（同文件系统原子操作），再校验一次目标目录
5. 改写本机记录的 `location`
6. **把源目录移进回收站**，不是 `rm`，并把它的 mtime 设为当前时间，回收站的 7 天从这一刻算起
7. 清理状态文件

第 5 步之前任何一步失败，都会删掉目标副本，回到原状。第 5 步之后目标已经生效，后面再出错只给警告，不会回滚。

中间态写在 `~/.pi/agent/memory/.migrations/<id>.json`。进程被杀掉后，下次 `session_start` 会根据本机记录判断哪一边正在生效：
- 记录已指向目标：目标生效，把残留的源目录移进回收站。
- 记录仍指向源：源生效，删掉临时副本；目标里如果是一份和源完全一致的副本，也一并删掉；不一致就留着并提示你检查。

**最坏情况是多一份拷贝，不会是零份。**

搬去 `project` 之后（接管的情况除外）会问一次怎么入库：

| 选项 | 行为 |
|---|---|
| keep untracked | 往 `.git/info/exclude` 写 `.pi/memory/`（本地忽略，不动 `.gitignore`） |
| commit | 先跑密钥扫描，命中就拒绝，exclude 保持原样；通过后只 `git add/commit -- .pi/memory`，提交信息可改。提交失败会恢复 exclude |
| commit and push | 同上；没有 upstream 就只提交，不报错。如果分支上还有别的未推送提交，`git push` 会把它们一起推上去，所以推送前会先问你，推送要按两次 `enter` |

反方向搬走时，如果 `.pi/memory` 还被 git 跟踪，只提示命令，不自动 `git rm --cached`。

## 安全

- **写入闸**：模型用 `write`/`edit` 往记忆目录里写时，内容命中密钥模式（`sk-`、`ghp_`、`AKIA`、私钥头、通用 `token=...` 等）会被 `tool_call` 直接 block，回报文件名（edit 会标出是第几处修改）+ 行号 + 掩码预览，不回显密钥本身。判断目标路径时和 pi 的文件工具用同样的解析规则：`~`、`@` 前缀、`/c/...` 这类 Git Bash 路径、`file://`；Windows 下忽略大小写。
- **只是尽力而为**：通过 `bash`（`echo > file`、`sed -i` 等）写的内容拦不住。
- **提交前再扫一遍**：整个记忆目录。
- **不往仓库写配置**：见上文「配置」。

## 索引预算

| 上限 | 值 | 行为 |
|---|---|---|
| 行数 | 150 | 超出截断并插入 WARNING |
| 字节 | 12 KB | 按 UTF-8 字节计算（中文每字 3 字节），在最后一个换行处截断 |
| 单条钩子 | 160 字符 | `doctor` 警告 |

截断不会报错，只会少加载；`/memory doctor` 会告诉你该拆分了，面板里被截掉的那几条也会单独标 `!`。

## 索引快照与 prompt cache

注入的索引是**会话开始时的快照**，之后每轮都注入一模一样的文本。模型在会话中途写入新记忆，不会改变 system prompt，provider 的 prompt cache 也就不会因此失效。

以下时机会刷新快照：
- 上下文压缩之后：压缩本身已经让缓存失效，这时刷新不额外付出代价。
- `/memory switch`、`/memory open`、在面板里删除记忆：用户主动操作，刷新一次可以接受。
- `/new`、`/resume`、`/fork`、`/reload`：pi 会重建扩展实例，自然拿到新快照。

快照可能比磁盘上的文件旧，所以做了两层保护：
- 规则里要求修改 `MEMORY.md` 之前先 `read`。
- 写入闸检查对 `MEMORY.md` 的整文件 `write`：如果新内容会丢掉磁盘上已有的条目，直接 block，提示先读再用 `edit` 追加。确实要删条目时，用 `edit`。

## 不做的事

- 跨项目 / 全局记忆（跨项目偏好请放 `~/.pi/agent/AGENTS.md`）
- LLM 召回、embedding
- 回合结束的后台提取
- 自动整合 / autoDream
- 团队同步
- 目标目录非空时的 merge（先手动挪走）

## 开发

```sh
npm install        # 依赖是 @earendil-works/pi-coding-agent、pi-tui + vitest
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```

模块划分：

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 注册 hooks / 命令，串起所有模块；索引快照与写入闸 |
| `src/prompt.ts` | 注入文本（唯一来源） |
| `src/indexFile.ts` | `MEMORY.md` 解析、按字节截断、链接归一化、文件枚举 |
| `src/paths.ts` | `location` + `id` → 实际路径；与 pi 一致的工具路径解析 |
| `src/registry.ts` | 本机项目记录的读写（原子写，坏文件不覆盖） |
| `src/config.ts` | 位置类型；只读一次的旧版 `.pi/settings.json` 键 |
| `src/migrate.ts` | 搬家 / 接管、按阶段的崩溃恢复 |
| `src/git.ts` | exclude、只提交记忆目录、push |
| `src/doctor.ts` | 本地确定性 lint，产出带文件归属的结构化问题 |
| `src/secrets.ts` | 密钥模式与掩码 |
| `src/store.ts` | 面板的数据：条目 + 孤儿文件 + 各自的问题；删除（进回收站 + 删索引行）、清回收站 |
| `src/ui/panel.ts` | `/memory` 面板（Memories / Issues 两页） |
| `src/ui/viewer.ts` | 全文浮层 |
| `src/ui/choice.ts` | `/memory switch` 用的选择面板和单行输入 |
| `src/ui/kit.ts` | 选中行、确认态等绘制 helper（与 `/sessions` 同一份） |

---

本插件属于 Shizuku 系列 pi 插件（[pi-shizuku](https://github.com/AoShizuku/pi-shizuku)）：共用的左栏、设计语言与跨插件约定见总仓库。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
