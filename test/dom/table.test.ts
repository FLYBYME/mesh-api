// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { Table } from '../../src/runtime/dom/index.js';
import { signal, flushSync, resource } from '../../src/runtime/reactivity/index.js';

describe('Table({ rows, columns?, key })', () => {
    interface TaskRow {
        id: string;
        title: string;
        priority: number;
        status: string;
    }

    const initialTasks: TaskRow[] = [
        { id: 'task-1', title: 'Alpha Feature', priority: 3, status: 'in-progress' },
        { id: 'task-2', title: 'Beta Fix', priority: 1, status: 'backlog' },
        { id: 'task-3', title: 'Gamma Optimization', priority: 2, status: 'completed' },
    ];

    it('derives columns automatically from row shape when columns prop is omitted', () => {
        const rows = signal(initialTasks);
        const table = Table({
            rows,
            key: 'id',
        });

        expect(table.tagName.toLowerCase()).toBe('table');
        expect(table.classList.contains('mesh-table')).toBe(true);

        const headers = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent?.trim());
        expect(headers).toEqual(['Id', 'Title', 'Priority', 'Status']);

        const rowNodes = table.querySelectorAll('tbody tr');
        expect(rowNodes.length).toBe(3);
    });

    it('respects explicitly provided columns, orders, and labels', () => {
        const rows = signal(initialTasks);
        const table = Table({
            rows,
            columns: [
                { key: 'title', label: 'Task Name' },
                { key: 'status', label: 'Current State' },
                { key: 'priority', label: 'Urgency Level' },
            ],
            key: 'id',
        });

        const headers = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent?.trim());
        expect(headers).toEqual(['Task Name', 'Current State', 'Urgency Level']);

        const firstRowCells = Array.from(table.querySelectorAll('tbody tr:first-child td')).map(td => td.textContent?.trim());
        expect(firstRowCells).toEqual(['Alpha Feature', 'in-progress', '3']);
    });

    it('re-sorting a table moves row nodes rather than recreating them — asserts node identity', () => {
        const rows = signal([...initialTasks]);
        const table = Table({
            rows,
            key: 'id',
            sortable: true,
        });

        const tbody = table.querySelector('tbody')!;
        const initialRowNodes = Array.from(tbody.children) as HTMLElement[];

        // Capture exact object references to DOM nodes
        const nodeAlpha = initialRowNodes[0]!; // task-1 (priority 3)
        const nodeBeta = initialRowNodes[1]!;  // task-2 (priority 1)
        const nodeGamma = initialRowNodes[2]!; // task-3 (priority 2)

        expect(nodeAlpha.getAttribute('data-key')).toBe('task-1');
        expect(nodeBeta.getAttribute('data-key')).toBe('task-2');
        expect(nodeGamma.getAttribute('data-key')).toBe('task-3');

        // Click Priority column header to sort ascending (priority 1 -> 2 -> 3)
        const priorityHeader = table.querySelector('th[data-column="priority"]') as HTMLTableCellElement;
        priorityHeader.click();
        flushSync();

        const sortedRowNodesAsc = Array.from(tbody.children) as HTMLElement[];
        expect(sortedRowNodesAsc.length).toBe(3);

        // Verify new visual order: Beta (1), Gamma (2), Alpha (3)
        expect(sortedRowNodesAsc[0]!.getAttribute('data-key')).toBe('task-2');
        expect(sortedRowNodesAsc[1]!.getAttribute('data-key')).toBe('task-3');
        expect(sortedRowNodesAsc[2]!.getAttribute('data-key')).toBe('task-1');

        // CRITICAL PROOF: Exact DOM node instances are preserved and moved, never recreated
        expect(sortedRowNodesAsc[0]).toBe(nodeBeta);
        expect(sortedRowNodesAsc[1]).toBe(nodeGamma);
        expect(sortedRowNodesAsc[2]).toBe(nodeAlpha);

        // Click again to sort descending (priority 3 -> 2 -> 1)
        priorityHeader.click();
        flushSync();

        const sortedRowNodesDesc = Array.from(tbody.children) as HTMLElement[];
        expect(sortedRowNodesDesc[0]).toBe(nodeAlpha);
        expect(sortedRowNodesDesc[1]).toBe(nodeGamma);
        expect(sortedRowNodesDesc[2]).toBe(nodeBeta);
    });

    it('editing one cell bound value updates exactly that node and leaves siblings identical', () => {
        interface ReactiveItem {
            id: string;
            title: () => string;
            count: () => number;
        }

        const titleSignal = signal('Original Title');
        const countSignal = signal(10);

        const items: ReactiveItem[] = [
            { id: '1', title: () => titleSignal(), count: () => countSignal() },
            { id: '2', title: () => 'Static Item', count: () => 99 },
        ];

        const table = Table({
            rows: items,
            columns: [
                { key: 'title', label: 'Title' },
                { key: 'count', label: 'Count' },
            ],
            key: 'id',
        });

        const tbody = table.querySelector('tbody')!;
        const row1 = tbody.children[0] as HTMLTableRowElement;
        const row2 = tbody.children[1] as HTMLTableRowElement;

        const cellTitle1 = row1.children[0] as HTMLTableCellElement;
        const cellCount1 = row1.children[1] as HTMLTableCellElement;
        const cellTitle2 = row2.children[0] as HTMLTableCellElement;

        const originalTextNodeTitle1 = cellTitle1.firstChild;
        const originalTextNodeCount1 = cellCount1.firstChild;
        const originalTextNodeTitle2 = cellTitle2.firstChild;

        expect(cellTitle1.textContent).toBe('Original Title');
        expect(cellCount1.textContent).toBe('10');
        expect(cellTitle2.textContent).toBe('Static Item');

        // Update title signal only
        titleSignal.set('Updated Title');
        flushSync();

        // Title 1 changed fine-grained
        expect(cellTitle1.textContent).toBe('Updated Title');
        expect(cellTitle1.firstChild).toBe(originalTextNodeTitle1);

        // Sibling cell count1, sibling row row2, and its text nodes were completely untouched
        expect(cellCount1.textContent).toBe('10');
        expect(cellCount1.firstChild).toBe(originalTextNodeCount1);
        expect(cellTitle2.textContent).toBe('Static Item');
        expect(cellTitle2.firstChild).toBe(originalTextNodeTitle2);
        expect(tbody.children[0]).toBe(row1);
        expect(tbody.children[1]).toBe(row2);
    });

    it('subscribes fine-grained to reactive Resource data updates', async () => {
        let fetchCount = 0;
        const querySignal = signal('v1');

        const tasksResource = resource(async () => {
            fetchCount++;
            const version = querySignal();
            return [
                { id: '1', name: `Item 1 (${version})` },
                { id: '2', name: `Item 2 (${version})` },
            ];
        });

        const table = Table({
            rows: tasksResource,
            columns: ['id', 'name'],
            key: 'id',
        });

        // Initially waiting for async resource auto-fetch
        await new Promise(r => setTimeout(r, 10));
        flushSync();

        expect(fetchCount).toBe(1);
        const rowsAfterFirstFetch = table.querySelectorAll('tbody tr');
        expect(rowsAfterFirstFetch.length).toBe(2);
        expect(table.querySelector('tbody tr:first-child td[data-column="name"]')?.textContent).toBe('Item 1 (v1)');

        // Change querySignal -> resource automatically refetches fine-grained
        querySignal.set('v2');
        flushSync();
        await new Promise(r => setTimeout(r, 10));
        flushSync();

        expect(fetchCount).toBe(2);
        expect(table.querySelector('tbody tr:first-child td[data-column="name"]')?.textContent).toBe('Item 1 (v2)');
    });

    it('filters rows via reactive signal while preserving surviving row node identity', () => {
        const filterText = signal('');
        const allTasks = signal([...initialTasks]);

        const filteredTasks = () => {
            const query = filterText().toLowerCase();
            if (!query) return allTasks();
            return allTasks().filter(t => t.title.toLowerCase().includes(query));
        };

        const table = Table({
            rows: filteredTasks,
            key: 'id',
        });

        const tbody = table.querySelector('tbody')!;
        const initialNodes = Array.from(tbody.children) as HTMLElement[];
        const nodeAlpha = initialNodes[0]!;
        const nodeGamma = initialNodes[2]!;

        // Filter to only items with 'a' in title (Alpha, Gamma)
        filterText.set('a');
        flushSync();

        const filteredNodes = Array.from(tbody.children) as HTMLElement[];
        expect(filteredNodes.length).toBe(3); // 'Alpha Feature', 'Beta Fix', 'Gamma Optimization' all contain 'a'

        // Filter to 'optimization' -> only Gamma
        filterText.set('optimization');
        flushSync();

        const singleNodeList = Array.from(tbody.children) as HTMLElement[];
        expect(singleNodeList.length).toBe(1);
        expect(singleNodeList[0]).toBe(nodeGamma); // EXACT node identity preserved

        // Clear filter -> all 3 back, surviving nodeGamma is still identical
        filterText.set('');
        flushSync();

        const restoredList = Array.from(tbody.children) as HTMLElement[];
        expect(restoredList.length).toBe(3);
        expect(restoredList[2]).toBe(nodeGamma); // Surviving node kept across all transitions
    });

    it('supports custom column render callbacks and custom classes', () => {
        const rows = signal(initialTasks);
        const table = Table({
            rows,
            columns: [
                {
                    key: 'title',
                    label: 'Custom Title',
                    render: (val) => {
                        const span = document.createElement('span');
                        span.className = 'custom-badge';
                        span.textContent = `★ ${String(val)}`;
                        return span;
                    },
                },
                {
                    key: 'priority',
                    label: 'Prio',
                    class: 'custom-cell-class',
                    headerClass: 'custom-header-class',
                },
            ],
            key: 'id',
        });

        const customBadge = table.querySelector('tbody tr:first-child td[data-column="title"] .custom-badge');
        expect(customBadge).not.toBeNull();
        expect(customBadge?.textContent).toBe('★ Alpha Feature');

        const customTh = table.querySelector('thead th[data-column="priority"]');
        expect(customTh?.classList.contains('custom-header-class')).toBe(true);

        const customTd = table.querySelector('tbody tr:first-child td[data-column="priority"]');
        expect(customTd?.classList.contains('custom-cell-class')).toBe(true);
    });
});
