//! 文件监听与去抖核心（主实施计划阶段 2 的 Rust 侧交付，Wave 2a watcher 流）。
//!
//! 三层结构：
//! - [`Debouncer`]：纯去抖合并器，不依赖 notify；事件时间戳由调用方注入
//!   （[`RawEvent::ts_ms`]），测试可用合成时间序列精确验证窗口语义；
//! - [`LoopSuppressor`]：纯回环抑制器（线程安全），应用自身保存 / 文件操作
//!   前后调用 [`LoopSuppressor::mark`] / [`LoopSuppressor::complete`]，监听
//!   回调中命中 [`LoopSuppressor::is_self`] 的事件按自身操作丢弃；
//! - [`WatchService`]：notify 接入层——递归监听项目根，默认排除目录过滤，
//!   原始事件 → [`RawEvent`] → [`Debouncer`] → `mpsc::Sender<WatchOutcome>`。
//!
//! 命令粘合层（命令注册、事件桥转发到 JS）由集成方编写；对接方式、事件
//! 负载与 pause/resume 命令 ID 见 `docs/dev/contracts/watcher.md`。
//!
//! 可测性说明：本 crate 是纯 bin crate，未被 `main.rs` 引用的模块不参与
//! 编译，因此本文件必须自包含——只允许依赖 std 与 notify，禁止 `crate::`
//! 路径引用。测试载体为 `tests/watcher_probe.rs`（`#[path]` 引入本文件）；
//! 主 Agent 集成时在 `src/workspace/mod.rs` 声明 `pub mod watcher;` 后，
//! 本模块进入产品编译，探针测试继续作为对外行为契约存在，两者不冲突。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{recommended_watcher, RecursiveMode, Watcher};

// ---------- 常量 ----------

/// 去抖窗口：窗口内同路径事件合并为一个（主计划阶段 2 验收值为 300ms）。
pub const DEBOUNCE_WINDOW_MS: u64 = 300;

/// 回环抑制宽限期默认值：`complete(op_id)` 之后这段时间内，该操作触碰过的
/// 路径仍被视为自身操作（覆盖文件系统通知的固有延迟）。
pub const SELF_GRACE_DEFAULT_MS: u64 = 750;

/// WatchService 默认排除目录（`files.watcherExclude` 默认值）。
/// `WatchService::new` 的 `exclude` 参数传空切片时启用本列表。
pub const DEFAULT_EXCLUDES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "dist",
    "build",
    ".cache",
];

/// WatchService 冲刷线程的轮询间隔：决定合并事件在窗口届满后的最大附加延迟。
const FLUSH_TICK: Duration = Duration::from_millis(100);

// ---------- 原始事件 ----------

/// 去抖器输入的事件种类（与 notify 后端解耦的最小语义集）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventKind {
    /// 新文件/目录出现。
    Created,
    /// 内容变化（写入、追加、元数据以外的实际变更）。
    Modified,
    /// 文件/目录被删除。
    Removed,
    /// 同一根内重命名 / 移动：`from` 消失、`to` 出现。
    Renamed { from: PathBuf, to: PathBuf },
}

impl std::fmt::Display for EventKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EventKind::Created => write!(f, "创建"),
            EventKind::Modified => write!(f, "修改"),
            EventKind::Removed => write!(f, "删除"),
            EventKind::Renamed { from, to } => {
                write!(f, "重命名 {} → {}", from.display(), to.display())
            }
        }
    }
}

/// 进入去抖器的原始事件。
///
/// 字段 `path` 是事件的主路径：对 [`EventKind::Created`] / [`Modified`] /
/// [`Removed`] 即受影响路径；对 [`EventKind::Renamed`] 恒等于 `from`
/// （合并键即主路径，重命名目标保存在 kind 内）。用 [`RawEvent::renamed`]
/// 构造可保证该不变式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEvent {
    pub kind: EventKind,
    pub path: PathBuf,
    /// 事件时间戳（Unix 毫秒）。生产路径由 [`now_ms`] 生成；测试可注入
    /// 合成时间戳以精确验证窗口语义。
    pub ts_ms: u64,
}

impl RawEvent {
    /// 构造重命名事件：`path` 与 `from` 保持一致。
    pub fn renamed(from: PathBuf, to: PathBuf, ts_ms: u64) -> Self {
        RawEvent {
            kind: EventKind::Renamed {
                from: from.clone(),
                to,
            },
            path: from,
            ts_ms,
        }
    }

    /// 事件涉及的全部路径（重命名含来源与目标，供排除/抑制判定使用）。
    pub fn involved_paths(&self) -> Vec<&Path> {
        let mut v = vec![self.path.as_path()];
        if let EventKind::Renamed { to, .. } = &self.kind {
            v.push(to.as_path());
        }
        v
    }
}

impl std::fmt::Display for RawEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {}（{}ms）",
            self.kind,
            self.path.display(),
            self.ts_ms
        )
    }
}

// ---------- 合并事件 ----------

/// 去抖器输出的合并事件：窗口届满后每个路径至多产生一个。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergedEvent {
    Created {
        path: PathBuf,
        ts_ms: u64,
    },
    Modified {
        path: PathBuf,
        ts_ms: u64,
    },
    Removed {
        path: PathBuf,
        ts_ms: u64,
    },
    Renamed {
        from: PathBuf,
        to: PathBuf,
        ts_ms: u64,
    },
}

impl MergedEvent {
    /// 事件涉及的全部路径（重命名含来源与目标）。
    pub fn involved_paths(&self) -> Vec<&Path> {
        match self {
            MergedEvent::Created { path, .. }
            | MergedEvent::Modified { path, .. }
            | MergedEvent::Removed { path, .. } => vec![path.as_path()],
            MergedEvent::Renamed { from, to, .. } => vec![from.as_path(), to.as_path()],
        }
    }

    /// 前端语义分类（契约 `workspace:file-changed` 的 `kind` 字段取值）。
    pub fn kind_name(&self) -> &'static str {
        match self {
            MergedEvent::Created { .. } => "created",
            MergedEvent::Modified { .. } => "modified",
            MergedEvent::Removed { .. } => "removed",
            MergedEvent::Renamed { .. } => "renamed",
        }
    }
}

impl std::fmt::Display for MergedEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MergedEvent::Created { path, .. } => write!(f, "创建 {}", path.display()),
            MergedEvent::Modified { path, .. } => write!(f, "修改 {}", path.display()),
            MergedEvent::Removed { path, .. } => write!(f, "删除 {}", path.display()),
            MergedEvent::Renamed { from, to, .. } => {
                write!(f, "重命名 {} → {}", from.display(), to.display())
            }
        }
    }
}

// ---------- 去抖器 ----------

/// 未届满的待合并事件（键为路径，存于 [`Debouncer::pending`]）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingEvent {
    kind: EventKind,
    last_ts: u64,
}

impl PendingEvent {
    fn into_merged(self, path: &Path) -> MergedEvent {
        let ts_ms = self.last_ts;
        match self.kind {
            EventKind::Created => MergedEvent::Created {
                path: path.to_path_buf(),
                ts_ms,
            },
            EventKind::Modified => MergedEvent::Modified {
                path: path.to_path_buf(),
                ts_ms,
            },
            EventKind::Removed => MergedEvent::Removed {
                path: path.to_path_buf(),
                ts_ms,
            },
            EventKind::Renamed { from, to } => MergedEvent::Renamed { from, to, ts_ms },
        }
    }
}

/// 同路径合并的结果。
enum MergeResult {
    /// 覆盖未决事件的种类与时间戳。
    Update(PendingEvent),
    /// 取消：事件对消（如 Created+Removed），不再产出。
    Cancel,
    /// 未决事件先行产出，再以新种类开新窗口。
    Replace(PendingEvent),
}

/// 纯去抖合并器：300ms（可调）滑动窗口内同主路径事件合并为一个
/// [`MergedEvent`]，合并语义由 [`merge_kinds`] 决定。
///
/// 时间完全由 [`RawEvent::ts_ms`] 注入——`feed` 只依据传入时间戳与窗口值
/// 判定届满，不读系统时钟，因此测试可用任意合成时间序列精确复现事件风暴、
/// 窗口边界等场景。
///
/// 窗口语义（滑动静默期）：
/// - 新事件与同路径未决事件的间隔 `< window_ms` → 合并，并把未决时间戳
///   推进到新事件时刻；
/// - 间隔 `>= window_ms` → 未决事件先行届满产出，新事件开新窗口；
/// - 无新事件时，未决事件在 `last_ts + window_ms` 后届满（由 [`Debouncer::flush`]
///   或后续任意 `feed` 冲刷）。
///
/// 注意：持续不断写入的文件只要相邻写入间隔一直小于窗口就永不产出——
/// 这是静默期去抖的定义使然（编辑器只关心写入平息后的最终状态），契约文档
/// 有专门说明。
#[derive(Debug)]
pub struct Debouncer {
    window_ms: u64,
    pending: BTreeMap<PathBuf, PendingEvent>,
}

impl Default for Debouncer {
    fn default() -> Self {
        Self::new()
    }
}

impl Debouncer {
    /// 以默认 300ms 窗口构造。
    pub fn new() -> Self {
        Self::with_window(DEBOUNCE_WINDOW_MS)
    }

    /// 以自定义窗口（毫秒）构造。
    pub fn with_window(window_ms: u64) -> Self {
        Debouncer {
            window_ms,
            pending: BTreeMap::new(),
        }
    }

    /// 是否还有未决事件。
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// 注入一个原始事件，返回所有因此届满的合并事件（含其他路径的届满）。
    pub fn feed(&mut self, raw: RawEvent) -> Vec<MergedEvent> {
        let mut out = self.flush(raw.ts_ms);
        self.absorb(raw, &mut out);
        out
    }

    /// 冲刷所有相对 `now_ms` 已届满（`now_ms - last_ts >= window_ms`）的
    /// 未决事件。WatchService 的冲刷线程周期调用；测试用它模拟时间流逝。
    pub fn flush(&mut self, now_ms: u64) -> Vec<MergedEvent> {
        let expired: Vec<PathBuf> = self
            .pending
            .iter()
            .filter(|(_, e)| now_ms.saturating_sub(e.last_ts) >= self.window_ms)
            .map(|(k, _)| k.clone())
            .collect();
        expired
            .into_iter()
            .filter_map(|k| self.pending.remove(&k).map(|e| e.into_merged(&k)))
            .collect()
    }

    /// 无条件冲刷全部未决事件（按路径字典序产出）。用于停机或测试收尾。
    pub fn flush_all(&mut self) -> Vec<MergedEvent> {
        // BTreeMap::drain 尚未稳定，整体取走等价且更省事
        std::mem::take(&mut self.pending)
            .into_iter()
            .map(|(k, e)| e.into_merged(&k))
            .collect()
    }

    /// 吸收一个原始事件：与同路径未决事件合并、对消，或开新窗口。
    fn absorb(&mut self, raw: RawEvent, out: &mut Vec<MergedEvent>) {
        let RawEvent {
            kind,
            path: key,
            ts_ms: ts,
        } = raw;
        let result = match self.pending.get(&key) {
            // 间隔 < 窗口 → 合并；其余（无未决 / 已届满）→ 新窗口
            Some(entry) if ts.saturating_sub(entry.last_ts) < self.window_ms => {
                merge_kinds(&entry.kind, kind.clone(), entry.last_ts.max(ts))
            }
            _ => None,
        };
        match result {
            Some(MergeResult::Update(pending)) => {
                self.pending.insert(key, pending);
            }
            Some(MergeResult::Cancel) => {
                self.pending.remove(&key);
            }
            Some(MergeResult::Replace(pending)) => {
                // 旧未决事件先行届满产出（键即其主路径），再开新窗口
                if let Some(old) = self.pending.remove(&key) {
                    out.push(old.into_merged(&key));
                }
                self.pending.insert(key, pending);
            }
            None => {
                self.pending.insert(key, PendingEvent { kind, last_ts: ts });
            }
        }
    }
}

/// 未决种类 + 新事件种类 → 合并结果（`ts` 为合并后的最后观测时间）。
///
/// 规格明确的四条之外补充了幂等、文件复现与重命名组合；无法安全合并的
/// 组合一律先产出未决事件再开新窗口（宁可多产出一次，也不丢事件）。
fn merge_kinds(pending: &EventKind, incoming: EventKind, ts: u64) -> Option<MergeResult> {
    use EventKind::{Created, Modified, Removed};
    let update = |kind: EventKind| Some(MergeResult::Update(PendingEvent { kind, last_ts: ts }));
    let replace = |kind: EventKind| Some(MergeResult::Replace(PendingEvent { kind, last_ts: ts }));
    match (pending, incoming) {
        // —— 规格明确的合并规则 ——
        (Modified, Modified) => update(Modified),
        (Created, Modified) => update(Created),
        (Created, Removed) => Some(MergeResult::Cancel),
        (Modified, Removed) => update(Removed),
        // —— 同类幂等 ——
        (Created, Created) => update(Created),
        (Removed, Removed) => update(Removed),
        // —— 删除后复现 / 修改后重建 ——
        (Removed, Created) | (Modified, Created) => update(Created),
        (Removed, Modified) => update(Modified),
        // —— 重命名：主路径即 from（RawEvent 不变式），任何未决 + 重命名 → 重命名
        (_, EventKind::Renamed { from, to }) => update(EventKind::Renamed { from, to }),
        // 重命名后同路径仍报修改（后端二次通知）：并入重命名，不重复产出
        (EventKind::Renamed { from, to }, Modified) => update(EventKind::Renamed {
            from: from.clone(),
            to: to.clone(),
        }),
        // 重命名后同路径又创建/删除：无法安全合并 → 先产出重命名再开新窗口
        (EventKind::Renamed { .. }, Created) => replace(Created),
        (EventKind::Renamed { .. }, Removed) => replace(Removed),
    }
}

// ---------- 回环抑制 ----------

/// 纯回环抑制器（线程安全，可 Clone 共享）：应用自身保存 / 文件操作产生的
/// 文件系统事件与外部变更无法从内容上区分，靠"操作前后登记触碰过的路径"
/// 来识别并丢弃自身事件。
///
/// 语义：
/// - [`mark`](Self::mark)：登记一次进行中操作（按 `op_id` 幂等覆盖）；
/// - [`complete`](Self::complete)：操作结束，其路径进入宽限期
///   （默认 [`SELF_GRACE_DEFAULT_MS`]，可用 [`with_grace`](Self::with_grace) 调整），
///   期内仍视为自身事件——文件系统通知到达通常晚于保存返回；
/// - [`is_self`](Self::is_self)：命中进行中或宽限期内路径 → `true`。
///
/// 路径匹配在字符串层做归一化：剥离 Windows verbatim 前缀（`\\?\`、
/// `\\?\UNC`）；Windows 目标下再补充"斜杠统一 + 小写"变体，使
/// `\\?\G:\Proj\a.md` 与 `g:/proj/A.MD` 可互相命中。不做需要 I/O 的
/// canonicalize——调用方必须保证 mark 的路径与监听事件路径处于同一坐标
/// 系（详见契约文档）。
#[derive(Debug, Clone)]
pub struct LoopSuppressor {
    inner: Arc<SuppressorInner>,
}

#[derive(Debug)]
struct SuppressorInner {
    grace: Duration,
    state: Mutex<SuppressorState>,
}

#[derive(Debug, Default)]
struct SuppressorState {
    /// 进行中操作：op_id → 归一化路径集。
    in_flight: HashMap<u64, HashSet<PathBuf>>,
    /// 宽限期内的已完成操作路径：归一化路径 → 过期时刻。
    recent: HashMap<PathBuf, Instant>,
}

impl LoopSuppressor {
    /// 以默认宽限期（[`SELF_GRACE_DEFAULT_MS`]）构造。
    pub fn new() -> Self {
        Self::with_grace(Duration::from_millis(SELF_GRACE_DEFAULT_MS))
    }

    /// 以自定义宽限期构造。
    pub fn with_grace(grace: Duration) -> Self {
        LoopSuppressor {
            inner: Arc::new(SuppressorInner {
                grace,
                state: Mutex::new(SuppressorState::default()),
            }),
        }
    }

    /// 登记一次自身操作触碰的路径。相同 `op_id` 重复 mark 为覆盖语义。
    pub fn mark(&self, op_id: u64, paths: &[PathBuf]) {
        let set: HashSet<PathBuf> = paths.iter().cloned().collect();
        self.inner
            .state
            .lock()
            .unwrap()
            .in_flight
            .insert(op_id, set);
    }

    /// 结束一次自身操作：其路径进入宽限期。未知 `op_id` 为无害 no-op。
    pub fn complete(&self, op_id: u64) {
        let mut state = self.inner.state.lock().unwrap();
        if let Some(paths) = state.in_flight.remove(&op_id) {
            let expiry = Instant::now() + self.inner.grace;
            for p in paths {
                state.recent.insert(p, expiry);
            }
        }
        purge_expired(&mut state.recent);
    }

    /// 判断路径是否命中自身操作（进行中或宽限期内）。
    pub fn is_self(&self, path: &Path) -> bool {
        let mut state = self.inner.state.lock().unwrap();
        purge_expired(&mut state.recent);
        state
            .in_flight
            .values()
            .flatten()
            .chain(state.recent.keys())
            .any(|p| paths_match(p, path))
    }
}

impl Default for LoopSuppressor {
    fn default() -> Self {
        Self::new()
    }
}

/// 惰性清理宽限期已过期的路径。
fn purge_expired(recent: &mut HashMap<PathBuf, Instant>) {
    let now = Instant::now();
    recent.retain(|_, expiry| *expiry > now);
}

/// 抑制匹配用的路径变体：原样、剥 verbatim 前缀；Windows 下再补
/// "斜杠统一 + 小写"变体。
fn path_variants(path: &Path) -> Vec<String> {
    let s = path.to_string_lossy();
    let stripped = strip_verbatim(&s);
    let mut v = vec![s.to_string(), stripped.clone()];
    #[cfg(windows)]
    v.push(unify_windows(&stripped));
    v
}

/// 剥离 Windows verbatim 前缀，得到常规可读路径文本；其他平台原样返回。
fn strip_verbatim(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.to_string()
    }
}

/// Windows 目标下的宽松变体：斜杠统一为反斜杠并小写化（Windows 路径
/// 大小写不敏感；中文等非 ASCII 字符不受 to_lowercase 影响）。
#[cfg(windows)]
fn unify_windows(s: &str) -> String {
    s.replace('/', "\\").to_lowercase()
}

/// 两个路径是否指向同一目标（变体交叉比较）。
fn paths_match(a: &Path, b: &Path) -> bool {
    let (va, vb) = (path_variants(a), path_variants(b));
    va.iter().any(|x| vb.contains(x))
}

// ---------- 排除过滤 ----------

/// 排除判定（纯函数）：路径的任一组件名与排除列表项精确相等即命中。
///
/// 匹配对象是**组件名**（目录或文件名整段），不做 glob、不做子串——
/// `target` 排除 `G:/proj/target/x.md` 但不误伤 `G:/proj/mytarget/a.md`；
/// 项目根本身不含排除组件，永不被排除。比较区分大小写（notify 返回
/// 磁盘实际大小写，约定排除列表用小写）。
pub fn is_excluded(path: &Path, exclude: &[String]) -> bool {
    if exclude.is_empty() {
        return false;
    }
    path.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        exclude.iter().any(|e| e.as_str() == name)
    })
}

// ---------- WatchService ----------

/// WatchService 对外产出的结果，经 `mpsc` 通道递交给粘合层。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchOutcome {
    /// 外部变更（已去抖合并、已过排除与回环抑制）。
    ExternalChange(MergedEvent),
    /// 自身操作产生的事件（已抑制）。仅在发生抑制时发送，供粘合层记录。
    SelfSuppressed,
    /// 监听后端错误（notify::Error 文本）。
    Error(String),
}

impl std::fmt::Display for WatchOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WatchOutcome::ExternalChange(me) => write!(f, "外部变更：{me}"),
            WatchOutcome::SelfSuppressed => write!(f, "自身操作事件（已抑制）"),
            WatchOutcome::Error(msg) => write!(f, "监听错误：{msg}"),
        }
    }
}

/// WatchService 构造失败。
#[derive(Debug)]
pub enum WatchError {
    /// 监听根不存在。
    NotFound(PathBuf),
    /// 监听根不是目录。
    NotADirectory(PathBuf),
    /// 根路径规范化失败。
    Io(std::io::Error),
    /// notify 后端错误（创建监听器或注册递归监听失败）。
    Notify(notify::Error),
}

impl std::fmt::Display for WatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WatchError::NotFound(p) => write!(f, "监听目录不存在：{}", p.display()),
            WatchError::NotADirectory(p) => write!(f, "监听目标不是目录：{}", p.display()),
            WatchError::Io(e) => write!(f, "监听路径访问失败：{e}"),
            WatchError::Notify(e) => write!(f, "文件监听启动失败：{e}"),
        }
    }
}

impl std::error::Error for WatchError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            WatchError::Io(e) => Some(e),
            WatchError::Notify(e) => Some(e),
            _ => None,
        }
    }
}

/// 回调与冲刷线程共享的状态。
struct Shared {
    debouncer: Mutex<Debouncer>,
    suppressor: LoopSuppressor,
    tx: Sender<WatchOutcome>,
    /// 接收端暂存：`new` 的返回签名固定为 `Self`，接收端由粘合层经
    /// [`WatchService::take_receiver`] 取走。
    rx_slot: Mutex<Option<Receiver<WatchOutcome>>>,
    excludes: Vec<String>,
    paused: AtomicBool,
    shutdown: AtomicBool,
}

impl Shared {
    fn is_excluded_path(&self, path: &Path) -> bool {
        is_excluded(path, &self.excludes)
    }
}

/// notify 接入层：递归监听项目根，把外部文件系统事件去抖后递交给粘合层。
///
/// 生命周期：`Drop` 时反注册监听并停掉冲刷线程；通道发送端随服务销毁，
/// 接收端在 `recv` 处自然收尾。
///
/// 事件路径坐标系：监听根经 canonicalize（Windows 下为 `\\?\` 原生前缀），
/// 事件路径在映射时剥离 verbatim 前缀，对外输出常规绝对路径；粘合层调用
/// [`WatchService::suppressor`] 登记 mark/complete 时使用同一展示形式路径
/// 即可正确命中抑制。
pub struct WatchService {
    /// Option 以便 Drop 时先显式反注册监听、再停冲刷线程。
    watcher: Option<notify::RecommendedWatcher>,
    shared: Arc<Shared>,
    root: PathBuf,
    ticker: Option<std::thread::JoinHandle<()>>,
}

impl WatchService {
    /// 递归监听 `root`，产出经去抖与过滤的外部变更。
    ///
    /// `exclude` 为目录/文件名排除列表（组件名精确相等，见 [`is_excluded`]）；
    /// 传空切片时启用 [`DEFAULT_EXCLUDES`]。构造成功即开始监听；接收端经
    /// [`take_receiver`](Self::take_receiver) 取走（每服务至多一个）。
    pub fn new(root: impl AsRef<Path>, exclude: &[String]) -> Result<Self, WatchError> {
        let root = root.as_ref();
        if !root.exists() {
            return Err(WatchError::NotFound(root.to_path_buf()));
        }
        if !root.is_dir() {
            return Err(WatchError::NotADirectory(root.to_path_buf()));
        }
        // canonicalize：校验真实存在 + 统一坐标系（Windows 得到 \\?\ 前缀，
        // 事件路径随之规范为反斜杠绝对路径，展示时统一剥离）。
        let canonical = root.canonicalize().map_err(WatchError::Io)?;
        let excludes: Vec<String> = if exclude.is_empty() {
            DEFAULT_EXCLUDES.iter().map(|s| s.to_string()).collect()
        } else {
            exclude.to_vec()
        };

        let (tx, rx) = channel();
        let shared = Arc::new(Shared {
            debouncer: Mutex::new(Debouncer::new()),
            suppressor: LoopSuppressor::new(),
            tx,
            rx_slot: Mutex::new(Some(rx)),
            excludes,
            paused: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
        });

        let cb_shared = Arc::clone(&shared);
        let watcher = recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            handle_notify_result(&cb_shared, res);
        })
        .map_err(WatchError::Notify)?;
        let mut watcher = watcher;
        watcher
            .watch(&canonical, RecursiveMode::Recursive)
            .map_err(WatchError::Notify)?;

        let ticker_shared = Arc::clone(&shared);
        let ticker = std::thread::Builder::new()
            .name("watcher-flush".to_string())
            .spawn(move || ticker_loop(ticker_shared))
            .map_err(|e| WatchError::Io(std::io::Error::other(format!("冲刷线程启动失败：{e}"))))?;

        Ok(WatchService {
            watcher: Some(watcher),
            shared,
            root: canonical,
            ticker: Some(ticker),
        })
    }

    /// 取走事件接收端（粘合层应尽早调用并在线程中持续 `recv`）。
    pub fn take_receiver(&self) -> Option<Receiver<WatchOutcome>> {
        self.shared.rx_slot.lock().unwrap().take()
    }

    /// 回环抑制器（与监听回调共用同一实例）：粘合层在自身保存 / 文件操作
    /// 前后调用 mark/complete，阶段 6 原子保存复用此入口。
    pub fn suppressor(&self) -> &LoopSuppressor {
        &self.shared.suppressor
    }

    /// 监听根（canonicalize 后的路径；展示时注意剥离 `\\?\` 前缀）。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 暂停监听：暂停期间到达的事件直接丢弃（不缓存、不回放）。
    /// 建议粘合层在 resume 后触发一次手动刷新以补齐暂停期间的变更。
    pub fn pause(&self) {
        self.shared.paused.store(true, Ordering::Relaxed);
    }

    /// 恢复监听。
    pub fn resume(&self) {
        self.shared.paused.store(false, Ordering::Relaxed);
    }

    /// 是否处于暂停状态。
    pub fn is_paused(&self) -> bool {
        self.shared.paused.load(Ordering::Relaxed)
    }
}

impl std::fmt::Debug for WatchService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WatchService")
            .field("root", &self.root)
            .field("paused", &self.is_paused())
            .finish_non_exhaustive()
    }
}

impl Drop for WatchService {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::Relaxed);
        // 先反注册监听（停事件源），再等冲刷线程退出（至多一个 FLUSH_TICK）。
        self.watcher = None;
        if let Some(handle) = self.ticker.take() {
            let _ = handle.join();
        }
    }
}

/// notify 回调入口：暂停即丢弃；错误转 `WatchOutcome::Error`；正常事件
/// 依次经过映射 → 排除过滤 → 回环抑制 → 去抖合并 → 递交。
fn handle_notify_result(shared: &Shared, res: Result<notify::Event, notify::Error>) {
    if shared.paused.load(Ordering::Relaxed) {
        return;
    }
    let event = match res {
        Ok(event) => event,
        Err(e) => {
            let _ = shared.tx.send(WatchOutcome::Error(e.to_string()));
            return;
        }
    };
    let ts = now_ms();
    let mut suppressed = false;
    let mut kept = Vec::new();
    for raw in map_notify_event(&event, ts) {
        let involved = raw.involved_paths();
        // 重命名任一端落入排除目录 → 整体丢弃（树侧由手动刷新兜底）
        if involved.iter().any(|p| shared.is_excluded_path(p)) {
            continue;
        }
        // 任一端命中自身操作 → 抑制
        if involved.iter().any(|p| shared.suppressor.is_self(p)) {
            suppressed = true;
            continue;
        }
        kept.push(raw);
    }
    if suppressed {
        let _ = shared.tx.send(WatchOutcome::SelfSuppressed);
    }
    if kept.is_empty() {
        return;
    }
    let merged: Vec<MergedEvent> = {
        let mut debouncer = shared.debouncer.lock().unwrap();
        kept.into_iter()
            .flat_map(|raw| debouncer.feed(raw))
            .collect()
    };
    emit_merged(shared, merged);
}

/// 冲刷线程：周期性把届满的未决事件递交出去（没有新事件时去抖依赖它收尾）。
fn ticker_loop(shared: Arc<Shared>) {
    while !shared.shutdown.load(Ordering::Relaxed) {
        std::thread::sleep(FLUSH_TICK);
        if shared.paused.load(Ordering::Relaxed) {
            continue;
        }
        let merged = {
            let mut debouncer = shared.debouncer.lock().unwrap();
            debouncer.flush(now_ms())
        };
        emit_merged(&shared, merged);
    }
}

/// 递交合并事件：递交前再做一次排除与抑制判定（mark 可能发生在事件已进入
/// 去抖器之后——如"保存前的一瞬间外部事件恰好入队"）。
fn emit_merged(shared: &Shared, merged: Vec<MergedEvent>) {
    for me in merged {
        let involved = me.involved_paths();
        if involved.iter().any(|p| shared.is_excluded_path(p)) {
            continue;
        }
        if involved.iter().any(|p| shared.suppressor.is_self(p)) {
            let _ = shared.tx.send(WatchOutcome::SelfSuppressed);
            continue;
        }
        let _ = shared.tx.send(WatchOutcome::ExternalChange(me));
    }
}

/// notify 事件 → 原始事件映射（纯函数，同一 notify 事件派生的 RawEvent
/// 共享同一时间戳）。
///
/// 映射规则：
/// - `Create(_)` → `Created`；`Remove(_)` → `Removed`；
/// - `Modify(Name(Both))`（Windows ReadDirectoryChangesW 的重命名主形态）
///   → 单个 `Renamed { from, to }`；
/// - `Modify(Name(From))` → `Removed`、`Modify(Name(To))` → `Created`
///   （拆分形态后端：对应主计划"无法唯一识别时按删除+新增处理"）；
/// - 其余 `Modify(_)` → `Modified`；`EventKind::Any` → `Modified`
///   （泛化事件宁可多报一次重载也不漏变更）；
/// - `Access(_)` / `EventKind::Other` → 不产出（非变更语义）。
pub fn map_notify_event(event: &notify::Event, ts_ms: u64) -> Vec<RawEvent> {
    use notify::event::{ModifyKind, RenameMode};
    // 统一坐标系：监听根经 canonicalize（Windows 下带 \\?\ 前缀），notify
    // 事件路径随之带前缀；对外一律剥离为常规展示路径（见契约文档 §5）。
    let paths: Vec<PathBuf> = event.paths.iter().map(|p| display_path(p)).collect();
    let simple = |kind: EventKind| {
        paths
            .iter()
            .map(|p| RawEvent {
                kind: kind.clone(),
                path: p.clone(),
                ts_ms,
            })
            .collect::<Vec<RawEvent>>()
    };
    match &event.kind {
        notify::EventKind::Create(_) => simple(EventKind::Created),
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => match paths.as_slice() {
            [from, to] => vec![RawEvent::renamed(from.clone(), to.clone(), ts_ms)],
            _ => Vec::new(),
        },
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)) => simple(EventKind::Removed),
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)) => simple(EventKind::Created),
        // Name(Any/Other) 与内容/元数据修改统一按 Modified 处理
        notify::EventKind::Modify(_) => simple(EventKind::Modified),
        notify::EventKind::Remove(_) => simple(EventKind::Removed),
        // FSEvents 等后端的泛化事件：按修改处理（防御性，见函数注释）
        notify::EventKind::Any => simple(EventKind::Modified),
        // 访问类与未知种类不产生对外事件
        notify::EventKind::Access(_) | notify::EventKind::Other => Vec::new(),
    }
}

/// 事件路径坐标系归一：剥离 Windows verbatim 前缀，得到常规展示路径。
fn display_path(path: &Path) -> PathBuf {
    PathBuf::from(strip_verbatim(&path.to_string_lossy()))
}

/// 当前 Unix 毫秒时间戳（时钟回拨等异常时取 0，仅影响去抖时序不致 panic）。
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
