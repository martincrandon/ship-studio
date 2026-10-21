//! Screenshots for the person on the phone.
//!
//! The point of remote access is "here's what it looks like now", not a wall
//! of terminal output. Two things make a screenshot useful from a phone:
//!
//! - **Sharp.** Captured at 2× (desktop) or 3× (phone) device pixel ratio,
//!   then re-encoded as JPEG so a high-DPI page fits through a chat.
//! - **Viewable.** Returned inline for the assistant *and* stored behind an
//!   image link of its own: `…/shipstudio/shot/<id>.jpg`. The id is a fresh
//!   256-bit random value per image, so the link shows that one picture and
//!   nothing else — it never contains the connector's token, which would be
//!   a key to the whole computer sitting in a chat transcript. Links expire
//!   after a day and only the newest few dozen are kept, in memory.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const SHOT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_SHOTS: usize = 40;
/// Past this many pixels a capture is scaled down — a long full-page shot at
/// 2× would otherwise be tens of megabytes.
const MAX_PIXELS: u64 = 12_000_000;
/// High enough that small text stays crisp; JPEG at this quality is still a
/// fraction of the PNG's size.
const JPEG_QUALITY: u8 = 92;

struct Shot {
    jpeg: Vec<u8>,
    created: Instant,
}

static SHOTS: LazyLock<Mutex<HashMap<String, Shot>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// A device to capture as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Desktop,
    Phone,
}

impl Device {
    /// (CSS width, CSS height, device pixel ratio).
    pub fn viewport(self) -> (u32, u32, f32) {
        match self {
            Device::Desktop => (1280, 800, 2.0),
            Device::Phone => (390, 844, 3.0),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Device::Desktop => "desktop",
            Device::Phone => "phone",
        }
    }
}

/// Only files the capture command wrote into this project's screenshots
/// folder may be read back — the path comes from another component, and
/// nothing should be able to turn this into "read any file".
pub fn is_capture_path(project: &Path, file: &Path) -> bool {
    let dir = project.join(".shipstudio").join("screenshots");
    match (dunce::canonicalize(&dir), dunce::canonicalize(file)) {
        (Ok(dir), Ok(file)) => file.starts_with(dir) && file.is_file(),
        _ => false,
    }
}

/// The full-resolution image (served at the link) and a smaller copy for the
/// assistant itself. Chat apps shrink an inline image to their own size and
/// show *that* — which is how a sharp 2560px capture reached a phone looking
/// blurry. The link is what the user should see; the preview copy just keeps
/// the assistant's view (and token use) small.
pub struct Encoded {
    pub full: Vec<u8>,
    pub preview: Vec<u8>,
}

/// Width of the copy handed to the assistant.
const PREVIEW_WIDTH: u32 = 1024;

pub fn encode(file: &Path) -> Result<Encoded, String> {
    let img = image::open(file).map_err(|e| format!("Couldn't read the screenshot: {e}"))?;
    let full = jpeg_of(&cap_pixels(img.clone()))?;
    let preview = if img.width() > PREVIEW_WIDTH {
        let h = (img.height() as u64 * PREVIEW_WIDTH as u64 / img.width() as u64) as u32;
        img.resize(
            PREVIEW_WIDTH,
            h.max(1),
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        img
    };
    Ok(Encoded {
        full,
        preview: jpeg_of(&cap_pixels(preview))?,
    })
}

fn jpeg_of(img: &image::DynamicImage) -> Result<Vec<u8>, String> {
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode_image(&rgb)
        .map_err(|e| format!("Couldn't encode the screenshot: {e}"))?;
    Ok(out)
}

/// Scale down only if enormous (a long full-page shot at 2x).
fn cap_pixels(img: image::DynamicImage) -> image::DynamicImage {
    let (w, h) = (img.width() as u64, img.height() as u64);
    if w * h <= MAX_PIXELS {
        return img;
    }
    let factor = (MAX_PIXELS as f64 / (w * h) as f64).sqrt();
    img.resize(
        ((w as f64) * factor) as u32,
        ((h as f64) * factor) as u32,
        image::imageops::FilterType::Lanczos3,
    )
}

fn prune(shots: &mut HashMap<String, Shot>) {
    shots.retain(|_, s| s.created.elapsed() < SHOT_TTL);
    while shots.len() >= MAX_SHOTS {
        let Some(oldest) = shots
            .iter()
            .min_by_key(|(_, s)| s.created)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        shots.remove(&oldest);
    }
}

/// Keep a screenshot and return its id.
pub fn store(jpeg: Vec<u8>) -> String {
    let id = super::new_token();
    if let Ok(mut shots) = SHOTS.lock() {
        prune(&mut shots);
        shots.insert(
            id.clone(),
            Shot {
                jpeg,
                created: Instant::now(),
            },
        );
    }
    id
}

/// The image for an id, if it exists and hasn't expired.
pub fn get(id: &str) -> Option<Vec<u8>> {
    // Ids are exactly what `store` makes: 64 hex characters.
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut shots = SHOTS.lock().ok()?;
    prune(&mut shots);
    shots.get(id).map(|s| s.jpeg.clone())
}

/// Forget every stored screenshot — used when the link is replaced or remote
/// access is turned off, so old image links stop working too.
pub fn clear() {
    if let Ok(mut shots) = SHOTS.lock() {
        shots.clear();
    }
}

/// Pull the id out of an image path: `/shipstudio/shot/<id>.jpg` or
/// `/shot/<id>.jpg`.
pub fn id_from_path(path: &str) -> Option<&str> {
    path.strip_prefix(super::tailscale::MOUNT_PATH)
        .unwrap_or(path)
        .strip_prefix("/shot/")?
        .strip_suffix(".jpg")
}

/// The public URL for a stored screenshot.
pub fn public_url(dns_name: &str, id: &str) -> String {
    format!(
        "https://{dns_name}{}/shot/{id}.jpg",
        super::tailscale::MOUNT_PATH
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_shots_come_back_by_id_only() {
        let id = store(vec![1, 2, 3]);
        assert_eq!(id.len(), 64);
        assert_eq!(get(&id), Some(vec![1, 2, 3]));
        assert_eq!(get("nope"), None);
        assert_eq!(get(&"0".repeat(64)), None);
        assert_eq!(get("../../etc/passwd"), None);
    }

    #[test]
    fn image_paths_parse_with_or_without_the_mount() {
        let id = "a".repeat(64);
        assert_eq!(
            id_from_path(&format!("/shipstudio/shot/{id}.jpg")),
            Some(id.as_str())
        );
        assert_eq!(id_from_path(&format!("/shot/{id}.jpg")), Some(id.as_str()));
        assert_eq!(id_from_path(&format!("/shipstudio/mcp/{id}")), None);
        assert_eq!(id_from_path(&format!("/shot/{id}.png")), None);
    }

    #[test]
    fn device_sizes_are_high_dpi() {
        let (w, _, scale) = Device::Desktop.viewport();
        assert!(w as f32 * scale >= 2560.0);
        let (w, _, scale) = Device::Phone.viewport();
        assert!(w as f32 * scale >= 1170.0);
    }

    #[test]
    fn png_captures_become_jpegs() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("shot.png");
        image::RgbImage::from_pixel(64, 32, image::Rgb([200, 30, 30]))
            .save(&png)
            .unwrap();
        let jpeg = encode(&png).unwrap().full;
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "JPEG magic");
    }

    #[test]
    fn the_preview_copy_is_small_and_the_full_one_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("wide.png");
        image::RgbImage::from_pixel(2560, 1600, image::Rgb([240, 240, 240]))
            .save(&png)
            .unwrap();
        let e = encode(&png).unwrap();
        let full = image::load_from_memory(&e.full).unwrap();
        let preview = image::load_from_memory(&e.preview).unwrap();
        assert_eq!((full.width(), full.height()), (2560, 1600));
        assert_eq!((preview.width(), preview.height()), (1024, 640));
    }

    #[test]
    fn only_files_in_the_screenshots_folder_are_readable() {
        let dir = tempfile::tempdir().unwrap();
        let shots = dir.path().join(".shipstudio/screenshots");
        std::fs::create_dir_all(&shots).unwrap();
        let inside = shots.join("a.png");
        std::fs::write(&inside, b"x").unwrap();
        let outside = dir.path().join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();
        assert!(is_capture_path(dir.path(), &inside));
        assert!(!is_capture_path(dir.path(), &outside));
        assert!(!is_capture_path(
            dir.path(),
            &shots.join("../../secret.txt")
        ));
    }
}
