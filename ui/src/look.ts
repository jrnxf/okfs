// Class lists that more than one component draws with.

/** A list's padding: its left edge lines up with the bars over it. */
export const LIST_PAD = "pr-(--pad) pl-[calc(var(--pad)*1.25)]";

/** A folder's rows and the heads over them: icon, name, size and age. A phone has no room for the age. */
export const ROW_GRID = `grid items-center gap-2.5 ${LIST_PAD} grid-cols-[16px_minmax(0,1fr)_68px_66px] icons-none:grid-cols-[minmax(0,1fr)_68px_66px] phone:grid-cols-[16px_minmax(0,1fr)_62px] phone:icons-none:grid-cols-[minmax(0,1fr)_62px]`;

/** The matches' rows and heads: a folder's, with the folder each match is in after its name. */
export const MATCH_GRID = `grid items-center gap-2.5 ${LIST_PAD} grid-cols-[16px_minmax(0,1.15fr)_minmax(0,1fr)_68px_66px] icons-none:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_68px_66px] phone:grid-cols-[16px_minmax(0,1fr)_62px] phone:icons-none:grid-cols-[minmax(0,1fr)_62px]`;

/** The bar of heads over a list. Its first child is over the icons, its last over the ages. */
export const HEADS = "label h-[calc(30px*var(--density))] flex-none border-b border-b-line text-muted *:first:icons-none:hidden *:last:phone:hidden";

/** A head that sorts by its column, or only names it. */
export const HEAD = "inline-flex items-center gap-0.75 text-left";

/** A row of a list. Where it is and how tall is up to the list. */
export const ROW = "row cursor-default touch-manipulation hover:bg-hover";

/** A row of a list that draws only the rows in view, each where it is: see vlist.tsx. The cursor's highlight hides
 * while a copy of it travels with a slide. */
export const LIST_ROW = "absolute gliding:aria-selected:bg-transparent gliding:aria-selected:shadow-none";

/** A row's look while it is not the cursor's: a hairline's room, drawn in nothing. */
export const ROW_REST = "shadow-[inset_0_calc(var(--line-w)*-1)_0_transparent]";

/** The cursor's row. */
export const ROW_ON = "aria-selected:bg-accent-soft aria-selected:shadow-[inset_3px_0_0_var(--accent)]";

/** A row's size and age. */
export const SIZE = "num text-right text-s text-muted";
export const AGE = "num whitespace-nowrap text-right text-s text-muted phone:hidden";

/** A name in a row: the weight tells a folder from a file. */
export const nameWeight = (dir: boolean): string => (dir ? "font-medium" : "font-regular");

/** The bar over a pane: the folder or the file it shows, and what can be done with it. */
export const BAR =
  "box-content flex h-[calc(30px*var(--density))] min-w-0 flex-none items-center gap-2.5 border-b border-b-line pr-[calc(var(--pad)*0.5)] pl-[calc(var(--pad)*1.25)] phone:relative phone:h-[calc(46px*var(--density))]";

/** The name in a pane's bar, and what is known of it, which gives up its room first. */
export const BAR_NAME = "min-w-0 flex-[0_1_auto] truncate font-strong phone:flex-1";
export const BAR_FACTS = "num min-w-0 flex-1 truncate text-xs text-muted phone:hidden";

/** A button in a pane's bar. */
export const BAR_BTN = "h-[calc(24px*var(--density))] px-1.5 phone:h-[34px] phone:px-2.25";

/** A row of a menu: the theme menu's, and a phone's menu of a file's actions. */
export const MENU_ROW = "flex h-(--row-h) w-full items-center gap-2.5 rounded px-2 text-left hover:bg-hover aria-pressed:bg-accent-soft";

/** A menu or a dialog over the page: it grows in from where it opens. */
export const POP_IN = "transition-[opacity,transform] duration-150 ease-out starting:opacity-0 starting:[transform:scale(0.96)] motion-reduce:starting:[transform:none]";

/** The backdrop behind a dialog, which holds it near the top of the window. */
export const SCRIM = "fixed inset-0 z-50 grid [align-items:start] justify-items-center bg-scrim px-4 pt-[min(14vh,120px)] pb-4";

/** What a list says when it has nothing to show, over the middle of it. */
export const EMPTY = "absolute inset-0 grid place-content-center justify-items-center gap-1.5 p-6 text-center text-muted";
export const EMPTY_HEAD = "font-strong text-muted";
export const EMPTY_HINT = "text-s text-faint";

/** A folder row that a drag of files is over: what is let go there is uploaded into that folder. */
export const DROP_ROW = "bg-accent-soft rounded outline-[1.5px] outline-dashed outline-accent -outline-offset-3";

/** A list or a column that a drag of files is over, away from its folder rows. */
export const DROP_PANE = "rounded-lg outline-[1.5px] outline-dashed outline-accent -outline-offset-4";

/** The list of keys and the dialogs that ask: a card over the page. */
export const DIALOG = "w-[min(420px,100%)] rounded-lg bg-surface shadow";
export const DIALOG_HEAD = "[font:var(--weight-strong)_var(--text)_var(--font-ui)]";

/** A dialog that asks for a decision, and the backdrop it comes up over, fading in: they are rare. */
export const ASK_IN = `${SCRIM} transition-opacity duration-150 ease-[ease] starting:opacity-0`;
export const ASK = `${DIALOG} grid gap-3 px-5 py-4.5 transition-[opacity,transform] duration-180 ease-out starting:opacity-0 starting:[transform:scale(0.96)] motion-reduce:starting:[transform:none]`;

/** A dialog's buttons, at its foot. */
export const ASK_DO = "mt-1 flex justify-end gap-2";
export const ASK_BTN = "h-[calc(30px*var(--density))] min-w-0 px-[calc(12px*var(--density))] phone:h-[38px] phone:flex-1 phone:justify-center";
