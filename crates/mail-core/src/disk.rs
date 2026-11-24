//! Start-up check that the disk holding the mail store is encrypted
//! (FileVault on macOS, BitLocker on Windows). v1 relies on full-disk encryption.

use crate::model::DiskEncryption;
use std::process::Command;

pub fn check() -> DiskEncryption {
    #[cfg(target_os = "macos")]
    {
        // "FileVault is On." / "FileVault is Off."
        return match Command::new("/usr/bin/fdesetup").arg("status").output() {
            Ok(o) => parse_filevault(&String::from_utf8_lossy(&o.stdout)),
            Err(_) => DiskEncryption::Unknown,
        };
    }
    #[cfg(target_os = "windows")]
    {
        // Works without admin rights. 1 = on, 2 = off, 3 = encrypting/unknown, 0 = not available.
        let script = "(New-Object -ComObject Shell.Application).NameSpace($env:SystemDrive).Self.ExtendedProperty('System.Volume.BitLockerProtection')";
        return match Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", script]).output() {
            Ok(o) => parse_bitlocker(&String::from_utf8_lossy(&o.stdout)),
            Err(_) => DiskEncryption::Unknown,
        };
    }
    #[cfg(target_os = "linux")]
    {
        return match Command::new("lsblk").args(["-n", "-o", "TYPE"]).output() {
            Ok(o) if String::from_utf8_lossy(&o.stdout).lines().any(|l| l.trim() == "crypt") => DiskEncryption::On,
            _ => DiskEncryption::Unknown,
        };
    }
    #[allow(unreachable_code)]
    DiskEncryption::Unknown
}

pub fn parse_filevault(out: &str) -> DiskEncryption {
    if out.contains("FileVault is On") {
        DiskEncryption::On
    } else if out.contains("FileVault is Off") {
        DiskEncryption::Off
    } else {
        DiskEncryption::Unknown
    }
}

pub fn parse_bitlocker(out: &str) -> DiskEncryption {
    match out.trim() {
        "1" | "3" | "5" => DiskEncryption::On,
        "2" | "0" => DiskEncryption::Off,
        _ => DiskEncryption::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses() {
        assert_eq!(parse_filevault("FileVault is On.\n"), DiskEncryption::On);
        assert_eq!(parse_filevault("FileVault is Off.\n"), DiskEncryption::Off);
        assert_eq!(parse_bitlocker("1\r\n"), DiskEncryption::On);
        assert_eq!(parse_bitlocker("2"), DiskEncryption::Off);
        assert_eq!(parse_bitlocker(""), DiskEncryption::Unknown);
    }
}
