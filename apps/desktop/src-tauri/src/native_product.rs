//! Restricted product transport. Credentials are native-only and never returned by an IPC command.
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
  collections::HashMap,
  fs,
  path::PathBuf,
  sync::atomic::{AtomicU64, Ordering},
};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct NativeProduct {
  mutation: Mutex<()>,
  generation: AtomicU64,
  sockets: Mutex<
    HashMap<
      String,
      (
        String,
        tokio::sync::mpsc::Sender<String>,
        tauri::async_runtime::JoinHandle<()>,
      ),
    >,
  >,
  streams: Mutex<HashMap<String, (String, tauri::async_runtime::JoinHandle<()>)>>,
}
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Vault {
  owner_id: String,
  #[serde(default)]
  suspended: bool,
  binding: Option<String>,
  cookie: Option<String>,
  origin: Option<String>,
  person: Option<Value>,
  pending: Option<Pending>,
}
#[derive(Serialize, Deserialize)]
struct Pending {
  handle: String,
  name: String,
}

pub(crate) fn document_allowed(url: &url::Url, dev: Option<&url::Url>) -> bool {
  if !url.username().is_empty() || url.password().is_some() {
    return false;
  }
  // Exact origins; never suffix, prefix, arbitrary tauri:, or a navigation's claimed label.
  let origin = format!(
    "{}://{}{}",
    url.scheme(),
    url.host_str().unwrap_or(""),
    url.port().map(|p| format!(":{p}")).unwrap_or_default()
  );
  matches!(
    origin.as_str(),
    "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
  ) || (cfg!(debug_assertions) && dev.is_some_and(|d| url.origin() == d.origin()))
}
fn check(window: &WebviewWindow) -> Result<String, String> {
  if !matches!(window.label(), "main" | "webui") {
    return Err("This surface has no private product capability".into());
  }
  let url = window.url().map_err(|_| "Document unavailable")?;
  if !document_allowed(&url, window.app_handle().config().build.dev_url.as_ref()) {
    return Err("Untrusted product document".into());
  }
  Ok(if url.scheme() == "tauri" {
    "tauri://localhost".into()
  } else {
    url.origin().ascii_serialization()
  })
}
fn path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_config_dir()
    .map_err(|_| "Private configuration unavailable")?
    .join("native-product");
  fs::create_dir_all(&dir).map_err(|_| "Private configuration unavailable")?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
      .map_err(|_| "Private configuration permissions failed")?;
  }
  Ok(dir.join("owner.json"))
}
fn read(app: &AppHandle) -> Result<Option<Vault>, String> {
  match fs::read(path(app)?) {
    Ok(bytes) => serde_json::from_slice(&bytes)
      .map(Some)
      .map_err(|_| "Desktop identity file is invalid; explicit recovery is required".into()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(_) => Err("Desktop identity unavailable".into()),
  }
}
fn save(app: &AppHandle, vault: &Vault) -> Result<(), String> {
  use std::io::Write;
  let file = path(app)?;
  let mut temporary = tempfile::NamedTempFile::new_in(file.parent().unwrap())
    .map_err(|_| "Cannot persist desktop identity")?;
  temporary
    .write_all(&serde_json::to_vec(vault).map_err(|_| "Cannot encode desktop identity")?)
    .map_err(|_| "Cannot persist desktop identity")?;
  temporary
    .as_file()
    .sync_all()
    .map_err(|_| "Cannot sync desktop identity")?;
  temporary
    .persist(&file)
    .map_err(|_| "Cannot commit desktop identity")?;
  #[cfg(unix)]
  fs::File::open(file.parent().unwrap())
    .and_then(|f| f.sync_all())
    .map_err(|_| "Desktop identity commit UNKNOWN")?;
  Ok(())
}
fn consent(window: &WebviewWindow, message: &str) -> bool {
  window
    .dialog()
    .message(message)
    .title("YUVI · 本机身份确认")
    .parent(window)
    .buttons(MessageDialogButtons::OkCancel)
    .blocking_show()
}
pub(crate) fn confirm_control(window: &WebviewWindow, message: &str) -> Result<(), String> {
  check(window)?;
  if read(window.app_handle())?.is_none() {
    return Err("Confirm desktop ownership first".into());
  }
  if !consent(window, message) {
    return Err("Native control cancelled".into());
  }
  Ok(())
}
async fn control(app: &AppHandle, action: &'static str, body: Value) -> Result<Value, String> {
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    crate::supervisor::native_product(&app, action, &body)
  })
  .await
  .map_err(|_| "Native controller failed".to_string())?
}
async fn binding(app: &AppHandle) -> Result<Value, String> {
  control(app, "binding", json!({})).await
}
fn bound(vault: &Vault, binding: &Value, origin: &str) -> Result<(), String> {
  if vault.binding.as_deref() != binding["binding"].as_str()
    || vault.origin.as_deref() != Some(origin)
    || vault.cookie.is_none()
  {
    return Err("Desktop product identity is absent or belongs to another Runtime".into());
  }
  Ok(())
}
async fn invalidate(app: &AppHandle, state: &NativeProduct) {
  state.generation.fetch_add(1, Ordering::SeqCst);
  for (_, (_, task)) in state.streams.lock().await.drain() {
    task.abort();
  }
  for (_, (_, _, task)) in state.sockets.lock().await.drain() {
    task.abort();
  }
  let _ = app.emit("native-product-changed", ());
}
fn client() -> Result<reqwest::Client, String> {
  reqwest::Client::builder()
    .redirect(reqwest::redirect::Policy::none())
    .connect_timeout(std::time::Duration::from_secs(5))
    .build()
    .map_err(|_| "Native transport unavailable".into())
}
async fn send(
  app: &AppHandle,
  vault: &Vault,
  origin: &str,
  path: &str,
  method: &str,
  body: Option<Value>,
) -> Result<reqwest::Response, String> {
  let b = binding(app).await?;
  bound(vault, &b, origin)?;
  let base = b["runtimeUrl"]
    .as_str()
    .ok_or("Runtime binding unavailable")?;
  let url = url::Url::parse(base).map_err(|_| "Invalid Runtime binding")?;
  if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
  {
    return Err("Runtime is not local".into());
  }
  let mut request = client()?
    .request(
      reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid method")?,
      format!("{base}{path}"),
    )
    .header("origin", origin)
    .header("cookie", vault.cookie.as_deref().unwrap());
  if let Some(body) = body {
    request = request.json(&body);
  }
  request
    .send()
    .await
    .map_err(|_| "Runtime product transport unavailable".into())
}

/// Credential renewal never retries a conversational side effect.
async fn active(app: &AppHandle, vault: &mut Vault, origin: &str) -> Result<(), String> {
  if vault.suspended {
    return Err("Sign-out pending".into());
  }
  let status = send(app, vault, origin, "/host/v1/product/status", "GET", None).await?;
  if status.status().as_u16() == 401 {
    vault.cookie = None;
    vault.person = None;
    save(app, vault)?;
    app
      .state::<NativeProduct>()
      .generation
      .fetch_add(1, Ordering::SeqCst);
    let _ = app.emit("native-product-changed", ());
    return Err("Product identity revoked or no longer renewable".into());
  }
  if !status.status().is_success() {
    return Err("Product identity status UNKNOWN".into());
  }
  let status: Value = status
    .json()
    .await
    .map_err(|_| "Product identity status incomplete")?;
  if status["status"] == "ACTIVE" {
    return Ok(());
  }
  if status["status"] != "EXPIRED" {
    return Err("Product identity is inactive".into());
  }
  let response = send(app, vault, origin, "/host/v1/product/renew", "POST", None).await?;
  if !response.status().is_success() {
    return Err("Product renewal unavailable; no operation was retried".into());
  }
  let cookie = response
    .headers()
    .get("set-cookie")
    .and_then(|h| h.to_str().ok())
    .and_then(|s| s.split(';').next())
    .ok_or("Product renewal receipt UNKNOWN")?;
  vault.cookie = Some(cookie.into());
  save(app, vault)?;
  Ok(())
}

#[tauri::command]
pub async fn native_product_activation(
  window: WebviewWindow,
  app: AppHandle,
  state: State<'_, NativeProduct>,
  action: String,
  name: Option<String>,
  person_id: Option<String>,
) -> Result<Value, String> {
  let origin = check(&window)?;
  let _guard = state.mutation.lock().await;
  let mut vault = match read(&app)? {
    Some(v) => v,
    None if action == "own" => {
      if !consent(&window, "确认这是你拥有的本机 YUVI 实例？\n仅此桌面创建的身份会在本机列出。已有身份需要明确的迁移授权。") { return Err("Ownership confirmation cancelled".into()); }
      let v = Vault {
        owner_id: format!(
          "yno_{}",
          crate::config::secrets::generate_postgres_password()?
        ),
        ..Vault::default()
      };
      save(&app, &v)?;
      v
    }
    None => return Ok(json!({"owned": false, "people": [], "person": null})),
  };
  if vault.suspended && !matches!(action.as_str(), "status" | "logout") {
    return Err("Complete the pending sign-out before selecting another identity".into());
  }
  if action == "enable" {
    if !consent(&window, "为此桌面启用本机 R5 记忆？\n会启动本实例的存储和 Runtime 服务；旧记忆不会自动迁移，也不会认领已有身份。") { return Err("Activation cancelled".into()); }
    let patch: crate::config::UserSettingsPatch = serde_json::from_value(json!({
      "memory":{"backend":"postgres","enabled":true,"mode":"managed"},
      "runtime":{"autostart":true,"mode":"managed"}
    }))
    .map_err(|_| "Invalid native activation configuration")?;
    app
      .state::<crate::config::ConfigState>()
      .service
      .update_settings(patch)?;
    let boot_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
      crate::durable_memory_boot::bootstrap_attached_linux(&boot_app)
    })
    .await
    .map_err(|_| "Native activation interrupted")??;
  } else if action == "create" || action == "resume" {
    if action == "create" && vault.pending.is_none() {
      let name = name
        .ok_or("A display name is required")?
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_string();
      if name.is_empty() || name.encode_utf16().count() > 100 {
        return Err("Invalid display name".into());
      }
      if !consent(
        &window,
        &format!("在此桌面创建独立身份「{name}」？\n创建后可进入聊天；它不会接管其他人的身份。"),
      ) {
        return Err("Creation cancelled".into());
      }
      vault.pending = Some(Pending {
        handle: format!(
          "desktop-create-{}",
          crate::config::secrets::generate_postgres_password()?
        ),
        name,
      });
      save(&app, &vault)?; // Freeze before A9 dispatch. UNKNOWN always reuses this exact command.
    }
    let pending = vault.pending.as_ref().ok_or("No pending creation")?;
    let result = control(&app, "create", json!({"ownerId": vault.owner_id, "displayName": pending.name, "commandHandle": pending.handle})).await?;
    if result["status"] != "APPLIED" {
      return Err(format!(
        "Person creation {}. Retry the pending creation; do not create a replacement.",
        result["status"]
      ));
    }
    vault.pending = None;
    save(&app, &vault)?;
  } else if action == "select" {
    let people = control(&app, "people", json!({"ownerId": vault.owner_id})).await?;
    let person = people["people"]
      .as_array()
      .and_then(|p| p.iter().find(|p| p["id"].as_str() == person_id.as_deref()))
      .ok_or("Person is not owned by this desktop")?
      .clone();
    if !consent(
      &window,
      &format!(
        "以「{}」进入此窗口绑定的 YUVI？\n将退出当前身份并清除窗口中的旧数据。",
        person["displayName"].as_str().unwrap_or("")
      ),
    ) {
      return Err("Selection cancelled".into());
    }
    vault.suspended = true;
    save(&app, &vault)?;
    invalidate(&app, &state).await;
    // Revoke and persist the empty old identity before issuing a new grant. UNKNOWN blocks switching.
    if vault.cookie.is_some() {
      let response = send(
        &app,
        &vault,
        vault.origin.as_deref().unwrap_or(&origin),
        "/host/v1/product/revoke",
        "POST",
        None,
      )
      .await?;
      if !response.status().is_success() && response.status().as_u16() != 401 {
        return Err("Previous identity revocation UNKNOWN".into());
      }
      vault.cookie = None;
      vault.person = None;
      save(&app, &vault)?;
    }
    vault.suspended = false;
    save(&app, &vault)?;
    let b = binding(&app).await?;
    let session = control(
      &app,
      "session",
      json!({"ownerId": vault.owner_id, "personId": person["id"], "origin": origin}),
    )
    .await?;
    if session["personId"] != person["id"] {
      return Err("Product session receipt does not match the confirmed Person".into());
    }
    vault.binding = b["binding"].as_str().map(str::to_string);
    vault.cookie = session["cookie"].as_str().map(str::to_string);
    vault.origin = Some(origin);
    vault.person = Some(person);
    if vault.cookie.is_none() {
      return Err("Product session issuance UNKNOWN".into());
    }
    save(&app, &vault)?;
    invalidate(&app, &state).await;
  } else if action == "logout" {
    vault.suspended = true;
    save(&app, &vault)?;
    invalidate(&app, &state).await;
    if vault.cookie.is_some() {
      let response = send(
        &app,
        &vault,
        vault.origin.as_deref().unwrap_or(&origin),
        "/host/v1/product/revoke",
        "POST",
        None,
      )
      .await?;
      if !response.status().is_success() && response.status().as_u16() != 401 {
        return Err("Revocation UNKNOWN; retry logout".into());
      }
    }
    vault.cookie = None;
    vault.person = None;
    vault.suspended = false;
    save(&app, &vault)?;
  } else if !matches!(action.as_str(), "status" | "own") {
    return Err("Unknown activation operation".into());
  }
  let people = match control(&app, "people", json!({"ownerId": vault.owner_id})).await {
    Ok(people) => people,
    Err(_) if matches!(action.as_str(), "status" | "own") => {
      return Ok(
        json!({"owned":true,"people":[],"person":null,"pending":vault.pending.is_some(),"revocationPending":vault.suspended,"serviceUnavailable":true,
        "memoryConfigured":matches!(app.state::<crate::config::ConfigState>().service.current_settings()?.memory.backend, crate::config::MemoryBackend::Postgres)}),
      )
    }
    Err(error) => return Err(error),
  };
  Ok(
    json!({"owned": true, "people": people["people"], "person": if vault.suspended { None } else { vault.person }, "pending": vault.pending.is_some(), "revocationPending": vault.suspended}),
  )
}

fn allowed(path: &str, method: &str, body: &Option<Value>, vault: &Vault) -> bool {
  if path.contains('\\')
    || path.contains('#')
    || path.contains("..")
    || !path.starts_with('/')
    || path.starts_with("//")
  {
    return false;
  }
  let Ok(url) = url::Url::parse(&format!("http://native.invalid{path}")) else {
    return false;
  };
  let route = url.path();
  if method == "GET"
    && matches!(
      route,
      "/health" | "/live2d/models" | "/host/v1/product/status" | "/v1/conversations/history"
    )
  {
    return true;
  }
  if method == "POST"
    && matches!(
      route,
      "/v1/messages" | "/v1/messages/stream" | "/host/v1/product/renew" | "/host/v1/product/memory"
    )
  {
    return true;
  }
  if method != "GET" || !route.starts_with("/memory/v1/") {
    return false;
  }
  let _ = (body, vault);
  matches!(
    route,
    "/memory/v1/overview"
      | "/memory/v1/current"
      | "/memory/v1/timeline"
      | "/memory/v1/detail"
      | "/memory/v1/relations"
      | "/memory/v1/processing"
      | "/memory/v1/ingestion"
      | "/memory/v1/retrievals"
      | "/memory/v1/retrieval"
  )
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductResponse {
  status: u16,
  content_type: String,
  body: String,
}

#[tauri::command]
pub async fn native_product_request(
  window: WebviewWindow,
  app: AppHandle,
  state: State<'_, NativeProduct>,
  path: String,
  method: String,
  body: Option<Value>,
) -> Result<ProductResponse, String> {
  let origin = check(&window)?;
  let _guard = state.mutation.lock().await; // Linearize rotation/revocation against other requests.
  let mut vault = read(&app)?.ok_or("Desktop ownership required")?;
  if vault.suspended {
    return Err("Sign-out is pending; private product operations are disabled".into());
  }
  if !allowed(&path, &method, &body, &vault) || path == "/v1/messages/stream" {
    return Err("Operation is outside the product capability".into());
  }
  if !matches!(
    path.as_str(),
    "/host/v1/product/status" | "/host/v1/product/renew" | "/host/v1/product/revoke"
  ) {
    active(&app, &mut vault, &origin).await?;
  }
  let response = send(&app, &vault, &origin, &path, &method, body).await?;
  let status = response.status().as_u16();
  if path == "/host/v1/product/memory" && response.status().is_success() {
    let _ = app.emit("native-product-permissions-changed", ());
  }
  if let Some(cookie) = response
    .headers()
    .get("set-cookie")
    .and_then(|h| h.to_str().ok())
  {
    if path != "/host/v1/product/renew" {
      return Err("Unexpected credential rotation".into());
    }
    vault.cookie = Some(
      cookie
        .split(';')
        .next()
        .ok_or("Invalid credential rotation")?
        .into(),
    );
    save(&app, &vault)?;
  }
  if status == 401 {
    vault.cookie = None;
    vault.person = None;
    save(&app, &vault)?;
    invalidate(&app, &state).await;
  }
  let content_type = response
    .headers()
    .get("content-type")
    .and_then(|h| h.to_str().ok())
    .unwrap_or("application/json")
    .to_string();
  if response.content_length().is_some_and(|n| n > 8_000_000) {
    return Err("Product response too large".into());
  }
  let bytes = response
    .bytes()
    .await
    .map_err(|_| "Product response incomplete")?;
  if bytes.len() > 8_000_000 {
    return Err("Product response too large".into());
  }
  let body = String::from_utf8(bytes.to_vec()).map_err(|_| "Invalid product response encoding")?;
  Ok(ProductResponse {
    status,
    content_type,
    body,
  })
}

#[tauri::command]
pub async fn native_product_stream(
  window: WebviewWindow,
  app: AppHandle,
  state: State<'_, NativeProduct>,
  id: String,
  body: Value,
  channel: Channel<Value>,
) -> Result<(), String> {
  let origin = check(&window)?;
  if id.len() > 100 || id.is_empty() {
    return Err("Invalid stream ID".into());
  }
  let _guard = state.mutation.lock().await;
  let vault = read(&app)?.ok_or("Desktop ownership required")?;
  if vault.suspended {
    return Err("Sign-out pending".into());
  }
  let generation = state.generation.load(Ordering::SeqCst);
  let mut streams = state.streams.lock().await;
  if streams.contains_key(&id) {
    return Err("Stream ID already in use".into());
  }
  let owner = window.label().to_string();
  let task_app = app.clone();
  let task_id = id.clone();
  let task = tauri::async_runtime::spawn(async move {
    let state = task_app.state::<NativeProduct>();
    let admission = state.mutation.lock().await;
    let prepared = async {
      if state.generation.load(Ordering::SeqCst) != generation {
        return Err("Identity changed".into());
      }
      let mut vault = read(&task_app)?.ok_or("Desktop ownership required")?;
      active(&task_app, &mut vault, &origin).await?;
      send(
        &task_app,
        &vault,
        &origin,
        "/v1/messages/stream",
        "POST",
        Some(body),
      )
      .await
    }
    .await;
    drop(admission);
    let response = match prepared {
      Ok(response) => response,
      Err(_) => {
        let _ = channel.send(json!({"type":"error"}));
        state.streams.lock().await.remove(&task_id);
        return;
      }
    };
    if state.generation.load(Ordering::SeqCst) != generation {
      return;
    }
    let content_type = response
      .headers()
      .get("content-type")
      .and_then(|h| h.to_str().ok())
      .unwrap_or("")
      .to_string();
    if channel
      .send(json!({"type":"open", "status":response.status().as_u16(), "contentType":content_type}))
      .is_err()
    {
      state.streams.lock().await.remove(&task_id);
      return;
    }
    let mut bytes = response.bytes_stream();
    let mut complete = true;
    while let Some(chunk) = bytes.next().await {
      if state.generation.load(Ordering::SeqCst) != generation {
        complete = false;
        break;
      }
      match chunk {
        Ok(chunk)
          if channel
            .send(json!({"type":"chunk", "bytes":chunk.to_vec()}))
            .is_ok() => {}
        _ => {
          complete = false;
          break;
        }
      }
    }
    let _ = channel.send(json!({"type": if complete { "close" } else { "error" }}));
    state.streams.lock().await.remove(&task_id);
  });
  streams.insert(id, (owner, task));
  Ok(())
}
#[tauri::command]
pub async fn native_product_cancel(
  window: WebviewWindow,
  state: State<'_, NativeProduct>,
  id: String,
) -> Result<(), String> {
  check(&window)?;
  let mut streams = state.streams.lock().await;
  if streams
    .get(&id)
    .is_some_and(|(owner, _)| owner == window.label())
  {
    if let Some((_, task)) = streams.remove(&id) {
      task.abort();
    }
  }
  let mut sockets = state.sockets.lock().await;
  if sockets
    .get(&id)
    .is_some_and(|(owner, _, _)| owner == window.label())
  {
    if let Some((_, _, task)) = sockets.remove(&id) {
      task.abort();
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn exact_documents_only() {
    for u in [
      "tauri://localhost/index.html#/main",
      "http://tauri.localhost/index.html",
      "https://tauri.localhost/index.html",
    ] {
      assert!(document_allowed(&url::Url::parse(u).unwrap(), None));
    }
    for u in [
      "tauri://evil/index.html",
      "http://tauri.localhost.evil",
      "https://evil/tauri.localhost",
      "http://tauri.localhost:8080",
      "http://127.0.0.1:9999",
      "data:text/html,hi",
    ] {
      assert!(!document_allowed(&url::Url::parse(u).unwrap(), None), "{u}");
    }
  }
  #[test]
  fn operations_are_bounded() {
    let vault = Vault::default();
    for p in [
      "/people/create",
      "/host/v1/identity",
      "/product/settings",
      "//evil/health",
      "/memory/v1/../people",
      "/memory/v1/%2e%2e/people",
    ] {
      assert!(!allowed(p, "POST", &None, &vault));
    }
    assert!(allowed(
      "/memory/v1/current?scope=untrusted",
      "GET",
      &None,
      &vault
    )); // Server enforces exact authenticated scope.
  }
}

/// Public model resources only. No identity header, Cookie, arbitrary origin, redirect or admin route.
/// Keeps the bundled CSP independent of a changing loopback port.
pub(crate) fn asset_protocol(
  context: tauri::UriSchemeContext<'_, tauri::Wry>,
  request: tauri::http::Request<Vec<u8>>,
  responder: tauri::UriSchemeResponder,
) {
  let app = context.app_handle().clone();
  let path = request.uri().path().to_string();
  let allowed = request.method() == "GET"
    && (path == "/live2d-core/live2dcubismcore.min.js" || path.starts_with("/live2d/"))
    && !path.contains("..")
    && !path.contains('\\')
    && !path.to_lowercase().contains("%2e")
    && !path.to_lowercase().contains("%2f");
  tauri::async_runtime::spawn(async move {
    let result = async {
      if !allowed {
        return Err("Asset path forbidden");
      }
      let b = binding(&app)
        .await
        .map_err(|_| "Asset Runtime unavailable")?;
      let base = b["runtimeUrl"]
        .as_str()
        .ok_or("Asset Runtime unavailable")?;
      let response = client()
        .map_err(|_| "Asset transport unavailable")?
        .get(format!("{base}{path}"))
        .send()
        .await
        .map_err(|_| "Asset unavailable")?;
      let status = response.status().as_u16();
      let content = response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
      let bytes = response.bytes().await.map_err(|_| "Asset incomplete")?;
      if bytes.len() > 128_000_000 {
        return Err("Asset too large");
      }
      Ok((status, content, bytes.to_vec()))
    }
    .await;
    let (status, content, bytes) =
      result.unwrap_or_else(|_| (403, "text/plain".into(), b"Asset unavailable".to_vec()));
    responder.respond(
      tauri::http::Response::builder()
        .status(status)
        .header("content-type", content)
        .header("access-control-allow-origin", "*")
        .body(bytes)
        .unwrap(),
    );
  });
}

#[tauri::command]
pub async fn native_product_socket(
  window: WebviewWindow,
  app: AppHandle,
  state: State<'_, NativeProduct>,
  id: String,
  channel: Channel<Value>,
) -> Result<(), String> {
  use tokio_tungstenite::tungstenite::client::IntoClientRequest;
  let origin = check(&window)?;
  let _guard = state.mutation.lock().await;
  let vault = read(&app)?.ok_or("Desktop ownership required")?;
  if vault.suspended {
    return Err("Sign-out pending".into());
  }
  if id.len() > 100 || id.is_empty() {
    return Err("Invalid socket ID".into());
  }
  let generation = state.generation.load(Ordering::SeqCst);
  let mut sockets = state.sockets.lock().await;
  if sockets.contains_key(&id) {
    return Err("Socket ID already in use".into());
  }
  let (sender, mut receiver) = tokio::sync::mpsc::channel::<String>(8);
  let task_app = app.clone();
  let task_id = id.clone();
  let task = tauri::async_runtime::spawn(async move {
    let state = task_app.state::<NativeProduct>();
    let work = async {
      let admission = state.mutation.lock().await;
      if state.generation.load(Ordering::SeqCst) != generation { return Err(()); }
      let mut vault = read(&task_app).map_err(|_| ())?.ok_or(())?;
      active(&task_app, &mut vault, &origin).await.map_err(|_| ())?;
  let b = binding(&task_app).await.map_err(|_| ())?;
  bound(&vault, &b, &origin).map_err(|_| ())?;
  let base = b["runtimeUrl"]
    .as_str()
    .ok_or(())?;
  let mut request = format!("{}/ws", base.replacen("http:", "ws:", 1))
    .into_client_request()
    .map_err(|_| ())?;
  request
    .headers_mut()
    .insert("origin", origin.parse().map_err(|_| ())?);
  request.headers_mut().insert(
    "cookie",
    vault
      .cookie
      .as_deref()
      .ok_or(())?
      .parse()
      .map_err(|_| ())?,
  );
      let (socket, _) = tokio::time::timeout(std::time::Duration::from_secs(10), tokio_tungstenite::connect_async(request)).await.map_err(|_| ())?.map_err(|_| ())?;
      drop(admission);
      let (mut writer,mut reader) = socket.split();
      channel.send(json!({"type":"open"})).map_err(|_| ())?;
      loop {
        tokio::select! {
          packet = receiver.recv() => {
            if state.generation.load(Ordering::SeqCst) != generation { break; }
            match packet { Some(packet) => writer.send(tokio_tungstenite::tungstenite::Message::Text(packet.into())).await.map_err(|_| ())?, None => break }
          },
          packet = reader.next() => {
            if state.generation.load(Ordering::SeqCst) != generation { break; }
            match packet {
              Some(Ok(tokio_tungstenite::tungstenite::Message::Text(packet))) => channel.send(json!({"type":"message","text":packet.to_string()})).map_err(|_| ())?,
              Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => break,
              Some(Err(_)) => return Err(()), _ => {}
            }
          }
        }
      }
      Ok::<(), ()>(())
    }.await;
    let _ = channel.send(json!({"type": if work.is_ok() { "close" } else { "error" }}));
    state.sockets.lock().await.remove(&task_id);
  });
  sockets.insert(id, (window.label().to_string(), sender, task));
  Ok(())
}
#[tauri::command]
pub async fn native_product_socket_send(
  window: WebviewWindow,
  state: State<'_, NativeProduct>,
  id: String,
  packet: Value,
) -> Result<(), String> {
  check(&window)?;
  if packet["type"] != "user.message" || packet.to_string().len() > 1_000_000 {
    return Err("Only conversational user.message packets are permitted".into());
  }
  let sockets = state.sockets.lock().await;
  let (owner, sender, _) = sockets.get(&id).ok_or("Socket closed")?;
  if owner != window.label() {
    return Err("Socket belongs to another window".into());
  }
  sender
    .try_send(packet.to_string())
    .map_err(|_| "Socket unavailable".into())
}
