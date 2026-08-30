// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { z, defineContract, defaultPrint } from '@flybyme/mesh';
import { Form } from '../../src/runtime/dom/index.js';
import { signal, flushSync } from '../../src/runtime/reactivity/index.js';

describe('Form({ contract, onSubmit, initial? })', () => {
    enum PriorityEnum {
        Low = 'low',
        Medium = 'medium',
        High = 'high',
    }

    const testContract = defineContract({
        domain: 'kanban',
        action: 'card_create',
        description: 'Create a new Kanban card',
        inputSchema: z.object({
            title: z.string().min(1, 'Title is required').describe('The card title displayed on the board'),
            repo: z.string().min(1, 'Repository is required').describe('Target Git repository'),
            priority: z.nativeEnum(PriorityEnum).default(PriorityEnum.Medium).describe('Card priority level'),
            estimate: z.number().min(1, 'Estimate must be at least 1 hour').optional().describe('Estimated story points/hours'),
            isBlocked: z.boolean().default(false).describe('Whether card progress is blocked'),
            dueDate: z.date().optional().describe('Target completion date'),
            tags: z.array(z.string()).default([]).describe('Searchable labels'),
            assignee: z.object({
                name: z.string().min(1, 'Assignee name is required'),
                email: z.string().email('Invalid email format').optional(),
            }).optional().describe('Assigned team member'),
        }),
        outputSchema: z.object({
            id: z.string(),
            title: z.string(),
        }),
        rest: { method: 'POST', path: '/kanban/cards' },
        print: defaultPrint,
    });

    it('renders real <form> with one field per schema property and proper control types', () => {
        const form = Form({
            contract: testContract,
            onSubmit: vi.fn(),
        });

        expect(form.tagName.toLowerCase()).toBe('form');
        expect(form.classList.contains('mesh-form')).toBe(true);

        // String inputs
        const titleInput = form.querySelector('input[name="title"]') as HTMLInputElement;
        expect(titleInput).not.toBeNull();
        expect(titleInput.type).toBe('text');

        // Number input
        const estimateInput = form.querySelector('input[name="estimate"]') as HTMLInputElement;
        expect(estimateInput).not.toBeNull();
        expect(estimateInput.type).toBe('number');

        // Boolean checkbox
        const blockedInput = form.querySelector('input[name="isBlocked"]') as HTMLInputElement;
        expect(blockedInput).not.toBeNull();
        expect(blockedInput.type).toBe('checkbox');

        // Enum select
        const prioritySelect = form.querySelector('select[name="priority"]') as HTMLSelectElement;
        expect(prioritySelect).not.toBeNull();
        expect(prioritySelect.options.length).toBe(3); // low, medium, high
        expect(prioritySelect.value).toBe('medium'); // from default

        // Date input
        const dateInput = form.querySelector('input[name="dueDate"]') as HTMLInputElement;
        expect(dateInput).not.toBeNull();
        expect(dateInput.type).toBe('date');

        // Repeatable group for array
        const tagsContainer = form.querySelector('[data-field="tags"]');
        expect(tagsContainer).not.toBeNull();
        expect(tagsContainer?.querySelector('.mesh-form-array-add')).not.toBeNull();

        // Fieldset for nested object
        const assigneeFieldset = form.querySelector('fieldset[data-field="assignee"]');
        expect(assigneeFieldset).not.toBeNull();
        expect(assigneeFieldset?.querySelector('legend')?.textContent).toContain('Assignee');
        expect(assigneeFieldset?.querySelector('input[name="assignee.name"]')).not.toBeNull();
    });

    it('converts .describe() text into field help text and respects required vs optional', () => {
        const form = Form({
            contract: testContract,
            onSubmit: vi.fn(),
        });

        // Title is required and has help text
        const titleContainer = form.querySelector('[data-field="title"]');
        expect(titleContainer?.querySelector('.mesh-form-required')?.textContent).toBe(' *');
        expect(titleContainer?.querySelector('.mesh-form-help')?.textContent).toBe('The card title displayed on the board');

        // Estimate is optional and has no required marker
        const estimateContainer = form.querySelector('[data-field="estimate"]');
        expect(estimateContainer?.querySelector('.mesh-form-required')).toBeNull();
        expect(estimateContainer?.querySelector('.mesh-form-help')?.textContent).toBe('Estimated story points/hours');

        // Priority is defaulted and therefore not marked required
        const priorityContainer = form.querySelector('[data-field="priority"]');
        expect(priorityContainer?.querySelector('.mesh-form-required')).toBeNull();
    });

    it('a required field left empty blocks submit, and the message comes from the contract own schema', async () => {
        const onSubmit = vi.fn();
        const form = Form({
            contract: testContract,
            onSubmit,
        });

        // Submit button is initially disabled because required fields are empty
        const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
        expect(submitBtn.disabled).toBe(true);

        // Attempt submit event
        form.dispatchEvent(new Event('submit', { cancelable: true }));
        flushSync();

        // onSubmit was NOT called
        expect(onSubmit).not.toHaveBeenCalled();

        // Validation errors surfaced directly from Zod schema
        const titleError = form.querySelector('[data-field="title"] .mesh-form-error');
        expect(titleError).not.toBeNull();
        expect(titleError?.textContent).toBe('Title is required');

        const repoError = form.querySelector('[data-field="repo"] .mesh-form-error');
        expect(repoError).not.toBeNull();
        expect(repoError?.textContent).toBe('Repository is required');
    });

    it('validates per-field on blur using the contract own schema', () => {
        const form = Form({
            contract: testContract,
            onSubmit: vi.fn(),
        });

        const titleInput = form.querySelector('input[name="title"]') as HTMLInputElement;
        const titleError = form.querySelector('[data-field="title"] .mesh-form-error');

        expect(titleError?.textContent).toBe('');

        // Trigger blur with empty value
        titleInput.dispatchEvent(new Event('blur'));
        flushSync();

        // Error message appears
        expect(titleError?.textContent).toBe('Title is required');

        // Fill in valid title and blur again
        titleInput.value = 'Implement fine-grained forms';
        titleInput.dispatchEvent(new Event('input'));
        titleInput.dispatchEvent(new Event('blur'));
        flushSync();

        // Error message cleared
        expect(titleError?.textContent).toBe('');
    });

    it('a field whose zod type is unsupported renders visibly disabled and warns, rather than vanishing', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const unsupportedContract = defineContract({
            domain: 'system',
            action: 'custom_action',
            description: 'Contract with unsupported schema types',
            inputSchema: z.object({
                validText: z.string(),
                bigValue: z.bigint().describe('Unsupported BigInt value'),
                symbolValue: z.symbol().describe('Unsupported Symbol value'),
            }),
            outputSchema: z.object({}),
            rest: { method: 'POST', path: '/system/custom' },
            print: defaultPrint,
        });

        const form = Form({
            contract: unsupportedContract,
            onSubmit: vi.fn(),
        });

        // Valid field renders normally
        expect(form.querySelector('input[name="validText"]')).not.toBeNull();

        // BigInt field is NOT omitted; renders visibly disabled
        const bigField = form.querySelector('[data-field="bigValue"]');
        expect(bigField).not.toBeNull();
        expect(bigField?.classList.contains('mesh-form-field-unsupported')).toBe(true);

        const bigInput = form.querySelector('input[name="bigValue"]') as HTMLInputElement;
        expect(bigInput).not.toBeNull();
        expect(bigInput.disabled).toBe(true);
        expect(bigInput.readOnly).toBe(true);
        expect(bigInput.value).toContain('Unsupported field: ZodBigInt');

        // Warning was logged naming the field and contract
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[mesh-api form] Unsupported Zod type 'ZodBigInt' at system.custom_action.bigValue; rendered disabled control")
        );
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[mesh-api form] Unsupported Zod type 'ZodSymbol' at system.custom_action.symbolValue; rendered disabled control")
        );

        warnSpy.mockRestore();
    });

    it('a server error naming a field lands on that field', async () => {
        const onSubmit = vi.fn().mockRejectedValue({
            error: {
                code: 'DUPLICATE_TITLE',
                message: 'A card with this title already exists in the repository',
                field: 'title',
            },
        });

        const form = Form({
            contract: testContract,
            initial: {
                title: 'Existing Card',
                repo: 'mesh-api',
            },
            onSubmit,
        });

        flushSync();

        // Submit form
        form.dispatchEvent(new Event('submit', { cancelable: true }));
        flushSync();

        // Await microtasks for async submit handler
        await Promise.resolve();
        flushSync();

        expect(onSubmit).toHaveBeenCalledTimes(1);

        const titleError = form.querySelector('[data-field="title"] .mesh-form-error');
        expect(titleError?.textContent).toBe('A card with this title already exists in the repository');
    });

    it('a general server error without a field lands on the global error summary', async () => {
        const onSubmit = vi.fn().mockRejectedValue({
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Database connection failed',
            },
        });

        const form = Form({
            contract: testContract,
            initial: {
                title: 'Valid Title',
                repo: 'mesh-api',
            },
            onSubmit,
        });

        flushSync();

        form.dispatchEvent(new Event('submit', { cancelable: true }));
        flushSync();
        await Promise.resolve();
        flushSync();

        const summary = form.querySelector('.mesh-form-error-summary');
        expect(summary).not.toBeNull();
        expect(summary?.textContent).toContain('Database connection failed');
    });

    it('supports repeatable array groups with Add and Remove operations', async () => {
        const submittedData = signal<unknown>(null);
        const form = Form({
            contract: testContract,
            initial: {
                title: 'Card with tags',
                repo: 'flybyme/mesh',
                tags: ['frontend', 'reactivity'],
            },
            onSubmit: (data) => {
                submittedData.set(data);
            },
        });

        flushSync();

        const tagsContainer = form.querySelector('[data-field="tags"]');
        expect(tagsContainer).not.toBeNull();

        let tagInputs = tagsContainer?.querySelectorAll('.mesh-form-array-items input') as NodeListOf<HTMLInputElement>;
        expect(tagInputs.length).toBe(2);
        expect(tagInputs[0]?.value).toBe('frontend');
        expect(tagInputs[1]?.value).toBe('reactivity');

        // Click Add Item
        const addBtn = tagsContainer?.querySelector('.mesh-form-array-add') as HTMLButtonElement;
        addBtn.click();
        flushSync();

        tagInputs = tagsContainer?.querySelectorAll('.mesh-form-array-items input') as NodeListOf<HTMLInputElement>;
        expect(tagInputs.length).toBe(3);

        tagInputs[2]!.value = 'components';
        tagInputs[2]!.dispatchEvent(new Event('input'));
        flushSync();

        // Click Remove on first item
        const removeBtns = tagsContainer?.querySelectorAll('.mesh-form-array-remove') as NodeListOf<HTMLButtonElement>;
        removeBtns[0]!.click();
        flushSync();

        tagInputs = tagsContainer?.querySelectorAll('.mesh-form-array-items input') as NodeListOf<HTMLInputElement>;
        expect(tagInputs.length).toBe(2);
        expect(tagInputs[0]?.value).toBe('reactivity');
        expect(tagInputs[1]?.value).toBe('components');

        // Submit form and check submitted array
        form.dispatchEvent(new Event('submit', { cancelable: true }));
        flushSync();
        await Promise.resolve();

        const result = submittedData() as { tags: string[] };
        expect(result.tags).toEqual(['reactivity', 'components']);
    });

    it('renders union of literals as select with options', () => {
        const unionContract = defineContract({
            domain: 'cms',
            action: 'article_create',
            description: 'Create an article with status union',
            inputSchema: z.object({
                title: z.string(),
                status: z.union([z.literal('draft'), z.literal('published'), z.literal('archived')]),
            }),
            outputSchema: z.object({ id: z.string() }),
            rest: { method: 'POST', path: '/articles' },
            print: defaultPrint,
        });

        const form = Form({
            contract: unionContract,
            onSubmit: vi.fn(),
        });

        const select = form.querySelector('select[name="status"]') as HTMLSelectElement;
        expect(select).not.toBeNull();
        expect(select.options.length).toBe(4); // placeholder + draft, published, archived
        expect(Array.from(select.options).map(o => o.value)).toEqual(['', 'draft', 'published', 'archived']);
    });

    it('validates nested object fields and maps issues to nested paths on submit', async () => {
        const onSubmit = vi.fn();
        const form = Form({
            contract: testContract,
            initial: {
                title: 'Valid Title',
                repo: 'mesh-api',
                assignee: {
                    name: 'Bob',
                    email: 'not-a-valid-email',
                },
            },
            onSubmit,
        });

        flushSync();

        form.dispatchEvent(new Event('submit', { cancelable: true }));
        flushSync();

        expect(onSubmit).not.toHaveBeenCalled();

        const emailError = form.querySelector('[data-field="assignee.email"] .mesh-form-error');
        expect(emailError?.textContent).toBe('Invalid email format');
    });

    it('invokes ref callback with the created HTMLFormElement', () => {
        let captured: HTMLFormElement | null = null;
        const form = Form({
            contract: testContract,
            onSubmit: vi.fn(),
            ref: (el) => {
                captured = el;
            },
        });

        expect(captured).toBe(form);
    });
});
