# watcher 契约（文件监听与去抖核心）

- 流归属：Wave 2a"文件监听"流（R2）交付，主计划阶段 2 的 Rust 侧。
- 上位契约：`docs/dev/interfaces.md`（唯一事实源）；本文是其 `workspace:file-changed` / `workspace:watcher-error` 相关条目的**实现层细化**，两者冲突时以 interfaces.md 为准并回改本文。
- 交付物：`src/workspace/watcher.rs`（纯逻辑核心 + notify 接入层）、`tests/watcher_probe.rs`（探针测试）、`Cargo.toml`（`notify = "7"`，实际解析 7.0.0）。
- **命令粘合层不在本流范围内**：命令注册、事件桥转发由主 Agent 统一编写，本文给出对接所需的全部约定。

## 1. 事件流总览

```text
notify 后端（ReadDirectoryChangesW / FSEvents / inotify，递归监听项目根）
  │ notify::Event
  ▼
map_notify_event()            纯映射：Create/Modify/Remove/Rename(Both|From|To) → RawEvent
  ▼
is_excluded()                 排除目录（组件名精确匹配）过滤，命中即丢弃
  ▼
LoopSuppressor::is_self()     回环抑制，命中发 WatchOutcome::SelfSuppressed 并丢弃
  ▼
Debouncer::feed()             300ms 滑动窗口按主路径合并
  ▼
冲刷线程（100ms tick）        届满未决事件 → Debouncer::flush(now)
  ▼
mpsc::Sender<WatchOutcome>    ExternalChange(MergedEvent) / SelfSuppressed / Error(String)
  ▼
【粘合层，待集成】接收线程 recv → 转发事件桥
  ▼
workspace:file-changed {path, kind, ts}        → 前端 window.Workspace.on 订阅
workspace:watcher-error {message}              → 前端状态栏提示
```

要点：

1. **粘合层必须尽早调用 `WatchService::take_receiver()`**（每服务至多一个接收端，`new` 的返回签名固定为 `Self`，接收端暂存在服务内部），并派一个线程持续 `recv`；收到即转发，不得在回调线程里做重活。
2. 事件桥转发走既有通道：粘合层为 `workspace::events::Event` 扩充变体（或等价机制），经 `events::emit` → 主线程 → `ipc::send_to_js`。SelfSuppressed 不下发 JS（建议粘合层仅计数/记日志）。
3. WatchService 自带去抖，粘合层**不要再**对 `workspace:file-changed` 做节流。

## 2. 类型与 API（`src/workspace/watcher.rs`，模块自包含，集成时在 `workspace/mod.rs` 声明 `pub mod watcher;`）

| 项 | 说明 |
|---|---|
| `EventKind` | `Created` / `Modified` / `Removed` / `Renamed { from, to }`；Display 完整（中文） |
| `RawEvent` | `{ kind, path, ts_ms }`；**不变式：Renamed 时 `path == from`**（用 `RawEvent::renamed(from, to, ts)` 构造保证）；`ts_ms` 为 Unix 毫秒，测试可注入合成时间戳 |
| `MergedEvent` | `Created/Modified/Removed { path, ts_ms }` / `Renamed { from, to, ts_ms }`；`ts_ms` 取窗口内最后一次观测；`kind_name()` 返回 `"created"/"modified"/"removed"/"renamed"`；`involved_paths()` 返回全部涉及路径 |
| `Debouncer` | `new()`（300ms）/ `with_window(ms)`；`feed(RawEvent) -> Vec<MergedEvent>`；`flush(now_ms)`（仅冲刷已届满项）/ `flush_all()`（强制，停机用）；`is_empty()` |
| `LoopSuppressor` | 线程安全可 Clone；`mark(op_id, paths)`（同 id 覆盖）/ `complete(op_id)`（未知 id 为 no-op）/ `is_self(&path) -> bool`；`new()` 默认宽限 750ms，`with_grace(Duration)` 可调 |
| `WatchService` | `new(root, exclude: &[String]) -> Result<Self, WatchError>`；`take_receiver()` / `suppressor()` / `pause()` / `resume()` / `is_paused()` / `root()`；`Drop` 反注册监听并停冲刷线程 |
| `WatchOutcome` | `ExternalChange(MergedEvent)` / `SelfSuppressed` / `Error(String)`；Display 完整 |
| `WatchError` | `NotFound` / `NotADirectory` / `Io` / `Notify(notify::Error)`；Display 中文、实现 `std::error::Error` |
| `is_excluded(path, exclude) -> bool` | 纯函数：路径任一组件名与列表项**整段相等**即命中（`target` 不误伤 `mytarget`、`target.md`）；区分大小写 |
| `map_notify_event(&notify::Event, ts) -> Vec<RawEvent>` | 纯函数：`Create→Created`、`Remove→Removed`、`Modify(Name(Both))→Renamed`、`Name(From)→Removed`、`Name(To)→Created`、其余 `Modify→Modified`、`EventKind::Any→Modified`（防御性）、`Access/Other→丢弃` |
| `DEFAULT_EXCLUDES` | `[".git", "node_modules", "target", ".venv", "dist", "build", ".cache"]` |
| `DEBOUNCE_WINDOW_MS` / `SELF_GRACE_DEFAULT_MS` | `300` / `750` |

## 3. 下行事件负载（粘合层按此构造）

### `workspace:file-changed`

```json
{ "path": "G:/proj/notes/a.md", "kind": "modified", "ts": 1730000000000 }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `path` | string | **当前路径**：created/modified/removed 为受影响路径；renamed 为 `to`（新路径）。绝对路径，已剥离 Windows `\\?\` 前缀 |
| `kind` | string | `"created"` \| `"modified"` \| `"removed"` \| `"renamed"`（即 `MergedEvent::kind_name()`） |
| `ts` | number | 合并事件最后观测时间（Unix 毫秒），前端仅用于排序/去抖展示，不得参与逻辑判定 |
| `from` | string | 仅 `kind == "renamed"` 时附加：原路径 |

### `workspace:watcher-error`

```json
{ "message": "文件监听启动失败：…" }
```

`WatchOutcome::Error(msg)` 原文（notify 后端错误文本，英文为主）。前端状态栏短暂标红即可；连续 Error 建议做频次抑制（如 3s 合并），避免刷屏。

### 与 interfaces.md §3.3 的关系（集成裁决点）

interfaces.md 预留了按种类细分的 `workspace:file-created / file-renamed / file-deleted` 等事件名。本契约按任务书收敛为**单一 `workspace:file-changed` + `kind` 字段**（前端一处订阅、switch 分发，最小面积）。若集成时主 Agent 决定启用细分事件名，按 `kind` 一对一改名即可（负载字段不变，renamed 事件用 `workspace:file-renamed`、removed 用 `workspace:file-deleted`），并需先更新 interfaces.md 再写代码。

## 4. clean/dirty tab 粘合建议（阶段 2 冲突矩阵的 Rust 侧职责边界）

Rust 侧只负责"把外部变更准确、去抖地递交给前端"；clean/dirty 判定与 UI 全在前端（`TabManager` 拥有 tab 状态）。建议分发逻辑（前端 workspace.js 或独立 `file-watcher.js`，经 `window.Workspace.on('workspace:file-changed', …)` 订阅）：

| MergedEvent | clean tab | dirty tab |
|---|---|---|
| `Modified { path }` | 自动重载内容，保留光标/滚动位置（重载前快照、重载后恢复），状态栏短暂提示"已自动重载" | 顶部非模态冲突横幅：【重新加载】【保留编辑版本】【另存为】；选"保留编辑版本"后再次保存必须二次确认覆盖 |
| `Created { path }` | 项目树插入节点；未打开则不动 tab | 同左（不影响编辑缓冲区） |
| `Removed { path }` | 关闭或标记该 tab（建议：保留内存内容，tab 标记"磁盘文件已删除"，提供【另存为】【关闭】） | 同左，dirty 内容绝不静默丢弃 |
| `Renamed { from, to }` | 更新 tab 路径/标题/保存目标，树节点改名；等价于"from 删除 + to 出现"的唯一识别形态 | 同左，dirty 状态保持 |

回环自证：自身保存产生的事件已被 LoopSuppressor 吞掉（`SelfSuppressed`），clean tab 自动重载不会与保存互相触发（主计划回归项"自身保存不触发自动重载循环"由此保证）。

## 5. 回环抑制使用规程（含阶段 6 原子保存联动点）

粘合层与后续模块按以下规程使用 `WatchService::suppressor()`（**与监听回调共用同一实例，勿自建**）：

1. `op_id`：进程内全局递增 `u64`（粘合层持 `AtomicU64`）。
2. **写盘动作开始前**调用 `mark(op_id, paths)`——事件可能已在去抖器队列里，mark 必须赶在写盘前（`emit_merged` 有递交前复核兜底，但不要依赖）。
3. 写盘返回后调用 `complete(op_id)`；路径进入 750ms 宽限期，覆盖文件系统通知延迟。
4. **阶段 6 原子保存联动**：`atomic_save` 写临时文件 + rename 替换目标时，`mark(op_id, [temp_path, target_path])` 两个路径都要登记（rename 事件任一端命中即抑制），save 返回后 `complete(op_id)`；重验回环抑制时无需改 watcher 侧代码。
5. 阶段 3 文件操作（新建/重命名/删除/移动）同规程：操作前 mark 全部受影响路径（移动 = 源 + 目标）。
6. 路径坐标系：mark/complete 直接使用与 `workspace:file-changed` 一致的展示路径（绝对、无 `\\?\` 前缀）。`LoopSuppressor` 匹配时自动剥离 verbatim 前缀，Windows 下再做斜杠/大小写宽松匹配兜底；但不做需要 I/O 的 canonicalize——两侧务必同一坐标系。

## 6. pause/resume 命令 ID（建议，注册由粘合层执行）

| 注册表 ID（= wire 命令名） | 行为 | 备注 |
|---|---|---|
| `watcher.pause` | `WatchService::pause()` | 暂停期间到达的事件**丢弃不回放** |
| `watcher.resume` | `WatchService::resume()` | 建议粘合层同时触发一次项目树手动刷新，补齐暂停期间变更 |

命名沿用 `file.open` / `workspace.open` 的 `<域>.<动作>` 风格；命令面板（阶段 5）可再加一个 toggle 包装，按 `is_paused()` 分发到两者。若排期移至阶段 5，ID 保持本表。

## 7. 语义细节与边界（消费方须知）

- **去抖是滑动静默期窗口**：间隔 `< 300ms` 的同路径事件一直合并，平息 300ms 后产出；持续不断写入的文件在平息前不产出（编辑器只关心最终状态，属设计取舍）。间隔恰为 300ms 开新窗口；`ts` 取最后观测。
- **排除过滤**：组件名整段相等；`exclude` 传空切片时启用 `DEFAULT_EXCLUDES`；重命名任一端落入排除目录则整条丢弃（树侧由手动刷新兜底）。
- **重命名拆分形态**：部分后端（inotify 部分场景）把 rename 报成 `From`/`To` 两个事件 → 映射为 `Removed(from)` + `Created(to)`，即主计划"可唯一识别时更新路径，否则按删除+新增处理"的后者；Windows 主平台报 `Both` → 单个 `Renamed`。
- **暂停语义**：`pause` 丢弃而非缓存，resume 不回放。
- **生命周期**：每工作区一个 WatchService；换根 = drop 旧服务再 `new` 新服务（Drop 即反注册并停线程，接收端 `recv` 因发送端关闭自然结束）。
- **错误恢复**：notify 后端错误以 `WatchOutcome::Error` 上报，服务不自动重建；粘合层可视策略提示用户手动刷新。

## 8. 测试与验证

- `tests/watcher_probe.rs`（探针模式，`#[path]` 引入源码，随 `cargo test` 运行）：事件风暴（1s/100 次→1 事件）、四条规格合并规则、重命名语义、窗口边界（299/300ms）、多路径独立性、抑制器 mark/complete/is_self 与并发、verbatim 前缀匹配（Windows）、`is_excluded` 过滤、notify 三种重命名形态映射、Display 完整性、WatchService 构造校验。
- `#[ignore]` 保留一条真实 notify 集成冒烟（变更到达 / 排除过滤 / 暂停恢复），本地 `cargo test -- --ignored` 执行；时序敏感，CI 不跑。
- 粘合层集成后需补充：`workspace:file-changed` 负载与前端消费的 Playwright 冒烟（归主 Agent 集成验收）。
