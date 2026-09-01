import './form.css';
// `z` from zod directly, and `ToolContract` as a type-only import so it is erased at compile time.
//
// `import { z } from '@flybyme/mesh'` is a *value* import of the mesh package root, which reaches
// ContextStack, the Supervisor and express — dragging the entire server into any browser bundle
// that touches a Form. Same constant, same instance, no server. See ../../../auth/roles.ts for the
// other place this boundary leaked.
import { z } from 'zod';
import type { ToolContract } from '@flybyme/mesh';
import type { Props, Child } from '../types.js';
import { signal } from '../../reactivity/signal.js';
import { computed } from '../../reactivity/computed.js';
import { effect } from '../../reactivity/effect.js';
import { bindClass, bindText } from '../bindings.js';
import { h } from '../h.js';
import { Button } from './Button.js';
import {
    classifyFormField,
    getObjectShape,
    type FormFieldClassification,
} from '../../../exposure/schema.js';

export interface FormContractLike<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
    readonly inputSchema: TInput;
    readonly domain?: string;
    readonly action?: string;
    readonly description?: string;
}

export interface FormProps<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
    contract: ToolContract<TInput> | FormContractLike<TInput>;
    onSubmit: (data: z.infer<TInput>) => Promise<unknown> | unknown;
    initial?: Partial<z.input<TInput>> | (() => Partial<z.input<TInput>>);
    submitLabel?: string | (() => string);
    class?: string | (() => string);
    id?: string | (() => string);
    ref?: (el: HTMLFormElement) => void;
}

interface FormFieldContext {
    readonly formElement: HTMLFormElement;
    readonly fieldErrors: () => Record<string, string>;
    readonly setFieldError: (path: string, message: string) => void;
    readonly clearFieldError: (path: string) => void;
    readonly validateField: (path: string) => void;
    readonly uniquePrefix: string;
}

let formIdCounter = 0;

function formatLabel(key: string): string {
    return key
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function formatDateForInput(date: unknown): string {
    if (date instanceof Date && !isNaN(date.getTime())) {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    if (typeof date === 'string') {
        const parsed = new Date(date);
        if (!isNaN(parsed.getTime())) {
            const year = parsed.getUTCFullYear();
            const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
            const day = String(parsed.getUTCDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }
        return date;
    }
    return '';
}

/**
 * Form: Schema-driven form component generated directly from a ToolContract.
 *
 * Enforces single source of truth for validation, types, help text, and optionality.
 * Submit is disabled while invalid or in flight, and server errors are surfaced back to
 * the specific field when named.
 */
export function Form<TInput extends z.ZodTypeAny = z.ZodTypeAny>(
    props: FormProps<TInput>
): HTMLFormElement {
    const formUniqueId = ++formIdCounter;
    const prefix = `mesh-form-${formUniqueId}`;

    const isSubmitting = signal(false);
    const formError = signal<string | null>(null);
    const fieldErrors = signal<Record<string, string>>({});

    const initialData = typeof props.initial === 'function'
        ? props.initial()
        : props.initial ?? {};

    const initialRecord: Record<string, unknown> = initialData && typeof initialData === 'object'
        ? (initialData as Record<string, unknown>)
        : {};

    const fieldGetters = new Map<string, () => unknown>();

    const setFieldError = (path: string, message: string) => {
        fieldErrors.update(prev => ({ ...prev, [path]: message }));
    };

    const clearFieldError = (path: string) => {
        fieldErrors.update(prev => {
            if (!(path in prev)) return prev;
            const next = { ...prev };
            delete next[path];
            return next;
        });
    };

    const clearAllErrors = () => {
        fieldErrors.set({});
        formError.set(null);
    };

    const getFormData = (): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        for (const [key, getter] of fieldGetters.entries()) {
            out[key] = getter();
        }
        return out;
    };

    const validateField = (fieldPath: string) => {
        const currentData = getFormData();
        const parsed = props.contract.inputSchema.safeParse(currentData);
        if (!parsed.success) {
            const issue = parsed.error.issues.find(iss => {
                const p = iss.path.join('.');
                return p === fieldPath || p.startsWith(`${fieldPath}.`) || p.startsWith(`${fieldPath}[`);
            });
            if (issue) {
                setFieldError(fieldPath, issue.message);
            } else {
                clearFieldError(fieldPath);
            }
        } else {
            clearFieldError(fieldPath);
        }
    };

    const isFormValid = computed(() => {
        const data = getFormData();
        return props.contract.inputSchema.safeParse(data).success;
    });

    const staticClass = 'mesh-form';
    const mergedClass = typeof props.class === 'function'
        ? () => `${staticClass} ${(props.class ? (props.class as () => string)() : '')}`.trim()
        : props.class ? `${staticClass} ${props.class}` : staticClass;

    const formElementProps: Props<HTMLFormElement> = {
        class: mergedClass,
        novalidate: true,
        ...(props.id !== undefined ? { id: props.id } : {}),
        ...(props.ref ? { ref: props.ref } : {}),
    };

    const formEl = h('form', formElementProps);

    const ctx: FormFieldContext = {
        formElement: formEl,
        fieldErrors: () => fieldErrors(),
        setFieldError,
        clearFieldError,
        validateField,
        uniquePrefix: prefix,
    };

    // Form-level error summary banner
    const errorSummary = h('div', {
        class: () => formError() ? 'mesh-form-error-summary' : 'mesh-form-error-summary mesh-hidden',
        role: 'alert',
        style: () => formError() ? '' : 'display: none;',
    }, h('p', { class: 'mesh-form-error-summary-text' }, () => formError() ?? ''));

    formEl.appendChild(errorSummary);

    // Build fields from contract input schema shape
    const shape = getObjectShape(props.contract.inputSchema);
    if (shape) {
        for (const [fieldName, fieldSchema] of Object.entries(shape)) {
            const initialVal = initialRecord[fieldName];
            const { element, getValue } = createField(
                fieldName,
                fieldName,
                fieldSchema,
                initialVal,
                ctx,
                `${props.contract.domain ?? 'form'}.${props.contract.action ?? 'submit'}`
            );
            fieldGetters.set(fieldName, getValue);
            formEl.appendChild(element);
        }
    }

    // Submit Actions
    const getSubmitLabel = (): string => {
        if (typeof props.submitLabel === 'function') {
            return props.submitLabel();
        }
        return props.submitLabel ?? 'Submit';
    };

    const submitButton = Button(
        {
            type: 'submit',
            variant: 'primary',
            disabled: () => isSubmitting() || !isFormValid(),
            class: 'mesh-form-submit',
        },
        () => (isSubmitting() ? 'Submitting...' : getSubmitLabel())
    );

    const actionsContainer = h('div', { class: 'mesh-form-actions' }, submitButton);
    formEl.appendChild(actionsContainer);

    // Submit Event Listener
    formEl.addEventListener('submit', async (e: Event) => {
        e.preventDefault();
        const currentData = getFormData();
        const parsed = props.contract.inputSchema.safeParse(currentData);

        if (!parsed.success) {
            const nextErrors: Record<string, string> = {};
            let rootErr: string | null = null;
            let firstFieldPath: string | null = null;

            for (const issue of parsed.error.issues) {
                const issuePath = issue.path.join('.');
                if (issuePath === '') {
                    rootErr = issue.message;
                } else {
                    if (!nextErrors[issuePath]) {
                        nextErrors[issuePath] = issue.message;
                    }
                    if (!firstFieldPath) {
                        firstFieldPath = issuePath;
                    }
                }
            }

            fieldErrors.set(nextErrors);
            formError.set(rootErr);

            if (firstFieldPath) {
                const targetControl = formEl.querySelector(`[name="${firstFieldPath}"]`) as HTMLElement | null;
                targetControl?.focus();
            }
            return;
        }

        clearAllErrors();
        isSubmitting.set(true);

        try {
            const result = await props.onSubmit(parsed.data);
            if (result && typeof result === 'object') {
                const resRecord = result as Record<string, unknown>;
                if ('error' in resRecord && resRecord.error && typeof resRecord.error === 'object') {
                    const errData = resRecord.error as Record<string, unknown>;
                    const field = typeof errData.field === 'string' ? errData.field : undefined;
                    const message = typeof errData.message === 'string' ? errData.message : 'Submission failed';
                    if (field) {
                        setFieldError(field, message);
                        const targetControl = formEl.querySelector(`[name="${field}"]`) as HTMLElement | null;
                        targetControl?.focus();
                    } else {
                        formError.set(message);
                    }
                }
            }
        } catch (err: unknown) {
            handleFormError(err, formEl, setFieldError, formError.set);
        } finally {
            isSubmitting.set(false);
        }
    });

    return formEl;
}

function handleFormError(
    err: unknown,
    formEl: HTMLFormElement,
    setFieldError: (path: string, message: string) => void,
    setFormError: (message: string | null) => void
): void {
    if (err && typeof err === 'object') {
        const errObj = err as Record<string, unknown>;

        // Direct field property on error object
        if (typeof errObj.field === 'string') {
            const msg = typeof errObj.message === 'string' ? errObj.message : 'Invalid value';
            setFieldError(errObj.field, msg);
            const target = formEl.querySelector(`[name="${errObj.field}"]`) as HTMLElement | null;
            target?.focus();
            return;
        }

        // Direct path property on error object
        if (Array.isArray(errObj.path) && errObj.path.length > 0) {
            const p = errObj.path.join('.');
            const msg = typeof errObj.message === 'string' ? errObj.message : 'Invalid value';
            setFieldError(p, msg);
            const target = formEl.querySelector(`[name="${p}"]`) as HTMLElement | null;
            target?.focus();
            return;
        }

        // Nested error body { error: { code, message, field? } }
        if (errObj.error && typeof errObj.error === 'object') {
            const inner = errObj.error as Record<string, unknown>;
            if (typeof inner.field === 'string') {
                const msg = typeof inner.message === 'string' ? inner.message : 'Invalid value';
                setFieldError(inner.field, msg);
                const target = formEl.querySelector(`[name="${inner.field}"]`) as HTMLElement | null;
                target?.focus();
                return;
            }
            if (Array.isArray(inner.path) && inner.path.length > 0) {
                const p = inner.path.join('.');
                const msg = typeof inner.message === 'string' ? inner.message : 'Invalid value';
                setFieldError(p, msg);
                const target = formEl.querySelector(`[name="${p}"]`) as HTMLElement | null;
                target?.focus();
                return;
            }
            if (typeof inner.message === 'string') {
                setFormError(inner.message);
                return;
            }
        }

        if (typeof errObj.message === 'string') {
            setFormError(errObj.message);
            return;
        }
    }

    setFormError(String(err));
}

interface CreatedField {
    element: HTMLElement;
    getValue: () => unknown;
}

function createField(
    fieldName: string,
    fieldPath: string,
    fieldSchema: z.ZodTypeAny,
    initialValue: unknown,
    ctx: FormFieldContext,
    contractKey: string
): CreatedField {
    const classification = classifyFormField(fieldSchema);
    const isRequired = !classification.unwrapped.isOptional;
    const description = classification.unwrapped.description;
    const defaultValue = classification.unwrapped.defaultValue;
    const initialOrDef = initialValue !== undefined ? initialValue : defaultValue;

    const fieldId = `${ctx.uniquePrefix}-${fieldPath.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
    const helpId = description ? `${fieldId}-help` : undefined;
    const errorId = `${fieldId}-error`;

    const getError = () => ctx.fieldErrors()[fieldPath];
    const hasError = () => Boolean(getError());

    // Label element
    const labelText = formatLabel(fieldName);
    const labelChildren: Child[] = [labelText];
    if (isRequired) {
        labelChildren.push(h('span', { class: 'mesh-form-required', 'aria-hidden': 'true' }, ' *'));
    }

    // Help Text Element
    const helpElement = description
        ? h('span', { id: helpId, class: 'mesh-form-help' }, description)
        : null;

    // Error Element
    const errorElement = h('span', {
        id: errorId,
        class: 'mesh-form-error',
        role: 'alert',
        style: () => hasError() ? '' : 'display: none;',
    }, () => getError() ?? '');

    // 1. String Input
    if (classification.kind === 'string') {
        const valSignal = signal<string>(typeof initialOrDef === 'string' ? initialOrDef : '');

        const inputEl = h('input', {
            type: 'text',
            id: fieldId,
            name: fieldPath,
            class: 'mesh-input',
            required: isRequired,
            value: () => valSignal(),
            'aria-describedby': () => hasError() ? errorId : helpId,
            'aria-invalid': () => hasError(),
            onInput: (e: Event) => {
                const target = e.target as HTMLInputElement;
                valSignal.set(target.value);
            },
            onBlur: () => {
                ctx.validateField(fieldPath);
            },
        });

        const labelEl = h('label', { for: fieldId, class: 'mesh-form-label' }, ...labelChildren);

        const container = h('div', {
            class: () => hasError()
                ? 'mesh-form-field mesh-form-field-string mesh-form-field-invalid'
                : 'mesh-form-field mesh-form-field-string',
            'data-field': fieldPath,
        }, labelEl, inputEl, helpElement, errorElement);

        return {
            element: container,
            getValue: () => {
                const str = valSignal();
                if (classification.unwrapped.isOptional && str === '') {
                    return undefined;
                }
                return str;
            },
        };
    }

    // 2. Number Input
    if (classification.kind === 'number') {
        const initialStr = typeof initialOrDef === 'number' ? String(initialOrDef) : '';
        const valSignal = signal<string>(initialStr);

        const inputEl = h('input', {
            type: 'number',
            id: fieldId,
            name: fieldPath,
            class: 'mesh-input',
            required: isRequired,
            value: () => valSignal(),
            'aria-describedby': () => hasError() ? errorId : helpId,
            'aria-invalid': () => hasError(),
            onInput: (e: Event) => {
                const target = e.target as HTMLInputElement;
                valSignal.set(target.value);
            },
            onBlur: () => {
                ctx.validateField(fieldPath);
            },
        });

        const labelEl = h('label', { for: fieldId, class: 'mesh-form-label' }, ...labelChildren);

        const container = h('div', {
            class: () => hasError()
                ? 'mesh-form-field mesh-form-field-number mesh-form-field-invalid'
                : 'mesh-form-field mesh-form-field-number',
            'data-field': fieldPath,
        }, labelEl, inputEl, helpElement, errorElement);

        return {
            element: container,
            getValue: () => {
                const str = valSignal().trim();
                if (str === '') {
                    return undefined;
                }
                const num = Number(str);
                return isNaN(num) ? str : num;
            },
        };
    }

    // 3. Boolean Checkbox
    if (classification.kind === 'boolean') {
        const valSignal = signal<boolean>(Boolean(initialOrDef));

        const checkboxEl = h('input', {
            type: 'checkbox',
            id: fieldId,
            name: fieldPath,
            class: 'mesh-checkbox',
            required: isRequired,
            checked: () => valSignal(),
            'aria-describedby': () => hasError() ? errorId : helpId,
            'aria-invalid': () => hasError(),
            onChange: (e: Event) => {
                const target = e.target as HTMLInputElement;
                valSignal.set(target.checked);
            },
            onBlur: () => {
                ctx.validateField(fieldPath);
            },
        });

        const checkboxLabel = h('label', { for: fieldId, class: 'mesh-checkbox-label' },
            checkboxEl,
            h('span', { class: 'mesh-checkbox-text' }, ...labelChildren)
        );

        const container = h('div', {
            class: () => hasError()
                ? 'mesh-form-field mesh-form-field-boolean mesh-form-field-invalid'
                : 'mesh-form-field mesh-form-field-boolean',
            'data-field': fieldPath,
        }, checkboxLabel, helpElement, errorElement);

        return {
            element: container,
            getValue: () => valSignal(),
        };
    }

    // 4. Enum / NativeEnum / Literal Union Select
    if (classification.kind === 'enum') {
        const initialStr = initialOrDef !== undefined ? String(initialOrDef) : '';
        const valSignal = signal<string>(initialStr);

        const selectOptions: HTMLElement[] = [];
        if (!classification.unwrapped.hasDefault && (classification.unwrapped.isOptional || initialStr === '')) {
            selectOptions.push(h('option', { value: '', selected: initialStr === '' }, 'Select an option...'));
        }

        for (const opt of classification.options) {
            const isSelected = opt === initialStr;
            selectOptions.push(h('option', { value: opt, selected: isSelected }, opt));
        }

        const selectEl = h('select', {
            id: fieldId,
            name: fieldPath,
            class: 'mesh-select',
            required: isRequired,
            value: () => valSignal(),
            'aria-describedby': () => hasError() ? errorId : helpId,
            'aria-invalid': () => hasError(),
            onChange: (e: Event) => {
                const target = e.target as HTMLSelectElement;
                valSignal.set(target.value);
            },
            onBlur: () => {
                ctx.validateField(fieldPath);
            },
        }, ...selectOptions);

        const labelEl = h('label', { for: fieldId, class: 'mesh-form-label' }, ...labelChildren);

        const container = h('div', {
            class: () => hasError()
                ? 'mesh-form-field mesh-form-field-select mesh-form-field-invalid'
                : 'mesh-form-field mesh-form-field-select',
            'data-field': fieldPath,
        }, labelEl, selectEl, helpElement, errorElement);

        return {
            element: container,
            getValue: () => {
                const val = valSignal();
                if (val === '') {
                    return undefined;
                }
                return val;
            },
        };
    }

    // 5. Date Input
    if (classification.kind === 'date') {
        const dateStr = formatDateForInput(initialOrDef);
        const valSignal = signal<string>(dateStr);

        const inputEl = h('input', {
            type: 'date',
            id: fieldId,
            name: fieldPath,
            class: 'mesh-input',
            required: isRequired,
            value: () => valSignal(),
            'aria-describedby': () => hasError() ? errorId : helpId,
            'aria-invalid': () => hasError(),
            onInput: (e: Event) => {
                const target = e.target as HTMLInputElement;
                valSignal.set(target.value);
            },
            onBlur: () => {
                ctx.validateField(fieldPath);
            },
        });

        const labelEl = h('label', { for: fieldId, class: 'mesh-form-label' }, ...labelChildren);

        const container = h('div', {
            class: () => hasError()
                ? 'mesh-form-field mesh-form-field-date mesh-form-field-invalid'
                : 'mesh-form-field mesh-form-field-date',
            'data-field': fieldPath,
        }, labelEl, inputEl, helpElement, errorElement);

        return {
            element: container,
            getValue: () => {
                const str = valSignal().trim();
                if (str === '') {
                    return undefined;
                }
                const d = new Date(`${str}T00:00:00.000Z`);
                return isNaN(d.getTime()) ? str : d;
            },
        };
    }

    // 6. Nested Object -> fieldset
    if (classification.kind === 'object') {
        const nestedInitial = initialOrDef && typeof initialOrDef === 'object'
            ? (initialOrDef as Record<string, unknown>)
            : {};

        const childGetters = new Map<string, () => unknown>();
        const childElements: HTMLElement[] = [];

        for (const [childKey, childSchema] of Object.entries(classification.shape)) {
            const childPath = `${fieldPath}.${childKey}`;
            const childInitial = nestedInitial[childKey];
            const childField = createField(childKey, childPath, childSchema, childInitial, ctx, contractKey);
            childGetters.set(childKey, childField.getValue);
            childElements.push(childField.element);
        }

        const legendEl = h('legend', { class: 'mesh-form-legend' }, ...labelChildren);

        const fieldsetEl = h('fieldset', {
            class: () => hasError()
                ? 'mesh-form-fieldset mesh-form-field-invalid'
                : 'mesh-form-fieldset',
            'data-field': fieldPath,
        }, legendEl, helpElement, errorElement, ...childElements);

        return {
            element: fieldsetEl,
            getValue: () => {
                const nestedOut: Record<string, unknown> = {};
                let hasAnyValue = false;
                for (const [key, getter] of childGetters.entries()) {
                    const v = getter();
                    if (v !== undefined && v !== '') {
                        hasAnyValue = true;
                    }
                    nestedOut[key] = v;
                }
                if (classification.unwrapped.isOptional && !hasAnyValue) {
                    return undefined;
                }
                return nestedOut;
            },
        };
    }

    // 7. Array -> Repeatable Group
    if (classification.kind === 'array') {
        const arrayInitial: unknown[] = Array.isArray(initialOrDef) ? initialOrDef : [];
        let nextArrayItemId = 0;

        interface ArrayItemRecord {
            id: number;
            field: CreatedField;
        }

        const itemsSignal = signal<ArrayItemRecord[]>([]);

        const createArrayItem = (itemVal?: unknown): ArrayItemRecord => {
            const id = ++nextArrayItemId;
            const itemIndex = itemsSignal().length;
            const itemPath = `${fieldPath}.${itemIndex}`;
            const childField = createField(`Item ${id}`, itemPath, classification.element, itemVal, ctx, contractKey);

            return {
                id,
                field: childField,
            };
        };

        const initialRecords = arrayInitial.map(val => createArrayItem(val));
        itemsSignal.set(initialRecords);

        const itemsContainer = h('div', { class: 'mesh-form-array-items' });

        const rebuildItemsDOM = () => {
            itemsContainer.innerHTML = '';
            const items = itemsSignal();
            for (let i = 0; i < items.length; i++) {
                const itemRec = items[i];
                if (!itemRec) continue;
                const removeBtn = Button({
                    type: 'button',
                    variant: 'danger',
                    size: 'sm',
                    class: 'mesh-form-array-remove',
                    onClick: () => {
                        itemsSignal.update(prev => prev.filter(r => r.id !== itemRec.id));
                        rebuildItemsDOM();
                        ctx.validateField(fieldPath);
                    },
                }, 'Remove');

                const row = h('div', { class: 'mesh-form-array-item' },
                    h('div', { class: 'mesh-form-array-item-content' }, itemRec.field.element),
                    removeBtn
                );
                itemsContainer.appendChild(row);
            }
        };

        rebuildItemsDOM();

        const addBtn = Button({
            type: 'button',
            variant: 'secondary',
            size: 'sm',
            class: 'mesh-form-array-add',
            onClick: () => {
                const newItem = createArrayItem();
                itemsSignal.update(prev => [...prev, newItem]);
                rebuildItemsDOM();
                ctx.validateField(fieldPath);
            },
        }, '+ Add Item');

        const arrayHeader = h('div', { class: 'mesh-form-array-header' },
            h('label', { class: 'mesh-form-label' }, ...labelChildren),
            addBtn
        );

        const container = h('div', {
            class: () => hasError()
                ? 'mesh-form-field mesh-form-field-array mesh-form-field-invalid'
                : 'mesh-form-field mesh-form-field-array',
            'data-field': fieldPath,
        }, arrayHeader, helpElement, errorElement, itemsContainer);

        return {
            element: container,
            getValue: () => {
                return itemsSignal().map(rec => rec.field.getValue());
            },
        };
    }

    // 8. Unsupported Schema Type -> visibly disabled control + console warning
    const typeName = classification.typeName;
    console.warn(`[mesh-api form] Unsupported Zod type '${typeName}' at ${contractKey}.${fieldPath}; rendered disabled control`);

    const disabledInput = h('input', {
        type: 'text',
        id: fieldId,
        name: fieldPath,
        disabled: true,
        readonly: true,
        class: 'mesh-input mesh-input-disabled',
        value: `[Unsupported field: ${typeName}]`,
        'aria-describedby': helpId,
    });

    const labelEl = h('label', { for: fieldId, class: 'mesh-form-label' },
        ...labelChildren,
        h('span', { class: 'mesh-form-unsupported-tag' }, ' (Unsupported)')
    );

    const unsupportedWarning = h('span', { class: 'mesh-form-help mesh-form-unsupported-warning' },
        `Unsupported schema type: ${typeName}`
    );

    const container = h('div', {
        class: 'mesh-form-field mesh-form-field-unsupported',
        'data-field': fieldPath,
    }, labelEl, disabledInput, helpElement, unsupportedWarning);

    return {
        element: container,
        getValue: () => initialOrDef,
    };
}
