//! Fixed private-PG fast shutdown, before GUI initialization. No generic signal/HTTP proxy.
//! pidfd pins the inspected kernel process even if the numeric PID is recycled.
use std::{
    fs,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    path::Path,
};

fn group(pid: &str) -> Result<String, String> {
    fs::read_to_string(format!("/proc/{pid}/cgroup"))
        .map_err(|e| e.to_string())?
        .lines()
        .find_map(|l| l.strip_prefix("0::").map(str::to_owned))
        .ok_or("cgroup v2 required".into())
}
fn pin(pid: i32) -> Result<OwnedFd, String> {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
}
fn send(fd: &OwnedFd, signal: i32) -> Result<(), String> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
pub fn stop(pid: i32) -> Result<(), String> {
    if pid <= 1 {
        return Err("Invalid private postmaster PID".into());
    }
    let fd = pin(pid)?; // Pin BEFORE inspection; later numeric PID reuse cannot redirect the signal.
    let expected =
        std::env::var("YUVI_LINUX_LIFECYCLE_CGROUP").map_err(|_| "Managed lifecycle required")?;
    if !expected.starts_with('/')
        || group("self")? != expected
        || group(&pid.to_string())? != expected
    {
        return Err("PostgreSQL is outside the managed invocation; no signal sent".into());
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = executable
        .parent()
        .and_then(Path::parent)
        .ok_or("Invalid package root")?;
    let data = Path::new(&std::env::var("YUVI_DATA_ROOT").map_err(|_| "Data root required")?)
        .join("Postgres/data")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let expected_exe = root
        .join("postgres/bin/postgres")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if fs::read_link(format!("/proc/{pid}/exe")).map_err(|e| e.to_string())? != expected_exe {
        return Err("Private PostgreSQL executable mismatch".into());
    }
    let argv = fs::read(format!("/proc/{pid}/cmdline")).map_err(|e| e.to_string())?;
    let args: Vec<_> = argv
        .split(|b| *b == 0)
        .filter(|v| !v.is_empty())
        .map(|v| String::from_utf8_lossy(v).to_string())
        .collect();
    if !args
        .windows(2)
        .any(|w| w[0] == "-D" && Path::new(&w[1]).canonicalize().ok().as_ref() == Some(&data))
    {
        return Err("Private PGDATA mismatch".into());
    }
    let marker: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(data.parent().ok_or("Invalid PGDATA")?.join("marker.json"))
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let cluster = marker["clusterId"]
        .as_str()
        .ok_or("Missing cluster identity")?;
    if !args
        .iter()
        .any(|a| a == &format!("cluster_name=yuvi-pg-{cluster}"))
    {
        return Err("Private cluster identity mismatch".into());
    }
    if fs::read_to_string(data.join("postmaster.pid"))
        .map_err(|e| e.to_string())?
        .lines()
        .next()
        != Some(&pid.to_string())
    {
        return Err("Private postmaster.pid mismatch".into());
    }
    send(&fd, libc::SIGINT)?; // PostgreSQL's documented fast shutdown, never SIGKILL here.
    let mut poll = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    if unsafe { libc::poll(&mut poll, 1, 12_000) } != 1 || poll.revents & libc::POLLIN == 0 {
        return Err("Private PG fast shutdown timed out; no escalation by numeric PID".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pidfd_stays_bound_after_child_exit() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let fd = pin(child.id() as i32).unwrap();
        send(&fd, libc::SIGTERM).unwrap();
        child.wait().unwrap();
        assert!(send(&fd, libc::SIGTERM).is_err());
        let mut other = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        assert!(send(&fd, libc::SIGTERM).is_err());
        assert!(other.try_wait().unwrap().is_none());
        other.kill().unwrap();
        other.wait().unwrap();
    }
    #[test]
    fn no_unmanaged_private_pg_signal() {
        assert!(stop(std::process::id() as i32).is_err());
    }
}
