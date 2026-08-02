use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone)]
struct VdfToken {
    value: TokenValue,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone)]
enum TokenValue {
    Text(String),
    Open,
    Close,
}

#[derive(Serialize)]
struct SteamAccount {
    steam_id: String,
    account_name: String,
    persona_name: String,
    avatar_data_url: Option<String>,
    timestamp: u64,
    remember_password: bool,
    is_active: bool,
}

#[derive(Serialize)]
struct ScanResult {
    accounts: Vec<SteamAccount>,
    steam_running: bool,
}

fn tokenize_vdf(input: &str) -> Vec<VdfToken> {
    let bytes = input.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                let start = index;
                index += 1;
                let mut value = String::new();
                while index < bytes.len() {
                    if bytes[index] == b'\\' && index + 1 < bytes.len() {
                        let next = bytes[index + 1];
                        value.push(if next == b'n' { '\n' } else { next as char });
                        index += 2;
                    } else if bytes[index] == b'"' {
                        index += 1;
                        break;
                    } else {
                        value.push(bytes[index] as char);
                        index += 1;
                    }
                }
                tokens.push(VdfToken { value: TokenValue::Text(value), start, end: index });
            }
            b'{' => {
                tokens.push(VdfToken { value: TokenValue::Open, start: index, end: index + 1 });
                index += 1;
            }
            b'}' => {
                tokens.push(VdfToken { value: TokenValue::Close, start: index, end: index + 1 });
                index += 1;
            }
            b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'/' => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' { index += 1; }
            }
            _ => index += 1,
        }
    }
    tokens
}

fn steam_path() -> Option<PathBuf> {
    if let Ok(custom) = env::var("STEAM_PATH") {
        let path = PathBuf::from(custom);
        if path.exists() { return Some(path); }
    }

    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey("Software\\Valve\\Steam") {
            if let Ok(value) = key.get_value::<String, _>("SteamPath") {
                let path = PathBuf::from(value.replace('/', "\\"));
                if path.exists() { return Some(path); }
            }
        }
        for variable in ["PROGRAMFILES(X86)", "PROGRAMFILES"] {
            if let Ok(root) = env::var(variable) {
                let path = PathBuf::from(root).join("Steam");
                if path.exists() { return Some(path); }
            }
        }
    }

    #[cfg(target_os = "linux")]
    if let Ok(home) = env::var("HOME") {
        for path in [PathBuf::from(&home).join(".local/share/Steam"), PathBuf::from(&home).join(".steam/steam")] {
            if path.exists() { return Some(path); }
        }
    }

    #[cfg(target_os = "macos")]
    if let Ok(home) = env::var("HOME") {
        let path = PathBuf::from(home).join("Library/Application Support/Steam");
        if path.exists() { return Some(path); }
    }
    None
}

fn steam_is_running() -> bool {
    #[cfg(windows)]
    return Command::new("tasklist").args(["/FI", "IMAGENAME eq steam.exe", "/NH"]).output()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_ascii_lowercase().contains("steam.exe"))
        .unwrap_or(false);

    #[cfg(not(windows))]
    return Command::new("pgrep").arg("-x").arg("steam").status().map(|s| s.success()).unwrap_or(false);
}

#[cfg(windows)]
fn auto_login_user() -> Option<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Valve\\Steam")
        .ok()
        .and_then(|key| key.get_value::<String, _>("AutoLoginUser").ok())
        .map(|name| name.to_ascii_lowercase())
}

#[cfg(not(windows))]
fn auto_login_user() -> Option<String> { None }

fn value_after(tokens: &[VdfToken], start: usize, key: &str, end: usize) -> Option<String> {
    let mut index = start;
    while index + 1 < end && index + 1 < tokens.len() {
        if let TokenValue::Text(current) = &tokens[index].value {
            if current.eq_ignore_ascii_case(key) {
                if let TokenValue::Text(value) = &tokens[index + 1].value { return Some(value.clone()); }
            }
        }
        index += 1;
    }
    None
}

fn user_blocks(tokens: &[VdfToken]) -> Vec<(String, usize, usize)> {
    let users_index = tokens.iter().position(|token| matches!(&token.value, TokenValue::Text(text) if text.eq_ignore_ascii_case("users")));
    let Some(users_index) = users_index else { return Vec::new(); };
    let Some(users_open) = (users_index + 1..tokens.len()).find(|&i| matches!(tokens[i].value, TokenValue::Open)) else { return Vec::new(); };
    let mut blocks = Vec::new();
    let mut index = users_open + 1;
    let mut depth = 1usize;
    while index < tokens.len() && depth > 0 {
        match &tokens[index].value {
            TokenValue::Open => depth += 1,
            TokenValue::Close => depth = depth.saturating_sub(1),
            TokenValue::Text(steam_id) if depth == 1 => {
                if index + 1 < tokens.len() && matches!(tokens[index + 1].value, TokenValue::Open) {
                    let start = index;
                    let mut cursor = index + 2;
                    let mut block_depth = 1usize;
                    while cursor < tokens.len() && block_depth > 0 {
                        match tokens[cursor].value {
                            TokenValue::Open => block_depth += 1,
                            TokenValue::Close => block_depth -= 1,
                            _ => {}
                        }
                        cursor += 1;
                    }
                    if block_depth == 0 { blocks.push((steam_id.clone(), start, cursor)); }
                    index = cursor;
                    continue;
                }
            }
            _ => {}
        }
        index += 1;
    }
    blocks
}

fn find_avatar(steam: &Path, steam_id: &str, avatar_hash: Option<&str>) -> Option<String> {
    let avatar_dir = steam.join("config/avatarcache");
    let mut candidates = vec![avatar_dir.join(format!("{steam_id}.png")), avatar_dir.join(format!("{steam_id}.jpg"))];
    if let Some(hash) = avatar_hash {
        candidates.push(avatar_dir.join(format!("{hash}.png")));
        candidates.push(avatar_dir.join(format!("{hash}.jpg")));
    }
    let path = candidates.into_iter().find(|path| path.is_file())?;
    let bytes = fs::read(&path).ok()?;
    let mime = if path.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("png")) { "image/png" } else { "image/jpeg" };
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
fn scan_steam_accounts() -> Result<ScanResult, String> {
    let steam = steam_path().ok_or_else(|| "Папка Steam не найдена. Установите Steam или задайте STEAM_PATH.".to_string())?;
    let loginusers = steam.join("config/loginusers.vdf");
    let raw = fs::read_to_string(&loginusers).map_err(|_| "Файл config/loginusers.vdf не найден или недоступен.".to_string())?;
    let tokens = tokenize_vdf(&raw);
    let running = steam_is_running();
    let auto_user = auto_login_user();
    let mut accounts = Vec::new();

    for (steam_id, start, end) in user_blocks(&tokens) {
        let account_name = value_after(&tokens, start, "AccountName", end).unwrap_or_default();
        let persona_name = value_after(&tokens, start, "PersonaName", end).unwrap_or_else(|| account_name.clone());
        let timestamp = value_after(&tokens, start, "Timestamp", end).and_then(|v| v.parse().ok()).unwrap_or(0);
        let most_recent = value_after(&tokens, start, "MostRecent", end).is_some_and(|v| v == "1");
        let remember_password = value_after(&tokens, start, "RememberPassword", end).is_some_and(|v| v == "1");
        let avatar_hash = value_after(&tokens, start, "Avatar", end);
        let matches_auto_user = auto_user.as_ref().is_some_and(|name| name == &account_name.to_ascii_lowercase());
        accounts.push(SteamAccount {
            avatar_data_url: find_avatar(&steam, &steam_id, avatar_hash.as_deref()),
            steam_id,
            account_name,
            persona_name,
            timestamp,
            remember_password,
            is_active: running && (matches_auto_user || (auto_user.is_none() && most_recent)),
        });
    }
    accounts.sort_by(|a, b| b.is_active.cmp(&a.is_active).then(b.timestamp.cmp(&a.timestamp)));
    Ok(ScanResult { accounts, steam_running: running })
}

fn remove_account_block(raw: &str, steam_id: &str) -> Option<String> {
    let tokens = tokenize_vdf(raw);
    let (_, start_token, end_token) = user_blocks(&tokens).into_iter().find(|(id, _, _)| id == steam_id)?;
    let mut start = tokens[start_token].start;
    let mut end = tokens[end_token - 1].end;
    while start > 0 && matches!(raw.as_bytes()[start - 1], b' ' | b'\t') { start -= 1; }
    if start > 0 && raw.as_bytes()[start - 1] == b'\n' { start -= 1; }
    while end < raw.len() && matches!(raw.as_bytes()[end], b' ' | b'\t' | b'\r') { end += 1; }
    if end < raw.len() && raw.as_bytes()[end] == b'\n' { end += 1; }
    let mut updated = String::with_capacity(raw.len() - (end - start));
    updated.push_str(&raw[..start]);
    updated.push_str(&raw[end..]);
    Some(updated)
}

fn remove_avatar_cache(steam: &Path, steam_id: &str) {
    let dir = steam.join("config/avatarcache");
    let Ok(entries) = fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.contains(&steam_id.to_ascii_lowercase()) { let _ = fs::remove_file(entry.path()); }
    }
}

#[tauri::command]
fn delete_local_account_data(steam_id: String, confirmation: String) -> Result<(), String> {
    if confirmation.trim().to_lowercase() != "подтверждаю" { return Err("Введите «подтверждаю» без кавычек.".into()); }
    if !steam_id.chars().all(|char| char.is_ascii_digit()) { return Err("Некорректный Steam ID.".into()); }
    if steam_is_running() { return Err("Полностью закройте Steam и повторите удаление.".into()); }
    let steam = steam_path().ok_or_else(|| "Папка Steam не найдена.".to_string())?;
    let loginusers = steam.join("config/loginusers.vdf");
    let raw = fs::read_to_string(&loginusers).map_err(|_| "Не удалось прочитать loginusers.vdf.".to_string())?;
    let updated = remove_account_block(&raw, &steam_id).ok_or_else(|| "Эта локальная запись уже не существует.".to_string())?;
    let backup = loginusers.with_extension("vdf.sav-backup");
    fs::copy(&loginusers, &backup).map_err(|_| "Не удалось создать резервную копию loginusers.vdf.".to_string())?;
    let temp = loginusers.with_extension("vdf.tmp");
    fs::write(&temp, updated).map_err(|_| "Не удалось записать обновлённые данные.".to_string())?;
    fs::rename(&temp, &loginusers).map_err(|_| "Не удалось заменить loginusers.vdf.".to_string())?;
    remove_avatar_cache(&steam, &steam_id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![scan_steam_accounts, delete_local_account_data])
        .run(tauri::generate_context!())
        .expect("error while running Steam Accounts");
}
