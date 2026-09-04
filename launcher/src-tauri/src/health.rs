use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// True once GET http://127.0.0.1:<port><path> answers 200, polling every 100 ms up to `timeout`.
pub fn wait_healthy(port: u16, path: &str, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if check(port, path) { return true; }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn check(port: u16, path: &str) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&(std::net::Ipv4Addr::LOCALHOST, port).into(), Duration::from_millis(300)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
    if s.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").as_bytes()).is_err() { return false; }
    let mut buf = [0u8; 64];
    let Ok(n) = s.read(&mut buf) else { return false };
    String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200")
}
