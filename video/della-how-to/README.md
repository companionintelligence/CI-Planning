# Companion Planning · Della Bradley How-To

The Della Bradley use-case clips are committed in `assets/video/`. They are short, landscape videos
showing one person's planning flow. The eight standalone cuts are:

1. [Della Doesn't Want to Burn Out](assets/video/della-howto-01.mp4)
2. [Capture It, Then Close the Loop](assets/video/della-howto-02.mp4)
3. [Focus on the Next Step](assets/video/della-howto-03.mp4)
4. [Repeat What Works](assets/video/della-howto-04.mp4)
5. [Reuse Time, Keep It Sorted](assets/video/della-howto-05.mp4)
6. [See How the Week Feels](assets/video/della-howto-06.mp4)
7. [Fit the Plan to Real Life](assets/video/della-howto-07.mp4)
8. [Keep Connections Optional](assets/video/della-howto-08.mp4)

The folder also contains 16 feature clips (`01-Today.mp4` through `16-Scheduled-Jobs.mp4`).
Those explain individual app areas; the eight `della-howto-*` videos tell the Della use-case story.

The [storyboard](storyboard.json) holds the scenes, titles, and narration. Narration audio lives in
`assets/audio/`. The video kit can rebuild the cuts with `ci-video build`, `ci-video check`, and
`ci-video render --format landscape`.
