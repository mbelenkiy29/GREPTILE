import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export function buttonClass(variant: ButtonVariant = "default", size: ButtonSize = "md", block = false, extra?: string): string {
  return [
    "button",
    variant !== "default" && `button-${variant}`,
    size !== "md" && `button-${size}`,
    block && "button-block",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: IconName;
  children?: ReactNode;
}

/**
 * A button. Defaults to `type="button"`; pass `type="submit"` in forms. `loading` disables it and shows a spinner
 * (for client forms; server-action forms can use {@link SubmitButton}).
 */
export function Button({
  variant,
  size,
  block,
  icon,
  loading = false,
  className,
  children,
  type = "button",
  disabled,
  ...rest
}: CommonProps & { loading?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, block, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

/** A link styled as a button. External links open in a new tab with `rel="noreferrer"`. */
export function ButtonLink({
  href,
  variant,
  size,
  block,
  icon,
  external = false,
  className,
  children,
  ...rest
}: CommonProps & { href: string; external?: boolean } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const cls = buttonClass(variant, size, block, className);
  const content = (
    <>
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
      {external && <Icon name="external" size={12} />}
    </>
  );
  if (external || href.startsWith("/api/")) {
    return (
      <a href={href} className={cls} {...(external ? { target: "_blank", rel: "noreferrer" } : {})} {...rest}>
        {content}
      </a>
    );
  }
  return (
    <Link href={href} className={cls} {...rest}>
      {content}
    </Link>
  );
}

/** An icon-only button; `label` is its accessible name (and tooltip). */
export function IconButton({
  icon,
  label,
  outline = false,
  className,
  type = "button",
  ...rest
}: { icon: IconName; label: string; outline?: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button type={type} className={["icon-button", outline && "icon-button-outline", className].filter(Boolean).join(" ")} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={18} />
    </button>
  );
}
