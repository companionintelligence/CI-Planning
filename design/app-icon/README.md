# App icon

The sources are the SVG files in this folder. `app-icon-rounded.svg` has transparent corners, for the favicon and for desktop icons. `app-icon.svg` is square and opaque, for iOS, Android and the web. `app-icon-foreground.svg` is the glyph alone, for the Android adaptive icon.

To regenerate the 1024 px PNGs, use librsvg and ImageMagick:

    rsvg-convert -w 1024 -h 1024 app-icon.svg -o raw.png
    magick raw.png -background '#409b9b' -alpha remove -alpha off icon-1024.png
    rsvg-convert -w 1024 -h 1024 app-icon-rounded.svg -o icon-1024-rounded.png
    rsvg-convert -w 1024 -h 1024 app-icon-foreground.svg -o icon-foreground-1024.png

Then resize into the platform folders: `mobile/ios/.../AppIcon-512@2x.png` (1024 px, opaque), the Android `mipmap-*` folders (launcher 48 to 192 px, adaptive foreground 108 to 432 px), and `client/public` (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, and `favicon.svg`). The desktop app's icons come from `tauri icon` on a 1024 px source.

The web manifest's maskable icon is `app-icon-maskable.svg`: the glyph at 86% over a full-bleed gradient, so a launcher can crop it to any shape without clipping the mark. Render it with `rsvg-convert -w 512 -h 512 app-icon-maskable.svg -o client/public/icon-maskable-512.png`.

The launch screens show `app-icon-rounded.svg` centred on the app's dark background (#041620): the iOS `Splash.imageset` (2732 px, all three scales) and the Android `drawable*/splash.png` files, each with the mark at 30% of the shorter side. Regenerate them with `rsvg-convert` for the mark, then `magick -size WxH xc:'#041620' mark.png -gravity center -composite splash.png`.
