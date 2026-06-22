import { Circle, Square, Triangle, Diamond, Smile, Cog, Hourglass } from 'lucide-solid';

export function ShapeIcon(props: { shape: string | null | undefined; size?: number; class?: string; strokeWidth?: number }) {
  const size = () => props.size ?? 14;
  const sw = () => props.strokeWidth ?? 1.5;
  const shape = () => (props.shape ?? '').toLowerCase();
  return (
    <>
      {shape() === 'circle' ? <Circle size={size()} strokeWidth={sw()} class={props.class} />
       : shape() === 'triangle' ? <Triangle size={size()} strokeWidth={sw()} class={props.class} />
       : shape() === 'diamond' ? <Diamond size={size()} strokeWidth={sw()} class={props.class} />
       : shape() === 'spiral' ? (
           <svg width={size()} height={size()} viewBox="0 0 24 24" fill="none"
             style={{ stroke: 'currentColor', 'stroke-width': String(sw()), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }}
             class={props.class}>
             <path d="M12 3 C19 3 21 8 21 12 C21 17 18 21 12 21 C7 21 4 18 4 12 C4 9 5 7 7 6 C9 5 11 5 12 6 C13 7 13 9 12 9 C11 9 11 10 12 12" />
           </svg>
         )
       : shape() === 'smile' ? <Smile size={size()} strokeWidth={sw()} class={props.class} />
       : shape() === 'gear' ? <Cog size={size()} strokeWidth={sw()} class={props.class} />
       : shape() === 'hourglass' ? <Hourglass size={size()} strokeWidth={sw()} class={props.class} />
       : <Square size={size()} strokeWidth={sw()} class={props.class} />}
    </>
  );
}
