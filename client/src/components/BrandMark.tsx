/**
 * The app's own mark: the calendar-and-check icon from design/app-icon, drawn inline so it needs no
 * request and takes the size of the space it sits in. It replaces the generic chip icon the
 * navigation and sign-in screens used to show, so the app matches its icon and its launch screens.
 * Decorative: the name beside it says what the app is.
 */
let markCount = 0;

export function BrandMark(props: { size: number; class?: string }) {
  // Each mark names its own gradient, so two marks on one page never share an id.
  const gradientId = `brand-mark-bg-${++markCount}`;
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
      </defs>
      <rect width="1024" height="1024" rx="230" fill={`url(#${gradientId})`} />
      <rect x="232" y="276" width="560" height="530" rx="64" fill="#041620" />
      <path d="M232 340 A64 64 0 0 1 296 276 H728 A64 64 0 0 1 792 340 V396 H232 Z" fill="#0a6358" />
      <rect x="330" y="216" width="36" height="120" rx="18" fill="#041620" />
      <rect x="658" y="216" width="36" height="120" rx="18" fill="#041620" />
      <path d="M372 610 L468 706 L652 512" fill="none" stroke="#58ebbf" stroke-width="58" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
