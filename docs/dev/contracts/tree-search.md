# tree-search 契约（目录树 + 全文搜索核心）

- 日期：2026-09-04
- 交付流：Wave 2a R1（`feat/tree-search`，基于 main@cbd4abd）
- 依据：主实施计划阶段 1（懒加载目录树）与阶段 4（后台全文搜索）；`docs/dev/interfaces.md`（信封与事件桥总契约）
- 性质：本文是 `tree.rs` / `search.rs` 两个纯逻辑核心及其 wire 层（命令/事件）的**唯一事实源**；interfaces.md 与本文冲突时以本文为准并回写 interfaces.md

## 0. 交付物与集成声明

| 文件 | 说明 |
|---|---|
| `src/workspace/tree.rs` | 懒加载目录树核心（阶段 1） |
| `src/workspace/search.rs` | 后台全文搜索核心（阶段 4） |
| `tests/tree_probe.rs` | tree 对外行为契约测试（含 10k 门禁测试，`--ignored`） |
| `tests/search_probe.rs` | search 对外行为契约测试（含 10k 门禁测试，`--ignored`） |

- 两个模块**自包含**：仅依赖 std 与 serde（derive，既有依赖），**零新增依赖、Cargo.toml 零改动**，不引用任何 `crate::` 路径。
- 集成声明（主 Agent 执行）：`src/workspace/mod.rs` 加 `pub mod tree;`、`pub mod search;`。声明后两个模块内嵌的 `#[cfg(test)]` 单元测试会被 bin 测试目标收集（当前经探针 `#[path]` 引入时已被收集，集成后与探针测试并存，已验证无冲突）。
- 不修改：Cargo.toml、main.rs、commands.rs、ipc.rs、前端、platform/。

## 1. tree.rs 契约

### 1.1 类型

```rust
pub struct TreeFilter {
    pub visible_exts: Vec<String>,   // 不区分大小写；条目可省略前导点（内部补点）
    pub excluded_dirs: Vec<String>,  // 不区分大小写，按目录名单段精确匹配
    pub show_hidden: bool,
}
// TreeFilter::default() 即主计划阶段 1 默认值：
//   visible_exts = [".md",".markdown",".txt",".json",".yaml",".yml",".toml",".ini",".csv"]
//   excluded_dirs = [".git","node_modules","target",".venv","dist","build",".cache"]
//   show_hidden = false

pub enum EntryKind { Dir, File, SymLinkFile }   // wire 值："dir" / "file" / "symlink-file"

pub struct TreeEntry { pub name: String, pub rel_path: String, pub kind: EntryKind }

pub enum TreeError { NotFound(PathBuf), NotADirectory(PathBuf), InvalidRelDir(String), Io(std::io::Error) }

pub fn list_dir(root: &Path, rel_dir: &str, filter: &TreeFilter)
    -> Result<Vec<TreeEntry>, TreeError>;
```

### 1.2 语义细则

- **懒加载**：单次调用只列一层，不做递归；调用方逐层展开。
- **rel_dir 约定**：`/` 分隔；空串 = 根；`rel_path` 输出同样 `/` 分隔（跨平台 wire 一致）；允许 `.` 段与冗余分隔符（内部清洗）。
- **越界拒绝**（`TreeError::InvalidRelDir`）：绝对路径（Unix `/x`；Windows `/x`、`C:/x`、`C:x`、UNC）、任何 `..` 段、含冒号或 NUL 的输入。注意 Windows 下 `"/etc".is_absolute()` 为 false，实现按路径组件判定（含盘符相对路径注入防御）。
- **排序**：目录恒在文件之前（含 SymLinkFile）；组内按名称排序，不区分大小写（同名回退字节序，稳定）。
- **隐藏**：`.` 开头的文件与目录默认隐藏；`show_hidden = true` 时显示，但仍受扩展名白名单约束。
- **扩展名**：取最后一个点之后的段，不区分大小写；无扩展名普通名（`LICENSE`）不可见；**纯点前缀名（`.env`、`.gitignore`）视为无扩展名**——不受白名单拦截，仅受隐藏开关约束（编辑器惯例）。
- **排除目录**：按目录名匹配（不区分大小写），不显示；目录符号链接同属"不显示"（见 §4 决策 1）。
- **符号链接**：文件符号链接显示为 `SymLinkFile`（受隐藏与扩展名过滤，按**链接名**判定扩展名）；断链符号链接按文件符号链接处理；**目录符号链接一律不显示**（不可展开，防越出可信项目根与环路）。
- **容错**：单条目元数据读取失败跳过该条目；目标目录不可读报 `Io`；不存在报 `NotFound`；非目录报 `NotADirectory`。

## 2. search.rs 契约

### 2.1 类型与默认值

```rust
pub struct SearchOptions {
    pub query: String,               // 空串 → SearchError::EmptyQuery
    pub case_sensitive: bool,        // 默认 false（ASCII 折叠）
    pub whole_word: bool,            // 默认 false
    pub use_regex: bool,             // true → SearchError::UnsupportedFeature("regex 引擎待集成")
    pub include_globs: Vec<String>,  // 默认空 = 不收窄
    pub exclude_globs: Vec<String>,  // 默认空
    pub max_file_bytes: u64,         // 默认 5 * 1024 * 1024
    pub max_results: usize,          // 默认 10_000；0 = 不扫描直接返回 truncated
}

pub struct SearchHit { pub rel_path: String, pub line: u32, pub col: u32, pub line_text: String }

pub struct SearchSummary { pub files_scanned: usize, pub hits: usize, pub truncated: bool, pub cancelled: bool }

pub enum SearchError { EmptyQuery, UnsupportedFeature(&'static str), InvalidGlob(GlobError),
                       RootNotFound(PathBuf), #[allow(dead_code)] Io(std::io::Error) }

pub fn search(root: &Path, opts: &SearchOptions, cancel: &AtomicBool,
              on_hit: &mut dyn FnMut(SearchHit)) -> Result<SearchSummary, SearchError>;
```

- `SearchOptions` 实现 `Serialize + Deserialize + Default`，容器级 `#[serde(default)]`：wire 反序列化时缺省字段回落默认值（前端可只传 `query` 与需覆盖的开关）。
- 取消与截断都是**正常返回**（`Ok(summary)`），不是错误。
- 遍历顺序确定：深度优先，同层文件与子目录按名称升序（不区分大小写），子目录在当前层文件处理完后继续下探。

### 2.2 行列与行文本语义

- `line` / `col` 均为 1 起；`col` 按 **Unicode 字符**计数（无效字节按替换符计 1）。
- 文件头 UTF-8 BOM 剥离后再匹配，首行列号不受影响。
- `line_text` 不含行尾符（CRLF 的 `\r` 被剔除）；超过 500 字符的行截断为"命中列前后窗口 + 省略号"（命中列约在窗口第 201 字符处，`col` 始终是全行真实列号，面板高亮以 `col` 为准）。
- 同一行多处命中 → 多条 SearchHit（各自 col）。
- 含换行的查询按**匹配起点所在行**报告。

### 2.3 匹配语义（字面量）

- 字节级匹配：大小写不敏感 = needle 与 hay 双向 ASCII 小写折叠（非 ASCII 字符精确比较，`İ`/`ß` 类 Unicode 折叠不支持，已记录）。
- 全词边界：词字符仅 `[A-Za-z0-9_]`（与 JS `\b` 一致）；**非 ASCII 字符视为边界**——全词搜索中文可正常命中。
- UTF-16 等编码文件被二进制嗅探天然跳过（阶段 4 范围仅 UTF-8/BOM）。

### 2.4 过滤语义

- **复用树默认过滤**（与 `tree.rs::TreeFilter::default()` 同步维护，两模块自包含各持一份常量，**改动需双侧同步**）：默认可见扩展名白名单、默认排除目录、隐藏文件/目录不搜索。
- **搜索不跟踪任何符号链接**（含文件符号链接；树中显示的 SymLinkFile 不参与搜索——防越出可信根，与 VS Code 默认 `followSymlinks=false` 一致）。
- `include_globs`：非空时文件必须命中其一（**只收窄**，不能把白名单外文件纳入搜索）。
- `exclude_globs`：命中**目录**即整棵剪枝；命中文件即跳过；优先于 include。
- `files_scanned` 计数 = 实际读入并完成匹配的文本文件；二进制/超大/不可读/被过滤文件不计。

### 2.5 glob 子集（手写，`compile_glob` 公开可复用）

| 语法 | 语义 |
|---|---|
| `*` | 任意字符序列，**不跨 `/`** |
| `**` | 独立路径段时跨段（可吞零段，`**/a.md` 命中 `a.md`）；段内（如 `a**b`）折叠为 `*` 语义 |
| `?` | 恰一个字符 |
| `{a,b}` | 一层展开（空候选允许）；**嵌套报错**；总展开数 > 64 报错 |

- 不含 `/` 的模式按**文件名（basename）**匹配任意层级；含 `/` 的按相对路径匹配。
- 匹配对 ASCII 大小写不敏感；单侧右花括号 `}` 为字面量。
- 非法模式返回 `GlobError { pattern, reason }`（中文原因），**不 panic**。
- 模式 `./` 前缀与尾部 `/` 在编译期清洗。

## 3. wire 层（命令与事件定稿）

### 3.1 上行命令（新命令，粘合层由主 Agent 编写）

| wire 命令 | 注册表 ID | 负载 | 行为 |
|---|---|---|---|
| `workspace.tree.list` | `workspace.tree.list` | `path?`：相对项目根的目录（`/` 分隔；缺省或空串 = 根） | **同步执行** `list_dir`（单目录 <50ms 已实测），结果经 `workspace:tree-listed` 事件立即返回；失败经 `workspace:error`（`TreeError::Display` 中文消息）。复用既有 `CommandPayload.path` 字段，ipc.rs 零改动 |
| `workspace.search.start` | `workspace.search.start` | `searchId: number`（前端生成的代际号）+ `options: SearchOptions`（snake_case 字段，缺省字段回落默认） | 校验 options（regex/空查询/非法 glob 以 `workspace:error` 回报）→ 置旧代际 cancel → 后台线程执行 `search`，增量经 `workspace:search-result`、完成经 `workspace:search-completed` 返回。需在 `CommandPayload` 增加可选字段（建议 `search_id: Option<u64>` + `options: Option<serde_json::Value>`） |
| `workspace.search.cancel` | `workspace.search.cancel` | `searchId: number` | 置当前搜索的 cancel 标志（每文件检查点生效，线程在毫秒级退出并回报 `cancelled: true`）。同上需要 `search_id` 字段 |

### 3.2 下行事件（新事件负载定稿）

| 事件 | 负载 | 触发时机 |
|---|---|---|
| `workspace:tree-listed` | `{ "relDir": string, "entries": [{name, rel_path, kind}] }` | `workspace.tree.list` 处理完成（含空目录：`entries: []`） |
| `workspace:search-result` | `{ "searchId": number, "hits": [SearchHit] }` | 后台搜索**批量**增量回报（建议每攒 100 条或每文件一批，见 §5） |
| `workspace:search-completed` | `{ "searchId": number, "summary": {files_scanned, hits, truncated, cancelled} }` | 搜索结束（自然完成 / 截断 / 取消三种情况统一由此事件收口） |

- 建议将 interfaces.md §3.3 预留的 `workspace:search-cancelled` **并入** `workspace:search-completed{cancelled:true}`，不再单独广播（待主 Agent 定稿回写）。
- 前端以 `searchId` 对齐请求与事件：新搜索发出后，旧 `searchId` 的事件直接丢弃。

### 3.3 需回写 interfaces.md 的登记项（主 Agent 集成时）

1. §2 命令表登记 §3.1 三条命令（handler 注册进 `commands::register_builtin()` 或模块 `init()`）。
2. §3.3 定稿 `workspace:tree-listed` / `workspace:search-result` / `workspace:search-completed` 负载；处置 `workspace:search-cancelled`。
3. §1.1 信封字段表补充 `searchId` / `options`（如经 IpcMessage 直连需同步扩展解析）。
4. `src/workspace/events.rs` 增加 SearchResult / SearchCompleted 事件变体（tree-listed 推荐由粘合层直接 `ipc::send_to_js` 返回，见 §5）。

## 4. 粘合层接线建议（CommandContext handler，主 Agent 编写）

### 4.1 workspace.tree.list（主线程同步执行）

```rust
fn tree_list(ctx: &CommandContext, payload: &CommandPayload) {
    let rel_dir = payload.path.as_deref().unwrap_or("");
    match workspace::tree::list_dir(workspace::current_root(), rel_dir, &workspace::tree::TreeFilter::default()) {
        Ok(entries) => ipc::send_to_js(ctx.webview, "workspace:tree-listed",
            &json!({ "relDir": rel_dir, "entries": entries })),   // entries 已实现 Serialize
        Err(e) => workspace::emit_error(e.to_string()),           // 中文消息
    }
}
```

- list_dir 已在核心内做 rel_dir 越界拒绝；粘合层可选叠加 `workspace::ensure_within_root` 复核。
- 未打开工作区时（无 current_root）按产品语义回 `workspace:error`。

### 4.2 workspace.search.start / cancel（后台线程 + mpsc → 事件桥）

```rust
static CURRENT: Mutex<Option<(u64, Arc<AtomicBool>)>> = ...;   // 当前搜索代际与取消标志

fn search_start(ctx: &CommandContext, payload: &CommandPayload) {
    let opts: SearchOptions = serde_json::from_value(payload.options.clone()?)
        .map_err(|e| emit_error(format!("搜索参数非法：{e}")))?;   // 反序列化失败中文回报
    // 快速校验路径（regex / 空查询 / 非法 glob 在 search() 内同步报错）
    let (tx, rx) = std::sync::mpsc::channel::<SearchHit>();
    let cancel = Arc::new(AtomicBool::new(false));
    // 旧搜索置取消，登记新代际
    if let Some((_, old)) = CURRENT.lock().unwrap().replace((search_id, cancel.clone())) {
        old.store(true, Ordering::Relaxed);
    }
    let root = workspace::current_root()?.to_path_buf();
    std::thread::Builder::new().name("workspace-search".into()).spawn(move || {
        let summary = search(&root, &opts, &cancel.as_ref(), &mut |h| { let _ = tx.send(h); });
        drop(tx);                                                // 关闭通道
        if let Ok(s) = summary { /* 由转发侧发出 completed */ }
    });
    // 转发侧（可用独立线程，或由搜索线程直接 emit——events::emit 线程安全）：
    //   攒批 100 条 → events::emit(Event::SearchResult { search_id, hits })
    //   rx 关闭后  → events::emit(Event::SearchCompleted { search_id, summary })
}
```

- 事件统一走 `workspace::events::emit`（EventLoopProxy 通道，跨线程安全，主线程分支回 `__fromRust`）。
- `events::emit` 本身线程安全，转发线程仅承担**攒批**（每 100 条或每文件一批，10k 命中下避免 10k 次 evaluate_script）与**代际过滤**（CURRENT 中 searchId 不匹配时丢弃迟到事件）。
- 取消响应性：核心在每文件检查点检查 cancel；单个 ≤5MB 文件内部处理为毫秒级，满足阶段 4"取消后 500ms 内退出"门禁。

## 5. 性能实测（10k 门禁，阶段 1/4 前期实测）

- 方法：`python tools/gen-test-tree.py --count 10000 --root tests/.tmp/tree-10k`（10000 可见文件 + 505 排除目录文件 + 8 隐藏文件，60 个目录，总 3.5MB）→ `cargo test --release -- --ignored --nocapture`（tree_probe / search_probe 的 `#[ignore]` 测试）→ 删除临时树。
- 环境：Windows 10 22H2（19045）；Intel i5-3470（4C4T @3.2GHz，2012 年平台，**低于**主计划"中端硬件"基准，数据偏保守）；SATA SSD；release 模式（`opt-level="s"`、`lto="fat"`）。

| 指标 | 实测 | 门禁 | 结论 |
|---|---|---|---|
| 根目录 `list_dir` | 0.43ms（5 条目） | 单目录 < 50ms | 通过 |
| 全树 60 目录逐层 `list_dir` 累计 | 47.8ms（平均 0.8ms/目录） | — | 前端全量展开一次的累计成本也远低于 UI 卡顿阈值 |
| 单目录最大 `list_dir` | 1.27ms（branch-4，173 条目） | 单目录 < 50ms | **通过（≈1/40）** |
| 搜索首结果（高频查询 `needle-`） | **1.51ms** | 首结果 < 1s | **通过** |
| 搜索全量（高频查询，截断于 10000 条上限） | 2.29s（扫描 6219 文件） | 全量 < 5s | 通过 |
| 搜索全量（唯一锚点 `needle-04217`，扫完全部 10000 文件） | **3.69s**（命中 2） | 全量 < 5s | **通过** |
| 取消粒度 | 每文件检查点（实测单文件处理毫秒级） | 线程 500ms 内退出 | 通过（预期） |

- 正确性联动：10k 测试同时断言全树可见文件恰为 10000（过滤语义正确性）、全量搜索 `files_scanned == 10000`。
- 附注：全量 3.69s 主要是 10k 次文件打开的 I/O 成本；更低延迟可在集成后按需评估（如按目录并行扫描），当前满足门禁、不做优化。

## 6. 语义决策记录（供主 Agent 复核）

1. **目录符号链接不显示**：EntryKind 三值约束下无法表达"可显示但不可展开"；同时规避越出可信项目根（symlink 指向根外）与环路。若产品需要，后续可增 `symlink-dir` 类型（wire 值预留命名 `"symlink-dir"`）。
2. **搜索不跟踪符号链接**（含文件符号链接）：防越根读取；树中显示的 SymLinkFile 不参与搜索。
3. **排除目录大小写不敏感**（`Build` 也被排除）：跨平台一致优先；Linux 上极少误伤。
4. **regex 未实现**：`use_regex=true` 返回 `UnsupportedFeature("regex 引擎待集成")`；是否引入 regex crate 由主 Agent 阶段 4 集成时裁决（注意二进制体积预算 ≤5MB，regex 约 +0.3~0.5MB）。
5. **纯点前缀名视为无扩展名**（`.env` 不受白名单拦截，show_hidden 放行后可见）；搜索侧因"隐藏文件一律不搜"，该分支不可达，语义一致。
6. **超长行截断**：line_text ≤ 500 字符 + 省略号，命中列保持全行真实值（面板以 col 高亮，勿按 line_text 长度定位）。
7. **max_results = 0** 视为"上限 0"：不扫描，直接返回 `truncated: true`。

## 7. 变更记录

- 2026-09-04（Wave 2a R1）：初版。tree.rs / search.rs 核心 API 与语义、wire 命令与事件负载定稿、粘合层接线建议、10k 性能实测数据。
