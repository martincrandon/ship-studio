# Local patches

This is the upstream `xcap` 0.3.3 crate with one change in
`src/macos/capture.rs`: window images use Core Graphics' best-resolution mode.
Ship Studio crops using CSS coordinates scaled by the display pixel ratio, so
the source image also needs to use the display's native pixel density.
