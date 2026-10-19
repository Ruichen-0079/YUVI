#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    if std::env::args().nth(1).as_deref()==Some("--stop-private-postgres") {
        let args:Vec<_>=std::env::args().collect();
        let result=if args.len()==3 {args[2].parse::<i32>().map_err(|_|"Invalid PID".to_string()).and_then(yuvi_desktop_lib::managed_postgres::stop)} else {Err("Expected private postmaster PID".into())};
        if let Err(error)=result {eprintln!("{error}");std::process::exit(1);}
        return;
    }
    yuvi_desktop_lib::run()
}
