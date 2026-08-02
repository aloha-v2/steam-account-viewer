use std::{fs, path::Path};

fn main() {
    // tauri-build requires a Windows ICO even when installer bundling is disabled.
    // Generate a tiny valid embedded icon so fresh clones build without binary assets.
    let icon_path = Path::new("icons/icon.ico");
    if !icon_path.exists() {
        fs::create_dir_all("icons").expect("failed to create icons directory");
        let icon: [u8; 70] = [
            0, 0, 1, 0, 1, 0, // ICONDIR
            1, 1, 0, 0, 1, 0, 32, 0, 48, 0, 0, 0, 22, 0, 0, 0, // entry
            40, 0, 0, 0, // BITMAPINFOHEADER size
            1, 0, 0, 0, // width
            2, 0, 0, 0, // height: XOR + AND masks
            1, 0, 32, 0, // planes and bit depth
            0, 0, 0, 0, // compression
            4, 0, 0, 0, // image size
            0, 0, 0, 0, 0, 0, 0, 0, // pixels per meter
            0, 0, 0, 0, 0, 0, 0, 0, // palette
            64, 54, 49, 255, // one opaque dark-blue BGRA pixel
            0, 0, 0, 0, // AND transparency mask
        ];
        fs::write(icon_path, icon).expect("failed to create Windows icon");
    }

    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}
