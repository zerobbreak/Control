//! Git and GitHub for the user's own controls: see what a run changed, stage, commit, push,
//! pull, branch and open pull requests. Uses the installed `git` and `gh` CLIs, so the user's
//! existing credentials, SSH keys and GitHub login apply and nothing new stores secrets.
//!
//! Also classifies agents' shell commands, so the Command Centre can rule on git actions.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::Serialize;

/// Largest diff returned to the UI; longer ones are cut with a note.
const MAX_DIFF_BYTES: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitError(pub String);

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for GitError {}

pub type GitResult<T> = Result<T, GitError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Conflicted,
}

/// One changed path. A file can have staged and unstaged changes at once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// The old path of a rename or copy.
    pub original: Option<String>,
    pub staged: Option<ChangeKind>,
    pub unstaged: Option<ChangeKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub root: String,
    /// None when HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// True before the first commit.
    pub unborn: bool,
    pub files: Vec<FileChange>,
    pub remotes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// "OPEN", "CLOSED" or "MERGED".
    pub state: String,
    pub is_draft: bool,
}

/// A git working tree, found from any folder inside it.
#[derive(Debug)]
pub struct GitRepo {
    root: PathBuf,
}

impl GitRepo {
    pub fn open(folder: &Path) -> GitResult<Self> {
        let root = run("git", folder, &["rev-parse", "--show-toplevel"])
            .map_err(|_| GitError(format!("{} is not inside a git repository", folder.display())))?;
        Ok(Self { root: PathBuf::from(root.trim()) })
    }

    /// Makes `folder` a new repository, creating the folder if needed.
    pub fn init(folder: &Path) -> GitResult<Self> {
        std::fs::create_dir_all(folder).map_err(|e| GitError(format!("could not create {}: {e}", folder.display())))?;
        run("git", folder, &["init"])?;
        Self::open(folder)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn git(&self, args: &[&str]) -> GitResult<String> {
        run("git", &self.root, args)
    }

    pub fn status(&self) -> GitResult<RepoStatus> {
        let raw = self.git(&["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"])?;
        let mut status = parse_status(&raw);
        status.root = self.root.display().to_string();
        status.remotes = self.git(&["remote"])?.lines().map(str::to_string).collect();
        Ok(status)
    }

    pub fn current_branch(&self) -> Option<String> {
        let name = self.git(&["symbolic-ref", "--quiet", "--short", "HEAD"]).ok()?;
        Some(name.trim().to_string()).filter(|n| !n.is_empty())
    }

    pub fn branches(&self) -> GitResult<Vec<String>> {
        Ok(self.git(&["branch", "--format=%(refname:short)"])?.lines().map(str::to_string).collect())
    }

    /// The diff of one file, staged or not. Untracked files show as wholly added.
    pub fn diff(&self, path: &str, staged: bool) -> GitResult<String> {
        let tracked = self.git(&["ls-files", "--error-unmatch", "--", path]).is_ok();
        let text = if tracked {
            let mut args = vec!["diff", "--no-color", "--no-ext-diff"];
            if staged {
                args.push("--cached");
            }
            args.extend(["--", path]);
            self.git(&args)?
        } else {
            // `--no-index` exits 1 whenever the files differ, which here is always.
            let output = command("git", &self.root, &["diff", "--no-color", "--no-index", "--", null_device(), path])?;
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        Ok(clip(text))
    }

    /// Stages the given paths, or everything when `paths` is empty.
    pub fn stage(&self, paths: &[String]) -> GitResult<()> {
        let mut args = vec!["add", "--all", "--"];
        args.extend(paths.iter().map(String::as_str));
        self.git(&args).map(drop)
    }

    /// Unstages the given paths, or everything when `paths` is empty. Work in the files is kept.
    pub fn unstage(&self, paths: &[String]) -> GitResult<()> {
        let all = [".".to_string()];
        let paths = if paths.is_empty() { &all[..] } else { paths };
        let has_head = self.git(&["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok();
        let mut args = if has_head {
            vec!["restore", "--staged", "--"]
        } else {
            // Before the first commit there is nothing to restore from.
            vec!["rm", "--cached", "-r", "--quiet", "--"]
        };
        args.extend(paths.iter().map(String::as_str));
        self.git(&args).map(drop)
    }

    /// Commits what is staged and returns the new commit's short hash.
    pub fn commit(&self, message: &str) -> GitResult<String> {
        let message = message.trim();
        if message.is_empty() {
            return Err(GitError("write a commit message first".into()));
        }
        if self.git(&["diff", "--cached", "--quiet"]).is_ok() {
            return Err(GitError("nothing is staged to commit".into()));
        }
        self.git(&["commit", "--quiet", "-m", message])?;
        Ok(self.git(&["rev-parse", "--short", "HEAD"])?.trim().to_string())
    }

    /// Pushes the current branch, setting its upstream on the first push.
    pub fn push(&self) -> GitResult<()> {
        let status = self.status()?;
        if status.upstream.is_some() {
            return self.git(&["push"]).map(drop);
        }
        let remote = status
            .remotes
            .iter()
            .find(|r| *r == "origin")
            .or(status.remotes.first())
            .ok_or_else(|| GitError("this repository has no remote to push to".into()))?;
        self.git(&["push", "--set-upstream", remote, "HEAD"]).map(drop)
    }

    /// Pulls only if it can fast-forward, so it never creates a merge on the user's behalf.
    pub fn pull(&self) -> GitResult<()> {
        self.git(&["pull", "--ff-only"]).map(drop)
    }

    pub fn fetch(&self) -> GitResult<()> {
        self.git(&["fetch", "--prune"]).map(drop)
    }

    /// Creates a branch from the current commit and switches to it, keeping uncommitted work.
    pub fn create_branch(&self, name: &str) -> GitResult<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(GitError("name the branch first".into()));
        }
        self.git(&["check-ref-format", "--branch", name]).map_err(|_| GitError(format!("{name} is not a valid branch name")))?;
        self.git(&["switch", "--create", name]).map(drop)
    }

    pub fn switch_branch(&self, name: &str) -> GitResult<()> {
        self.git(&["switch", name.trim()]).map(drop)
    }

    /// The pull request for the current branch, if GitHub has one.
    pub fn pull_request(&self) -> GitResult<Option<PullRequest>> {
        let output = command("gh", &self.root, &["pr", "view", "--json", "number,title,url,state,isDraft"])?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            // gh reports a branch without a pull request as an error.
            if err.contains("no pull requests found") {
                return Ok(None);
            }
            return Err(GitError(err.trim().to_string()));
        }
        let pr: serde_json::Value =
            serde_json::from_slice(&output.stdout).map_err(|e| GitError(format!("unexpected reply from gh: {e}")))?;
        Ok(Some(PullRequest {
            number: pr["number"].as_u64().unwrap_or_default(),
            title: pr["title"].as_str().unwrap_or_default().to_string(),
            url: pr["url"].as_str().unwrap_or_default().to_string(),
            state: pr["state"].as_str().unwrap_or_default().to_string(),
            is_draft: pr["isDraft"].as_bool().unwrap_or_default(),
        }))
    }

    /// Opens a pull request for the current branch, which must already be pushed, and returns its URL.
    pub fn create_pull_request(&self, title: &str, body: &str, draft: bool) -> GitResult<String> {
        if title.trim().is_empty() {
            return Err(GitError("give the pull request a title first".into()));
        }
        let mut args = vec!["pr", "create", "--title", title.trim(), "--body", body];
        if draft {
            args.push("--draft");
        }
        let out = run("gh", &self.root, &args)?;
        Ok(out.lines().rev().find(|l| l.starts_with("http")).unwrap_or(out.trim()).to_string())
    }
}

/// What a shell command would do in git or on GitHub, for the Command Centre's rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum GitAction {
    Commit,
    /// Sends work to a remote: a push, or creating or merging a pull request.
    Publish,
}

/// The most far-reaching git action anywhere in `command`, including chained commands.
pub fn classify(command: &str) -> Option<GitAction> {
    command
        .split(['&', '|', ';', '\n'])
        .filter_map(|segment| classify_one(&segment.split_whitespace().collect::<Vec<_>>()))
        .max()
}

fn classify_one(words: &[&str]) -> Option<GitAction> {
    let (program, rest) = words.split_first()?;
    let program = program.trim_start_matches(['(', '{']).to_lowercase();
    match program.trim_end_matches(".exe") {
        "git" => {
            // Skip global options such as `-C <dir>` and `-c key=value` to find the subcommand.
            let mut rest = rest.iter();
            let sub = loop {
                match rest.next()? {
                    &"-C" | &"-c" | &"--git-dir" | &"--work-tree" => {
                        rest.next();
                    }
                    option if option.starts_with('-') => {}
                    sub => break *sub,
                }
            };
            match sub {
                "commit" => Some(GitAction::Commit),
                "push" => Some(GitAction::Publish),
                _ => None,
            }
        }
        "gh" => match rest {
            ["pr", "create" | "merge", ..] | ["repo", "create", ..] | ["release", "create", ..] => {
                Some(GitAction::Publish)
            }
            _ => None,
        },
        _ => None,
    }
}

fn parse_status(raw: &str) -> RepoStatus {
    let mut status = RepoStatus {
        root: String::new(),
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        unborn: false,
        files: Vec::new(),
        remotes: Vec::new(),
    };
    let mut entries = raw.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if let Some(header) = entry.strip_prefix("## ") {
            parse_branch_header(header, &mut status);
            continue;
        }
        if entry.len() < 4 {
            continue;
        }
        let (x, y) = (entry.as_bytes()[0] as char, entry.as_bytes()[1] as char);
        let path = entry[3..].to_string();
        let original = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            entries.next().map(str::to_string)
        } else {
            None
        };
        let conflicted = matches!((x, y), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D'));
        let (staged, unstaged) = if conflicted {
            (None, Some(ChangeKind::Conflicted))
        } else if (x, y) == ('?', '?') {
            (None, Some(ChangeKind::Untracked))
        } else {
            (kind(x), kind(y))
        };
        status.files.push(FileChange { path, original, staged, unstaged });
    }
    status
}

/// `main...origin/main [ahead 1, behind 2]`, `No commits yet on main` or `HEAD (no branch)`.
fn parse_branch_header(header: &str, status: &mut RepoStatus) {
    if let Some(branch) = header.strip_prefix("No commits yet on ") {
        status.unborn = true;
        status.branch = Some(branch.trim().to_string());
        return;
    }
    if header.starts_with("HEAD (no branch)") {
        return;
    }
    let (names, counts) = match header.split_once(" [") {
        Some((names, counts)) => (names, counts.trim_end_matches(']')),
        None => (header, ""),
    };
    match names.split_once("...") {
        Some((branch, upstream)) => {
            status.branch = Some(branch.to_string());
            status.upstream = Some(upstream.to_string());
        }
        None => status.branch = Some(names.to_string()),
    }
    for part in counts.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            status.ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            status.behind = n.parse().unwrap_or(0);
        }
    }
}

fn kind(code: char) -> Option<ChangeKind> {
    match code {
        'A' => Some(ChangeKind::Added),
        'M' => Some(ChangeKind::Modified),
        'D' => Some(ChangeKind::Deleted),
        'R' => Some(ChangeKind::Renamed),
        'C' => Some(ChangeKind::Copied),
        'T' => Some(ChangeKind::TypeChanged),
        _ => None,
    }
}

fn clip(mut text: String) -> String {
    if text.len() > MAX_DIFF_BYTES {
        let mut cut = MAX_DIFF_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n… diff cut short; open the file to see the rest\n");
    }
    text
}

fn null_device() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

/// Runs a CLI and returns its stdout, or its stderr as the error.
fn run(program: &str, dir: &Path, args: &[&str]) -> GitResult<String> {
    let output = command(program, dir, args)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(GitError(if err.is_empty() { out } else { err }))
    }
}

fn command(program: &str, dir: &Path, args: &[&str]) -> GitResult<Output> {
    let mut cmd = Command::new(program);
    cmd.current_dir(dir)
        .args(args)
        // Never wait on a prompt nobody can see; fail with a message instead.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_EDITOR", "true");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output().map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => GitError(format!("{program} is not installed or not on PATH")),
        _ => GitError(format!("could not run {program}: {err}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mc-git-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A repository with an identity, so commits work on machines without global git config.
    fn repo() -> (GitRepo, PathBuf) {
        let dir = temp("repo");
        let repo = GitRepo::init(&dir).unwrap();
        repo.git(&["config", "user.name", "Test"]).unwrap();
        repo.git(&["config", "user.email", "test@example.com"]).unwrap();
        repo.git(&["checkout", "-q", "-b", "main"]).unwrap();
        (repo, dir)
    }

    #[test]
    fn stage_commit_push_round_trip() {
        let (repo, dir) = repo();
        fs::write(dir.join("a.txt"), "one\n").unwrap();

        let status = repo.status().unwrap();
        assert!(status.unborn);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.files[0].unstaged, Some(ChangeKind::Untracked));
        assert!(repo.diff("a.txt", false).unwrap().contains("+one"));

        repo.stage(&[]).unwrap();
        assert_eq!(repo.status().unwrap().files[0].staged, Some(ChangeKind::Added));
        repo.unstage(&["a.txt".into()]).unwrap();
        assert_eq!(repo.status().unwrap().files[0].staged, None, "unstaging works before the first commit");

        assert_eq!(repo.commit("first"), Err(GitError("nothing is staged to commit".into())));
        repo.stage(&["a.txt".into()]).unwrap();
        assert!(!repo.commit("first").unwrap().is_empty());
        assert!(repo.status().unwrap().files.is_empty());

        // A local bare repository stands in for GitHub.
        let remote = temp("remote");
        run("git", &remote, &["init", "--bare", "-q"]).unwrap();
        assert!(repo.push().is_err(), "no remote yet");
        repo.git(&["remote", "add", "origin", &remote.display().to_string()]).unwrap();
        repo.push().unwrap();
        let status = repo.status().unwrap();
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));

        fs::write(dir.join("a.txt"), "two\n").unwrap();
        repo.stage(&[]).unwrap();
        repo.commit("second").unwrap();
        assert_eq!(repo.status().unwrap().ahead, 1);
        repo.push().unwrap();
        assert_eq!(repo.status().unwrap().ahead, 0);

        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(remote);
    }

    #[test]
    fn branches_are_created_and_switched_with_work_kept() {
        let (repo, dir) = repo();
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        repo.stage(&[]).unwrap();
        repo.commit("first").unwrap();
        fs::write(dir.join("a.txt"), "edited\n").unwrap();

        repo.create_branch("feature/login").unwrap();
        assert_eq!(repo.current_branch().as_deref(), Some("feature/login"));
        assert_eq!(repo.status().unwrap().files[0].unstaged, Some(ChangeKind::Modified));
        assert!(repo.create_branch("bad name..").is_err());
        assert_eq!(repo.branches().unwrap(), ["feature/login", "main"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn opening_a_folder_outside_git_says_so() {
        let dir = temp("plain");
        assert!(GitRepo::open(&dir).unwrap_err().0.contains("not inside a git repository"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn parses_branch_headers_renames_and_conflicts() {
        let raw = "## main...origin/main [ahead 2, behind 1]\0R  new.rs\0old.rs\0UU both.rs\0 M edited.rs\0";
        let s = parse_status(raw);
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!(s.files[0].original.as_deref(), Some("old.rs"));
        assert_eq!(s.files[0].staged, Some(ChangeKind::Renamed));
        assert_eq!(s.files[1].unstaged, Some(ChangeKind::Conflicted));
        assert_eq!((s.files[2].staged, s.files[2].unstaged), (None, Some(ChangeKind::Modified)));
        assert_eq!(parse_status("## HEAD (no branch)\0").branch, None);
    }

    #[test]
    fn classifies_git_actions_even_when_chained() {
        assert_eq!(classify("git commit -m 'fix'"), Some(GitAction::Commit));
        assert_eq!(classify("git -C repo push origin main"), Some(GitAction::Publish));
        assert_eq!(classify("git add . && git commit -m x && git push"), Some(GitAction::Publish));
        assert_eq!(classify("npm test; git.exe push"), Some(GitAction::Publish));
        assert_eq!(classify("gh pr create --fill"), Some(GitAction::Publish));
        assert_eq!(classify("gh pr view"), None);
        assert_eq!(classify("git status"), None);
        assert_eq!(classify("echo git push"), None);
    }
}
