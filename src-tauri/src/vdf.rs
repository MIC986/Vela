//! Valve's key-value formats: the text form (.vdf/.acf), the binary form used by
//! shortcuts.vdf, and appinfo.vdf, which wraps the binary form in a table of apps.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Str(String),
    Int(i64),
    Map(Vec<(String, Value)>),
}

impl Value {
    /// Case-insensitive lookup; Valve's files are inconsistent about key case.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Map(items) => items.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn path(&self, keys: &[&str]) -> Option<&Value> {
        keys.iter().try_fold(self, |v, k| v.get(k))
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Value::Str(s)) => Some(s),
            _ => None,
        }
    }

    pub fn int(&self, key: &str) -> Option<i64> {
        match self.get(key) {
            Some(Value::Int(i)) => Some(*i),
            Some(Value::Str(s)) => s.parse().ok(),
            _ => None,
        }
    }

    pub fn items(&self) -> &[(String, Value)] {
        match self {
            Value::Map(items) => items,
            _ => &[],
        }
    }
}

/// Parses the text format. Malformed input yields whatever was read before it.
pub fn parse_text(input: &str) -> Value {
    let mut chars = input.chars().peekable();
    Value::Map(parse_map(&mut chars))
}

fn parse_map(chars: &mut std::iter::Peekable<std::str::Chars>) -> Vec<(String, Value)> {
    let mut items = Vec::new();
    loop {
        skip_ws(chars);
        match chars.peek() {
            None => return items,
            Some('}') => {
                chars.next();
                return items;
            }
            Some('"') => {}
            Some(_) => {
                // Stray token: step over it rather than give up on the whole file.
                chars.next();
                continue;
            }
        }
        let key = parse_string(chars);
        skip_ws(chars);
        match chars.peek() {
            Some('{') => {
                chars.next();
                let inner = parse_map(chars);
                items.push((key, Value::Map(inner)));
            }
            Some('"') => {
                let value = parse_string(chars);
                items.push((key, Value::Str(value)));
            }
            _ => return items,
        }
    }
}

fn skip_ws(chars: &mut std::iter::Peekable<std::str::Chars>) {
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else if c == '/' {
            // Line comment.
            chars.next();
            for c in chars.by_ref() {
                if c == '\n' {
                    break;
                }
            }
        } else {
            break;
        }
    }
}

fn parse_string(chars: &mut std::iter::Peekable<std::str::Chars>) -> String {
    chars.next(); // opening quote
    let mut out = String::new();
    while let Some(c) = chars.next() {
        match c {
            '"' => break,
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => break,
            },
            c => out.push(c),
        }
    }
    out
}

/// Bounds-checked cursor over binary data. Every read returns None past the end,
/// so a truncated or newer-format file ends the parse instead of panicking.
struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Reader { data, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let slice = self.data.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn i64(&mut self) -> Option<i64> {
        self.take(8).map(|b| i64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }
    fn cstr(&mut self) -> Option<String> {
        let rest = self.data.get(self.pos..)?;
        let end = rest.iter().position(|&b| b == 0)?;
        let s = String::from_utf8_lossy(&rest[..end]).into_owned();
        self.pos += end + 1;
        Some(s)
    }
}

const KV_MAP: u8 = 0;
const KV_STR: u8 = 1;
const KV_I32: u8 = 2;
const KV_F32: u8 = 3;
const KV_PTR: u8 = 4;
const KV_WSTR: u8 = 5;
const KV_COLOR: u8 = 6;
const KV_U64: u8 = 7;
const KV_END: u8 = 8;
const KV_I64: u8 = 10;
const KV_END_ALT: u8 = 11;

fn read_kv(r: &mut Reader, strings: Option<&[String]>, depth: usize) -> Option<Vec<(String, Value)>> {
    if depth > 64 {
        return None;
    }
    let mut items = Vec::new();
    loop {
        let kind = r.u8()?;
        if kind == KV_END || kind == KV_END_ALT {
            return Some(items);
        }
        let key = match strings {
            Some(table) => table.get(r.u32()? as usize)?.clone(),
            None => r.cstr()?,
        };
        let value = match kind {
            KV_MAP => Value::Map(read_kv(r, strings, depth + 1)?),
            KV_STR => Value::Str(r.cstr()?),
            KV_I32 | KV_PTR | KV_COLOR => Value::Int(r.u32()? as i32 as i64),
            KV_F32 => {
                r.u32()?;
                continue;
            }
            KV_WSTR => {
                // UTF-16, null-terminated.
                while r.take(2)? != [0, 0] {}
                continue;
            }
            KV_U64 | KV_I64 => Value::Int(r.i64()?),
            _ => return None,
        };
        items.push((key, value));
    }
}

/// Parses a stand-alone binary file such as shortcuts.vdf.
pub fn parse_binary(data: &[u8]) -> Option<Value> {
    read_kv(&mut Reader::new(data), None, 0).map(Value::Map)
}

#[derive(Debug, Clone, Default)]
pub struct AppInfo {
    pub name: String,
    pub kind: String,
    pub oslist: String,
    pub developer: Option<String>,
    pub publisher: Option<String>,
    pub release: Option<i64>,
    pub metacritic: Option<u8>,
    pub review: Option<u8>,
}

/// Reads appinfo.vdf, supporting the layouts Steam has used since 2022.
pub fn parse_appinfo(data: &[u8]) -> HashMap<u32, AppInfo> {
    const V40: u32 = 0x0756_4428;
    const V41: u32 = 0x0756_4429;
    let mut apps = HashMap::new();
    let mut r = Reader::new(data);
    let Some(magic) = r.u32() else { return apps };
    if magic != V40 && magic != V41 {
        return apps;
    }
    if r.u32().is_none() {
        return apps;
    }
    let mut table: Option<Vec<String>> = None;
    if magic == V41 {
        let Some(offset) = r.i64() else { return apps };
        let Some(mut t) = usize::try_from(offset).ok().filter(|o| *o < data.len()).map(|o| Reader { data, pos: o }) else {
            return apps;
        };
        let Some(count) = t.u32() else { return apps };
        let mut strings = Vec::with_capacity((count as usize).min(1 << 20));
        for _ in 0..count {
            let Some(s) = t.cstr() else { break };
            strings.push(s);
        }
        table = Some(strings);
    }
    loop {
        let Some(appid) = r.u32() else { break };
        if appid == 0 {
            break;
        }
        let Some(size) = r.u32() else { break };
        let start = r.pos;
        let Some(next) = start.checked_add(size as usize) else { break };
        // info state + last updated + pics token + text sha + change number + binary sha
        if r.take(4 + 4 + 8 + 20 + 4 + 20).is_some() {
            if let Some(kv) = read_kv(&mut r, table.as_deref(), 0) {
                let root = Value::Map(kv);
                if let Some(common) = root.path(&["appinfo", "common"]) {
                    let name = common.str("name").unwrap_or_default().to_string();
                    let release = common
                        .int("steam_release_date")
                        .or_else(|| common.int("original_release_date"))
                        .or_else(|| root.path(&["appinfo", "extended"]).and_then(|e| e.int("releasedate")));
                    let extended = root.path(&["appinfo", "extended"]);
                    apps.insert(
                        appid,
                        AppInfo {
                            kind: common.str("type").unwrap_or_default().to_ascii_lowercase(),
                            oslist: common.str("oslist").unwrap_or_default().to_ascii_lowercase(),
                            developer: extended.and_then(|e| e.str("developer")).map(String::from),
                            publisher: extended.and_then(|e| e.str("publisher")).map(String::from),
                            metacritic: common.int("metacritic_score").and_then(|v| u8::try_from(v).ok()),
                            review: common.int("review_percentage").and_then(|v| u8::try_from(v).ok()),
                            release,
                            name,
                        },
                    );
                }
            }
        }
        // The size field is authoritative, whatever the entry's parse did.
        r.pos = next;
    }
    apps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_handles_nesting_escapes_and_comments() {
        let v = parse_text("// c\n\"a\" { \"b\" \"x\\\\y\" \"c\" { \"D\" \"7\" } }");
        assert_eq!(v.path(&["a"]).unwrap().str("b"), Some("x\\y"));
        assert_eq!(v.path(&["a", "c"]).unwrap().int("d"), Some(7));
    }

    #[test]
    fn text_survives_truncation() {
        let v = parse_text("\"a\" { \"b\" \"1\" \"c\" {");
        assert_eq!(v.path(&["a"]).unwrap().int("b"), Some(1));
    }

    #[test]
    fn binary_reads_shortcut_shape() {
        let mut d = vec![KV_MAP];
        d.extend(b"shortcuts\0");
        d.push(KV_MAP);
        d.extend(b"0\0");
        d.push(KV_STR);
        d.extend(b"AppName\0Doom\0");
        d.push(KV_I32);
        d.extend(b"LastPlayTime\0");
        d.extend(5i32.to_le_bytes());
        d.extend([KV_END, KV_END, KV_END]);
        let v = parse_binary(&d).unwrap();
        let entry = v.path(&["shortcuts", "0"]).unwrap();
        assert_eq!(entry.str("appname"), Some("Doom"));
        assert_eq!(entry.int("lastplaytime"), Some(5));
    }

    #[test]
    fn appinfo_rejects_garbage_without_panicking() {
        assert!(parse_appinfo(&[1, 2, 3]).is_empty());
        assert!(parse_appinfo(&[0x29, 0x44, 0x56, 0x07, 1, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255]).is_empty());
    }
}
