fn main() -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use winres::WindowsResource;
        WindowsResource::new()
            .set_icon("assets/icon.ico")
            .set("ProductName", "KASUGAI Canvas")
            .set("FileDescription", "KASUGAI Canvas server / bridge hub")
            .set("CompanyName", "yamamoto-ryuzo")
            .set("LegalCopyright", "MIT License")
            .compile()?;
    }
    Ok(())
}
