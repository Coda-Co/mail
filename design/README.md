# Design reference

Mockups for the mail app, for anyone building it (people or coding agents). Read alongside `../SPEC.md`, which is the source of truth for behaviour.

Live canvas: https://claude.ai/artifact/7PrypALbsct2WJC8gH5B72

## Files

| File | Screen | What it shows |
|---|---|---|
| `mockups/Main.dc.html` | Mail | Sidebar, unified inbox, reading pane with the reply draft at the top of the conversation, agenda panel on the right |
| `mockups/Search.dc.html` | Search | Search filtering the current view: scope chip, facet chips (From, To, Has attachment, Unread, Date, Account), contact card, results |
| `mockups/Calendar.dc.html` | Calendar | Work-week view, calendars overlaid by account colour, event detail panel |
| `mockups/PopOut.dc.html` | Pop-out window | A reply in its own window, with Dock back |
| `mockups/WebAccount.dc.html` | Web-only account | Outlook on the web filling the main panel, account tagged "web" in the sidebar |
| `screens/*.png` | All | Rendered images of each mockup at 1440x900, 2x |
| `tokens.json` | All | Colours, type scale, spacing, radii, layout widths |

## How to read the mockups

The `.dc.html` files are design mockups, not production code. Use them for layout, spacing, colours, copy and behaviour; don't copy their structure into the app.

- Markup inside `<x-dc>` is the screen. Styles are inline.
- `{{name}}` is a placeholder filled from `renderVals()` in the `<script type="text/x-dc">` block at the bottom.
- `<sc-for list="{{items}}" as="item">` repeats its contents for each item; `<sc-if value="{{flag}}">` shows its contents conditionally.
- Sample data (accounts, messages, events) is in `renderVals()`. All names and companies are made up.
- `support.js` is the design tool's runtime and isn't included, so the files won't render on their own. Use the images in `screens/`, or open the live canvas.

## Design principles

1. **Quiet by default.** Light grey sidebar, white content, one blue accent. Colour is reserved for account identity and the primary action.
2. **Account colour is the main visual language.** Every message, event and agenda item carries its account's colour.
3. **Few controls.** Only the actions in the mockups. No ribbon.
4. **Keyboard first.** Every action has a shortcut (see the spec), identical on Windows and macOS.
5. **Search filters what you're looking at.** It never opens a separate screen.
6. **Drafts sit at the top of the conversation**, and anything can pop out into its own window.
7. **One font: Geist**, bundled with the app.

## Not yet designed

- Dark mode
- New message (full compose), forwarding, attachments list
- Month and day calendar views, new event form
- Add account flow, including the "Need admin approval" screens
- Settings, including the signature editor
- Empty, loading, offline and error states
- Notifications
