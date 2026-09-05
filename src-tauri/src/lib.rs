use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    LogicalPosition, LogicalSize, Manager, Rect, WebviewUrl,
};

const INSTANCE_PREFIX: &str = "instance-";

struct AppState {
    next_id: AtomicU64,
    device_seed: u64,
    run_data_root: PathBuf,
    speeds: Mutex<HashMap<String, Arc<InstanceState>>>,
}

struct InstanceState {
    speed: AtomicU64,
    rotation: Mutex<Option<(f64, f64, u16)>>,
}

fn instance_number(label: &str) -> Option<u64> {
    label.strip_prefix(INSTANCE_PREFIX)?.parse().ok()
}

fn rotation_scale(width: f64, height: f64, rotation: u16) -> Result<f64, String> {
    if !matches!(rotation, 0 | 90 | 180 | 270) {
        return Err("旋转角度只允许 0、90、180 或 270".into());
    }
    Ok(if rotation % 180 == 0 {
        1.0
    } else {
        (width / height).min(height / width)
    })
}

fn rotation_script(width: f64, height: f64, rotation: u16) -> Result<String, String> {
    let scale = rotation_scale(width, height, rotation)?;
    Ok(format!(
        r#"(() => {{
          const id = '__isolated_rotation_style';
          const apply = () => {{
            let style = document.getElementById(id);
            if ({rotation} === 0) {{ style?.remove(); return; }}
            if (!document.body) {{ setTimeout(apply, 50); return; }}
            if (!style) {{ style = document.createElement('style'); style.id = id; document.head.appendChild(style); }}
            const css = `html {{ overflow: hidden !important; }} body {{ position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; overflow: hidden !important; transform-origin: center center !important; transform: rotate({rotation}deg) scale({scale}) !important; }}`;
            if (style.textContent !== css) style.textContent = css;
          }};
          apply();
        }})();"#
    ))
}

fn instance_device_id(seed: u64, id: u64) -> String {
    format!("{seed:016x}{:08x}{:08x}", std::process::id(), id as u32)
}

fn valid_device_id(device_id: &str) -> Result<&str, String> {
    if device_id.len() == 32 && device_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(device_id)
    } else {
        Err("设备号必须是 32 位十六进制字符".into())
    }
}

fn device_identity_script(device_id: &str) -> String {
    format!(
        r#"(() => {{
          if (!(location.hostname === 'gameh5pro.com' || location.hostname.endsWith('.gameh5pro.com'))) return;
          const deviceId = '{device_id}';
          const suffix = '_device_deviceID';
          const storage = window.localStorage;
          const originalGetItem = Storage.prototype.getItem;
          const originalSetItem = Storage.prototype.setItem;
          const isDeviceKey = (target, key) => target === storage && typeof key === 'string' && key.endsWith(suffix);
          const deviceValue = (key) => JSON.stringify({{ [key]: deviceId }});
          Storage.prototype.getItem = function (key) {{
            return isDeviceKey(this, key) ? deviceValue(key) : originalGetItem.call(this, key);
          }};
          Storage.prototype.setItem = function (key, value) {{
            return originalSetItem.call(this, key, isDeviceKey(this, key) ? deviceValue(key) : value);
          }};
        }})();"#
    )
}

fn valid_speed(speed: f64) -> Result<f64, String> {
    if speed.is_finite() && speed > 0.0 {
        Ok(speed)
    } else {
        Err("速度必须是大于 0 的数字".into())
    }
}

fn speed_script(speed: f64) -> Result<String, String> {
    let speed = valid_speed(speed)?;
    Ok(format!(
        r#"(() => {{
          const speed = {speed};
          const apply = (value) => {{
            window.__isolatedMonitorSpeed = value;
            const scheduler = window.cc?.director?.getScheduler?.();
            if (scheduler?.setTimeScale && scheduler.getTimeScale?.() !== value) scheduler.setTimeScale(value);
          }};
          if (!window.__isolatedMonitorSpeedListener) {{
            addEventListener('message', (event) => {{
              const value = Number(event.data?.__isolatedMonitorSpeed);
              if ((event.source === window.parent || event.source === window.top) && Number.isFinite(value) && value > 0) apply(value);
            }});
            window.__isolatedMonitorSpeedListener = true;
          }}
          apply(speed);
          const tick = () => {{
            apply(window.__isolatedMonitorSpeed);
            document.querySelectorAll('iframe').forEach((frame) => frame.contentWindow?.postMessage({{ __isolatedMonitorSpeed: window.__isolatedMonitorSpeed }}, '*'));
          }};
          clearInterval(window.__isolatedMonitorSpeedTimer);
          window.__isolatedMonitorSpeedTimer = setInterval(tick, 500);
          tick();
        }})();"#
    ))
}

#[tauri::command]
async fn create_instance(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
    speed: f64,
    device_id: Option<String>,
) -> Result<String, String> {
    let speed = valid_speed(speed)?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let label = format!("{INSTANCE_PREFIX}{id}");
    let device_id = match device_id {
        Some(device_id) => valid_device_id(&device_id)?.to_ascii_lowercase(),
        None => instance_device_id(state.device_seed, id),
    };
    let url: tauri::Url = url
        .parse()
        .map_err(|error| format!("目标网址无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("目标网址只允许 http 或 https 协议".into());
    }

    let window = app.get_window("main").ok_or("主窗口不存在")?;
    let speed_state = Arc::new(InstanceState {
        speed: AtomicU64::new(speed.to_bits()),
        rotation: Mutex::new(None),
    });
    let page_speed = Arc::clone(&speed_state);
    let initialization_script = format!(
        "{}\n{}\n{}",
        include_str!("quiet-console.js"),
        device_identity_script(&device_id),
        speed_script(speed)?
    );
    let webview = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .data_directory(state.run_data_root.clone())
        .initialization_script(initialization_script)
        .incognito(true)
        .general_autofill_enabled(false)
        .browser_extensions_enabled(false)
        .devtools(false)
        .on_page_load(move |webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let speed = f64::from_bits(page_speed.speed.load(Ordering::Relaxed));
                if let Ok(script) = speed_script(speed) {
                    let _ = webview.eval(script);
                }
                let rotation = page_speed.rotation.lock().ok().and_then(|value| *value);
                if let Some((width, height, rotation)) = rotation {
                    if let Ok(script) = rotation_script(width, height, rotation) {
                        let _ = webview.eval(script);
                    }
                }
            }
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .focused(false);

    let webview = window
        .add_child(
            webview,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| format!("创建隔离实例失败：{error}"))?;
    webview.hide().map_err(|error| error.to_string())?;
    state
        .speeds
        .lock()
        .map_err(|_| "速度状态不可用")?
        .insert(label.clone(), speed_state);

    Ok(label)
}

#[tauri::command]
fn list_instances(app: tauri::AppHandle) -> Vec<String> {
    let mut labels: Vec<_> = app
        .webviews()
        .into_keys()
        .filter(|label| instance_number(label).is_some())
        .collect();
    labels.sort_by_key(|label| instance_number(label));
    labels
}

#[tauri::command]
fn focus_instance(app: tauri::AppHandle, label: String) -> Result<(), String> {
    app.get_webview(&label)
        .ok_or("实例已关闭")?
        .set_focus()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn reload_instance(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if instance_number(&label).is_none() {
        return Err("非法实例标识".into());
    }
    app.get_webview(&label)
        .ok_or("实例已关闭")?
        .reload()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_instance_speed(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    label: String,
    speed: f64,
) -> Result<(), String> {
    if instance_number(&label).is_none() {
        return Err("非法实例标识".into());
    }
    let speed = valid_speed(speed)?;
    state
        .speeds
        .lock()
        .map_err(|_| "速度状态不可用")?
        .get(&label)
        .ok_or("实例已关闭")?
        .speed
        .store(speed.to_bits(), Ordering::Relaxed);
    app.get_webview(&label)
        .ok_or("实例已关闭")?
        .eval(speed_script(speed)?)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_instance_bounds(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    rotation: u16,
) -> Result<(), String> {
    if instance_number(&label).is_none()
        || ![x, y, width, height].iter().all(|value| value.is_finite())
    {
        return Err("非法实例布局".into());
    }

    let webview = app.get_webview(&label).ok_or("实例已关闭")?;
    if !visible {
        return webview.hide().map_err(|error| error.to_string());
    }
    if width < 1.0 || height < 1.0 {
        return Err("实例尺寸必须大于 0".into());
    }
    let script = rotation_script(width, height, rotation)?;
    let instance = state
        .speeds
        .lock()
        .map_err(|_| "实例状态不可用")?
        .get(&label)
        .cloned()
        .ok_or("实例已关闭")?;
    *instance.rotation.lock().map_err(|_| "旋转状态不可用")? = Some((width, height, rotation));

    webview
        .set_bounds(Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width, height).into(),
        })
        .and_then(|_| webview.eval(script))
        .and_then(|_| webview.show())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn close_instance(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    label: String,
) -> Result<(), String> {
    if instance_number(&label).is_none() {
        return Err("非法实例标识".into());
    }
    app.get_webview(&label)
        .ok_or("实例已关闭")?
        .close()
        .map_err(|error| error.to_string())?;
    state
        .speeds
        .lock()
        .map_err(|_| "速度状态不可用")?
        .remove(&label);
    Ok(())
}

pub fn run() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after Unix epoch")
        .as_nanos();
    let run_data_root = std::env::temp_dir()
        .join("web-multi-monitor")
        .join(format!("{}-{stamp}", std::process::id()));
    let cleanup_root = run_data_root.clone();

    let app = tauri::Builder::default()
        .manage(AppState {
            next_id: AtomicU64::new(1),
            device_seed: stamp as u64,
            run_data_root,
            speeds: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            create_instance,
            list_instances,
            focus_instance,
            reload_instance,
            set_instance_speed,
            set_instance_bounds,
            close_instance
        ])
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build application");

    app.run(|_, _| {});
    let _ = std::fs::remove_dir_all(cleanup_root);
}

#[cfg(test)]
mod tests {
    use super::{
        device_identity_script, instance_device_id, instance_number, rotation_scale, speed_script,
        valid_device_id, valid_speed,
    };

    #[test]
    fn accepts_only_instance_labels() {
        assert_eq!(instance_number("instance-12"), Some(12));
        assert_eq!(instance_number("main"), None);
        assert_eq!(instance_number("instance-x"), None);
    }

    #[test]
    fn scales_quarter_turn_to_fit() {
        assert_eq!(rotation_scale(500.0, 300.0, 90), Ok(0.6));
        assert_eq!(rotation_scale(500.0, 300.0, 180), Ok(1.0));
        assert!(rotation_scale(500.0, 300.0, 45).is_err());
    }

    #[test]
    fn assigns_a_distinct_game_device_id_to_each_instance() {
        let first = instance_device_id(7, 1);
        let second = instance_device_id(7, 2);
        assert_eq!(first.len(), 32);
        assert_ne!(first, second);
        assert!(device_identity_script(&first).contains(&first));
        assert!(device_identity_script(&first).contains("_device_deviceID"));
    }

    #[test]
    fn accepts_only_safe_persisted_device_ids() {
        assert!(valid_device_id("0123456789abcdef0123456789abcdef").is_ok());
        assert!(valid_device_id("short").is_err());
        assert!(valid_device_id("0123456789abcdef0123456789abcde'").is_err());
    }

    #[test]
    fn accepts_any_finite_positive_speed_without_an_upper_limit() {
        assert_eq!(valid_speed(1_000_000_000.0), Ok(1_000_000_000.0));
        assert!(valid_speed(0.0).is_err());
        assert!(valid_speed(-1.0).is_err());
        assert!(valid_speed(f64::INFINITY).is_err());
        let script = speed_script(3.5).unwrap();
        assert!(script.contains("const speed = 3.5"));
        assert!(script.contains("querySelectorAll('iframe')"));
        assert!(script.contains("addEventListener('message'"));
    }
}
