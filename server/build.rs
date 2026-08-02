fn main() -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use winres::WindowsResource;

        WindowsResource::new()
            .set_icon("assets/icon.ico")
            .compile()?;
    }
    Ok(())
}
