/**
 * Official multicolor brand marks for the sign-in providers. Kept as inline
 * multi-path SVGs (not via the single-path/single-color BrandIcon) because
 * these logos are intentionally multicolor. Public brand marks, drawn to spec.
 */

export function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.04 12.261c0-.815-.073-1.6-.21-2.353H12v4.451h6.19a5.29 5.29 0 0 1-2.296 3.472v2.886h3.716c2.174-2.002 3.43-4.95 3.43-8.456z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.105 0 5.71-1.03 7.613-2.787l-3.716-2.886c-1.03.69-2.347 1.097-3.897 1.097-2.996 0-5.532-2.024-6.437-4.744H1.73v2.98A11.997 11.997 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.563 14.68A7.21 7.21 0 0 1 5.18 12c0-.93.16-1.832.383-2.68V6.34H1.73A11.997 11.997 0 0 0 .455 12c0 1.94.464 3.775 1.275 5.66l3.833-2.98z"
      />
      <path
        fill="#EA4335"
        d="M12 4.773c1.69 0 3.205.582 4.398 1.722l3.298-3.298C17.706 1.184 15.102 0 12 0 7.392 0 3.41 2.633 1.73 6.34l3.833 2.98C6.468 6.6 9.004 4.773 12 4.773z"
      />
    </svg>
  );
}

export function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
      <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
      <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </svg>
  );
}
