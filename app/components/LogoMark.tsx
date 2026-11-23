/**
 * ReVault wordmark: solid accent rounded square with a dark zigzag.
 * One shared mark for the home page, the admin header and the sign-in card.
 * No gradients, no invented logos beyond the mark already in the repo.
 */
export default function LogoMark({
  size = 36,
  className,
}: {
  size?: number | undefined;
  className?: string | undefined;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect width="36" height="36" rx="10" fill="currentColor" />
      <path
        d="M10 18l4-6 4 6 4-6 4 6"
        stroke="#052e16"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
