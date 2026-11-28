import { createUniqueId, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { ViewportOverlay } from '../components/ViewportOverlay.js';

type SharedClass = { class?: string; children?: JSX.Element };

/** Canonical page title, supporting copy and right-aligned actions for route views. */
export function PageHeader(props: { title: JSX.Element | string; sub?: JSX.Element | string; children?: JSX.Element }) {
  return (
    <header class="view-head">
      <div class="min-w-0">
        <h1 class="view-title">{props.title}</h1>
        <Show when={props.sub}><p class="view-sub">{props.sub}</p></Show>
      </div>
      <Show when={props.children}><div class="view-actions">{props.children}</div></Show>
    </header>
  );
}

/**
 * Shared bordered surface. Keep body layout in the feature via `class`; the
 * title/actions slot uses the ui-card header recipe below. At narrow widths its
 * action group wraps onto a full row so controls do not compress the heading.
 */
export function Card(props: SharedClass & {
  title?: JSX.Element | string;
  label?: string;
  description?: JSX.Element | string;
  actions?: JSX.Element;
  role?: 'status' | 'alert';
}) {
  const titleId = createUniqueId();
  return (
    <section
      class={`card ${props.class ?? ''}`}
      role={props.role}
      aria-labelledby={props.title ? titleId : undefined}
      aria-label={!props.title ? props.label : undefined}
    >
      <Show when={props.title || props.description || props.actions}>
        <header class="ui-card__header">
          <div class="ui-card__copy">
            <Show when={props.title}><h2 id={titleId} class="ui-card__title">{props.title}</h2></Show>
            <Show when={props.description}><div class="ui-card__description">{props.description}</div></Show>
          </div>
          <Show when={props.actions}><div class="ui-card__actions">{props.actions}</div></Show>
        </header>
      </Show>
      {props.children}
    </section>
  );
}

/**
 * Right-aligned form actions with a narrow-screen contract: at phone widths,
 * direct buttons share the row evenly so labels stay reachable without overflow.
 */
export function FormActions(props: SharedClass) {
  return <div class={`ui-form-actions ${props.class ?? ''}`}>{props.children}</div>;
}

/** A visually toolbar-like, labeled group of controls. Use role=tablist for actual tabs. */
export function Toolbar(props: SharedClass & { label: string; orientation?: 'horizontal' | 'vertical' }) {
  return (
    <div
      role="group"
      aria-label={props.label}
      class={props.class ?? `flex flex-wrap items-center gap-2 ${props.orientation === 'vertical' ? 'flex-col items-stretch' : ''}`}
    >
      {props.children}
    </div>
  );
}

/** Empty result or first-use state with a consistent message and optional next action. */
export function EmptyState(props: SharedClass & {
  title: string;
  description?: JSX.Element | string;
  action?: JSX.Element;
  icon?: JSX.Element;
  headingLevel?: 2 | 3 | 4;
}) {
  const headingClass = 'text-sm font-semibold text-foreground';
  return (
    <section class={`card flex flex-col items-center justify-center gap-2 p-5 text-center ${props.class ?? ''}`} aria-label={props.title}>
      <Show when={props.icon}><div class="text-muted-foreground" aria-hidden="true">{props.icon}</div></Show>
      <Show when={props.headingLevel === 2} fallback={
        <Show when={props.headingLevel === 4} fallback={<h3 class={headingClass}>{props.title}</h3>}>
          <h4 class={headingClass}>{props.title}</h4>
        </Show>
      }>
        <h2 class={headingClass}>{props.title}</h2>
      </Show>
      <Show when={props.description}><p class="max-w-prose text-xs text-muted-foreground">{props.description}</p></Show>
      <Show when={props.action}><div class="mt-1">{props.action}</div></Show>
    </section>
  );
}

export interface FormFieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  required?: true;
}

/** Label, control, hint and error wired together with stable accessible IDs. */
export function FormField(props: {
  id?: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  class?: string;
  children: (control: FormFieldControlProps) => JSX.Element;
}) {
  const generatedId = createUniqueId();
  const id = () => props.id ?? `field-${generatedId}`;
  const hintId = () => `${id()}-hint`;
  const errorId = () => `${id()}-error`;
  const describedBy = () => [props.hint ? hintId() : null, props.error ? errorId() : null].filter(Boolean).join(' ') || undefined;
  const control = (): FormFieldControlProps => ({
    id: id(),
    'aria-describedby': describedBy(),
    'aria-invalid': props.error ? true : undefined,
    required: props.required ? true : undefined,
  });
  return (
    <div class={`flex min-w-0 flex-col gap-1 ${props.class ?? ''}`}>
      <label for={id()} class="text-xs font-medium text-foreground">
        {props.label}<Show when={props.required}><span aria-hidden="true"> *</span></Show>
      </label>
      {props.children(control())}
      <Show when={props.hint}><p id={hintId()} class="text-[11px] text-muted-foreground">{props.hint}</p></Show>
      <Show when={props.error}><p id={errorId()} class="text-[11px] text-destructive" role="alert">{props.error}</p></Show>
    </div>
  );
}

/** Native disclosure-based action menu: keyboard activation and expanded state come from the browser. */
export function ActionMenu(props: {
  label: string;
  trigger: JSX.Element;
  children: JSX.Element;
  class?: string;
}) {
  let menu: HTMLDetailsElement | undefined;
  return (
    <details ref={menu} class={`relative ${props.class ?? ''}`}>
      <summary class="btn-secondary list-none cursor-pointer [&::-webkit-details-marker]:hidden" aria-label={props.label}>
        {props.trigger}
      </summary>
      <div
        class="absolute right-0 z-20 mt-1 min-w-44 max-w-[min(20rem,calc(100vw-2rem))] rounded-md border border-border bg-card p-1 shadow-xl"
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('button, a, [role="menuitem"]')) menu!.open = false;
        }}
      >
        {props.children}
      </div>
    </details>
  );
}

export interface DataListColumn { label: string }
export interface DataListRow { key: string; cells: readonly JSX.Element[] }

/** Small semantic table with a contained horizontal scroller for narrow screens. */
export function DataList(props: {
  caption: string;
  columns: readonly DataListColumn[];
  rows: readonly DataListRow[];
  class?: string;
}) {
  return (
    <div class={`overflow-x-auto rounded ${props.class ?? ''}`} role="region" tabindex="0" aria-label={`${props.caption}, scrolls sideways`}>
      <table class="w-full text-left text-xs tabular-nums">
        <caption class="sr-only">{props.caption}</caption>
        <thead class="text-muted-foreground">
          <tr><For each={props.columns}>{(column) => <th scope="col" class="py-1 pr-3 align-bottom font-medium">{column.label}</th>}</For></tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => <tr class="border-t border-border"><For each={row.cells}>{(cell, index) => index() === 0
              ? <th scope="row" class="py-1 pr-3 font-normal whitespace-nowrap">{cell}</th>
              : <td class="py-1 pr-3 whitespace-nowrap">{cell}</td>}</For></tr>}
          </For>
        </tbody>
      </table>
    </div>
  );
}

export interface ModalSheetProps {
  open: boolean;
  title: string;
  ariaLabel?: string;
  onClose: () => void;
  children?: JSX.Element;
  header?: JSX.Element;
  footer?: JSX.Element;
  mode?: 'modal' | 'sheet';
  class?: string;
  /** Classes for the scrollable content region when a feature needs its own internal scrolling layout. */
  contentClass?: string;
  /** Extra backdrop classes for a feature's existing placement recipe (for example, a centered mobile dialog). */
  backdropClass?: string;
  style?: JSX.CSSProperties;
  closeLabel?: string;
  /** Return true to consume Escape for a nested popover before closing this dialog. */
  onEscape?: () => boolean;
  /** Optional access to the dialog node for feature-specific viewport behavior. */
  dialogRef?: (element: HTMLDivElement) => void;
  /** Disable automatic restoration when a layered parent surface owns focus return. */
  restoreFocus?: boolean;
}

/**
 * Use for every dialog or sheet. Owns dialog semantics, initial focus, focus
 * cycling, Escape and backdrop dismissal, plus focus return by default.
 * `ViewportOverlay` is only its low-level placement layer for passive or
 * non-modal surfaces.
 */
export function ModalSheet(props: ModalSheetProps) {
  const titleId = createUniqueId();
  function DialogContent() {
    let dialog: HTMLDivElement | undefined;
    let previousFocus: HTMLElement | null = null;
    onMount(() => {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      queueMicrotask(() => {
        if (!dialog) return;
        const first = dialog.querySelector<HTMLElement>('[autofocus]')
          ?? dialog.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
        (first ?? dialog).focus();
      });
    });
    onCleanup(() => props.restoreFocus !== false && previousFocus?.isConnected && previousFocus.focus());

    function keyDown(event: KeyboardEvent & { currentTarget: HTMLDivElement }) {
      if (event.key === 'Escape') {
        event.preventDefault();
        // A sheet can sit above a larger application modal (for example, Texture
        // settings above the ElementWizard). Keep Escape scoped to the topmost
        // surface so global or parent dismissal handlers cannot close both.
        event.stopPropagation();
        if (props.onEscape?.()) return;
        props.onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      const outside = !dialog.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || outside)) { event.preventDefault(); first.focus(); }
    }

    return (
      <ViewportOverlay
        class={`fixed inset-0 z-[1000] flex justify-center bg-black/60 p-3 ${props.mode === 'sheet' ? 'items-end sm:items-center' : 'items-center'} ${props.backdropClass ?? ''}`}
        onClick={(event) => { if (event.target === event.currentTarget) props.onClose(); }}
      >
        <div
          ref={(element) => { dialog = element; props.dialogRef?.(element); }}
          style={props.style}
          role="dialog"
          aria-modal="true"
          aria-labelledby={props.header ? undefined : titleId}
          aria-label={props.header ? (props.ariaLabel ?? props.title) : undefined}
          tabindex="-1"
          onKeyDown={keyDown}
          class={`card flex max-h-full min-h-0 w-full flex-col overflow-hidden ${props.mode === 'sheet' ? 'max-w-2xl rounded-b-none sm:rounded-b-sm' : 'max-w-xl'} ${props.class ?? ''}`}
        >
          <Show when={props.header} fallback={
            <header class="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border pb-3">
              <h2 id={titleId} class="min-w-0 text-sm font-bold text-foreground">{props.title}</h2>
              <button type="button" class="btn-icon" aria-label={props.closeLabel ?? 'Close dialog'} onClick={props.onClose}>×</button>
            </header>
          }>
            {props.header}
          </Show>
          <div
            role="region"
            aria-label={`${props.ariaLabel ?? props.title} content`}
            tabindex="0"
            class={`min-h-0 flex-1 overflow-y-auto py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${props.contentClass ?? ''}`}
          >{props.children}</div>
          <Show when={props.footer}>
            <footer class="flex-shrink-0 border-t border-border pt-3">{props.footer}</footer>
          </Show>
        </div>
      </ViewportOverlay>
    );
  }

  return (
    <Show when={props.open}>
      <DialogContent />
    </Show>
  );
}

export function Modal(props: Omit<ModalSheetProps, 'mode'>) {
  return <ModalSheet {...props} mode="modal" />;
}

export function Sheet(props: Omit<ModalSheetProps, 'mode'>) {
  return <ModalSheet {...props} mode="sheet" />;
}
