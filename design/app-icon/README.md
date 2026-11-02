# App icon

The sources are the SVG files in this folder. `app-icon-rounded.svg` has transparent corners, for the favicon and for desktop icons. `app-icon.svg` is square and opaque, for iOS, Android and the web. `app-icon-foreground.svg` is the glyph alone, for the Android adaptive icon.

To regenerate the 1024 px PNGs, use librsvg and ImageMagick:

    rsvg-convert -w 1024 -h 1024 app-icon.svg -o raw.png
    magick raw.png -background '#409b9b' -alpha remove -alpha off icon-1024.png
    rsvg-convert -w 1024 -h 1024 app-icon-rounded.svg -o icon-1024-rounded.png
    rsvg-convert -w 1024 -h 1024 app-icon-foreground.svg -o icon-foreground-1024.png

Then resize into the platform folders: `mobile/ios/.../AppIcon-512@2x.png` (1024 px, opaque), the Android `mipmap-*` folders (launcher 48 to 192 px, adaptive foreground 108 to 432 px), and `client/public` (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, and `favicon.svg`). The desktop app's icons come from `tauri icon` on a 1024 px source.
