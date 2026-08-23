use std::env;
use std::fs;
use std::hash::{DefaultHasher, Hasher};
use std::path::PathBuf;

fn main() -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use winres::WindowsResource;
        WindowsResource::new()
            .set_icon("assets/icon.ico")
            .compile()?;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let web_dir = manifest_dir.parent().unwrap().join("web");
    let files = ["index.html", "app.js", "styles.css", "favicon.ico"];
    let mut hasher = DefaultHasher::new();

    for file in &files {
        let path = web_dir.join(file);
        let bytes = fs::read(&path)?;
        hasher.write(&bytes);
        let canonical = path.canonicalize()?;
        println!("cargo:rerun-if-changed={}", canonical.display());
    }

    println!("cargo:rustc-env=WEB_ASSET_HASH={:016x}", hasher.finish());
    Ok(())
}
