use serde::Serialize;
use std::path::Path;

use super::{spawn_detached, PlatformError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
}

pub fn parse_args_template(template: &str, dir: &Path) -> Vec<String> {
    let replaced = template.replace("{dir}", &dir.to_string_lossy());
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for ch in replaced.chars() {
        match ch {
            '\'' | '"' if quote == Some(ch) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(ch),
            c if c.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

pub fn spawn_custom(path: &str, args_template: &str, dir: &Path) -> Result<(), PlatformError> {
    let args = parse_args_template(args_template, dir);
    spawn_detached(path, &args, Some(dir))
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
        let git = [
            r"C:\Program Files\Git\git-bash.exe",
            r"C:\Program Files\Git\bin\bash.exe",
        ];
        for p in git {
            if Path::new(p).exists() {
                let is_git_bash = p.ends_with("git-bash.exe");
                c.push((
                    "git-bash",
                    "Git Bash",
                    p,
                    if is_git_bash {
                        vec!["--cd".into(), "{dir}".into()]
                    } else {
                        vec!["--login".into(), "-i".into()]
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
