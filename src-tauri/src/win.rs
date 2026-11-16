//! Thin wrappers over the Windows APIs Vela needs.

use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::size_of;
use std::path::{Path, PathBuf};

use windows::core::{w, Interface, HSTRING, PCSTR, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, MAX_PATH, SIZE};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
};
use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, QueryFullProcessImageNameW, SetProcessWorkingSetSize, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{IShellItemImageFactory, IShellLinkW, SHCreateItemFromParsingName, ShellExecuteW, ShellLink, SIIGBF_ICONONLY};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::model::Launch;

/// Runs a launch description through the shell, so elevation prompts and
/// protocol handlers behave as if the user had double-clicked.
pub fn shell_open(launch: &Launch) -> Result<(), String> {
    match launch {
        Launch::Url { url } => shell_execute(url, "", None),
        Launch::Exe { path, args, cwd } => {
            let dir = cwd.clone().or_else(|| Path::new(path).parent().map(|p| p.to_string_lossy().into_owned()));
            shell_execute(path, args, dir.as_deref())
        }
        Launch::Aumid { aumid } => shell_execute("explorer.exe", &format!("shell:AppsFolder\\{aumid}"), None),
    }
}

fn shell_execute(target: &str, args: &str, cwd: Option<&str>) -> Result<(), String> {
    let (target_w, args_w) = (HSTRING::from(target), HSTRING::from(args));
    let cwd_w = cwd.map(HSTRING::from);
    let cwd_ptr = cwd_w.as_ref().map(|h| PCWSTR(h.as_ptr())).unwrap_or(PCWSTR::null());
    // SAFETY: every pointer refers to a live HSTRING for the duration of the call.
    let result = unsafe { ShellExecuteW(None, w!("open"), &target_w, &args_w, cwd_ptr, SW_SHOWNORMAL) };
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!("Windows could not start {target} (code {})", result.0 as isize))
    }
}

/// Hands memory that isn't in active use back to Windows, for while a game runs.
pub fn trim_memory() {
    // SAFETY: the pseudo-handle is always valid; usize::MAX for both is the documented trim request.
    unsafe {
        let _ = SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
    }
}

fn normalized(path: String) -> String {
    path.replace('/', "\\").to_lowercase()
}

/// One process's full image path, lowercased; None once it has exited.
pub fn process_path(pid: u32) -> Option<String> {
    // SAFETY: image_path closes the handle it opens.
    unsafe { image_path(pid) }.map(normalized)
}

/// Full image paths of all processes this user can inspect, lowercased.
pub fn process_paths() -> Vec<(u32, String)> {
    let mut out = Vec::new();
    // SAFETY: the snapshot handle is closed below and entries are sized as required.
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if let Some(path) = image_path(entry.th32ProcessID) {
                    out.push((entry.th32ProcessID, normalized(path)));
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    out
}

unsafe fn image_path(pid: u32) -> Option<String> {
    let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let result = QueryFullProcessImageNameW(handle, PROCESS_NAME_FORMAT(0), PWSTR(buf.as_mut_ptr()), &mut len);
    let _ = CloseHandle(handle);
    result.ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

#[derive(Default, Debug, Clone)]
pub struct VersionInfo {
    pub product_name: Option<String>,
    pub file_description: Option<String>,
    pub company: Option<String>,
}

/// Reads the name fields embedded in an executable.
pub fn version_info(path: &Path) -> VersionInfo {
    let mut info = VersionInfo::default();
    let wide = HSTRING::from(path.as_os_str());
    // SAFETY: the buffer is sized by GetFileVersionInfoSizeW and outlives every query into it.
    unsafe {
        let size = GetFileVersionInfoSizeW(&wide, None);
        if size == 0 {
            return info;
        }
        let mut data = vec![0u8; size as usize];
        if GetFileVersionInfoW(&wide, None, size, data.as_mut_ptr() as *mut c_void).is_err() {
            return info;
        }
        let block = data.as_ptr() as *const c_void;
        let mut translations: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let mut langs = vec!["040904b0".to_string(), "040904e4".to_string(), "000004b0".to_string()];
        if VerQueryValueW(block, w!("\\VarFileInfo\\Translation"), &mut translations, &mut len).as_bool() && len >= 4 {
            let pair = translations as *const u16;
            langs.insert(0, format!("{:04x}{:04x}", *pair, *pair.add(1)));
        }
        let query = |lang: &str, field: &str| -> Option<String> {
            let key = HSTRING::from(format!("\\StringFileInfo\\{lang}\\{field}"));
            let mut value: *mut c_void = std::ptr::null_mut();
            let mut chars = 0u32;
            if VerQueryValueW(block, &key, &mut value, &mut chars).as_bool() && chars > 1 {
                let slice = std::slice::from_raw_parts(value as *const u16, chars as usize);
                let text = String::from_utf16_lossy(slice);
                let text = text.trim_end_matches('\0').trim();
                (!text.is_empty()).then(|| text.to_string())
            } else {
                None
            }
        };
        for lang in &langs {
            info.product_name = info.product_name.or_else(|| query(lang, "ProductName"));
            info.file_description = info.file_description.or_else(|| query(lang, "FileDescription"));
            info.company = info.company.or_else(|| query(lang, "CompanyName"));
        }
    }
    info
}

/// COM must be initialized per thread; this keeps that balanced.
pub struct ComScope(bool);

impl ComScope {
    pub fn new() -> Self {
        // SAFETY: paired with CoUninitialize in Drop on this same thread.
        ComScope(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok() })
    }
}

impl Drop for ComScope {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balances the successful CoInitializeEx in new().
            unsafe { CoUninitialize() };
        }
    }
}

/// Resolves a .lnk file to its target program. Needs a ComScope on this thread.
pub fn shortcut_target(lnk: &Path) -> Option<PathBuf> {
    // SAFETY: COM calls on interfaces owned by this function; the buffer outlives GetPath.
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let file: IPersistFile = link.cast().ok()?;
        file.Load(&HSTRING::from(lnk.as_os_str()), STGM_READ).ok()?;
        let mut buf = [0u16; MAX_PATH as usize];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        (end > 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..end])))
    }
}

/// Renders a program's large icon to PNG bytes. Needs a ComScope on this thread.
pub fn exe_icon_png(path: &Path, size: i32) -> Option<Vec<u8>> {
    // SAFETY: the bitmap is deleted after its pixels are copied out; buffers are sized from the bitmap.
    unsafe {
        let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None).ok()?;
        let bitmap: HBITMAP = factory.GetImage(SIZE { cx: size, cy: size }, SIIGBF_ICONONLY).ok()?;
        let pixels = bitmap_rgba(bitmap);
        let _ = DeleteObject(bitmap.into());
        let (w, h, rgba) = pixels?;
        let img = image::RgbaImage::from_raw(w, h, rgba)?;
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).ok()?;
        Some(out.into_inner())
    }
}

unsafe fn bitmap_rgba(bitmap: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    let mut bm = BITMAP::default();
    if GetObjectW(bitmap.into(), size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void)) == 0 {
        return None;
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight);
    if w <= 0 || h <= 0 {
        return None;
    }
    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h, // top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut data = vec![0u8; (w * h * 4) as usize];
    let dc = CreateCompatibleDC(None);
    let lines = GetDIBits(dc, bitmap, 0, h as u32, Some(data.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS);
    let _ = DeleteDC(dc);
    if lines == 0 {
        return None;
    }
    for px in data.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    Some((w as u32, h as u32, data))
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DriveInfo {
    pub name: String,
    pub total: u64,
    pub free: u64,
}

pub fn drives() -> Vec<DriveInfo> {
    let mut out = Vec::new();
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if !Path::new(&root).exists() {
            continue;
        }
        let (mut free, mut total) = (0u64, 0u64);
        // SAFETY: out-pointers are valid for the duration of the call.
        let ok = unsafe { GetDiskFreeSpaceExW(&HSTRING::from(&root), Some(&mut free), Some(&mut total), None) };
        if ok.is_ok() && total > 0 {
            out.push(DriveInfo { name: root, total, free });
        }
    }
    out
}

/// Non-removable drive roots that hold data worth scanning.
pub fn fixed_drive_roots() -> Vec<PathBuf> {
    drives().into_iter().map(|d| PathBuf::from(d.name)).collect()
}

/// Watches for a controller's Guide button through XInput's hidden entry point.
pub struct GuideButton {
    get_state: Option<unsafe extern "system" fn(u32, *mut [u8; 16]) -> u32>,
}

impl GuideButton {
    pub fn new() -> Self {
        // SAFETY: ordinal 100 of xinput1_4.dll has this exact shape on every Windows build
        // that ships the DLL; a missing DLL or export leaves get_state empty.
        let get_state = unsafe {
            LoadLibraryW(w!("xinput1_4.dll"))
                .ok()
                .and_then(|lib| GetProcAddress(lib, PCSTR(100 as *const u8)))
                .map(|f| std::mem::transmute::<_, unsafe extern "system" fn(u32, *mut [u8; 16]) -> u32>(f))
        };
        GuideButton { get_state }
    }

    pub fn pressed(&self) -> bool {
        const GUIDE: u16 = 0x0400;
        let Some(get_state) = self.get_state else { return false };
        (0..4).any(|pad| {
            let mut state = [0u8; 16];
            // SAFETY: the buffer is at least as large as XINPUT_STATE.
            let code = unsafe { get_state(pad, &mut state) };
            code == 0 && u16::from_le_bytes([state[4], state[5]]) & GUIDE != 0
        })
    }
}

pub fn set_run_at_startup(enabled: bool) -> Result<(), String> {
    let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", winreg::enums::KEY_SET_VALUE)
        .map_err(|e| e.to_string())?;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        key.set_value("Vela", &format!("\"{}\" --startup", exe.display())).map_err(|e| e.to_string())
    } else {
        match key.delete_value("Vela") {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

/// The environment folders Vela expands in store paths.
pub fn env_paths() -> HashMap<&'static str, String> {
    ["ProgramData", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "PUBLIC"]
        .into_iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (k, v)))
        .collect()
}

/// The country Windows is set to, as a code like "US". Store catalogs differ by country.
pub fn region() -> String {
    static REGION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    REGION
        .get_or_init(|| {
            let mut buf = [0u16; 16];
            // SAFETY: the buffer outlives the call, which writes at most its length.
            let written = unsafe { windows::Win32::Globalization::GetUserDefaultGeoName(&mut buf) };
            let code = String::from_utf16_lossy(&buf[..usize::try_from(written).unwrap_or(0).saturating_sub(1)]);
            if code.len() == 2 && code.chars().all(|c| c.is_ascii_alphabetic()) { code.to_ascii_uppercase() } else { "US".into() }
        })
        .clone()
}
