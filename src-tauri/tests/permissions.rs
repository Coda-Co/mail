//! Every command the interface can call needs a permission in permissions/app.toml, or the
//! app refuses it at run time ("not allowed") while it works in the browser demo. This catches
//! a command added to build.rs without one.

use std::path::Path;

fn read(rel: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)).unwrap()
}

fn quoted(s: &str) -> Vec<String> {
    s.split('"').skip(1).step_by(2).map(String::from).collect()
}

#[test]
fn every_command_has_a_permission() {
    let build = read("build.rs");
    let start = build.find("const COMMANDS").expect("COMMANDS in build.rs");
    let end = start + build[start..].find("];").unwrap();
    let commands = quoted(&build[start..end]);
    assert!(commands.len() > 50, "read the command list");

    let allowed = quoted(&read("permissions/app.toml"));
    let missing: Vec<&String> = commands.iter().filter(|c| !allowed.contains(&format!("allow-{}", c.replace('_', "-")))).collect();
    assert!(missing.is_empty(), "commands without a permission in permissions/app.toml: {missing:?}");
}
