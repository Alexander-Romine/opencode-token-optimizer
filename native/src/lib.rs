//! Native hot path for the OpenCode `token-optimizer` plugin.
//!
//! Everything in here is on the per-tool-call path, so the design goals are:
//!   * one input copy, one output copy, no intermediate `String`s
//!   * zero dependencies beyond the napi glue
//!   * hand-rolled parsers instead of a regex engine (no DFA startup cost,
//!     no hidden allocations, much smaller binary)
//!
//! The plugin ships a pure-JS fallback with the same contract, so a failed
//! native load degrades performance rather than breaking the plugin.

#![allow(clippy::needless_pass_by_value)]

use napi_derive::napi;

/* ------------------------------------------------------------------ *
 * Hashing - dependency free FNV-1a 64 + a murmur3 style finalizer.
 * Not cryptographic: only used to key and fingerprint tool calls.
 * ------------------------------------------------------------------ */

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
/// 0x100000001b3
const FNV_PRIME: u64 = 0x100_0000_01b3;

#[inline(always)]
fn mix(h: u64, byte: u8) -> u64 {
    (h ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
}

#[inline]
fn mix_u64(mut h: u64, v: u64) -> u64 {
    for shift in (0..64).step_by(8) {
        h = mix(h, ((v >> shift) & 0xff) as u8);
    }
    h
}

/// Avalanche finalizer so that FNV's weak low-bit diffusion does not show up
/// as duplicate keys on short, similar inputs.
#[inline]
fn avalanche(mut h: u64) -> u64 {
    h ^= h >> 33;
    h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
    h ^= h >> 33;
    h = h.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    h ^= h >> 33;
    h
}

/// Stable 16-hex-char key over an ordered list of strings.
///
/// Runs on every tool call, so the parts are hashed as they are walked and
/// never concatenated first - the JS side can pass loose strings instead of
/// building a `JSON.stringify` key (which would allocate a large temporary).
#[napi]
pub fn hash_parts(parts: Vec<String>) -> String {
    let mut h = FNV_OFFSET;
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            h = mix(h, 0x1f); // unit separator
        }
        for &b in part.as_bytes() {
            h = mix(h, b);
        }
    }
    format!("{:016x}", avalanche(h))
}

/// Identity key for a file read: path + size + mtime is enough to decide that
/// an unchanged file does not need to be re-sent in full.
#[napi]
pub fn fingerprint(path: String, size: f64, modified_ms: f64) -> String {
    let mut h = FNV_OFFSET;
    for &b in path.as_bytes() {
        h = mix(h, b);
    }
    h = mix_u64(h, size.to_bits());
    h = mix_u64(h, modified_ms.to_bits());
    format!("{:016x}", avalanche(h))
}

/* ------------------------------------------------------------------ *
 * Text compression
 * ------------------------------------------------------------------ */

#[napi(object)]
#[derive(Clone)]
pub struct CompressOptions {
    /// Result budget in characters. `0` disables truncation.
    pub max_chars: u32,
    /// Share of the budget spent on the leading portion (0-100).
    pub head_pct: u32,
    /// Strip ANSI / VT escape sequences.
    pub strip_ansi: bool,
    /// Collapse runs of blank lines.
    pub collapse_blank: bool,
    /// Maximum consecutive blank lines kept when collapsing.
    pub max_blank_lines: u32,
    /// Trim trailing spaces and tabs off every line.
    pub trim_lines: bool,
    /// Truncation marker. `{{n}}` is replaced with the removed count.
    pub marker: Option<String>,
}

#[napi(object)]
pub struct CompressResult {
    pub text: String,
    pub original_chars: u32,
    pub result_chars: u32,
    pub truncated: bool,
    pub stripped: bool,
    pub collapsed: bool,
    pub trimmed: bool,
}

impl Default for CompressOptions {
    fn default() -> Self {
        Self {
            max_chars: 0,
            head_pct: 70,
            strip_ansi: true,
            collapse_blank: true,
            max_blank_lines: 1,
            trim_lines: false,
            marker: None,
        }
    }
}

fn char_count(s: &str) -> u32 {
    let n = s.chars().count();
    if n > u32::MAX as usize {
        u32::MAX
    } else {
        n as u32
    }
}

/// True for C0/DEL control bytes we drop. Tab and LF are preserved; CR and
/// ESC are handled explicitly before this is consulted.
#[inline(always)]
fn is_dropped_control(c: u8) -> bool {
    (c < 0x20 && c != b'\t' && c != b'\n' && c != b'\r' && c != 0x1b) || c == 0x7f
}

/// Advance past an escape sequence starting at `start` (which points at ESC).
/// Returns the index one past the sequence end, always `> start`.
fn skip_escape(b: &[u8], start: usize) -> usize {
    if start + 1 >= b.len() {
        return b.len();
    }
    match b[start + 1] {
        // CSI: ESC [ params... final byte in 0x40..=0x7E
        b'[' => {
            let mut j = start + 2;
            while j < b.len() {
                let c = b[j];
                j += 1;
                if (0x40..=0x7e).contains(&c) {
                    break;
                }
            }
            j
        }
        // OSC / DCS / PM / APC: string carrying sequences, ST or BEL terminated
        b']' | b'P' | b'^' | b'_' => {
            let mut j = start + 2;
            while j < b.len() {
                if b[j] == 0x07 {
                    j += 1;
                    break;
                }
                if b[j] == 0x1b && j + 1 < b.len() && b[j + 1] == b'\\' {
                    j += 2;
                    break;
                }
                j += 1;
            }
            j
        }
        // Charset / designator selections: ESC ( B  -> 3 bytes
        b'(' | b')' | b'*' | b'+' | b'#' => {
            if start + 2 < b.len() {
                start + 3
            } else {
                b.len()
            }
        }
        // Plain two byte escapes: ESC 7, ESC M, ...
        _ => start + 2,
    }
}

/// Trim spaces/tabs from the tail of the current line held in `out`.
/// Returns whether anything was removed.
#[inline]
fn trim_line_tail(out: &mut Vec<u8>, line_start: usize) -> bool {
    let mut end = out.len();
    while end > line_start && (out[end - 1] == b' ' || out[end - 1] == b'\t') {
        end -= 1;
    }
    let removed = end != out.len();
    if removed {
        out.truncate(end);
    }
    removed
}

/// Single pass over the input doing CR normalization, ANSI stripping, control
/// byte removal, trailing-whitespace trimming and blank line collapsing.
///
/// Everything writes straight into one `Vec<u8>`; `String::from_utf8` later
/// reuses that allocation because we only ever cut at ASCII control bytes and
/// therefore never split a UTF-8 sequence.
fn clean(input: &str, o: &CompressOptions) -> (String, bool, bool, bool) {
    let b = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());

    let mut stripped = false;
    let mut collapsed = false;
    let mut trimmed = false;

    let mut i = 0usize;
    let mut newline_run = 0usize;
    let mut line_start = 0usize;
    // max consecutive '\n' we are willing to emit (n blank lines = n+1 '\n')
    let max_newlines = o.max_blank_lines as usize + 1;

    while i < b.len() {
        let c = b[i];

        if c == b'\r' {
            // CRLF -> LF, lone CR -> LF. Falls through to the newline path.
            i += if i + 1 < b.len() && b[i + 1] == b'\n' {
                2
            } else {
                1
            };
        } else if c == 0x1b {
            if o.strip_ansi {
                let next = skip_escape(b, i);
                stripped = true;
                i = next;
                continue;
            }
            out.push(c);
            newline_run = 0;
            i += 1;
            continue;
        } else if c == b'\n' {
            i += 1;
        } else if is_dropped_control(c) {
            stripped = true;
            i += 1;
            continue;
        } else {
            out.push(c);
            newline_run = 0;
            i += 1;
            continue;
        }

        // --- newline path ---
        if o.trim_lines && trim_line_tail(&mut out, line_start) {
            trimmed = true;
        }
        if newline_run < max_newlines {
            out.push(b'\n');
            newline_run += 1;
        } else {
            collapsed = true;
        }
        line_start = out.len();
    }

    if o.trim_lines && line_start < out.len() && trim_line_tail(&mut out, line_start) {
        trimmed = true;
    }

    let text = match String::from_utf8(out) {
        Ok(s) => s,
        // Unreachable in practice: JS strings cross the boundary as valid UTF-8
        // and we only cut on ASCII control bytes.
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    (text, stripped, collapsed, trimmed)
}

fn render_marker(template: &str, removed: usize) -> String {
    if template.contains("{{n}}") {
        template.replace("{{n}}", &removed.to_string())
    } else {
        template.to_string()
    }
}

/// Keep the head and tail of `text` inside `max_chars`, joined by a marker
/// that states how much was dropped.
fn truncate(text: String, o: &CompressOptions) -> (String, bool) {
    let max = o.max_chars as usize;
    if max == 0 {
        return (text, false);
    }

    let total = text.chars().count();
    if total <= max {
        return (text, false);
    }

    let template = o
        .marker
        .clone()
        .unwrap_or_else(|| "\n\u{2026} {{n}} chars omitted \u{2026}\n".to_string());

    // The marker competes with content for the budget, so size it, take the
    // remainder as content budget, then re-render once if the digit count
    // shifted. One iteration is enough for any realistic count.
    let mut removed = total.saturating_sub(max);
    let mut marker = render_marker(&template, removed);
    let mut budget = max.saturating_sub(marker.chars().count());
    let recompute = total.saturating_sub(budget);
    if recompute != removed {
        removed = recompute;
        marker = render_marker(&template, removed);
        budget = max.saturating_sub(marker.chars().count());
    }

    let head_pct = o.head_pct.min(100) as usize;
    let head_chars = budget * head_pct / 100;
    let tail_chars = budget - head_chars;

    let head_byte = text
        .char_indices()
        .nth(head_chars)
        .map(|(idx, _)| idx)
        .unwrap_or(text.len());
    let tail_char_index = total.saturating_sub(tail_chars);
    let tail_byte = text
        .char_indices()
        .nth(tail_char_index)
        .map(|(idx, _)| idx)
        .unwrap_or(text.len());

    let mut res = String::with_capacity(head_byte + marker.len() + (text.len() - tail_byte));
    res.push_str(&text[..head_byte]);
    res.push_str(&marker);
    res.push_str(&text[tail_byte..]);

    // Belt and braces: never return more characters than the caller asked for.
    if res.chars().count() > max {
        let end = res
            .char_indices()
            .nth(max)
            .map(|(idx, _)| idx)
            .unwrap_or(res.len());
        res.truncate(end);
    }

    (res, true)
}

/// Compress a blob of tool output.
///
/// Order matters: cleaning runs first so truncation never keeps a dangling
/// half-escape sequence inside the retained head or tail.
#[napi]
pub fn compress(input: String, options: CompressOptions) -> CompressResult {
    let original_chars = char_count(&input);
    let (cleaned, stripped, collapsed, trimmed) = clean(&input, &options);
    let (text, truncated) = truncate(cleaned, &options);
    let result_chars = char_count(&text);

    CompressResult {
        text,
        original_chars,
        result_chars,
        truncated,
        stripped,
        collapsed,
        trimmed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(max: u32) -> CompressOptions {
        CompressOptions {
            max_chars: max,
            ..CompressOptions::default()
        }
    }

    #[test]
    fn strips_csi_and_osc() {
        let input = "\u{1b}[31mred\u{1b}[0m and \u{1b}]0;title\u{7}done";
        let r = compress(input.to_string(), opts(0));
        assert_eq!(r.text, "red and done");
        assert!(r.stripped);
    }

    #[test]
    fn collapses_blank_runs_and_crlf() {
        let input = "a\r\n\r\n\r\n\r\nb";
        let r = compress(input.to_string(), opts(0));
        assert_eq!(r.text, "a\n\nb");
        assert!(r.collapsed);
    }

    #[test]
    fn trims_trailing_ws() {
        let r = compress(
            "hi   \nthere\t\t".to_string(),
            CompressOptions {
                trim_lines: true,
                ..opts(0)
            },
        );
        assert_eq!(r.text, "hi\nthere");
        assert!(r.trimmed);
    }

    #[test]
    fn truncates_head_and_tail_within_budget() {
        let input: String = "abcdefghij".repeat(50); // 500 chars
        let r = compress(input.clone(), opts(100));
        assert!(r.truncated);
        assert!(r.result_chars <= 100, "got {}", r.result_chars);
        // Head must be a prefix of the input, tail must be a true suffix of it.
        assert!(input.starts_with(&r.text[..7]), "head mismatch: {:?}", &r.text[..7]);
        assert!(r.text.ends_with("abcdefghij"), "tail is not a real suffix: {:?}", r.text);
    }

    #[test]
    fn keeps_utf8_intact_at_cut_points() {
        let input: String = "\u{1f600}".repeat(500); // 4 bytes each
        let r = compress(input, opts(60));
        assert!(r.result_chars <= 60, "got {}", r.result_chars);
        assert!(r.text.is_char_boundary(r.text.len()));
        assert!(!r.text.contains('\u{fffd}'));
    }

    #[test]
    fn does_not_truncate_under_budget() {
        let r = compress("short".to_string(), opts(100));
        assert!(!r.truncated);
        assert_eq!(r.text, "short");
    }

    #[test]
    fn hashes_are_stable_and_order_sensitive() {
        assert_eq!(hash_parts(vec!["a".into(), "b".into()]), hash_parts(vec!["a".into(), "b".into()]));
        assert_ne!(hash_parts(vec!["a".into(), "b".into()]), hash_parts(vec!["b".into(), "a".into()]));
        assert_ne!(hash_parts(vec!["ab".into()]), hash_parts(vec!["a".into(), "b".into()]));
        assert_eq!(hash_parts(vec![]).len(), 16);
    }

    #[test]
    fn fingerprint_tracks_size_and_mtime() {
        let a = fingerprint("/x".into(), 10.0, 1.0);
        assert_eq!(a, fingerprint("/x".into(), 10.0, 1.0));
        assert_ne!(a, fingerprint("/x".into(), 11.0, 1.0));
        assert_ne!(a, fingerprint("/y".into(), 10.0, 1.0));
    }
}
