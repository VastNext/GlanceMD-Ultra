use serde::Serialize;
use std::path::{Path, PathBuf};

use super::{spawn_detached, PlatformError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
}

/// 剥离 Windows 规范化产生的 `\\?\` 或 `\\?\UNC\` 扩展路径前缀。
///
/// 原因：`cmd.exe`、`git-bash.exe` 和 Windows 系统 `CreateProcess` 的工作目录参数
/// 不支持 `\\?\` 前缀，传入时会直接报错或被强制回退到 `C:\Windows`。
pub fn clean_path_for_terminal(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{stripped}"))
    } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

pub fn parse_args_template(template: &str, dir: &Path) -> Vec<String> {
    let clean_dir = clean_path_for_terminal(dir);
    let dir_str = clean_dir.to_string_lossy();
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for ch in template.chars() {
        match ch {
            '\'' | '"' if quote == Some(ch) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(ch),
            c if c.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
        .into_iter()
        .map(|t| t.replace("{dir}", &dir_str))
        .collect()
}

fn default_args_for_path(path: &str, dir: &Path) -> Vec<String> {
    let clean_dir = clean_path_for_terminal(dir);
    let dir_str = clean_dir.to_string_lossy();
    let lower = path.to_lowercase();
    if lower.contains("git-bash") {
        vec![format!("--cd={}", dir_str)]
    } else if lower.contains("powershell") || lower.contains("pwsh") {
        vec!["-NoExit".to_string()]
    } else if lower.contains("cmd") {
        vec!["/K".to_string()]
    } else if lower.ends_with("wt.exe") || lower == "wt" {
        vec!["-d".to_string(), dir_str.into_owned()]
    } else {
        Vec::new()
    }
}

fn log_terminal_info(msg: impl AsRef<str>) {
    #[cfg(not(test))]
    crate::logger::log_line("INFO", "terminal", msg);
    #[cfg(test)]
    let _ = msg;
}

fn log_terminal_error(msg: impl AsRef<str>) {
    #[cfg(not(test))]
    crate::logger::log_line("ERROR", "terminal", msg);
    #[cfg(test)]
    let _ = msg;
}

pub fn spawn_custom(path: &str, args_template: &str, dir: &Path) -> Result<(), PlatformError> {
    let clean_dir = clean_path_for_terminal(dir);
    let args = if args_template.trim().is_empty() {
        default_args_for_path(path, &clean_dir)
    } else {
        parse_args_template(args_template, &clean_dir)
    };

    log_terminal_info(format!(
        "启动自定义终端: 程序='{}', 参数={:?}, 工作目录='{}'",
        path,
        args,
        clean_dir.display()
    ));

    let res = spawn_detached(path, &args, Some(&clean_dir));
    if let Err(ref e) = res {
        log_terminal_error(format!("启动自定义终端失败: 程序='{}', 错误={}", path, e));
    }
    res
}

fn existing(
    candidates: impl IntoIterator<Item = (String, String, String, Vec<String>)>,
) -> Vec<TerminalInfo> {
    candidates
        .into_iter()
        .filter_map(|(id, name, path, args)| {
            if path == "PATH" || Path::new(&path).exists() {
                Some(TerminalInfo {
                    id,
                    name,
                    path,
                    args,
                })
            } else {
                None
            }
        })
        .collect()
}

pub fn scan_candidates(candidates: &[(String, String, String, Vec<String>)]) -> Vec<TerminalInfo> {
    existing(candidates.iter().cloned())
}

pub fn scan_terminals() -> Vec<TerminalInfo> {
    #[cfg(target_os = "windows")]
    {
        let mut c = vec![
            (
                "windows-terminal",
                "Windows Terminal",
                "wt.exe",
                vec!["-d", "{dir}"],
            ),
            (
                "powershell",
                "PowerShell",
                "powershell.exe",
                vec!["-NoExit", "-Command", "Set-Location", "{dir}"],
            ),
            (
                "pwsh",
                "PowerShell 7",
                "pwsh.exe",
                vec!["-NoExit", "-Command", "Set-Location", "{dir}"],
            ),
            (
                "cmd",
                "Command Prompt",
                "cmd.exe",
                vec!["/K", "cd", "/d", "{dir}"],
            ),
            ("wsl", "WSL", "wsl.exe", vec!["--cd".into(), "{dir}".into()]),
        ];
        let mut git = vec![
            r"C:\Program Files\Git\git-bash.exe".to_string(),
            r"C:\Program Files\Git\bin\bash.exe".to_string(),
            r"C:\Program Files (x86)\Git\git-bash.exe".to_string(),
            r"C:\Program Files (x86)\Git\bin\bash.exe".to_string(),
        ];
        if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
            let p = Path::new(&local_app).join("Programs").join("Git");
            git.push(p.join("git-bash.exe").to_string_lossy().into_owned());
            git.push(
                p.join("bin")
                    .join("bash.exe")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        for p in &git {
            if Path::new(p).exists() {
                let is_git_bash = p.ends_with("git-bash.exe");
                c.push((
                    "git-bash",
                    "Git Bash",
                    p.as_str(),
                    if is_git_bash {
                        vec!["--cd={dir}"]
                    } else {
                        vec!["--login", "-i"]
                    },
                ));
            }
        }
        let mut out = Vec::new();
        for (id, name, path, args) in c {
            let available =
                path.ends_with(".exe") && (Path::new(path).exists() || command_in_path(path));
            if available {
                out.push(TerminalInfo {
                    id: id.into(),
                    name: name.into(),
                    path: path.into(),
                    args: args.into_iter().map(str::to_string).collect(),
                });
            }
        }
        out
    }
    #[cfg(target_os = "macos")]
    {
        scan_candidates(
            &[
                (
                    "terminal",
                    "Terminal",
                    "/System/Applications/Utilities/Terminal.app",
                    "open -a Terminal",
                ),
                (
                    "iterm",
                    "iTerm2",
                    "/Applications/iTerm.app",
                    "open -a iTerm",
                ),
            ]
            .map(|(a, b, c, d)| {
                (
                    a.into(),
                    b.into(),
                    c.into(),
                    d.split_whitespace().map(String::from).collect(),
                )
            })
            .to_vec(),
        )
    }
    #[cfg(target_os = "linux")]
    {
        [
            (
                "gnome-terminal",
                "GNOME Terminal",
                "gnome-terminal",
                vec!["--working-directory={dir}".into()],
            ),
            (
                "konsole",
                "Konsole",
                "konsole",
                vec!["--workdir".into(), "{dir}".into()],
            ),
            (
                "xfce4-terminal",
                "Xfce Terminal",
                "xfce4-terminal",
                vec!["--working-directory={dir}".into()],
            ),
        ]
        .into_iter()
        .filter(|(_, _, p, _)| command_in_path(p))
        .map(|(id, name, path, args)| TerminalInfo {
            id: id.into(),
            name: name.into(),
            path: path.into(),
            args,
        })
        .collect()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Vec::new()
    }
}

fn command_in_path(program: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|p| {
                p.join(program).is_file() || p.join(program.trim_end_matches(".exe")).is_file()
            })
        })
        .unwrap_or(false)
}
