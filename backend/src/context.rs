//! Files and folders the user hands Mission Control with a goal, described so the pill can show
//! what each one is before anything reads it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

use crate::git::GitRepo;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextKind {
    Folder,
    Image,
    Pdf,
    /// A Windows internet shortcut (`.url`): a link, such as a Google Drive file, not a document.
    Link,
    File,
    /// Gone since it was dropped.
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub path: String,
    pub name: String,
    pub kind: ContextKind,
    /// A short second line: a folder's git branch, a file's type and size.
    pub detail: String,
    /// A folder that is a code project, so a goal can run in it. Loose folders such as Downloads
    /// are only looked at.
    pub project: bool,
}

const IMAGES: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic"];

pub fn describe(path: &Path) -> ContextItem {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    let (kind, detail) = match std::fs::metadata(path) {
        Err(_) => (ContextKind::Missing, "No longer there".to_string()),
        Ok(meta) if meta.is_dir() && is_project(path) => {
            let branch = GitRepo::open(path).ok().and_then(|repo| repo.current_branch());
            let detail = branch.map_or_else(|| "Project".to_string(), |b| format!("git {b}"));
            return ContextItem { path: path.display().to_string(), name, kind: ContextKind::Folder, detail, project: true };
        }
        Ok(meta) if meta.is_dir() => {
            let scan = scan_folder(path, 0);
            let files = if scan.truncated { format!("{}+ files", group(scan.files)) } else { format!("{} files", group(scan.files)) };
            (ContextKind::Folder, format!("{files} · {}", human_size(scan.bytes)))
        }
        Ok(_) if shortcut_url(path).is_some() => {
            let url = shortcut_url(path).unwrap_or_default();
            let host = url.split("://").nth(1).and_then(|rest| rest.split('/').next()).unwrap_or(&url).to_string();
            return ContextItem {
                path: path.display().to_string(),
                name: shortcut_name(path),
                kind: ContextKind::Link,
                detail: format!("Link · {host}"),
                project: false,
            };
        }
        Ok(meta) => {
            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let size = human_size(meta.len());
            if IMAGES.contains(&ext.as_str()) {
                (ContextKind::Image, format!("Image · {size}"))
            } else if ext == "pdf" {
                (ContextKind::Pdf, format!("PDF · {size}"))
            } else if ext.is_empty() {
                (ContextKind::File, size)
            } else {
                (ContextKind::File, format!("{} · {size}", ext.to_uppercase()))
            }
        }
    };
    ContextItem { path: path.display().to_string(), name, kind, detail, project: false }
}

/// Files that mark a folder as a code project. A folder with any of these, or its own `.git`,
/// is somewhere a goal can run; anything else is a loose folder that is only looked at.
const PROJECT_MARKERS: [&str; 12] = [
    ".git",
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "composer.json",
    "Gemfile",
    "CMakeLists.txt",
];

pub fn is_project(folder: &Path) -> bool {
    if PROJECT_MARKERS.iter().any(|m| folder.join(m).exists()) {
        return true;
    }
    // .NET solutions and projects are named after the project.
    std::fs::read_dir(folder).map_or(false, |entries| {
        entries.flatten().any(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            name.ends_with(".sln") || name.ends_with(".csproj")
        })
    })
}

/// How many files a scan looks at before it stops counting, so a huge folder never stalls the pill.
const SCAN_LIMIT: usize = 20_000;
/// How deep a scan goes below the folder.
const SCAN_DEPTH: usize = 6;

/// What a loose folder holds, from file metadata only: nothing is opened or read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FolderScan {
    pub files: usize,
    pub bytes: u64,
    /// The scan stopped at `SCAN_LIMIT` files, so the totals are a floor.
    pub truncated: bool,
    /// The biggest files, largest first.
    pub largest: Vec<ScannedFile>,
    /// Files that share a name (ignoring copy suffixes like " (1)") and a size: likely copies.
    pub duplicates: Vec<Vec<ScannedFile>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScannedFile {
    pub path: PathBuf,
    pub bytes: u64,
    /// Days since it was last changed.
    pub age_days: Option<u64>,
}

/// Walks `folder` and sums it up, keeping the `keep` biggest files (none for just the totals).
pub fn scan_folder(folder: &Path, keep: usize) -> FolderScan {
    let mut scan = FolderScan::default();
    let mut all: Vec<ScannedFile> = Vec::new();
    let mut stack = vec![(folder.to_path_buf(), 0usize)];
    let now = SystemTime::now();
    'walk: while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                if depth + 1 < SCAN_DEPTH {
                    stack.push((entry.path(), depth + 1));
                }
                continue;
            }
            scan.files += 1;
            scan.bytes += meta.len();
            if keep > 0 {
                let age_days = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).map(|d| d.as_secs() / 86_400);
                all.push(ScannedFile { path: entry.path(), bytes: meta.len(), age_days });
            }
            if scan.files >= SCAN_LIMIT {
                scan.truncated = true;
                break 'walk;
            }
        }
    }
    if keep > 0 {
        let mut groups: HashMap<(String, u64), Vec<ScannedFile>> = HashMap::new();
        for file in all.iter().filter(|f| f.bytes > 0) {
            groups.entry((copy_base_name(&file.path), file.bytes)).or_default().push(file.clone());
        }
        let mut duplicates: Vec<Vec<ScannedFile>> = groups.into_values().filter(|g| g.len() > 1).collect();
        duplicates.sort_by_key(|g| std::cmp::Reverse(g[0].bytes * (g.len() as u64 - 1)));
        duplicates.truncate(5);
        scan.duplicates = duplicates;
        all.sort_by_key(|f| std::cmp::Reverse(f.bytes));
        all.truncate(keep);
        scan.largest = all;
    }
    scan
}

/// "node-v22-x64 (2).msi" and "node-v22-x64.msi" are the same download.
fn copy_base_name(path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let (stem, ext) = name.rsplit_once('.').map_or((name.as_str(), ""), |(s, e)| (s, e));
    let stem = stem.trim_end();
    let stem = match stem.rsplit_once(" (") {
        Some((base, n)) if n.ends_with(')') && n[..n.len() - 1].chars().all(|c| c.is_ascii_digit()) => base,
        _ => stem,
    };
    format!("{stem}.{ext}")
}

/// What an agent is told about a loose folder: Mission Control's scan, since the agent can read
/// files but not see their sizes, and how to suggest files to remove.
pub fn folder_report(folder: &Path) -> String {
    let scan = scan_folder(folder, 12);
    let mut out = format!(
        "Mission Control scanned {} (file details only, nothing was opened): {}{} files, {}.",
        folder.display(),
        group(scan.files),
        if scan.truncated { "+" } else { "" },
        human_size(scan.bytes)
    );
    if !scan.largest.is_empty() {
        out.push_str("\nLargest files:");
        for f in &scan.largest {
            out.push_str(&format!("\n  {} | {} | {}", f.path.display(), human_size(f.bytes), age(f.age_days)));
        }
    }
    if !scan.duplicates.is_empty() {
        out.push_str("\nLikely copies (same name and size):");
        for group in &scan.duplicates {
            let paths: Vec<String> = group.iter().map(|f| f.path.display().to_string()).collect();
            out.push_str(&format!("\n  {} each: {}", human_size(group[0].bytes), paths.join(" ; ")));
        }
    }
    out.push_str(
        "\nYou cannot delete or move anything. If some files are clearly safe to remove, end your reply with \
         a fenced block that starts with ```recycle and lists their full paths, one per line. Mission Control \
         will offer the user to move them to the Recycle Bin. Only suggest files from the scan above.",
    );
    out
}

fn age(days: Option<u64>) -> String {
    match days {
        None => "age unknown".into(),
        Some(0) => "changed today".into(),
        Some(d) if d < 60 => format!("{d} days old"),
        Some(d) if d < 730 => format!("{} months old", d / 30),
        Some(d) => format!("{} years old", d / 365),
    }
}

/// 2318 reads as "2,318".
fn group(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Where a Windows internet shortcut (`[InternetShortcut]` with a `URL=` line) points, if
/// `path` is one. Anything else, including unreadable files, is not a shortcut.
pub fn shortcut_url(path: &Path) -> Option<String> {
    let is_url = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("url"));
    if !is_url {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    text.lines().find_map(|line| line.trim().strip_prefix("URL=")).map(|url| url.trim().to_string()).filter(|u| !u.is_empty())
}

/// A shortcut's name as the user sees it on the desktop, without the hidden `.url`.
pub fn shortcut_name(path: &Path) -> String {
    path.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("{bytes} B")
    } else if b < KB * KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{:.1} MB", b / (KB * KB))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn a_loose_folder_is_scanned_not_run_in() {
        let root = std::env::temp_dir().join(format!("mc-scan-{}", uuid::Uuid::new_v4()));
        let downloads = root.join("Downloads");
        fs::create_dir_all(downloads.join("old")).unwrap();
        fs::write(downloads.join("big.iso"), vec![0u8; 5000]).unwrap();
        fs::write(downloads.join("node.msi"), vec![0u8; 300]).unwrap();
        fs::write(downloads.join("node (1).msi"), vec![0u8; 300]).unwrap();
        fs::write(downloads.join("old").join("notes.txt"), b"hi").unwrap();

        assert!(!is_project(&downloads));
        let item = describe(&downloads);
        assert_eq!((item.kind, item.project, item.detail.as_str()), (ContextKind::Folder, false, "4 files · 5 KB"));

        let scan = scan_folder(&downloads, 2);
        assert_eq!((scan.files, scan.bytes, scan.truncated), (4, 5602, false));
        assert_eq!(scan.largest.iter().map(|f| f.bytes).collect::<Vec<_>>(), vec![5000, 300]);
        assert_eq!(scan.duplicates.len(), 1, "node.msi and node (1).msi are one download twice");

        let report = folder_report(&downloads);
        assert!(report.contains("big.iso") && report.contains("```recycle") && report.contains("Likely copies"));

        fs::write(downloads.join("package.json"), "{}").unwrap();
        assert!(is_project(&downloads), "a package.json makes it a project");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn says_what_each_dropped_thing_is() {
        let root = std::env::temp_dir().join(format!("mc-context-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("project")).unwrap();
        fs::write(root.join("login-error.png"), vec![0u8; 2048]).unwrap();
        fs::write(root.join("auth-spec.pdf"), b"%PDF").unwrap();
        fs::write(root.join("notes.md"), b"hi").unwrap();

        let folder = describe(&root.join("project"));
        assert_eq!((folder.kind, folder.name.as_str(), folder.detail.as_str()), (ContextKind::Folder, "project", "0 files · 0 B"));
        assert!(!folder.project, "an empty folder is not a project");
        assert_eq!(describe(&root.join("login-error.png")).detail, "Image · 2 KB");
        assert_eq!(describe(&root.join("auth-spec.pdf")).kind, ContextKind::Pdf);
        assert_eq!(describe(&root.join("notes.md")).detail, "MD · 2 B");
        assert_eq!(describe(&root.join("gone.txt")).kind, ContextKind::Missing);

        let shortcut = root.join("Business Studies Memo 2021.pdfPDF.url");
        fs::write(&shortcut, "[InternetShortcut]\r\nURL=https://drive.google.com/file/d/abc/view?usp=drive_web\r\n").unwrap();
        let link = describe(&shortcut);
        assert_eq!(
            (link.kind, link.name.as_str(), link.detail.as_str()),
            (ContextKind::Link, "Business Studies Memo 2021.pdfPDF", "Link · drive.google.com")
        );
        assert_eq!(shortcut_url(&shortcut).as_deref(), Some("https://drive.google.com/file/d/abc/view?usp=drive_web"));
        assert_eq!(shortcut_url(&root.join("notes.md")), None);

        GitRepo::init(&root.join("project")).unwrap();
        let repo = describe(&root.join("project"));
        assert!(repo.project && repo.detail.starts_with("git "), "a repository is a project and shows its branch");
        let _ = fs::remove_dir_all(root);
    }
}
