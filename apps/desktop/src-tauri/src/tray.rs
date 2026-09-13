//! Tray menu authority. Menu ids resolve into semantic `TrayCommand`s and
//! dispatch forks here: surface presentation goes to the
//! `DesktopSurfaceManager` seam, while `Quit` goes straight to the app
//! lifecycle (`request_app_exit`) and never touches the surface seam.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::AppHandle;

use crate::desktop_surface::{DesktopSurfaceManager, SurfaceCommand, SurfaceId};
const TRAY_ID: &str = "yuvi-tray";
const TRAY_OPEN_MAIN: &str = "tray-open-main";
const TRAY_HIDE_MAIN: &str = "tray-hide-main";
const TRAY_OPEN_WEBUI: &str = "tray-open-webui";
const TRAY_HIDE_WEBUI: &str = "tray-hide-webui";
const TRAY_SHOW_COMPANION: &str = "tray-show-companion";
const TRAY_HIDE_COMPANION: &str = "tray-hide-companion";
const TRAY_SHOW_SUBTITLE: &str = "tray-show-subtitle";
const TRAY_HIDE_SUBTITLE: &str = "tray-hide-subtitle";
const TRAY_UNLOCK_SUBTITLE: &str = "tray-unlock-subtitle";
const TRAY_LOCK_COMPANION: &str = "tray-lock-companion";
const TRAY_UNLOCK_COMPANION: &str = "tray-unlock-companion";
const TRAY_QUIT: &str = "tray-quit";

/// A resolved tray intent. Surface intents carry one presentation command for
/// one existing surface; `Quit` is a lifecycle intent with no surface target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrayCommand {
  Main(SurfaceCommand),
  Companion(SurfaceCommand),
  WebUI(SurfaceCommand),
  Subtitle(SurfaceCommand),
  SubtitleUnlock,
  CompanionLock(bool),
  Quit,
}

/// Menu id → semantic command. Unknown ids resolve to `None` and dispatch
/// ignores them.
pub(crate) fn tray_command(id: &str) -> Option<TrayCommand> {
  match id {
    TRAY_OPEN_MAIN => Some(TrayCommand::Main(SurfaceCommand::Show)),
    TRAY_HIDE_MAIN => Some(TrayCommand::Main(SurfaceCommand::Hide)),
    TRAY_OPEN_WEBUI => Some(TrayCommand::WebUI(SurfaceCommand::Show)),
    TRAY_HIDE_WEBUI => Some(TrayCommand::WebUI(SurfaceCommand::Hide)),
    TRAY_SHOW_COMPANION => Some(TrayCommand::Companion(SurfaceCommand::Show)),
    TRAY_HIDE_COMPANION => Some(TrayCommand::Companion(SurfaceCommand::Hide)),
    TRAY_SHOW_SUBTITLE => Some(TrayCommand::Subtitle(SurfaceCommand::Show)),
    TRAY_HIDE_SUBTITLE => Some(TrayCommand::Subtitle(SurfaceCommand::Hide)),
    TRAY_UNLOCK_SUBTITLE => Some(TrayCommand::SubtitleUnlock),
    TRAY_LOCK_COMPANION => Some(TrayCommand::CompanionLock(true)),
    TRAY_UNLOCK_COMPANION => Some(TrayCommand::CompanionLock(false)),
    TRAY_QUIT => Some(TrayCommand::Quit),
    _ => None,
  }
}

/// Route one tray menu id. The `Quit` arm is the fork point: it calls the
/// lifecycle hook and never constructs a surface dispatch, so the surface
/// seam can never own exit.
pub(crate) fn dispatch_tray_menu<S, U, Q>(
  id: &str,
  mut on_surface: S,
  mut on_lock: U,
  mut on_quit: Q,
)
where
  S: FnMut(SurfaceId, SurfaceCommand),
  U: FnMut(SurfaceId, bool),
  Q: FnMut(),
{
  let Some(command) = tray_command(id) else { return };
  match command {
    TrayCommand::Quit => on_quit(),
    TrayCommand::SubtitleUnlock => on_lock(SurfaceId::Subtitle, false),
    TrayCommand::CompanionLock(locked) => on_lock(SurfaceId::Companion, locked),
    TrayCommand::Main(command) => on_surface(SurfaceId::Main, command),
    TrayCommand::Companion(command) => on_surface(SurfaceId::Companion, command),
    TrayCommand::WebUI(command) => on_surface(SurfaceId::WebUI, command),
    TrayCommand::Subtitle(command) => on_surface(SurfaceId::Subtitle, command),
  }
}

pub(crate) fn build_tray(app: &AppHandle) -> tauri::Result<()> {
  let open_main = MenuItem::with_id(app, TRAY_OPEN_MAIN, "Open YUVI", true, None::<&str>)?;
  let hide_main_item = MenuItem::with_id(app, TRAY_HIDE_MAIN, "Hide YUVI", true, None::<&str>)?;
  let open_webui = MenuItem::with_id(app, TRAY_OPEN_WEBUI, "Open WebUI", true, None::<&str>)?;
  let hide_webui_item = MenuItem::with_id(app, TRAY_HIDE_WEBUI, "Hide WebUI", true, None::<&str>)?;
  let show_companion_item =
    MenuItem::with_id(app, TRAY_SHOW_COMPANION, "Show Companion", true, None::<&str>)?;
  let hide_companion_item =
    MenuItem::with_id(app, TRAY_HIDE_COMPANION, "Hide Companion", true, None::<&str>)?;
  let show_subtitle_item =
    MenuItem::with_id(app, TRAY_SHOW_SUBTITLE, "Show Subtitle", true, None::<&str>)?;
  let hide_subtitle_item =
    MenuItem::with_id(app, TRAY_HIDE_SUBTITLE, "Hide Subtitle", true, None::<&str>)?;
  let unlock_subtitle_item =
    MenuItem::with_id(app, TRAY_UNLOCK_SUBTITLE, "Unlock Subtitle", true, None::<&str>)?;
  let lock_companion = MenuItem::with_id(app, TRAY_LOCK_COMPANION, "Lock Companion", true, None::<&str>)?;
  let unlock_companion = MenuItem::with_id(app, TRAY_UNLOCK_COMPANION, "Unlock Companion", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
  let menu = Menu::with_items(
    app,
    &[
      &open_main,
      &hide_main_item,
      &open_webui,
      &hide_webui_item,
      &show_companion_item,
      &hide_companion_item,
      &lock_companion,
      &unlock_companion,
      &show_subtitle_item,
      &hide_subtitle_item,
      &unlock_subtitle_item,
      &quit,
    ],
  )?;
  let icon = tauri::include_image!("icons/tray-32.png");

  TrayIconBuilder::with_id(TRAY_ID)
    .icon(icon)
    .tooltip("YUVI")
    .menu(&menu)
    .on_menu_event(|app, event| {
      dispatch_tray_menu(
        event.id.as_ref(),
        |surface, command| {
          if let Err(error) = DesktopSurfaceManager::execute(app, surface, command) {
            eprintln!("[yuvi-desktop] failed to dispatch tray surface command {surface:?} {command:?}: {error}");
          }
        },
        |surface, locked| {
          let result = if surface == SurfaceId::Companion {
            DesktopSurfaceManager::set_companion_locked(app, locked).map(|_| ())
          } else {
            DesktopSurfaceManager::set_subtitle_locked(app, locked).map(|_| ())
          };
          if let Err(error) = result {
            eprintln!("[yuvi-desktop] failed to set surface lock from tray: {error}");
          }
        },
        || crate::request_app_exit(app),
      );
    })
    .build(app)?;

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::{
    dispatch_tray_menu, tray_command, TRAY_HIDE_COMPANION, TRAY_HIDE_MAIN, TRAY_HIDE_SUBTITLE,
    TRAY_HIDE_WEBUI, TRAY_OPEN_MAIN, TRAY_OPEN_WEBUI, TRAY_QUIT, TRAY_SHOW_COMPANION,
    TRAY_SHOW_SUBTITLE, TRAY_UNLOCK_SUBTITLE, TrayCommand,
  };
  use crate::desktop_surface::{SurfaceCommand, SurfaceId};

  #[test]
  fn menu_ids_resolve_to_semantic_tray_commands() {
    assert_eq!(
      tray_command(TRAY_OPEN_MAIN),
      Some(TrayCommand::Main(SurfaceCommand::Show))
    );
    assert_eq!(
      tray_command(TRAY_HIDE_MAIN),
      Some(TrayCommand::Main(SurfaceCommand::Hide))
    );
    assert_eq!(
      tray_command(TRAY_OPEN_WEBUI),
      Some(TrayCommand::WebUI(SurfaceCommand::Show))
    );
    assert_eq!(
      tray_command(TRAY_HIDE_WEBUI),
      Some(TrayCommand::WebUI(SurfaceCommand::Hide))
    );
    assert_eq!(
      tray_command(TRAY_SHOW_COMPANION),
      Some(TrayCommand::Companion(SurfaceCommand::Show))
    );
    assert_eq!(
      tray_command(TRAY_HIDE_COMPANION),
      Some(TrayCommand::Companion(SurfaceCommand::Hide))
    );
    assert_eq!(
      tray_command(TRAY_SHOW_SUBTITLE),
      Some(TrayCommand::Subtitle(SurfaceCommand::Show))
    );
    assert_eq!(
      tray_command(TRAY_HIDE_SUBTITLE),
      Some(TrayCommand::Subtitle(SurfaceCommand::Hide))
    );
    assert_eq!(
      tray_command(TRAY_UNLOCK_SUBTITLE),
      Some(TrayCommand::SubtitleUnlock)
    );
    assert_eq!(tray_command(TRAY_QUIT), Some(TrayCommand::Quit));
  }

  /// Structural Quit-bypass invariant: the lifecycle hook fires and no surface
  /// dispatch is constructed. Quit must never reach `DesktopSurfaceManager`.
  #[test]
  fn quit_forks_to_lifecycle_and_never_enters_the_surface_seam() {
    let mut surface_dispatches: Vec<(SurfaceId, SurfaceCommand)> = Vec::new();
    let mut quit_calls = 0;
    let mut subtitle_unlocks = 0;
    dispatch_tray_menu(
      TRAY_QUIT,
      |surface, command| surface_dispatches.push((surface, command)),
      |_, _| subtitle_unlocks += 1,
      || quit_calls += 1,
    );
    assert!(
      surface_dispatches.is_empty(),
      "Quit must bypass DesktopSurfaceManager"
    );
    assert_eq!(subtitle_unlocks, 0);
    assert_eq!(quit_calls, 1);
  }

  #[test]
  fn surface_menu_commands_reach_their_surface_and_not_the_exit_path() {
    let cases = [
      (TRAY_OPEN_MAIN, (SurfaceId::Main, SurfaceCommand::Show)),
      (TRAY_HIDE_MAIN, (SurfaceId::Main, SurfaceCommand::Hide)),
      (TRAY_OPEN_WEBUI, (SurfaceId::WebUI, SurfaceCommand::Show)),
      (TRAY_HIDE_WEBUI, (SurfaceId::WebUI, SurfaceCommand::Hide)),
      (
        TRAY_SHOW_COMPANION,
        (SurfaceId::Companion, SurfaceCommand::Show),
      ),
      (
        TRAY_HIDE_COMPANION,
        (SurfaceId::Companion, SurfaceCommand::Hide),
      ),
      (
        TRAY_SHOW_SUBTITLE,
        (SurfaceId::Subtitle, SurfaceCommand::Show),
      ),
      (
        TRAY_HIDE_SUBTITLE,
        (SurfaceId::Subtitle, SurfaceCommand::Hide),
      ),
    ];
    for (id, expected) in cases {
      let mut surface_dispatches: Vec<(SurfaceId, SurfaceCommand)> = Vec::new();
      let mut quit_calls = 0;
      let mut subtitle_unlocks = 0;
      dispatch_tray_menu(
        id,
        |surface, command| surface_dispatches.push((surface, command)),
        |_, _| subtitle_unlocks += 1,
        || quit_calls += 1,
      );
      assert_eq!(quit_calls, 0, "{id} must not touch the lifecycle exit path");
      assert_eq!(subtitle_unlocks, 0, "{id} must not touch Subtitle lock state");
      assert_eq!(surface_dispatches, vec![expected]);
    }
  }

  #[test]
  fn subtitle_unlock_reaches_only_the_presentation_lock_path() {
    let mut surface_dispatches: Vec<(SurfaceId, SurfaceCommand)> = Vec::new();
    let mut subtitle_unlocks = 0;
    let mut quit_calls = 0;
    dispatch_tray_menu(
      TRAY_UNLOCK_SUBTITLE,
      |surface, command| surface_dispatches.push((surface, command)),
      |_, _| subtitle_unlocks += 1,
      || quit_calls += 1,
    );
    assert!(surface_dispatches.is_empty());
    assert_eq!(subtitle_unlocks, 1);
    assert_eq!(quit_calls, 0);
  }

  #[test]
  fn companion_lock_and_unlock_dispatch_only_to_surface_authority() {
    for (id, locked) in [(super::TRAY_LOCK_COMPANION, true), (super::TRAY_UNLOCK_COMPANION, false)] {
      let mut locks = Vec::new();
      dispatch_tray_menu(id, |_, _| panic!("unexpected visibility command"),
        |surface, value| locks.push((surface, value)), || panic!("unexpected quit"));
      assert_eq!(locks, vec![(SurfaceId::Companion, locked)]);
    }
  }

  #[test]
  fn unknown_menu_ids_are_ignored_safely() {
    let mut surface_dispatches: Vec<(SurfaceId, SurfaceCommand)> = Vec::new();
    let mut quit_calls = 0;
    let mut subtitle_unlocks = 0;
    dispatch_tray_menu(
      "tray-not-a-command",
      |surface, command| surface_dispatches.push((surface, command)),
      |_, _| subtitle_unlocks += 1,
      || quit_calls += 1,
    );
    assert!(surface_dispatches.is_empty());
    assert_eq!(subtitle_unlocks, 0);
    assert_eq!(quit_calls, 0);
  }
}
