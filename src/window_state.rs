use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 窗口状态（全部为逻辑像素：tao 的 inner_size/outer_position 返回物理像素，
/// 采集时按 scale_factor 换算，与恢复侧 LogicalSize/LogicalPosition 同一单位制）
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// 关闭时是否处于最大化。最大化尺寸是屏幕尺寸而非用户选择的常规尺寸，
    /// 因此最大化期间保留既有常规几何、只记录旗标；恢复时按常规几何建窗
    /// 再置最大化（旧文件缺省视为 false）
    #[serde(default)]
    pub maximized: bool,
}

/// 默认窗口几何（逻辑像素），状态文件缺失/损坏/越界时回退
const DEFAULT: WindowState = WindowState {
    x: 100,
    y: 100,
    width: 900,
    height: 700,
    maximized: false,
};

/// 尺寸防御范围（逻辑像素）：低于下限或高于上限视为异常数据。
/// 上限放宽到可容纳四台 4K@100% 横向拼接（15360）；更大的"窗口"不存在，
/// 只能是文件损坏——issue #1 的 25836×14380 在此被拒。
const MIN_WIDTH: u32 = 300;
const MIN_HEIGHT: u32 = 200;
const MAX_WIDTH: u32 = 16384;
const MAX_HEIGHT: u32 = 8640;

/// 位置防御范围：可容纳多台 4K 正负方向拼接。位置越界仅回退位置、保留尺寸
///（位置异常不会崩溃，尺寸才是 issue #1 崩溃的元凶）
const POSITION_LIMIT: i32 = 10_000;

/// 窗口状态文件随便携数据目录走（优先 exe 旁 data/，自动回退）
fn config_path() -> PathBuf {
    crate::data_dir::data_base().join("window_state.json")
}

/// 读取并防御性校验窗口状态。
///
/// 状态文件由上一进程自由写入，不能盲目信任：历史版本存在物理/逻辑单位
/// 混写的缺陷，高 DPI（缩放 > 100%）下每重启一次尺寸放大 scale 倍，数轮后
/// 留下 25836×14380 一类的巨幅值；不设防地传给窗口系统会在 Linux/Wayland
/// 下触发 GDK 巨幅 Cairo surface 分配失败 → 空指针解引用，启动即 SIGSEGV
///（issue #1）。尺寸越界整体回退默认几何，位置越界仅回退位置。
pub fn load_window_state() -> WindowState {
    let parsed = fs::read_to_string(config_path())
        .ok()
        .and_then(|data| parse_window_state(&data));
    sanitize_window_state(parsed)
}

fn parse_window_state(data: &str) -> Option<WindowState> {
    serde_json::from_str(data).ok()
}

/// 纯函数核心：对解析结果做防御性校验与回退（`None` 模拟文件缺失/损坏）
fn sanitize_window_state(parsed: Option<WindowState>) -> WindowState {
    let Some(state) = parsed else {
        crate::log_warn!("window_state", "窗口状态文件缺失或损坏，回退默认几何");
        return DEFAULT;
    };
    if !size_in_range(state.width, state.height) {
        crate::log_warn!(
            "window_state",
            "窗口尺寸异常（{}x{}），回退默认几何",
            state.width,
            state.height
        );
        return DEFAULT;
    }
    let mut state = state;
    if state.x.abs() > POSITION_LIMIT {
        crate::log_warn!(
            "window_state",
            "窗口 x 位置异常（{}），回退默认位置",
            state.x
        );
        state.x = DEFAULT.x;
    }
    if state.y.abs() > POSITION_LIMIT {
        crate::log_warn!(
            "window_state",
            "窗口 y 位置异常（{}），回退默认位置",
            state.y
        );
        state.y = DEFAULT.y;
    }
    state
}

fn size_in_range(width: u32, height: u32) -> bool {
    (MIN_WIDTH..=MAX_WIDTH).contains(&width) && (MIN_HEIGHT..=MAX_HEIGHT).contains(&height)
}

/// 从窗口采集当前几何并落盘。
///
/// 统一在此完成物理像素 → 逻辑像素换算，保证保存与恢复同一单位制——历史
/// 版本直接保存 `inner_size()`/`outer_position()` 的物理像素、又按逻辑像素
/// 恢复，缩放 > 100% 时每重启一次尺寸放大 scale 倍，数轮后膨胀至
/// 25836×14380（issue #1 的直接根源）。窗口处于最大化时保留既有常规几何，
/// 仅记录最大化旗标。
pub fn save_from_window(window: &tao::window::Window) {
    if window.is_maximized() {
        let mut state = load_window_state();
        state.maximized = true;
        write_state(&state);
        return;
    }
    let scale = window.scale_factor();
    let size = window.inner_size().to_logical::<f64>(scale);
    let pos = window
        .outer_position()
        .unwrap_or_default()
        .to_logical::<f64>(scale);
    save_window_state(
        (pos.x.round() as i32, pos.y.round() as i32),
        (size.width.round() as u32, size.height.round() as u32),
        false,
    );
}

pub fn save_window_state(pos: (i32, i32), size: (u32, u32), maximized: bool) {
    write_state(&WindowState {
        x: pos.0,
        y: pos.1,
        width: size.0,
        height: size.1,
        maximized,
    });
}

fn write_state(state: &WindowState) {
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, serde_json::to_string(state).unwrap_or_default());
}

#[cfg(test)]
mod tests {
    use super::{
        parse_window_state, sanitize_window_state, WindowState, DEFAULT, MAX_HEIGHT, MAX_WIDTH,
        MIN_HEIGHT, MIN_WIDTH, POSITION_LIMIT,
    };

    fn state(x: i32, y: i32, width: u32, height: u32, maximized: bool) -> WindowState {
        WindowState {
            x,
            y,
            width,
            height,
            maximized,
        }
    }

    #[test]
    fn 文件缺失或损坏时回退默认几何() {
        assert_eq!(sanitize_window_state(None), DEFAULT);
        assert_eq!(
            sanitize_window_state(parse_window_state("not json")),
            DEFAULT
        );
        assert_eq!(sanitize_window_state(parse_window_state("{}")), DEFAULT);
    }

    #[test]
    fn 合法状态原样通过() {
        let s = state(1920, -1080, 1280, 800, true);
        assert_eq!(sanitize_window_state(Some(s)), s);
        // 边界值：防御范围端点均放行
        assert_eq!(
            sanitize_window_state(Some(state(0, 0, MIN_WIDTH, MIN_HEIGHT, false))),
            state(0, 0, MIN_WIDTH, MIN_HEIGHT, false)
        );
        assert_eq!(
            sanitize_window_state(Some(state(
                POSITION_LIMIT,
                -POSITION_LIMIT,
                MAX_WIDTH,
                MAX_HEIGHT,
                false
            ))),
            state(
                POSITION_LIMIT,
                -POSITION_LIMIT,
                MAX_WIDTH,
                MAX_HEIGHT,
                false
            )
        );
    }

    #[test]
    fn 巨幅或过小尺寸整体回退默认几何() {
        // issue #1 报告的崩溃现场值
        assert_eq!(
            sanitize_window_state(Some(state(0, 0, 25836, 14380, false))),
            DEFAULT
        );
        // 超上限（单边）
        assert_eq!(
            sanitize_window_state(Some(state(0, 0, MAX_WIDTH + 1, 800, false))),
            DEFAULT
        );
        assert_eq!(
            sanitize_window_state(Some(state(0, 0, 1280, MAX_HEIGHT + 1, false))),
            DEFAULT
        );
        // 低于下限（0 来自解析或损坏文件同样拦截）
        assert_eq!(
            sanitize_window_state(Some(state(0, 0, 0, 700, false))),
            DEFAULT
        );
        assert_eq!(
            sanitize_window_state(Some(state(0, 0, MIN_WIDTH - 1, 700, false))),
            DEFAULT
        );
    }

    #[test]
    fn 位置越界仅回退位置保留尺寸() {
        let out = POSITION_LIMIT + 1;
        assert_eq!(
            sanitize_window_state(Some(state(out, 0, 1280, 800, false))),
            state(DEFAULT.x, 0, 1280, 800, false)
        );
        assert_eq!(
            sanitize_window_state(Some(state(0, -out, 1280, 800, true))),
            state(0, DEFAULT.y, 1280, 800, true)
        );
    }

    #[test]
    fn 旧格式文件缺最大化字段按未最大化处理() {
        let parsed = parse_window_state(r#"{"x":100,"y":100,"width":900,"height":700}"#);
        assert_eq!(
            sanitize_window_state(parsed),
            state(100, 100, 900, 700, false)
        );
    }
}
