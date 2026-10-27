// ---------------------------------------------------------------------------
// Enquirer type declarations.
//
// The published `enquirer` type definitions only describe the `Enquirer`
// class and the `prompt()` helper — the concrete prompt classes
// (`Select`, `Input`, `Confirm`, `AutoComplete`, `MultiSelect`, ...) are
// attached to the module export at runtime but are missing from the
// shipped `.d.ts`.
//
// This file declares the module surface the codebase actually uses so
// `new Enquirer.Select({...})` type-checks. It is declaration-only: it
// emits no runtime code.
// ---------------------------------------------------------------------------

declare module 'enquirer' {
    /** Options accepted by every prompt class. */
    interface PromptOptions {
        name?: string;
        type?: string;
        message?: string | (() => string) | (() => Promise<string>);
        prefix?: string;
        initial?: any;
        required?: boolean;
        enabled?: boolean | string;
        disabled?: boolean | string;
        format?(value: string): string | Promise<string>;
        result?(value: string): string | Promise<string>;
        skip?: ((state: object) => boolean | Promise<boolean>) | boolean;
        validate?(value: string): boolean | string | Promise<boolean | string>;
        stdin?: NodeJS.ReadStream;
        stdout?: NodeJS.WriteStream;
        [key: string]: unknown;
    }

    /** A single selectable choice. */
    interface Choice {
        name: string;
        message?: string;
        value?: unknown;
        hint?: string;
        role?: string;
        enabled?: boolean;
        disabled?: boolean | string;
    }

    /** Base class shared by every prompt. */
    class Prompt {
        constructor(options?: PromptOptions);
        run(): Promise<any>;
        render(): void;
    }

    /** Single-choice list prompt. */
    class Select extends Prompt {}
    /** Free-text input prompt. */
    class Input extends Prompt {}
    /** Yes/no confirmation prompt. */
    class Confirm extends Prompt {}
    /** Fuzzy-matching autocomplete prompt. */
    class AutoComplete extends Prompt {}
    /** Multiple-choice list prompt. */
    class MultiSelect extends Prompt {}
    /** Numeric input prompt. */
    class Numeral extends Prompt {}
    /** Password input prompt. */
    class Password extends Prompt {}
    /** Invisible (no-echo) input prompt. */
    class Invisible extends Prompt {}
    /** Editable multi-line text prompt. */
    class Editable extends Prompt {}
    /** Toggle prompt. */
    class Toggle extends Prompt {}
    /** Scale (1..n) prompt. */
    class Scale extends Prompt {}
    /** Sortable list prompt. */
    class Sort extends Prompt {}
    /** Form prompt (multiple questions). */
    class Form extends Prompt {}
    /** Survey prompt. */
    class Survey extends Prompt {}
    /** Quiz prompt. */
    class Quiz extends Prompt {}
    /** List prompt. */
    class List extends Prompt {}
    /** Text prompt. */
    class Text extends Prompt {}
    /** Snippet prompt. */
    class Snippet extends Prompt {}
    /** Basic-auth prompt. */
    class BasicAuth extends Prompt {}

    /** The Enquirer entry point: a class with the `prompt()` helper. */
    const Enquirer: {
        new (options?: object, answers?: object): {
            prompt<T = object>(questions: unknown): Promise<T>;
            register(type: string, fn: unknown): unknown;
            use(plugin: (enquirer: unknown) => void): unknown;
        };
        prompt<T = object>(questions: unknown): Promise<T>;
        Prompt: typeof Prompt;
        Select: typeof Select;
        Input: typeof Input;
        Confirm: typeof Confirm;
        AutoComplete: typeof AutoComplete;
        MultiSelect: typeof MultiSelect;
        Numeral: typeof Numeral;
        Password: typeof Password;
        Invisible: typeof Invisible;
        Editable: typeof Editable;
        Toggle: typeof Toggle;
        Scale: typeof Scale;
        Sort: typeof Sort;
        Form: typeof Form;
        Survey: typeof Survey;
        Quiz: typeof Quiz;
        List: typeof List;
        Text: typeof Text;
        Snippet: typeof Snippet;
        BasicAuth: typeof BasicAuth;
    };

    export = Enquirer;
}
