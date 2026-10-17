export type UiLevel = "info" | "warning" | "error";

/** The slice of pi's extension UI the setup flows need. */
export interface Ui {
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | null | undefined>;
	input(title: string, placeholder?: string): Promise<string | null | undefined>;
	notify(message: string, level?: UiLevel): void;
	/** Long-running step label, shown on the status line when the UI has one. */
	progress?(text: string): void;
}
