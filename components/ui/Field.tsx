import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

/**
 * Form controls with a visible label, optional help text, and an inline error wired up through
 * `aria-describedby` / `aria-invalid`. `id` defaults to `f-<name>`; pass one when a name repeats on a page.
 */
interface FieldChrome {
  label: ReactNode;
  help?: ReactNode;
  error?: string | null;
  /** Extra content next to the label (e.g. a source badge). */
  adornment?: ReactNode;
  id?: string;
}

function describedBy(id: string, help: unknown, error: unknown): string | undefined {
  return [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

export function Field({
  id,
  label,
  help,
  error,
  adornment,
  children,
}: Required<Pick<FieldChrome, "id">> & Omit<FieldChrome, "id"> & { children: ReactNode }) {
  return (
    <div className="field" data-field={id}>
      <div className="field-label">
        <label htmlFor={id}>{label}</label>
        {adornment}
      </div>
      {children}
      {help && (
        <p className="field-help" id={`${id}-help`}>
          {help}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({ label, help, error, adornment, id, name, className, ...rest }: FieldChrome & InputHTMLAttributes<HTMLInputElement>) {
  const fid = id ?? `f-${name}`;
  return (
    <Field id={fid} label={label} help={help} error={error} adornment={adornment}>
      <input
        id={fid}
        name={name}
        className={["input", className].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, help, error)}
        {...rest}
      />
    </Field>
  );
}

export function Select({
  label,
  help,
  error,
  adornment,
  id,
  name,
  options,
  className,
  ...rest
}: FieldChrome & { options: readonly { value: string; label: string }[] } & SelectHTMLAttributes<HTMLSelectElement>) {
  const fid = id ?? `f-${name}`;
  return (
    <Field id={fid} label={label} help={help} error={error} adornment={adornment}>
      <select
        id={fid}
        name={name}
        className={["select", className].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, help, error)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function Textarea({ label, help, error, adornment, id, name, className, ...rest }: FieldChrome & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const fid = id ?? `f-${name}`;
  return (
    <Field id={fid} label={label} help={help} error={error} adornment={adornment}>
      <textarea
        id={fid}
        name={name}
        className={["textarea", className].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, help, error)}
        {...rest}
      />
    </Field>
  );
}

/** A labelled checkbox (label wraps the input). */
export function Checkbox({ label, id, name, ...rest }: { label: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className="check" htmlFor={id}>
      <input type="checkbox" id={id} name={name} {...rest} />
      <span>{label}</span>
    </label>
  );
}

/** An on/off switch: a checkbox with `role="switch"`, so it submits like a checkbox. */
export function Switch({ label, id, name, ...rest }: { label: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role">) {
  return (
    <label className="switch" htmlFor={id}>
      <input type="checkbox" role="switch" id={id} name={name} {...rest} />
      <span>{label}</span>
    </label>
  );
}
