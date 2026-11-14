import type { Calibration, WeekReview } from '../lib/api.js';
import { CalendarReview } from './CalendarReview.js';

/** Backward-compatible weekly wrapper used by the Plan my week assistant. */
export function WeeklyReview(props: { data: WeekReview | undefined; calibration?: Calibration | undefined }) {
  return <CalendarReview data={props.data} period="week" calibration={props.calibration} />;
}
