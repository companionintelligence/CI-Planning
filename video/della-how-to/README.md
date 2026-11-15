# Companion Planning · Della Bradley How-To

The Della Bradley use-case clips are short, landscape videos showing one person's planning flow.
The eight standalone cuts are:

1. Della Doesn't Want to Burn Out (`della-howto-01.mp4`)
2. Capture It, Then Close the Loop (`della-howto-02.mp4`)
3. Focus on the Next Step (`della-howto-03.mp4`)
4. Repeat What Works (`della-howto-04.mp4`)
5. Reuse Time, Keep It Sorted (`della-howto-05.mp4`)
6. See How the Week Feels (`della-howto-06.mp4`)
7. Fit the Plan to Real Life (`della-howto-07.mp4`)
8. Keep Connections Optional (`della-howto-08.mp4`)

There are also 16 feature clips (`01-Today.mp4` through `16-Scheduled-Jobs.mp4`). Those explain
individual app areas; the eight `della-howto-*` videos tell the Della use-case story.

The video files are not committed: `video/.gitignore` ignores `*.mp4`. Keep them locally in
`assets/video/`, where `storyboard.json` expects them, before building or rendering.

The [storyboard](storyboard.json) holds the scenes, titles, and narration. Narration audio lives in
`assets/audio/`. The video kit can rebuild the cuts with `ci-video build`, `ci-video check`, and
`ci-video render --format landscape`.
