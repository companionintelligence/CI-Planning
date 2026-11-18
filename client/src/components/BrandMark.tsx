/**
 * The app's own mark: the triangle, crescent and circle from design/app-icon, drawn inline so it needs no
 * request and takes the size of the space it sits in. It replaces the generic chip icon the
 * navigation and sign-in screens used to show, so the app matches its icon and its launch screens.
 * Decorative: the name beside it says what the app is.
 */
let markCount = 0;

export function BrandMark(props: { size: number; class?: string }) {
  // Each mark names its own gradient and clip, so repeated marks never share an id.
  const markId = ++markCount;
  const gradientId = `brand-mark-bg-${markId}`;
  const maskId = `brand-mark-circle-cutout-${markId}`;
  const clipId = `brand-mark-disk-clip-${markId}`;
  return (
    <svg
      class={props.class}
      width={props.size}
      height={props.size}
      viewBox="0 0 1024 1024"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#58ebbf" />
          <stop offset="1" stop-color="#409b9b" />
        </linearGradient>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
          <rect width="1024" height="1024" fill="#fff" />
          <circle cx="524" cy="594" r="286" fill="#000" />
        </mask>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <path d="M524 128 128 860H920Z" />
        </clipPath>
      </defs>
      <rect width="1024" height="1024" rx="230" fill={`url(#${gradientId})`} />
      <path d="M524 128 128 860H920Z" fill="#041620" mask={`url(#${maskId})`} />
      <circle cx="576" cy="578" r="220" fill="#041620" clip-path={`url(#${clipId})`} />
    </svg>
  );
}
