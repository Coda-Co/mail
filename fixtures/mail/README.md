# Mail body fixtures

Synthetic HTML bodies that reproduce the markup real clients send, for rendering tests
(`crates/mail-core/tests/render_fixtures.rs` and `src/lib/quoted.test.ts`).

The structure (tags, classes, inline styles, quote headers, separators) is copied from
real messages; all names, addresses and text are invented. Never paste a real message here.

| File | Pattern |
| --- | --- |
| `outlook-desktop-reply.html` | Outlook for Windows (Word engine): full document, `<style>` with `p.MsoNormal`, `<o:p>`, conditional comments, cid signature logo, `border-top` "From/Sent/To/Subject" headers, an external-sender warning banner inside the quote. |
| `outlook-desktop-forward.html` | A short note on top of an `FW:`; the signature is a deep `font-size:0` table stack. |
| `owa-reply.html` | Outlook on the web / new Outlook: `elementToProof` divs with `color:rgb(0,0,0)`, `#appendonsend`, blank `<div><br></div>` lines, `<hr style="display:inline-block;width:98%">` before the header, nested `x_divRplyFwdMsg`. |
| `outlook-centered-hr-reply.html` | Outlook mobile / older OWA: the separator is `<div class="MsoNormal" align="center"><hr></div>` followed by `#divRplyFwdMsg`. |
| `gmail-reply.html` | Gmail: `gmail_signature` with a fixed 600px table, `gmail_quote gmail_quote_container` + `gmail_attr`, and a legal disclaimer the sender's server appends after the quote. |
| `transactional-preheader.html` | Service notification: hidden preheader padded with zero-width characters, `!important`, cards built from tables, a dark-mode class hook, a long unsubscribe link. |
| `nowrap-signature.html` | Corporate signature built from `white-space:nowrap` tables, a 108-character underscore rule and a `width:685px` disclaimer table. |
