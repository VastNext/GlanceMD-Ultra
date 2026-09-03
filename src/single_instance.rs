//! 单实例支持：named mutex 检测已有实例，named pipe 转发打开请求。
//!
//! 第二实例启动时发现已有实例在运行，就把 CLI 文件参数写入管道
//! （主实例收到后在已有窗口新开标签页），然后自己退出；
//! 无文件参数时发送空载荷，仅请求聚焦已有窗口。
//!
//! 使用 raw FFI 而非 windows crate，避免版本间 API 签名差异。

use std::thread;
use std::time::Duration;

const MUTEX_NAME: &str = "Local\\GlanceMD.SingleInstance.v1";
const PIPE_NAME: &str = r"\\.\pipe\glancemd.openfile.v1";

const ERROR_ALREADY_EXISTS: u32 = 183;
const ERROR_BROKEN_PIPE: u32 = 109;
const ERROR_NO_DATA: u32 = 232;
const ERROR_PIPE_CONNECTED: u32 = 536;
const INVALID_HANDLE_VALUE: isize = -1;
const GENERIC_WRITE: u32 = 0x4000_0000;
const OPEN_EXISTING: u32 = 3;
const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
const PIPE_TYPE_BYTE: u32 = 0x0;
const PIPE_READMODE_BYTE: u32 = 0x0;
const PIPE_WAIT: u32 = 0x0;

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attrs: *const core::ffi::c_void, initial_owner: i32, name: *const u16)
        -> isize;
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        max_instances: u32,
        out_buffer_size: u32,
        in_buffer_size: u32,
        default_timeout: u32,
        attrs: *const core::ffi::c_void,
    ) -> isize;
    fn ConnectNamedPipe(pipe: isize, overlapped: *const core::ffi::c_void) -> i32;
    fn DisconnectNamedPipe(pipe: isize) -> i32;
    fn CreateFileW(
        name: *const u16,
        desired_access: u32,
        share_mode: u32,
        attrs: *const core::ffi::c_void,
        creation_disposition: u32,
        flags_and_attributes: u32,
        template_file: isize,
    ) -> isize;
    fn WriteFile(
        file: isize,
        buffer: *const u8,
        bytes_to_write: u32,
        bytes_written: *mut u32,
        overlapped: *const core::ffi::c_void,
    ) -> i32;
    fn ReadFile(
        file: isize,
        buffer: *mut u8,
        bytes_to_read: u32,
        bytes_read: *mut u32,
        overlapped: *const core::ffi::c_void,
    ) -> i32;
    fn FlushFileBuffers(file: isize) -> i32;
    fn CloseHandle(handle: isize) -> i32;
    fn GetLastError() -> u32;
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 主实例令牌：持有期间保持"唯一实例"状态，Drop 时释放。
pub struct PrimaryInstance {
    mutex: isize,
}

impl Drop for PrimaryInstance {
    fn drop(&mut self) {
        if self.mutex != 0 {
            unsafe { CloseHandle(self.mutex) };
        }
    }
}

/// 尝试成为主实例。返回 None 表示已有实例在运行。
/// mutex 创建失败时仍返回 Some（放弃单实例约束，独立启动）。
pub fn try_acquire_primary() -> Option<PrimaryInstance> {
    let name = to_wide(MUTEX_NAME);
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if handle == 0 || handle == INVALID_HANDLE_VALUE {
            return Some(PrimaryInstance { mutex: 0 });
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(handle);
            return None;
        }
        Some(PrimaryInstance { mutex: handle })
    }
}

/// 第二实例：把文件路径列表发给主实例。空列表 = 仅请求聚焦窗口。
/// 返回 false 表示发送失败（调用方应回退为独立窗口启动）。
pub fn send_open_request(paths: &[String]) -> bool {
    // 载荷：UTF-16LE，每条路径以 NUL 结尾；空列表发送单个 NUL（聚焦请求）
    let mut payload: Vec<u16> = Vec::new();
    if paths.is_empty() {
        payload.push(0);
    } else {
        for p in paths {
            payload.extend(p.encode_utf16());
            payload.push(0);
        }
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(payload.as_ptr().cast::<u8>(), payload.len() * 2) };

    let pipe_name = to_wide(PIPE_NAME);
    // 主实例管道线程可能尚未就绪，重试约 2 秒
    for _ in 0..40 {
        unsafe {
            let pipe = CreateFileW(
                pipe_name.as_ptr(),
                GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                0,
            );
            if pipe != INVALID_HANDLE_VALUE {
                let ok = write_all(pipe, bytes) && FlushFileBuffers(pipe) != 0;
                CloseHandle(pipe);
                return ok;
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

unsafe fn write_all(file: isize, mut data: &[u8]) -> bool {
    while !data.is_empty() {
        let mut written = 0u32;
        if WriteFile(
            file,
            data.as_ptr(),
            data.len() as u32,
            &mut written,
            std::ptr::null(),
        ) == 0
        {
            return false;
        }
        if written == 0 {
            return false;
        }
        data = &data[written as usize..];
    }
    true
}

/// 主实例：阻塞监听打开请求，每收到一批路径调用一次 on_paths。
/// 设计为在独立后台线程运行；管道创建失败时直接返回（主窗口不受影响）。
pub fn serve_open_requests<F: FnMut(Vec<String>)>(mut on_paths: F) {
    let pipe_name = to_wide(PIPE_NAME);
    let pipe = unsafe {
        CreateNamedPipeW(
            pipe_name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            4096,
            4096,
            0,
            std::ptr::null(),
        )
    };
    if pipe == 0 || pipe == INVALID_HANDLE_VALUE {
        return;
    }

    let mut chunk = [0u8; 2048];
    loop {
        // 阻塞等待客户端连接
        let connected = unsafe { ConnectNamedPipe(pipe, std::ptr::null()) };
        if connected == 0 {
            let err = unsafe { GetLastError() };
            if err == ERROR_NO_DATA {
                unsafe { DisconnectNamedPipe(pipe) };
                continue;
            }
            if err != ERROR_PIPE_CONNECTED {
                // ERROR_PIPE_CONNECTED：客户端在监听前已连上，可正常读取；
                // 其他罕见错误小睡后重试，避免死循环空转
                thread::sleep(Duration::from_millis(50));
                continue;
            }
        }

        // 循环读取直到客户端断开（写端 CloseHandle 后 ReadFile 报 BROKEN_PIPE）
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let mut n = 0u32;
            let ok = unsafe {
                ReadFile(
                    pipe,
                    chunk.as_mut_ptr(),
                    chunk.len() as u32,
                    &mut n,
                    std::ptr::null(),
                )
            };
            if ok == 0 {
                let err = unsafe { GetLastError() };
                if err != ERROR_BROKEN_PIPE && err != ERROR_NO_DATA {
                    buf.clear(); // 异常中断，丢弃不完整数据
                }
                break;
            }
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n as usize]);
        }
        unsafe { DisconnectNamedPipe(pipe) };

        if !buf.is_empty() {
            let paths = decode_paths(&buf);
            on_paths(paths);
        }
    }
}

/// 解析 UTF-16LE + NUL 分隔的路径列表
fn decode_paths(bytes: &[u8]) -> Vec<String> {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let mut paths = Vec::new();
    let mut cur: Vec<u16> = Vec::new();
    for &u in &units {
        if u == 0 {
            if !cur.is_empty() {
                paths.push(String::from_utf16_lossy(&cur));
                cur.clear();
            }
        } else {
            cur.push(u);
        }
    }
    if !cur.is_empty() {
        paths.push(String::from_utf16_lossy(&cur));
    }
    paths
}
