//! Small text helpers: HTML to plain text for snippets and the search index.

/// Strip tags, drop <style>/<script>/<head>, decode entities, collapse whitespace.
pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let lower = html.to_ascii_lowercase();
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // Skip whole blocks whose content is not text.
            let mut skipped = false;
            for tag in ["style", "script", "head", "title"] {
                let open = format!("<{tag}");
                if lower[i..].starts_with(&open) {
                    let close = format!("</{tag}>");
                    match lower[i..].find(&close) {
                        Some(end) => i += end + close.len(),
                        None => i = bytes.len(),
                    }
                    skipped = true;
                    break;
                }
            }
            if skipped {
                continue;
            }
            let end = match html[i..].find('>') {
                Some(e) => i + e + 1,
                None => bytes.len(),
            };
            let tag = &lower[i..end];
            if tag.starts_with("<br") || tag.starts_with("</p") || tag.starts_with("</div") || tag.starts_with("</li") || tag.starts_with("</tr") || tag.starts_with("<hr") {
                out.push('\n');
            } else {
                out.push(' ');
            }
            i = end;
        } else {
            let next = html[i..].find('<').map(|n| i + n).unwrap_or(bytes.len());
            out.push_str(&html_escape::decode_html_entities(&html[i..next]));
            i = next;
        }
    }
    collapse(&out)
}

fn collapse(s: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in s.lines() {
        let l = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if l.is_empty() && lines.last().map(|x| x.is_empty()).unwrap_or(true) {
            continue;
        }
        lines.push(l);
    }
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines.join("\n").replace('\u{a0}', " ")
}

/// One-line preview.
pub fn snippet(text: &str, max: usize) -> String {
    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= max {
        one
    } else {
        let mut s: String = one.chars().take(max).collect();
        s.push('…');
        s
    }
}

/// Plain text to simple HTML paragraphs.
pub fn text_to_html(text: &str) -> String {
    text.split("\n\n")
        .map(|p| format!("<p>{}</p>", html_escape::encode_text(p).replace('\n', "<br>")))
        .collect::<Vec<_>>()
        .join("")
}

pub fn initials(name: &str) -> String {
    name.split_whitespace().filter_map(|w| w.chars().next()).take(2).collect::<String>().to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strips_html() {
        let t = html_to_text("<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;Miles,</p><p>Line <b>two</b><br>three &amp; four</p></body></html>");
        assert_eq!(t, "Hi Miles,\nLine two\nthree & four");
    }
    #[test]
    fn snippets() {
        assert_eq!(snippet("a  b\nc", 10), "a b c");
        assert_eq!(snippet("abcdef", 3), "abc…");
    }
}
