import { createEffect, createResource, createSignal, For, Show } from 'solid-js';
import {
  Activity, Baby, BookOpen, Briefcase, CalendarDays, Car, Church, ClipboardList,
  Coffee, CookingPot, Dumbbell, GraduationCap, HandHeart, Heart, House, Laptop,
  Leaf, Mail, Music, PawPrint, Phone, Plane, Shield, ShoppingBag, Star, Sun,
  Target, TreePine, Utensils, Users, Wrench, Brain, Bed,
} from 'lucide-solid';
import type { Component } from 'solid-js';
import { api, type PatternRange, type Tag } from '../../lib/api.js';
import { PATTERN_COLORS, colorVar } from '../../lib/pattern-meta.js';
import { refetchPatternBlocks, refetchPatternPrefs, refetchTags, showToast } from '../../stores/index.js';

const ICONS: [string, Component<{ size?: number; strokeWidth?: number } >][] = [
  ['House', House], ['Briefcase', Briefcase], ['Users', Users], ['Heart', Heart], ['Star', Star], ['Sun', Sun],
  ['CalendarDays', CalendarDays], ['BookOpen', BookOpen], ['Target', Target], ['Dumbbell', Dumbbell], ['Utensils', Utensils], ['Coffee', Coffee],
  ['Phone', Phone], ['Mail', Mail], ['Laptop', Laptop], ['Music', Music], ['Leaf', Leaf], ['PawPrint', PawPrint],
  ['Car', Car], ['Plane', Plane], ['ShoppingBag', ShoppingBag], ['CookingPot', CookingPot], ['Wrench', Wrench], ['Baby', Baby],
  ['GraduationCap', GraduationCap], ['Shield', Shield], ['Church', Church], ['TreePine', TreePine], ['Bed', Bed], ['Brain', Brain],
  ['HandHeart', HandHeart], ['Activity', Activity], ['ClipboardList', ClipboardList],
];

export function PatternTagsSetup(props: { onBack: () => void; onNext: () => void; busy: boolean }) {
  const [tagRows] = createResource(() => api.tags.list().then((r) => r.tags.filter((t) => t.kind === 'direction')));
  const [prefs] = createResource(() => api.patternPrefs.list().then((r) => r.prefs));
  const [drafts, setDrafts] = createSignal<Record<string, { name: string; icon: string; color: string }>>({});
  const [open, setOpen] = createSignal<string | null>(null);
  createEffect(() => {
    const ts = tagRows(), ps = prefs();
    if (!ts || !ps) return;
    setDrafts(Object.fromEntries(ts.map((t) => [t.id, { name: t.name, icon: ps[t.id]?.icon_shape || 'House', color: ps[t.id]?.color_token || 'tag-1' }])));
  });
  async function save() {
    const ts = tagRows() ?? [];
    await Promise.all(ts.map(async (t: Tag) => {
      const d = drafts()[t.id]; if (!d) return;
      if (d.name.trim() && d.name.trim() !== t.name) await api.tags.update(t.id, { name: d.name.trim() });
      await api.patternPrefs.set(t.id, { icon_shape: d.icon, color_token: d.color });
    }));
    await Promise.all([refetchTags(), refetchPatternPrefs()]);
  }
  return <div class="flex flex-col gap-3">
    <div><h2 class="text-base font-semibold text-foreground">Pattern Tags</h2><p class="text-xs text-muted-foreground mt-0.5">Set the names and visual cues for Home, Work, and Community.</p></div>
    <div class="flex flex-col gap-2 max-h-[52vh] overflow-y-auto">
      <For each={tagRows()}>{(tag) => {
        const d = () => drafts()[tag.id] ?? { name: tag.name, icon: 'House', color: 'tag-1' };
        return <div class="rounded border border-border p-2.5 flex flex-col gap-2">
          <div class="flex items-center gap-2">
            <span style={{ color: colorVar(d().color) }}><IconFor name={d().icon} size={16}/></span>
            <input class="input py-1 text-sm flex-1 min-w-0" aria-label={`${tag.name} tag name`} value={d().name} onInput={(e) => setDrafts((v) => ({ ...v, [tag.id]: { ...d(), name: e.currentTarget.value } }))}/>
            <button class="btn-secondary text-xs" type="button" onClick={() => setOpen(open() === tag.id ? null : tag.id)}>Icon ▾</button>
          </div>
          <Show when={open() === tag.id}>
            <div class="grid grid-cols-3 gap-1 max-h-28 overflow-y-auto p-1 border border-border rounded">
              <For each={ICONS}>{([name, Icon]) => <button type="button" title={name} aria-label={name} class="h-8 border border-border rounded flex items-center justify-center hover:border-primary" classList={{ 'text-primary border-primary': d().icon === name }} onClick={() => { setDrafts((v) => ({ ...v, [tag.id]: { ...d(), icon: name } })); setOpen(null); }}><Icon size={15}/></button>}</For>
            </div>
          </Show>
          <div class="flex flex-wrap gap-1.5" aria-label={`${tag.name} color`}><For each={PATTERN_COLORS}>{(c) => <button type="button" title={c.label} aria-label={c.label} class="w-5 h-5 rounded-full border-2" classList={{ 'border-foreground scale-110': d().color === c.token, 'border-transparent': d().color !== c.token }} style={{ 'background-color': colorVar(c.token) }} onClick={() => setDrafts((v) => ({ ...v, [tag.id]: { ...d(), color: c.token } }))}/>}</For></div>
        </div>;
      }}</For>
    </div>
    <div class="flex justify-between"><button class="btn-ghost text-xs" onClick={props.onBack}>Back</button><button class="btn-primary text-xs" disabled={props.busy || !tagRows() || !prefs()} onClick={() => void save().then(props.onNext).catch((e) => showToast((e as Error).message, 'error'))}>Save and continue</button></div>
  </div>;
}

export function DayTypeSetup(props: { dayType: string; onBack: () => void; onNext: () => void; onSkip?: () => void; onAddType?: () => void; busy: boolean }) {
  const [dirs] = createResource(() => api.tags.list().then((r) => r.tags.filter((t) => t.kind === 'direction')));
  const [base] = createResource(() => api.patternBlocks.forDay(props.dayType).then((r) => r.windows));
  const [rows, setRows] = createSignal<Record<string, { start_time: string; end_time: string }[]>>({});
  createEffect(() => { const w = base(); if (w) setRows(Object.fromEntries(Object.entries(w).map(([k, ranges]) => [k, ranges.map((r) => ({ start_time: r.start_time, end_time: r.end_time }))]))); });
  const get = (id: string) => rows()[id] ?? [];
  function update(id: string, idx: number, key: 'start_time' | 'end_time', value: string) { setRows((old) => ({ ...old, [id]: get(id).map((r, i) => i === idx ? { ...r, [key]: value } : r) })); }
  function add(id: string) { setRows((old) => ({ ...old, [id]: [...get(id), { start_time: '09:00', end_time: '17:00' }] })); }
  async function save() {
    for (const dir of dirs() ?? []) await api.patternBlocks.set(dir.id, props.dayType, get(dir.id));
    refetchPatternBlocks();
  }
  const title = () => props.dayType === 'workday' ? 'Set up your first Workday' : props.dayType === 'weekend' ? 'Set up Weekend' : `Set up ${props.dayType.replaceAll('-', ' ')}`;
  return <div class="flex flex-col gap-3">
    <div><h2 class="text-base font-semibold text-foreground">{title()}</h2><p class="text-xs text-muted-foreground mt-0.5">{props.dayType === 'weekend' ? 'Setting up Weekend now helps the planner use different availability on your days off. Choose when Home, Work, and Community are usually available.' : 'Choose when Home, Work, and Community are usually available. These defaults guide open time and auto-scheduling.'}</p></div>
    <div class="flex flex-col gap-3 max-h-[54vh] overflow-y-auto">
      <For each={dirs()}>{(dir) => <section class="rounded border border-border p-2.5 flex flex-col gap-2"><h3 class="text-sm font-medium capitalize">{dir.name}</h3>
        <For each={get(dir.id)}>{(range, index) => <div class="flex items-center gap-2"><input class="input py-1 text-sm flex-1 min-w-0" type="time" value={range.start_time} onInput={(e) => update(dir.id, index(), 'start_time', e.currentTarget.value)}/><span class="text-muted-foreground">–</span><input class="input py-1 text-sm flex-1 min-w-0" type="time" value={range.end_time} onInput={(e) => update(dir.id, index(), 'end_time', e.currentTarget.value)}/><button class="btn-ghost text-xs" aria-label="Remove window" onClick={() => setRows((old) => ({ ...old, [dir.id]: get(dir.id).filter((_, i) => i !== index()) }))}>×</button></div>}</For>
        <button class="text-xs text-primary self-start" onClick={() => add(dir.id)}>+ Add window</button>
      </section>}</For>
    </div>
    <div class="flex flex-wrap justify-between gap-2"><div class="flex gap-2"><button class="btn-ghost text-xs" onClick={props.onBack}>Back</button><Show when={props.onSkip}><button class="btn-ghost text-xs" onClick={props.onSkip}>Skip Weekend</button></Show></div><div class="flex gap-2"><Show when={props.dayType === 'workday'}><button class="btn-secondary text-xs" onClick={props.onAddType}>Add another day type</button></Show><button class="btn-primary text-xs" disabled={props.busy || !base() || !dirs()} onClick={() => void save().then(props.onNext).catch((e) => showToast((e as Error).message, 'error'))}>Save and continue</button></div></div>
  </div>;
}

export function WeekdayTypesStep(props: { onBack: () => void; onNext: () => void; busy: boolean }) {
  const [map] = createResource(() => api.dayTypes.weekMap().then((r) => r.map));
  const [types] = createResource(() => api.dayTypes.list().then((r) => r.day_types));
  const [days, setDays] = createSignal<Record<number, string>>({});
  createEffect(() => { if (map()) setDays({ ...map()! }); });
  const labels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  async function save() { await api.dayTypes.setWeekMap(days()); refetchPatternBlocks(); props.onNext(); }
  return <div class="flex flex-col gap-3"><div><h2 class="text-base font-semibold text-foreground">Choose your default days</h2><p class="text-xs text-muted-foreground mt-0.5">Pick which days use Workday and Weekend availability. You can change this any time.</p></div>
    <div class="flex flex-col gap-1.5">{labels.map((label, dow) => <label class="flex items-center justify-between gap-3 border border-border rounded px-2.5 py-2 text-sm">{label}<select class="input py-1 text-sm w-36" value={days()[dow] ?? (dow === 0 || dow === 6 ? 'weekend' : 'workday')} onChange={(e) => setDays((d) => ({ ...d, [dow]: e.currentTarget.value }))}><For each={types()}>{(type) => <option value={type.key}>{type.name}</option>}</For></select></label>)}</div>
    <div class="flex justify-between"><button class="btn-ghost text-xs" onClick={props.onBack}>Back</button><button class="btn-primary text-xs" disabled={props.busy || !map() || !types()} onClick={() => void save().catch((e) => showToast((e as Error).message, 'error'))}>Save and continue</button></div>
  </div>;
}

function IconFor(props: { name: string; size: number }) {
  const item = ICONS.find(([name]) => name === props.name);
  const Icon = item?.[1] ?? House;
  return <Icon size={props.size} strokeWidth={1.8}/>;
}
