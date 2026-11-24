//! HTML for display and compose: sanitising mail bodies, blocking remote images,
//! inserting and swapping signatures, and quoting the message being answered.

use crate::model::{Address, Attachment, DraftMode, Message};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const MAIL_ATTRS: &[&str] = &[
    "style", "class", "align", "valign", "width", "height", "bgcolor", "border", "cellpadding", "cellspacing", "color", "face", "size", "dir", "colspan", "rowspan", "title",
];

pub struct Sanitized {
    pub html: String,
    pub remote_images_blocked: bool,
}

/// Sanitise a received mail body. `inline` maps content ids to data URLs for cid: images.
pub fn sanitize_mail(html: &str, allow_remote: bool, inline: &HashMap<String, String>) -> Sanitized {
    let blocked = Arc::new(AtomicBool::new(false));
    let flag = blocked.clone();
    let html = replace_cids(html, inline);
    let mut b = ammonia::Builder::default();
    let extra_tags: HashSet<&str> = ["font", "center", "u", "s", "strike", "span", "div", "table", "tbody", "thead", "tfoot", "tr", "td", "th", "img", "hr"].into_iter().collect();
    b.add_tags(extra_tags);
    b.add_generic_attributes(MAIL_ATTRS.iter().copied());
    b.add_tag_attributes("img", ["src", "alt", "width", "height"]);
    b.add_tag_attributes("a", ["href", "name"]);
    b.add_url_schemes(["data", "cid"]);
    b.link_rel(Some("noopener noreferrer"));
    b.attribute_filter(move |el, attr, value| {
        if allow_remote {
            return Some(value.into());
        }
        let lower = value.trim_start().to_ascii_lowercase();
        let remote = lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("//");
        match (el, attr) {
            ("img", "src") if remote => {
                flag.store(true, Ordering::Relaxed);
                None
            }
            (_, "background") if remote => {
                flag.store(true, Ordering::Relaxed);
                None
            }
            (_, "style") if lower.contains("url(") => {
                flag.store(true, Ordering::Relaxed);
                Some(strip_css_urls(value).into())
            }
            _ => Some(value.into()),
        }
    });
    b.add_generic_attributes(["background"]);
    let out = b.clean(&html).to_string();
    Sanitized { html: out, remote_images_blocked: blocked.load(Ordering::Relaxed) }
}

/// Sanitise a received mail body for display, keeping the sender's `<style>` blocks
/// (Outlook puts its paragraph spacing and fonts there, e.g. `p.MsoNormal{margin:0}`).
/// The CSS only applies inside the sandboxed message iframe.
pub fn sanitize_mail_for_display(html: &str, allow_remote: bool, inline: &HashMap<String, String>) -> Sanitized {
    let (css, css_blocked) = extract_styles(html, allow_remote);
    let mut s = sanitize_mail(html, allow_remote, inline);
    if !css.is_empty() {
        s.html = format!("<style>{css}</style>{}", s.html);
    }
    s.remote_images_blocked |= css_blocked;
    s
}

/// Collect the contents of every `<style>` element, made safe to re-emit: no `@import`,
/// no way to close the element early, and `url(...)` removed unless remote content is allowed.
fn extract_styles(html: &str, allow_remote: bool) -> (String, bool) {
    let lower = html.to_ascii_lowercase();
    let mut css = String::new();
    let mut blocked = false;
    let mut i = 0;
    while let Some(p) = lower[i..].find("<style") {
        let open = i + p;
        let Some(gt) = lower[open..].find('>') else { break };
        let start = open + gt + 1;
        let end = lower[start..].find("</style").map(|e| start + e).unwrap_or(html.len());
        let mut block = html[start..end].replace("<!--", "").replace("-->", "");
        block = strip_css_imports(&block);
        if !allow_remote && block.to_ascii_lowercase().contains("url(") {
            blocked = true;
            block = strip_css_urls(&block);
        }
        css.push_str(&block.replace('<', "\\3C "));
        css.push('\n');
        i = end;
    }
    (css.trim().to_string(), blocked)
}

fn strip_css_imports(css: &str) -> String {
    let lower = css.to_ascii_lowercase();
    let mut out = String::new();
    let mut i = 0;
    while let Some(p) = lower[i..].find("@import") {
        out.push_str(&css[i..i + p]);
        i = lower[i + p..].find(';').map(|e| i + p + e + 1).unwrap_or(css.len());
    }
    out.push_str(&css[i..]);
    out
}

fn strip_css_urls(style: &str) -> String {
    let mut out = String::new();
    let lower = style.to_ascii_lowercase();
    let mut i = 0;
    while let Some(p) = lower[i..].find("url(") {
        out.push_str(&style[i..i + p]);
        let rest = &lower[i + p..];
        let end = rest.find(')').map(|e| i + p + e + 1).unwrap_or(style.len());
        out.push_str("none");
        i = end;
    }
    out.push_str(&style[i..]);
    out
}

fn replace_cids(html: &str, inline: &HashMap<String, String>) -> String {
    if inline.is_empty() || !html.contains("cid:") {
        return html.to_string();
    }
    let mut out = html.to_string();
    for (cid, data_url) in inline {
        out = out.replace(&format!("cid:{cid}"), data_url);
    }
    out
}

/// Map content id → data URL for inline attachments already cached on disk (≤ 2 MB each).
pub fn inline_data_urls(attachments: &[Attachment]) -> HashMap<String, String> {
    use base64::Engine;
    let mut m = HashMap::new();
    for a in attachments.iter().filter(|a| a.content_id.is_some()) {
        if let (Some(cid), Some(path)) = (&a.content_id, &a.local_path) {
            if a.size <= 2_000_000 {
                if let Ok(bytes) = std::fs::read(path) {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                    m.insert(cid.trim_matches(|c| c == '<' || c == '>').to_string(), format!("data:{};base64,{}", a.content_type, b64));
                }
            }
        }
    }
    m
}

/// Signatures: bold, italic, links, colour, line breaks and an inline logo image.
pub fn sanitize_signature(html: &str) -> String {
    let mut b = ammonia::Builder::empty();
    b.add_tags(["b", "strong", "i", "em", "u", "a", "br", "p", "div", "span", "img", "font"]);
    b.add_tag_attributes("a", ["href"]);
    b.add_tag_attributes("img", ["src", "alt", "width", "height", "style"]);
    b.add_tag_attributes("span", ["style"]);
    b.add_tag_attributes("div", ["style"]);
    b.add_tag_attributes("p", ["style"]);
    b.add_tag_attributes("font", ["color"]);
    b.url_schemes(["http", "https", "mailto", "tel", "data"].into_iter().collect());
    b.link_rel(None);
    b.clean(html).to_string()
}

const SIG_OPEN: &str = "<div data-signature=\"";

/// Wrap a signature for insertion into a draft body.
pub fn signature_block(id: &str, html: &str) -> String {
    format!("{SIG_OPEN}{}\">{}</div>", html_escape::encode_double_quoted_attribute(id), html)
}

/// Find the byte range of the signature block, matching nested divs.
fn signature_range(body: &str) -> Option<(usize, usize)> {
    let start = body.find(SIG_OPEN)?;
    let lower = body.to_ascii_lowercase();
    let mut depth = 0i32;
    let mut i = start;
    while i < body.len() {
        let rest = &lower[i..];
        if rest.starts_with("<div") {
            depth += 1;
            i += 4;
        } else if rest.starts_with("</div>") {
            depth -= 1;
            i += 6;
            if depth == 0 {
                return Some((start, i));
            }
        } else {
            i += rest.chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        }
    }
    None
}

/// Replace the signature block (or insert one before the quote / at the end).
pub fn swap_signature(body: &str, new_sig: Option<(&str, &str)>) -> String {
    let block = new_sig.map(|(id, html)| signature_block(id, html)).unwrap_or_default();
    if let Some((s, e)) = signature_range(body) {
        return format!("{}{}{}", &body[..s], block, &body[e..]);
    }
    if block.is_empty() {
        return body.to_string();
    }
    match body.find(QUOTE_OPEN) {
        Some(q) => format!("{}{}{}", &body[..q], block, &body[q..]),
        None => format!("{body}{block}"),
    }
}

const QUOTE_OPEN: &str = "<div data-quote";

fn addr_list(list: &[Address]) -> String {
    list.iter().map(|a| html_escape::encode_text(a.display()).to_string()).collect::<Vec<_>>().join("; ")
}

/// Starting body for a new draft: an empty line, then the signature. The quote of the
/// message being answered is kept separately (see `quote_block`) so the editor stays clean.
pub fn compose_body(signature: Option<(&str, &str)>) -> String {
    let mut body = String::from("<div><br></div>");
    if let Some((id, html)) = signature {
        body.push_str(&signature_block(id, html));
    }
    body
}

/// The quoted original, appended below the body when the draft is saved to the server.
pub fn quote_block(mode: DraftMode, src: &Message, when: &str) -> String {
    let s = &src.summary;
    let quoted = sanitize_mail(&src.body_html, false, &HashMap::new()).html;
    let meta = match mode {
        DraftMode::Forward => format!(
            "<p><b>From:</b> {} &lt;{}&gt;<br><b>Sent:</b> {}<br><b>To:</b> {}{}<br><b>Subject:</b> {}</p>",
            html_escape::encode_text(s.from.display()),
            html_escape::encode_text(&s.from.email),
            html_escape::encode_text(when),
            addr_list(&s.to),
            if src.cc.is_empty() { String::new() } else { format!("<br><b>Cc:</b> {}", addr_list(&src.cc)) },
            html_escape::encode_text(&s.subject)
        ),
        _ => format!("<p>{} · {}</p>", html_escape::encode_text(s.from.display()), html_escape::encode_text(when)),
    };
    format!("{QUOTE_OPEN}><hr>{meta}<blockquote>{quoted}</blockquote></div>")
}

pub fn reply_subject(mode: DraftMode, subject: &str) -> String {
    let lower = subject.to_lowercase();
    match mode {
        DraftMode::Reply | DraftMode::ReplyAll if !lower.starts_with("re:") => format!("RE: {subject}"),
        DraftMode::Forward if !(lower.starts_with("fw:") || lower.starts_with("fwd:")) => format!("FW: {subject}"),
        _ => subject.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_remote_images_and_scripts() {
        let s = sanitize_mail(
            "<p onclick=x>Hi</p><img src=\"https://t.co/p.gif\"><img src=\"data:image/png;base64,AA==\"><script>alert(1)</script><div style=\"background:url(https://x/y)\">z</div>",
            false,
            &HashMap::new(),
        );
        assert!(s.remote_images_blocked);
        assert!(!s.html.contains("t.co"));
        assert!(!s.html.contains("script"));
        assert!(!s.html.contains("onclick"));
        assert!(s.html.contains("data:image/png"));
        assert!(!s.html.contains("https://x/y"));
        let allowed = sanitize_mail("<img src=\"https://t.co/p.gif\">", true, &HashMap::new());
        assert!(!allowed.remote_images_blocked);
        assert!(allowed.html.contains("t.co"));
    }

    #[test]
    fn display_keeps_sender_styles() {
        let html = "<html><head><style><!--\np.MsoNormal{margin:0cm;font-family:\"Aptos\",sans-serif}\n@import url(https://x/a.css);\ndiv{background:url(https://t.co/p.gif)}\n--></style></head><body><p class=MsoNormal>Hi</p></body></html>";
        let s = sanitize_mail_for_display(html, false, &HashMap::new());
        assert!(s.html.starts_with("<style>"));
        assert!(s.html.contains("p.MsoNormal{margin:0cm"));
        assert!(s.html.contains("class=\"MsoNormal\""));
        assert!(!s.html.contains("@import"));
        assert!(!s.html.contains("t.co"));
        assert!(s.remote_images_blocked);
        let evil = sanitize_mail_for_display("<style>a{}</style ><script>x</script><style>b{content:'<img>'}</style>", false, &HashMap::new());
        assert!(!evil.html.contains("script"));
        assert_eq!(evil.html.matches('<').count(), 2, "{}", evil.html);
        // Quotes in replies stay free of sender CSS.
        assert!(!sanitize_mail(html, false, &HashMap::new()).html.contains("<style"));
    }

    #[test]
    fn cid_images_become_data_urls() {
        let mut m = HashMap::new();
        m.insert("logo@1".to_string(), "data:image/png;base64,AA==".to_string());
        let s = sanitize_mail("<img src=\"cid:logo@1\">", false, &m);
        assert!(s.html.contains("data:image/png;base64,AA=="));
        assert!(!s.remote_images_blocked);
    }

    #[test]
    fn swaps_signature() {
        let body = format!("<div>Hello</div>{}<div data-quote><hr>old</div>", signature_block("s1", "<div><b>Miles</b></div><div>Coda</div>"));
        let swapped = swap_signature(&body, Some(("s2", "<i>M</i>")));
        assert_eq!(swapped, "<div>Hello</div><div data-signature=\"s2\"><i>M</i></div><div data-quote><hr>old</div>");
        let removed = swap_signature(&swapped, None);
        assert_eq!(removed, "<div>Hello</div><div data-quote><hr>old</div>");
        let inserted = swap_signature(&removed, Some(("s3", "X")));
        assert_eq!(inserted, "<div>Hello</div><div data-signature=\"s3\">X</div><div data-quote><hr>old</div>");
    }

    #[test]
    fn signature_sanitiser_keeps_formatting() {
        let s = sanitize_signature("<b>Miles</b><br><a href=\"https://coda.co\">Coda</a><span style=\"color:#0B5CC4\">x</span><img src=\"data:image/png;base64,AA==\"><script>x</script>");
        assert!(s.contains("<b>Miles</b>"));
        assert!(s.contains("href=\"https://coda.co\""));
        assert!(s.contains("color:#0B5CC4"));
        assert!(s.contains("data:image/png"));
        assert!(!s.contains("script"));
    }

    #[test]
    fn subjects() {
        assert_eq!(reply_subject(DraftMode::Reply, "Hello"), "RE: Hello");
        assert_eq!(reply_subject(DraftMode::Reply, "Re: Hello"), "Re: Hello");
        assert_eq!(reply_subject(DraftMode::Forward, "Hello"), "FW: Hello");
        assert_eq!(reply_subject(DraftMode::New, "Hello"), "Hello");
    }
}
