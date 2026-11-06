import type { Dispatch, StateUpdater } from 'preact/hooks';

/** A `useState` setter handed down from App, which owns all shell state. */
export type Setter<T> = Dispatch<StateUpdater<T>>;
