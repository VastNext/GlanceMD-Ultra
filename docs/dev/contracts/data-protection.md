# 数据保护契约（file_codec / atomic_save / recovery）

- 日期：2026-09-04（Wave 2a / R5 流交付）
- 依据：主实施计划阶段 6（数据保护）Rust 侧三项交付；上行/下行通道与登记规则以 `docs/dev/interfaces.md` 为唯一事实源
- 范围：编码读写、原子保存、崩溃恢复区三个**纯逻辑核心模块**的 API 语义、IPC 契约与粘合层接线建议。命令注册表 handler（CommandContext 签名）由主 Agent 统一编写，本文是它的实现依据
- 状态：核心与探针测试已落地（`tests/file_codec_probe.rs` / `tests/atomic_save_probe.rs` / `tests/recovery_probe.rs` 全绿）；§4 IPC 部分待集成后回填 interfaces.md §2/§3 正式登记

## 1. 模块清单与集成声明

| 文件 | 内容 | 集成方需要做的 |
|---|---|---|
| `src/file_codec.rs` | 编码/换行元数据读写（阶段 6 交付项 2） | `main.rs` 追加 `mod file_codec;` |
| `src/atomic_save.rs` | 原子保存（阶段 6 交付项 1） | `main.rs` 追加 `mod atomic_save;` |
| `src/workspace/recovery.rs` | 崩溃恢复区（阶段 6 交付项 4） | `src/workspace/mod.rs` 追加 `pub mod recovery;` |

- **零新依赖**：三个模块只用 std / serde / serde_json（均已在 Cargo.toml），未改 Cargo.toml。
- 模块自含、不含 `crate::` 路径引用（探针测试以 `#[path]` 独立编译）；集成后如需统一原子写实现，可把 `recovery.rs` 内部的 `write_atomic` 换为 `crate::atomic_save::atomic_write`（行为等价，非必须）。
- 集成前模块带 `#![allow(dead_code)]`（同 `platform/mod.rs` 先例）；粘合层接入后可移除。

## 2. file_codec API

### 2.1 类型与函数

```rust
pub enum DetectedEncoding { Utf8, Utf8Bom, NonUtf8 }
pub enum Eol { Lf, Crlf, Mixed }
pub struct TextFile { pub content: String, pub original_eol: Eol, pub had_bom: bool }
pub const UTF8_BOM: [u8; 3];

pub fn detect(bytes: &[u8]) -> DetectedEncoding;
pub fn read_text(bytes: &[u8]) -> Result<TextFile, CodecError>;   // CodecError::UnsupportedEncoding
pub fn encode(text: &str, original: &TextFile) -> Vec<u8>;
```

### 2.2 语义约定

| 项 | 约定 |
|---|---|
| 编码支持 | 仅 UTF-8 / UTF-8 BOM（主计划 §0.2 不可重开决策）；非 UTF-8 **显式报错**，绝不静默错误解码。`detect` 与 `read_text` 语义一致：BOM + 非 UTF-8 内容同样判 NonUtf8 |
| 内容存储 | 确定换行风格（Lf/Crlf）时 `content` 统一为 **LF** 存储（与 `<textarea>` 编辑器形态一致）；`original_eol` / `had_bom` 记录原文件元数据 |
| 写回还原 | `encode` 先归一到 LF 再按 `original_eol` 转换（幂等）：Crlf → 全部 CRLF；Lf → 全部 LF；BOM 按原样回填 |
| Mixed 特例 | LF/CRLF 混杂文件读取时**原样保留**内容、写回时原样写出（统一化是有损的，保真优先于归一）。已知边界：前端 `<textarea>` 取值会把 CRLF 归一为 LF，故经 UI 编辑保存后的 Mixed 文件会统一为 LF——属可接受行为，不视为数据丢失（内容字符无损） |
| 零漂移保证 | 对未编辑内容：`encode(read_text(b).content, &meta) == b` 逐字节一致；全组合（{无BOM/LF, 无BOM/CRLF, BOM/LF, BOM/CRLF, Mixed} + 空文件/仅 BOM）由探针覆盖 |
| 无换行符文件 | 按 `Eol::Lf` 处理（写回不转换，零风险）；孤立 `\r`（Classic Mac 遗留）不计为换行、作为内容字符保留 |

## 3. atomic_save API

```rust
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), SaveError>;
pub enum SaveError { MissingParent(PathBuf), Io(std::io::Error) }
```

- 流程：同目录唯一临时文件 `.tmp-<pid>-<纳秒>-<计数>`（`File::create_new`，不覆盖任何已有文件）→ `write_all` → `flush` → `sync_all` → drop 句柄 → `fs::rename` 覆盖目标；任一步失败清理临时文件并报错，**目标旧内容保证完好**。
- Windows 覆盖依据：std 文档明确 `fs::rename` 对应 `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`（可覆盖已存在文件）；探针在 Windows 主平台实测成立。目标被其他进程独占时 rename 报 Access Denied，旧文件完好——可接受失败。
- 临时文件放在**目标同目录**：保证 rename 不跨卷（跨卷失去原子性）。
- `MissingParent`：父目录不存在/不是目录时显式报错，**不代建目录**。
- 崩溃残留：进程任意时刻被杀最多残留一个 `.tmp-` 半成品，目标不受影响。**残留清扫属启动期策略（粘合层职责）**：启动时扫一遍常用目录代价高，建议首版不做主动清扫，仅在用户打开受影响文件时原子重写自然覆盖；如需清扫，遍历目标目录删除 `.tmp-` 前缀文件即可（应用为单实例，见 `single_instance.rs`，无并发冲突）。

## 4. recovery API 与 IPC 契约

### 4.1 存储 API

```rust
pub struct RecoveryEntry { pub tab_id: String, pub path: Option<String>, pub content: String, pub saved_at_ms: u64 }
pub struct RecoveryStore;   // RecoveryStore::open(base_dir: &Path) -> Self
pub struct PendingReport { pub entries: Vec<RecoveryEntry>, pub warnings: Vec<String> }

snapshot(&RecoveryEntry) -> Result<(), RecoveryError>   // 同 tab 原子覆盖
list_pending() -> Vec<RecoveryEntry>                    // 损坏条目跳过，按 saved_at_ms 升序
list_pending_report() -> PendingReport                  // 同上 + 损坏条目警告
take(&str /*tab_id*/) -> Option<RecoveryEntry>          // 取走即删；损坏返回 None 且不销毁
discard(&str /*tab_id*/)                                // 尽力删除，静默
prune_before(max_age_ms: u64, now_ms: u64) -> usize     // 清 saved_at_ms < now_ms-max_age_ms；返回清理数；顺带清 .tmp- 残留与损坏条目
```

### 4.2 存储布局

- 目录：`{base_dir}/recovery/`，**惰性创建**；条目文件 `{清洗后 tab_id}.json`（白名单 `[A-Za-z0-9-_.]` + 多字节字母，其余替换 `_`；防 `.`/`..`、Windows 保留设备名、>100 字节截断）。条目 JSON 内 `tab_id` 保持原值，存取用同一映射对称可逆。
- **base_dir 约定（生产）**：`dirs::config_dir()/glancemd-ultra`（阶段 0 身份重命名后的配置目录名，与 `window_state.rs` 现有用法一致）。恢复区在工作区根之外 → 快照写入天然不触发阶段 2 文件监听。
- 条目 JSON 键名（serde 默认 snake_case，与 `workspace:*` 事件负载命名约定一致）：

```json
{ "tab_id": "...", "path": "G:/proj/note.md 或 null", "content": "...", "saved_at_ms": 1700000000000 }
```

### 4.3 上行命令（wire 命令 = 注册表 ID）

| wire 命令 | 负载（逻辑字段） | 行为 | 响应 |
|---|---|---|---|
| `workspace.recovery.snapshot` | `tab_id`、`path?`、`content`、`saved_at_ms` | `RecoveryStore::snapshot` 原子覆盖写入；建议前端仅对 dirty tab 周期发送（3–5 秒节奏，切 tab/失焦时补一次） | 无（fire-and-forget）。失败仅 `eprintln!` 记录，不打扰用户——恢复区是尽力而为的保险，不值得为它弹错误提示 |
| `workspace.recovery.list` | 无 | `list_pending_report()` | 下发 `workspace:recovery-available`（§4.4） |
| `workspace.recovery.restore` | `tab_id` | `take(tab_id)`（取走即删） | 下发 `workspace:recovery-restored`（§4.4） |
| `workspace.recovery.discard` | `tab_id` | `discard(tab_id)` | 无 |

- **信封承载**：现有 IPC 信封字段（`content/path/title/dirty`）装不下 `tab_id`/`saved_at_ms`。建议集成方二选一：(a) 信封增加可选 `data` 字段（JSON 字符串），`CommandPayload` 同步增加、恢复命令从 `data` 反序列化；(b) 在 `ipc.rs` 为这四条命令单独解析负载。**推荐 (a)**——后续阶段的结构化命令可复用。本文按逻辑字段表述，具体承载由集成方定夺后回填 `interfaces.md` §1.1。

### 4.4 下行事件

| 事件 | 负载 | 触发时机 |
|---|---|---|
| `workspace:recovery-available` | `{ entries: [{tab_id, path, saved_at_ms}], warnings: [string] }` | 启动时扫描完成后广播一次（**entries 只含元数据不含 content**，避免多 tab 大内容一次性塞进事件；内容经 restore 取回）；前端也可随时发 `workspace.recovery.list` 请求重发。`warnings` 透传 `list_pending_report().warnings` 供日志/状态栏提示 |
| `workspace:recovery-restored` | `{ tab_id, path, content }` | restore 成功后；前端以此创建 **dirty** tab（内容进入编辑器但不落盘，恢复后周期快照自动重建恢复条目，语义自洽） |

- 集成时把以上两条事件登记进 `interfaces.md` §3（workspace 语义，走 `workspace::events::emit` 通道，自动获得 `workspace.js` 分发）。
- `workspace:recovery-available` 事件负载中的条目与 `RecoveryEntry` 的差异（无 `content`）是有意为之，前端面板（Wave 2b RecoveryUI）按元数据渲染列表，点击恢复后再拉内容。

### 4.5 时机与清理策略（粘合层建议）

| 时机 | 动作 |
|---|---|
| 内容变化且 dirty | 前端节流后发 `workspace.recovery.snapshot`（每 tab 一个条目，`saved_at_ms` 用前端时钟即可，仅用于相对过期） |
| 保存成功（`file_saved`） | 前端发 `workspace.recovery.discard`（内容已落盘，恢复条目失去意义） |
| tab 正常关闭且不 dirty | 前端发 `workspace.recovery.discard` |
| 启动 | 启动流程早期调用一次 `prune_before(7*24*3600*1000, 当前毫秒)`（默认保留 7 天）；扫描后广播 `workspace:recovery-available` |
| 用户在恢复提示中选择放弃 | 逐条 `workspace.recovery.discard` |
| 优雅退出 | 已保存 tab 无需处理（保存时已 discard）；dirty tab 的恢复条目**保留**——它正是崩溃恢复的数据来源，退出不清 |

## 5. 粘合层接线建议（保存/打开路径替换）

| 现状 | 替换为 |
|---|---|
| `file_ops::read_file` = `fs::read_to_string`（`commands.rs::open_file` 调用） | `fs::read` + `file_codec::read_text`；`file_opened` 负载建议扩展为 `{content, path, original_eol, had_bom}`（前端透传给保存链路，避免 Rust 侧维护状态）；NonUtf8 → 现有 `error` 事件（消息已中文、明确"仅支持 UTF-8"） |
| `file_ops::write_file` = `fs::write`（`ipc.rs` save_file / save_as 调用） | `file_codec::encode(&content, &meta)` + `atomic_save::atomic_write`。`meta` 来自打开时的元数据（经前端回传或按 §2 语义以 `Eol::Lf + had_bom=false` 兜底——新建文件无历史风格可言） |

- `save_as` 首次保存到新路径时没有"原文件元数据"，直接 `encode(content, &TextFile{original_eol: Lf, had_bom: false, ..})` + `atomic_write` 即可。
- **与阶段 2 回环抑制的联动点（验收要求：原子保存改变写入路径后必须重验冲突矩阵）**：
  1. 自身保存事件在 Windows 上可能表现为 Modify **或** Rename（rename 覆盖目标）——阶段 2 watcher 的回环抑制逻辑必须覆盖"rename 覆盖已存在文件"这一事件形态，不能只按 Modify 抑制；
  2. 抑制窗口建议以"保存前记录的目标路径 + 短时间窗"为键，保存完成（rename 成功）后开启；
  3. 恢复区快照写入配置目录（工作区根之外），watcher 不会看到，无需抑制。
- 阶段 6 其余交付（自动保存开关、退出时 dirty 文件清单、大文件模式）属前端/命令编排层，不在本流范围。

## 6. 验证对照

| 验收项（主计划阶段 6） | 覆盖 |
|---|---|
| BOM 与换行符往返零漂移 | `tests/file_codec_probe.rs::往返_全组合_*` |
| 非 UTF-8 不静默错误解码 | `tests/file_codec_probe.rs::read_text_非utf8显式报错` |
| 原子保存在模拟中断后目标文件不损坏 | `tests/atomic_save_probe.rs::中断模拟_写入中途崩溃目标文件完好` |
| 崩溃恢复存储语义（存取/覆盖/损坏隔离/过期清理） | `tests/recovery_probe.rs` 全部 |
| kill -9 后重启可恢复（真实进程级） | 人工专项（主计划 §2 回归策略），依赖 §4/§5 粘合层接线完成后执行 |
| 冲突矩阵重跑（回环抑制） | 阶段 2 矩阵在 §5 接线合并后重跑，属集成方验收 |
