/**
 * Modal navigation state machine, free of React so it can be tested with a fake
 * controller.
 *
 * The grid owns selection and paging; the modal only receives callbacks. This
 * class decides what a Next / Previous request means:
 *
 *  - a loaded neighbour is selected immediately;
 *  - Next on the loaded tail with more pages registers ONE pending intent and
 *    asks the controller for the next page (a request already in flight is
 *    joined, not duplicated: the controller is single-flight);
 *  - Next on the exhausted tail wraps to the first item;
 *  - Previous on the first item wraps to the TRUE last item, which needs every
 *    remaining page, so the intent keeps asking for the next page, one request
 *    at a time, until the controller reports exhaustion.
 *
 * Intent lifecycle: none -> pending (navigate) -> resolved (select + clear) or
 * cancelled (close, other selection, controller replaced, generation changed).
 * A failed page leaves the intent pending in an 'error' phase with auto-paging
 * stopped; retry() resumes it through controller.retry().
 *
 * Callers must feed it two signals from the controller: observe() on every
 * state change (resolves intents) and settled() once a request has fully
 * finished (continues multi-page paging). Continuation must NOT happen from
 * observe(): onChange fires while the controller still marks the request in
 * flight, so a loadMore() there would be silently dropped.
 */

export type NavDirection = 'next' | 'previous-wrap';
export type NavStep = 'next' | 'previous';
export type NavResult = 'moved' | 'pending' | 'ignored' | 'none';

export interface NavSnapshot<T extends { id: string }> {
    items: T[];
    hasMore: boolean;
    loading: boolean;
    error: { message: string } | null;
    generation: number;
}

export interface NavController<T extends { id: string }> {
    readonly state: NavSnapshot<T>;
    loadMore(): void;
    retry(): void;
}

export interface NavIntent {
    direction: NavDirection;
    anchorId: string;
    /** The controller instance itself; generations can repeat across instances. */
    controllerIdentity: object;
    generation: number;
}

export interface NavStatus {
    direction: NavDirection;
    phase: 'loading' | 'error';
    message: string | null;
}

export interface ModalNavigationCallbacks {
    select: (id: string) => void;
    onStatus: (status: NavStatus | null) => void;
}

export class ModalNavigation<T extends { id: string }> {
    private _intent: NavIntent | null = null;
    private lastStatusKey = 'none';

    constructor(private readonly cb: ModalNavigationCallbacks) { }

    get intent(): NavIntent | null { return this._intent; }

    navigate(step: NavStep, selectedId: string | null, controller: NavController<T> | null): NavResult {
        if (this._intent) return 'ignored';
        if (!controller || selectedId === null) return 'none';

        const { items, hasMore } = controller.state;
        const idx = items.findIndex(i => i.id === selectedId);
        if (idx === -1) return 'none';

        if (step === 'next') {
            if (idx < items.length - 1) return this.move(items[idx + 1].id);
            if (!hasMore) return items.length > 1 ? this.move(items[0].id) : 'none';
            return this.register('next', items[idx].id, controller);
        }

        if (idx > 0) return this.move(items[idx - 1].id);
        if (!hasMore) return items.length > 1 ? this.move(items[items.length - 1].id) : 'none';
        return this.register('previous-wrap', items[idx].id, controller);
    }

    /** Feed every controller state change and every selection change. */
    observe(selectedId: string | null, controller: NavController<T> | null): void {
        this.check(selectedId, controller);
    }

    /** Feed once a controller request has settled and the slot is free. */
    settled(selectedId: string | null, controller: NavController<T> | null): void {
        if (!this.check(selectedId, controller) || !controller) return;
        const s = controller.state;
        if (!s.error && s.hasMore) controller.loadMore();
        this.emit(controller);
    }

    /** Retry a failed page; the intent is kept. */
    retry(controller: NavController<T> | null): boolean {
        const intent = this._intent;
        if (!intent || !controller || controller !== intent.controllerIdentity || !controller.state.error) return false;
        controller.retry();
        this.emit(controller);
        return true;
    }

    cancel(): void {
        this._intent = null;
        this.emit(null);
    }

    private move(id: string): NavResult {
        this.cb.select(id);
        return 'moved';
    }

    private register(direction: NavDirection, anchorId: string, controller: NavController<T>): NavResult {
        this._intent = { direction, anchorId, controllerIdentity: controller, generation: controller.state.generation };
        controller.loadMore();
        this.emit(controller);
        return 'pending';
    }

    /** Resolve or cancel the intent against a snapshot; true while it stays pending. */
    private check(selectedId: string | null, controller: NavController<T> | null): boolean {
        const intent = this._intent;
        if (!intent) return false;
        if (!controller || controller !== intent.controllerIdentity
            || controller.state.generation !== intent.generation
            || selectedId !== intent.anchorId) {
            this.cancel();
            return false;
        }

        const { items, hasMore, loading } = controller.state;
        const idx = items.findIndex(i => i.id === intent.anchorId);
        if (idx === -1) {
            this.cancel();
            return false;
        }

        let targetId: string | null = null;
        let resolved = false;
        if (intent.direction === 'next') {
            if (idx < items.length - 1) {
                targetId = items[idx + 1].id;
                resolved = true;
            } else if (!hasMore && !loading) {
                targetId = items[0].id;
                resolved = true;
            }
        } else if (!hasMore && !loading) {
            targetId = items[items.length - 1].id;
            resolved = true;
        }

        if (!resolved) {
            this.emit(controller);
            return true;
        }
        this._intent = null;
        this.emit(null);
        if (targetId !== null && targetId !== intent.anchorId) this.cb.select(targetId);
        return false;
    }

    private emit(controller: NavController<T> | null): void {
        const intent = this._intent;
        let status: NavStatus | null = null;
        if (intent && controller) {
            const err = controller.state.error;
            status = { direction: intent.direction, phase: err ? 'error' : 'loading', message: err ? err.message : null };
        }
        const key = status ? `${status.direction}|${status.phase}|${status.message ?? ''}` : 'none';
        if (key === this.lastStatusKey) return;
        this.lastStatusKey = key;
        this.cb.onStatus(status);
    }
}
