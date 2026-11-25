//! Sanitising real-world mail markup for display. The bodies live in `fixtures/mail/`
//! (synthetic content, structure copied from what Outlook, Outlook on the web, Gmail and
//! notification services actually send); see the README there.

use mail_core::html::{sanitize_mail, sanitize_mail_for_display, Sanitized};
use std::collections::HashMap;
use std::path::Path;

fn fixture(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/mail").join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn display(name: &str, allow_remote: bool) -> Sanitized {
    sanitize_mail_for_display(&fixture(name), allow_remote, &HashMap::new())
}

#[test]
fn outlook_desktop_drops_office_markup_but_keeps_blank_lines() {
    let html = display("outlook-desktop-reply.html", true).html;
    assert!(!html.contains("<o:p"), "{html}");
    assert!(!html.contains("[if gte mso"), "conditional comments leaked: {html}");
    assert!(!html.contains("shapedefaults"), "{html}");
    // Outlook's blank lines are `<p class=MsoNormal><o:p>&nbsp;</o:p></p>` with
    // `p.MsoNormal{margin:0}`: once <o:p> goes, the &nbsp; must stay or the spacing collapses.
    assert!(html.matches("&nbsp;</span></p>").count() >= 3, "blank lines lost: {html}");
    assert!(html.contains("p.MsoNormal, li.MsoNormal, div.MsoNormal"), "{html}");
    assert!(html.contains("class=\"MsoNormal\""));
    assert!(html.contains("margin-top:14pt;margin-bottom:14pt"), "auto spacing not applied: {html}");
}

#[test]
fn outlook_desktop_cid_logo_becomes_data_url() {
    let mut inline = HashMap::new();
    inline.insert("image001.png@01DC5E2B.7A9F1B30".to_string(), "data:image/png;base64,AA==".to_string());
    let s = sanitize_mail_for_display(&fixture("outlook-desktop-reply.html"), false, &inline);
    assert!(s.html.contains("src=\"data:image/png;base64,AA==\""), "{}", s.html);
    assert!(!s.html.contains("cid:"), "{}", s.html);
}

/// Word writes `<!--[if !mso]><style>v\:* {behavior:url(#default#VML);}</style><![endif]-->`
/// into the head of every message. That is a comment, not a remote resource, so a message
/// whose only image is an inline logo must not report blocked remote content.
#[test]
#[ignore = "bug: extract_styles reads <style> inside conditional comments, so url(#default#VML) flags every Outlook desktop message"]
fn outlook_desktop_vml_behaviour_is_not_remote_content() {
    let mut inline = HashMap::new();
    inline.insert("image001.png@01DC5E2B.7A9F1B30".to_string(), "data:image/png;base64,AA==".to_string());
    let s = sanitize_mail_for_display(&fixture("outlook-desktop-reply.html"), false, &inline);
    assert!(!s.remote_images_blocked, "{}", s.html);
    assert!(!s.html.contains("behavior"), "{}", s.html);
}

#[test]
fn quote_markers_the_reading_pane_relies_on_survive() {
    // src/lib/quoted.ts finds Gmail quotes by class on the sanitised body.
    let gmail = display("gmail-reply.html", true).html;
    assert!(gmail.contains("class=\"gmail_quote gmail_quote_container\""), "{gmail}");
    assert!(gmail.contains("class=\"gmail_attr\""), "{gmail}");
    assert!(gmail.contains("class=\"gmail_signature\""), "{gmail}");
    // ids are stripped, so Outlook's `#divRplyFwdMsg` / `#appendonsend` can't be used as
    // markers; quoted.ts has to recognise the From/Sent/Subject header text instead.
    let owa = display("owa-reply.html", true).html;
    assert!(!owa.contains("divRplyFwdMsg"), "{owa}");
    assert!(!owa.contains("appendonsend"), "{owa}");
    assert!(owa.contains("<b>From:</b> Lee Vendor"), "{owa}");
}

#[test]
fn owa_keeps_inline_colours_and_its_head_style() {
    let owa = display("owa-reply.html", true).html;
    // Every OWA paragraph pins `color: rgb(0, 0, 0)`; it reaches the iframe as-is.
    assert!(owa.matches("color: rgb(0, 0, 0)").count() >= 4, "{owa}");
    assert!(owa.starts_with("<style>"), "{owa}");
    assert!(owa.contains("P {margin-top:0;margin-bottom:0;}"), "{owa}");
    assert!(owa.contains("<hr style=\"display:inline-block;width:98%\">"), "{owa}");
}

#[test]
fn preheader_stays_hidden() {
    let s = display("transactional-preheader.html", true).html;
    let start = s.find("Security issues require your attention").expect("preheader text");
    let open = s[..start].rfind("<div").unwrap();
    assert!(s[open..start].contains("display:none"), "preheader would show: {}", &s[open..start]);
    // Zero-width padding survives; it's invisible inside the hidden block.
    assert!(s.contains('\u{200c}') && s.contains('\u{feff}'));
}

#[test]
fn sender_media_queries_and_important_survive() {
    let s = display("transactional-preheader.html", true).html;
    assert!(s.contains("@media (prefers-color-scheme: dark)"), "{s}");
    assert!(s.contains("@media only screen and (max-width: 480px)"), "{s}");
    assert!(s.contains("width:100% !important"), "{s}");
    assert!(s.contains("class=\"dm-text\""), "{s}");
}

#[test]
fn remote_images_in_signatures_and_notifications_are_blocked() {
    for name in ["gmail-reply.html", "transactional-preheader.html"] {
        let s = display(name, false);
        assert!(s.remote_images_blocked, "{name}");
        assert!(!s.html.contains("cdn.example.com"), "{name}: {}", s.html);
        let shown = display(name, true);
        assert!(!shown.remote_images_blocked, "{name}");
        assert!(shown.html.contains("https://cdn.example.com/"), "{name}");
    }
}

#[test]
fn links_keep_query_strings_and_phone_numbers() {
    let s = display("transactional-preheader.html", true).html;
    assert!(s.contains("unsubscribe?m=1.jSYJSVCKGkoSG1Jvm-qzAA."), "{s}");
    assert!(s.contains("&amp;utm_source=email\""), "{s}");
    assert!(s.contains("rel=\"noopener noreferrer\""), "{s}");
    let fwd = display("outlook-desktop-forward.html", true).html;
    assert!(fwd.contains("href=\"tel:+44%20(0)%2020%200000%200000\""), "{fwd}");
}

#[test]
fn nowrap_signature_layout_reaches_the_frame() {
    let s = display("nowrap-signature.html", true).html;
    assert!(s.contains("white-space:nowrap"), "{s}");
    assert!(s.contains("width:685px"), "{s}");
    assert!(s.contains(&"_".repeat(108)));
}

#[test]
fn replies_quote_without_sender_css() {
    for name in ["outlook-desktop-reply.html", "owa-reply.html", "transactional-preheader.html"] {
        let s = sanitize_mail(&fixture(name), false, &HashMap::new()).html;
        assert!(!s.contains("<style"), "{name}: {s}");
        assert!(!s.contains("@media"), "{name}");
    }
}
