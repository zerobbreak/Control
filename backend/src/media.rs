//! What is playing on the computer, and the play / pause / skip / volume controls, through
//! Windows' own media controls (the ones the volume flyout shows). Only used once the user has
//! allowed media controls.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: Option<String>,
    /// The app playing it, as a person would name it, e.g. "Chrome".
    pub app: String,
    pub playing: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaAction {
    PlayPause,
    Next,
    Previous,
    VolumeUp,
    VolumeDown,
    Mute,
}

/// "chrome.exe" or "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" reads as an app name.
pub fn app_name(source: &str) -> String {
    let base = source.rsplit(['\\', '/']).next().unwrap_or(source);
    let base = base.split('!').next_back().unwrap_or(base);
    let base = base.strip_suffix(".exe").or_else(|| base.strip_suffix(".EXE")).unwrap_or(base);
    let base = base.rsplit('.').next().unwrap_or(base);
    let known = [("chrome", "Chrome"), ("msedge", "Edge"), ("firefox", "Firefox"), ("spotify", "Spotify"), ("zunemusic", "Media Player")];
    let lower = base.to_lowercase();
    known
        .iter()
        .find(|(id, _)| lower.contains(id))
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| base.to_string())
}

#[cfg(windows)]
mod platform {
    use super::{app_name, MediaAction, NowPlaying};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_VOLUME_DOWN, VK_VOLUME_MUTE,
        VK_VOLUME_UP,
    };

    fn session() -> windows::core::Result<Option<Session>> {
        // Calls come from worker threads; joining the multithreaded apartment twice is harmless.
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        let manager = Manager::RequestAsync()?.join()?;
        Ok(manager.GetCurrentSession().ok())
    }

    pub fn now_playing() -> Result<Option<NowPlaying>, String> {
        let Some(session) = session().map_err(|e| e.to_string())? else { return Ok(None) };
        let props = session.TryGetMediaPropertiesAsync().and_then(|op| op.join()).map_err(|e| e.to_string())?;
        let title = props.Title().map(|t| t.to_string()).unwrap_or_default();
        if title.is_empty() {
            return Ok(None);
        }
        let artist = props.Artist().map(|a| a.to_string()).ok().filter(|a| !a.is_empty());
        let app = session.SourceAppUserModelId().map(|s| app_name(&s.to_string())).unwrap_or_default();
        let playing = session.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).is_ok_and(|s| s == Status::Playing);
        Ok(Some(NowPlaying { title, artist, app, playing }))
    }

    pub fn control(action: MediaAction) -> Result<(), String> {
        let key = match action {
            MediaAction::VolumeUp => Some(VK_VOLUME_UP),
            MediaAction::VolumeDown => Some(VK_VOLUME_DOWN),
            MediaAction::Mute => Some(VK_VOLUME_MUTE),
            _ => None,
        };
        if let Some(key) = key {
            return press(key);
        }
        let session = session().map_err(|e| e.to_string())?.ok_or("nothing is playing")?;
        let op = match action {
            MediaAction::PlayPause => session.TryTogglePlayPauseAsync(),
            MediaAction::Next => session.TrySkipNextAsync(),
            _ => session.TrySkipPreviousAsync(),
        };
        let done = op.and_then(|op| op.join()).map_err(|e| e.to_string())?;
        if done { Ok(()) } else { Err("the app playing it did not respond".into()) }
    }

    /// Volume is the system's, so it is the volume keys rather than one app's level.
    fn press(key: VIRTUAL_KEY) -> Result<(), String> {
        let input = |flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: key, dwFlags: flags, ..Default::default() } },
        };
        let inputs = [input(Default::default()), input(KEYEVENTF_KEYUP)];
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == 2 { Ok(()) } else { Err("Windows did not take the key press".into()) }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{MediaAction, NowPlaying};

    pub fn now_playing() -> Result<Option<NowPlaying>, String> {
        Ok(None)
    }

    pub fn control(_action: MediaAction) -> Result<(), String> {
        Err("media controls are only available on Windows".into())
    }
}

pub use platform::{control, now_playing};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_app_playing() {
        assert_eq!(app_name("chrome.exe"), "Chrome");
        assert_eq!(app_name("Chrome"), "Chrome");
        assert_eq!(app_name("C:\\Program Files\\Mozilla Firefox\\firefox.exe"), "Firefox");
        assert_eq!(app_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        assert_eq!(app_name("vlc.exe"), "vlc");
    }
}

#[cfg(all(test, windows))]
mod live {
    /// Reads whatever this machine is playing. Run by hand: `cargo test media -- --ignored`.
    #[test]
    #[ignore]
    fn reads_what_is_playing_here() {
        println!("{:?}", super::now_playing());
        assert!(super::now_playing().is_ok());
    }
}
