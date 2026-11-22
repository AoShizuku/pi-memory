# pi-memory 设计：给人用的 `/memory`

> 记忆本身（注入、写入闸、搬家）的设计见 `README.md`。这里只讲人怎么查看和管理记忆。

## 1. 问题

pi-memory 一开始只考虑了模型这一侧：模型读索引、写主题文件，插件负责注入和设闸。人这一侧只有几条零散的子命令，而且没有一条用到插件统一的设计语言（`plugins/design_style.md`）：

| 入口 | 原来的做法 | 问题 |
|---|---|---|
| `/memory` | `pi.sendMessage` 往对话里插 6 行 `key: value` | 看不到任何一条记忆；custom message 会以 **user 消息**的身份进入模型上下文，本机路径、record 路径这些只对人有用的信息被塞给了模型 |
| `/memory doctor` | 同样插进对话，是一份 errors / warnings 文本 | 问题列出来了，却没法当场处理；报告同样进了上下文 |
| `/memory doctor --purge` | pi 原生 `confirm`，文案是中文 | 原生弹框；也是 `design_style.md` §11 记着的唯一一处中文界面 |
| `/memory switch` | 原生 `select`（选项是 `"project - keep memory in …"` 这种长句）+ 原生 `confirm` + 原生 `input` | 和其他插件的面板完全两样 |

人真正需要的是三件事：我有哪些记忆、每条写了什么、哪些出了问题，以及删掉不要的那条。这三件都做不到。

## 2. 方案

### 2.1 `/memory` 是一个底部面板

底部面板（不带 `overlay` 的 `ctx.ui.custom`），布局照 `/sessions`：左栏列表，右侧方框预览。两页，用 `Tab` 切换。

```text
─ Memories  Issues 2 ────────────────────────────── 5 memories · index 4 lines 0.2/12 KB · local ─
search   type to filter by title, hook, file or content
▎   用户偏好中文回复        feedback  ╭─ 用户偏好中文回复 ─────────────── feedback · 2d ─╮
    pi 钉在 v1.5.2           project  │ 回复用中文，技术名词保留原文                      │
  × 旧的 hud 布局约定              —  │                                                   │
    飞书文档读写                   —  │ 回复一律用中文，技术名词保留原文。                │
  ! tmp                            —  │ Why: 用户明确纠正过两次英文回复。                 │
                                      ╰─ lang.md ─────────────────────────────────────────╯

type to search · ↑↓ select · enter view · ctrl+d delete · tab issues · esc close
```

- **Memories 页**：先按索引顺序列出每条索引项，再列出索引没提到的主题文件。
  - 每行第 2 列是问题标记：有 error 时 `×`，只有 warning 时 `!`。所有行都没有问题时，这一列不画。
  - 行尾是 frontmatter 里的 `type`，没有就写 `—`。整个目录都没有 `type` 时，这一列不画。
  - 预览框：上框写标题、`type · 相对时间`；框内依次是这条记忆的问题、索引钩子（muted），然后是去掉 frontmatter 的正文；下框写文件名。
  - 窄屏（< 80 列）不画预览框，选中行下面多一行钩子。
- **Issues 页**：doctor 的全部发现，一行一条：标记、短标签、对象（文件 / 链接 / 回收站路径）。选中行下面展开完整说明。`enter` 跳到它说的那条记忆。
- **顶边**（`design_style.md` §4.1）：页签在左，后面是 Issues 的数量，颜色取最严重的那一级；右侧是记忆数、索引行数、索引字节数 / 12 KB（超预算时 warning 色）、存放位置。窄屏时只留记忆数和位置。
- **超出索引预算的条目**单独标 `!`。doctor 只对整份索引报一次超预算，但人需要知道具体是哪几条没被注入。

### 2.2 只读，不编辑

面板里不改记忆内容。

- 记忆由模型维护。写入闸、索引快照、`MEMORY.md` 整文件覆盖保护，这一套都是按模型写入设计的；人手改走的是另一条路，容易和快照、闸门打架。
- 在终端里画一个多行编辑器不值得；pi 原生编辑器又会把设计语言带回去。
- 需要改内容时，让模型改，或者用 `/memory open` 改索引（保留原样，见 §3）。

`enter` 打开居中浮层看全文（§7）。全文包括 frontmatter，原样展示，自己处理滚动（`↑↓`、`pgup/pgdn`、`home/end`、滚轮）。文件打开期间不会变长，所以浮层高度跟着内容走，上限是终端高度的 80%。

### 2.3 删除：`ctrl+d` 按两次

面板支持打字搜索，`x` 会被当成输入，所以照 `design_style.md` §6.5 用 `ctrl+d ctrl+d`。确认态下，提示行写明这次删除会做什么：

| 对象 | 删除做什么 |
|---|---|
| 索引项，文件存在 | 文件移进回收站，删掉这一行索引 |
| 索引项，还有别的索引行指向同一个文件 | 只删这一行，文件保留 |
| 索引项，文件不存在（悬空） | 只删这一行 |
| 外链 | 只删这一行 |
| 没进索引的文件 | 文件移进回收站 |

1. **不硬删。** 文件移到 `~/.pi/agent/memory/.trash/<id>-file-<时间戳>/<相对路径>`，和搬家用的是同一个回收站，mtime 设为当前时间，7 天保留期从这一刻算起。跨盘时退化为复制后删除。
2. **索引行按原文精确匹配。** 删除前重新读一次 `MEMORY.md`，删掉和面板加载时一字不差的那一行，其余行原样保留，包括模型在面板打开后新加的行。找不到这一行（被改过）就拒绝，什么都不动，面板重新加载。
3. **删除之后刷新注入快照**，代价是一次 prompt cache 未命中，和 `/memory open` 一样。不刷新的话，模型看到的索引里还留着已删的条目。

### 2.4 Issues 页上清回收站

原来的 `/memory doctor --purge` 是一次性删光所有过期副本，靠中文的原生 `confirm` 确认。现在过期副本作为 `old trash` 出现在 Issues 页上，逐条 `ctrl+d ctrl+d` 永久删除。`purgeTrash` 拒绝回收站根目录之外的路径。

`--purge` 这个参数仍然接受，效果等同于 `/memory doctor`：打开面板，停在 Issues 页。

### 2.5 `/memory switch`：底部选择面板

原生的 `select` / `confirm` / `input` 换成两个小组件（`ui/choice.ts`）：

```text
Memory location  stored on this machine

▎ project           D:/repo/.pi/memory · can be committed
  local ● current   ~/.pi/agent/memory/repo-1 · this machine only

  from  ~/.pi/agent/memory/repo-1
  to    D:/repo/.pi/memory

  The current directory is copied, verified, then moved into the trash; nothing is deleted in place.

↑↓ select · enter move · esc cancel
```

- **位置面板**：两个位置都列出来，带上路径，当前位置标 accent 色 `● current`。选中当前位置时按 `enter` 只在顶边右侧提示，不做任何事。选中另一个位置时，列表下面写出 from / to 和搬家规则。
- **按两次 enter 才搬家。** 这是对 §6 的一处偏离：§6 的 `x x` / `ctrl+d ctrl+d` 是给列表上的附带操作用的；这个面板只有「搬家」一个动作，所以动作键就是 `enter`。确认态的行为照 §6：竖标和底色换成 error，提示行换成 `press enter again to move memory in the project · any other key cancels`，其他任何键都只取消确认。
- 命令里写了目标（`/memory switch project`）时，同样弹出位置面板，并预先选中这个目标；面板本身就是确认。
- **入库面板**：`keep untracked` / `commit` / `commit and push`。提交信息用单行输入面板，默认值预填。分支上还有别的未推送提交时，再弹一个 `Push now?` 面板，`push N commits` 同样要按两次 enter。

### 2.6 非 TUI 模式

RPC 和 print 模式下不开面板，也不调用原生对话框：

- `/memory`、`/memory status` 用 `notify` 输出状态文本。
- `/memory doctor` 用 `notify` 输出报告。有过期副本时，提示到交互式 TUI 里去清。
- `/memory switch project|local` 直接执行：命令里写明的目标就是确认。不写目标只给用法提示。入库那一步只提示命令，不自动执行。

**所有输出都不再走 `sendMessage`**，不会再有任何内容进入模型上下文。

## 3. 明确不做

| 不做 | 理由 |
|---|---|
| 面板内编辑 | §2.2 |
| 孤儿文件一键补进索引（用 description 当钩子） | 第一版先只标出来；补索引需要决定钩子怎么写，交给模型 |
| 重排索引顺序 | 顺序只影响超预算时截掉哪几条，属于少见需求 |
| 删除 `/memory open` | 它是现有功能，用户没说要去掉；它用的是 pi 原生编辑器，不在这次对齐的范围内 |

## 4. 结论

1. `/memory` 是一个底部面板，分 Memories / Issues 两页，doctor 并进 Issues 页，问题标在对应的行上。
2. 面板只读，只做删除：`ctrl+d` 按两次。文件进回收站，不硬删；索引行按原文精确匹配，被改过就拒绝；删除后刷新注入快照。
3. 过期的回收站副本在 Issues 页上逐条清理，取代原来的中文 `confirm`。
4. `/memory switch` 改成底部选择面板，按两次 enter 才搬家；入库方式、提交信息、推送确认都换成同一套组件。
5. 状态和报告一律用 `notify`，不再用 `sendMessage` 把内容塞进模型上下文。
6. 顺手修掉一个旧 bug：`parseIndex` 不认 CRLF 行尾。Windows 上用 CRLF 保存的 `MEMORY.md` 会被整份当成 malformed：doctor 把每一行都报成格式错误；写入闸也认不出整文件覆盖时丢掉了哪些条目，覆盖保护形同虚设。注入用的是原文，不受影响。

## 设置面板接入

记忆是数据，不搬进 `/shizuku` 设置面板：那里只放一个跳到 `/memory` 的入口，外加当前项目的位置（local / project）、记忆目录和 `PI_MEMORY_AGENT_DIR` 是否生效三项只读信息。
