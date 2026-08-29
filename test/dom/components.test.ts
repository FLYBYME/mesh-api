// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
    Stack,
    Row,
    Text,
    Heading,
    Button,
    Input,
    Card,
    Badge,
    Spinner,
    EmptyState,
    ErrorState,
} from '../../src/runtime/dom/index.js';
import {
    signal,
    flushSync,
} from '../../src/runtime/reactivity/index.js';

describe('DOM Component Catalogue', () => {
    describe('Stack', () => {
        it('renders vertical layout with gap and alignment classes', () => {
            const stack = Stack(
                { gap: 'md', align: 'center', justify: 'between' },
                Text({}, 'Child 1'),
                Text({}, 'Child 2'),
            );

            expect(stack.classList.contains('mesh-stack')).toBe(true);
            expect(stack.classList.contains('mesh-stack-gap-md')).toBe(true);
            expect(stack.classList.contains('mesh-stack-align-center')).toBe(true);
            expect(stack.classList.contains('mesh-stack-justify-between')).toBe(true);
            expect(stack.children.length).toBe(2);
        });

        it('supports custom numeric gap', () => {
            const stack = Stack({ gap: 18 });
            expect(stack.style.gap).toBe('18px');
        });
    });

    describe('Row', () => {
        it('renders horizontal layout with wrap and spacing', () => {
            const row = Row(
                { gap: 'sm', wrap: true, align: 'baseline' },
                Text({}, 'Label'),
                Badge({ variant: 'success' }, 'Active'),
            );

            expect(row.classList.contains('mesh-row')).toBe(true);
            expect(row.classList.contains('mesh-row-wrap')).toBe(true);
            expect(row.classList.contains('mesh-row-align-baseline')).toBe(true);
            expect(row.classList.contains('mesh-row-gap-sm')).toBe(true);
            expect(row.children.length).toBe(2);
        });
    });

    describe('Text', () => {
        it('renders semantic spans or paragraphs with variants', () => {
            const body = Text({ variant: 'body' }, 'Normal text');
            expect(body.tagName.toLowerCase()).toBe('span');
            expect(body.classList.contains('mesh-text-variant-body')).toBe(true);

            const code = Text({ variant: 'code' }, 'const x = 1;');
            expect(code.tagName.toLowerCase()).toBe('code');
            expect(code.classList.contains('mesh-text-variant-code')).toBe(true);

            const p = Text({ as: 'p', weight: 'bold', size: 'lg' }, 'Paragraph');
            expect(p.tagName.toLowerCase()).toBe('p');
            expect(p.classList.contains('mesh-text-weight-bold')).toBe(true);
            expect(p.classList.contains('mesh-text-size-lg')).toBe(true);
        });
    });

    describe('Heading', () => {
        it('renders semantic h1-h6 headings', () => {
            const h1 = Heading({ level: 1, size: '2xl' }, 'Title 1');
            expect(h1.tagName.toLowerCase()).toBe('h1');
            expect(h1.classList.contains('mesh-heading-level-1')).toBe(true);
            expect(h1.classList.contains('mesh-heading-size-2xl')).toBe(true);
            expect(h1.textContent).toBe('Title 1');

            const h3 = Heading({ level: 3 }, 'Subtitle');
            expect(h3.tagName.toLowerCase()).toBe('h3');
            expect(h3.classList.contains('mesh-heading-level-3')).toBe(true);
        });
    });

    describe('Button', () => {
        it('renders accessible clickable button with variants and handlers', () => {
            let clicked = false;
            const btn = Button(
                {
                    variant: 'primary',
                    size: 'lg',
                    type: 'submit',
                    onClick: () => {
                        clicked = true;
                    },
                },
                'Submit Form',
            );

            expect(btn.tagName.toLowerCase()).toBe('button');
            expect(btn.type).toBe('submit');
            expect(btn.classList.contains('mesh-button-variant-primary')).toBe(true);
            expect(btn.classList.contains('mesh-button-size-lg')).toBe(true);

            btn.click();
            expect(clicked).toBe(true);
        });

        it('binds reactive disabled state', () => {
            const isSubmitting = signal(false);
            const btn = Button({ disabled: () => isSubmitting() }, 'Save');

            expect(btn.disabled).toBe(false);

            isSubmitting.set(true);
            flushSync();
            expect(btn.disabled).toBe(true);
        });
    });

    describe('Input', () => {
        it('renders controlled input control', () => {
            const text = signal('Initial');
            const input = Input({
                type: 'text',
                placeholder: 'Enter name',
                value: () => text(),
                onInput: (e: Event) => {
                    const target = e.target as HTMLInputElement;
                    text.set(target.value);
                },
            });

            expect(input.tagName.toLowerCase()).toBe('input');
            expect(input.type).toBe('text');
            expect(input.placeholder).toBe('Enter name');
            expect(input.value).toBe('Initial');

            input.value = 'Typed content';
            input.dispatchEvent(new Event('input'));
            flushSync();

            expect(text()).toBe('Typed content');
        });
    });

    describe('Card', () => {
        it('renders card container with header, body, and footer', () => {
            const card = Card(
                {
                    header: Heading({ level: 3 }, 'Card Header'),
                    footer: Text({ variant: 'muted' }, 'Card Footer'),
                    variant: 'elevated',
                },
                Text({}, 'Main body content'),
            );

            expect(card.classList.contains('mesh-card')).toBe(true);
            expect(card.classList.contains('mesh-card-variant-elevated')).toBe(true);

            const header = card.querySelector('.mesh-card-header');
            const body = card.querySelector('.mesh-card-body');
            const footer = card.querySelector('.mesh-card-footer');

            expect(header?.textContent).toBe('Card Header');
            expect(body?.textContent).toBe('Main body content');
            expect(footer?.textContent).toBe('Card Footer');
        });
    });

    describe('Badge', () => {
        it('renders badge with status variant', () => {
            const badge = Badge({ variant: 'warning', size: 'md' }, 'Pending Review');
            expect(badge.tagName.toLowerCase()).toBe('span');
            expect(badge.classList.contains('mesh-badge')).toBe(true);
            expect(badge.classList.contains('mesh-badge-variant-warning')).toBe(true);
            expect(badge.classList.contains('mesh-badge-size-md')).toBe(true);
            expect(badge.textContent).toBe('Pending Review');
        });
    });

    describe('Spinner', () => {
        it('renders accessible loading indicator with role status', () => {
            const spinner = Spinner({ size: 'lg', label: 'Fetching data...' });
            expect(spinner.getAttribute('role')).toBe('status');
            expect(spinner.getAttribute('aria-label')).toBe('Fetching data...');
            expect(spinner.classList.contains('mesh-spinner-size-lg')).toBe(true);
        });
    });

    describe('EmptyState', () => {
        it('renders empty feedback view with title, description, and action button', () => {
            const state = EmptyState({
                title: 'No Cards Found',
                description: 'Create a new card to start tracking tasks.',
                action: Button({ variant: 'primary' }, 'New Card'),
            });

            expect(state.classList.contains('mesh-empty-state')).toBe(true);
            expect(state.querySelector('.mesh-empty-state-title')?.textContent).toBe('No Cards Found');
            expect(state.querySelector('.mesh-empty-state-desc')?.textContent).toContain('Create a new card');
            expect(state.querySelector('.mesh-empty-state-action button')?.textContent).toBe('New Card');
        });
    });

    describe('ErrorState', () => {
        it('renders accessible error alert with role alert and retry callback', () => {
            let retried = false;
            const error = ErrorState({
                title: 'Network Timeout',
                message: new Error('Failed to reach server'),
                onRetry: () => {
                    retried = true;
                },
            });

            expect(error.getAttribute('role')).toBe('alert');
            expect(error.querySelector('.mesh-error-state-title')?.textContent).toBe('Network Timeout');
            expect(error.querySelector('.mesh-error-state-message')?.textContent).toBe('Failed to reach server');

            const retryBtn = error.querySelector('button');
            expect(retryBtn).not.toBeNull();
            retryBtn?.click();
            expect(retried).toBe(true);
        });
    });
});
