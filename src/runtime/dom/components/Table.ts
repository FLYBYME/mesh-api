import './table.css';
import type { DOMChild, DynamicChild, Props } from '../types.js';
import type { Signal, Resource } from '../../reactivity/types.js';
import { signal } from '../../reactivity/signal.js';
import { computed } from '../../reactivity/computed.js';
import { h } from '../h.js';
import { For } from '../control.js';

export type TableColumn<T> = {
    [K in keyof T & string]: {
        readonly key: K;
        readonly label?: string | (() => string);
        readonly render?: (value: T[K], row: T, index: () => number) => DOMChild;
        readonly sortable?: boolean;
        readonly sortFn?: (a: T, b: T) => number;
        readonly class?: string | (() => string);
        readonly headerClass?: string | (() => string);
    };
}[keyof T & string];

export type TableColumnProp<T> = TableColumn<T> | (keyof T & string) | string;

export interface TableProps<T> {
    readonly rows:
        | (() => readonly T[])
        | Signal<readonly T[]>
        | Signal<T[]>
        | Resource<readonly T[]>
        | Resource<T[]>
        | readonly T[];
    readonly columns?: readonly TableColumnProp<T>[];
    readonly key: (keyof T & string) | ((row: T) => string | number);
    readonly class?: string | (() => string);
    readonly sortable?: boolean;
    readonly ref?: (el: HTMLTableElement) => void;
}

function isRecord(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null;
}

function isResource<T>(val: unknown): val is Resource<readonly T[]> | Resource<T[]> {
    return isRecord(val) && 'data' in val && typeof val['data'] === 'function';
}

function formatHeader(key: string): string {
    return key
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

interface InternalColumn<T> {
    readonly key: string;
    readonly label: string | (() => string);
    readonly sortable?: boolean;
    readonly sortFn?: (a: T, b: T) => number;
    readonly class?: string | (() => string);
    readonly headerClass?: string | (() => string);
    readonly renderCell: (row: T, index: () => number) => DOMChild;
}

/**
 * Table: Fine-grained, keyed data table component.
 *
 * Built on `For` to preserve DOM node identity across sorting and filtering.
 * Sorting and filtering are signals over data, never direct DOM mutations.
 *
 * Virtualisation is deferred to Phase 6 and needed only for massive datasets.
 */
export function Table<T>(props: TableProps<T>): HTMLTableElement {
    const sortColumn = signal<string | null>(null);
    const sortDirection = signal<'asc' | 'desc'>('asc');

    const getRawRows = (): readonly T[] => {
        const raw = props.rows;
        if (typeof raw === 'function') {
            const res = raw();
            return Array.isArray(res) ? res : [];
        }
        if (isResource<T>(raw)) {
            const res = raw.data();
            return Array.isArray(res) ? res : [];
        }
        if (Array.isArray(raw)) {
            return raw;
        }
        return [];
    };

    const normalizedColumns = computed<InternalColumn<T>[]>(() => {
        if (props.columns && props.columns.length > 0) {
            return props.columns.map((col): InternalColumn<T> => {
                if (typeof col === 'string') {
                    const colKey = col;
                    return {
                        key: colKey,
                        label: formatHeader(colKey),
                        renderCell: (row: T) => {
                            if (!isRecord(row)) return '';
                            const raw = row[colKey];
                            const val = typeof raw === 'function' ? raw() : raw;
                            return val == null ? '' : String(val);
                        },
                    };
                }

                const colKey = col.key;
                const label = col.label ?? formatHeader(colKey);
                const renderFn = col.render;

                return {
                    key: colKey,
                    label,
                    sortable: col.sortable,
                    sortFn: col.sortFn,
                    class: col.class,
                    headerClass: col.headerClass,
                    renderCell: renderFn
                        ? (row: T, index: () => number) => {
                              const val = row[col.key];
                              return renderFn(val, row, index);
                          }
                        : (row: T) => {
                              if (!isRecord(row)) return '';
                              const raw = row[colKey];
                              const val = typeof raw === 'function' ? raw() : raw;
                              return val == null ? '' : String(val);
                          },
                };
            });
        }

        const list = getRawRows();
        if (list.length === 0) return [];
        const first = list[0];
        if (!isRecord(first)) return [];

        return Object.keys(first).map((k): InternalColumn<T> => ({
            key: k,
            label: formatHeader(k),
            renderCell: (row: T) => {
                if (!isRecord(row)) return '';
                const raw = row[k];
                const val = typeof raw === 'function' ? raw() : raw;
                return val == null ? '' : String(val);
            },
        }));
    });

    const handleSortClick = (colKey: string, col: InternalColumn<T>) => {
        if (props.sortable === false || col.sortable === false) return;

        if (sortColumn() === colKey) {
            if (sortDirection() === 'asc') {
                sortDirection.set('desc');
            } else {
                sortColumn.set(null);
                sortDirection.set('asc');
            }
        } else {
            sortColumn.set(colKey);
            sortDirection.set('asc');
        }
    };

    const sortedRows = computed<readonly T[]>(() => {
        const rawList = getRawRows();
        const currentSort = sortColumn();
        if (!currentSort) return rawList;

        const dir = sortDirection() === 'asc' ? 1 : -1;
        const activeCol = normalizedColumns().find(c => c.key === currentSort);
        const customSort = activeCol?.sortFn;

        return [...rawList].sort((a, b) => {
            if (customSort) {
                return customSort(a, b) * dir;
            }
            if (!isRecord(a) || !isRecord(b)) return 0;

            const rawA = a[currentSort];
            const rawB = b[currentSort];

            const valA = typeof rawA === 'function' ? rawA() : rawA;
            const valB = typeof rawB === 'function' ? rawB() : rawB;

            if (valA === valB) return 0;
            if (valA == null) return 1;
            if (valB == null) return -1;

            if (typeof valA === 'number' && typeof valB === 'number') {
                return (valA - valB) * dir;
            }

            if (valA instanceof Date && valB instanceof Date) {
                return (valA.getTime() - valB.getTime()) * dir;
            }

            return String(valA).localeCompare(String(valB)) * dir;
        });
    });

    const keyProp = props.key;
    const keyFn = (row: T): string | number => {
        if (typeof keyProp === 'function') {
            return keyProp(row);
        }
        if (isRecord(row)) {
            const val = row[keyProp];
            if (typeof val === 'function') {
                return String(val());
            }
            return String(val);
        }
        return String(row);
    };

    const renderRow = (initialRow: T, index: () => number): HTMLElement => {
        const rowKey = keyFn(initialRow);
        const cols = normalizedColumns();
        const cells: HTMLElement[] = [];

        const getCurrentRow = (): T => {
            const list = sortedRows();
            const idx = index();
            const atIdx = list[idx];
            if (atIdx && keyFn(atIdx) === rowKey) {
                return atIdx;
            }
            const found = list.find(r => keyFn(r) === rowKey);
            return found ?? initialRow;
        };

        for (const col of cols) {
            const colKey = col.key;
            const cellContent: DOMChild | DynamicChild = () => {
                const row = getCurrentRow();
                return col.renderCell(row, index);
            };

            const cellStaticClass = 'mesh-table-cell';
            const colClass = col.class;
            const cellClass = typeof colClass === 'function'
                ? () => `${cellStaticClass} ${colClass()}`.trim()
                : colClass ? `${cellStaticClass} ${colClass}` : cellStaticClass;

            const td = h('td', {
                class: cellClass,
                'data-column': colKey,
            }, cellContent);

            cells.push(td);
        }

        return h('tr', {
            class: 'mesh-table-row',
            'data-key': String(rowKey),
        }, ...cells);
    };

    const thead = h('thead', { class: 'mesh-table-head' },
        h('tr', {}, () => {
            const cols = normalizedColumns();
            return cols.map(col => {
                const colKey = col.key;
                const isColSortable = props.sortable !== false && col.sortable !== false;
                const labelText = typeof col.label === 'function' ? col.label() : col.label;

                const sortIndicator = () => {
                    if (sortColumn() !== colKey) return '';
                    return sortDirection() === 'asc' ? ' ↑' : ' ↓';
                };

                const ariaSort = () => {
                    if (sortColumn() !== colKey) return 'none';
                    return sortDirection() === 'asc' ? 'ascending' : 'descending';
                };

                const headerStatic = isColSortable
                    ? 'mesh-table-header mesh-table-header-sortable'
                    : 'mesh-table-header';
                const colHeaderClass = col.headerClass;
                const headerClass = typeof colHeaderClass === 'function'
                    ? () => `${headerStatic} ${colHeaderClass()}`.trim()
                    : colHeaderClass ? `${headerStatic} ${colHeaderClass}` : headerStatic;

                return h('th', {
                    scope: 'col',
                    class: headerClass,
                    'data-column': colKey,
                    'aria-sort': isColSortable ? ariaSort : undefined,
                    onClick: isColSortable ? () => handleSortClick(colKey, col) : undefined,
                },
                labelText,
                isColSortable ? h('span', { class: 'mesh-table-sort-indicator', 'aria-hidden': 'true' }, sortIndicator) : null
                );
            });
        })
    );

    const tbody = h('tbody', { class: 'mesh-table-body' },
        For(sortedRows, (row, index) => renderRow(row, index), keyFn)
    );

    const staticTableClass = 'mesh-table';
    const mergedTableClass = typeof props.class === 'function'
        ? () => `${staticTableClass} ${(props.class ? (props.class as () => string)() : '')}`.trim()
        : props.class ? `${staticTableClass} ${props.class}` : staticTableClass;

    const tableProps: Props<HTMLTableElement> = {
        class: mergedTableClass,
        ...(props.ref ? { ref: props.ref } : {}),
    };

    return h('table', tableProps, thead, tbody);
}
