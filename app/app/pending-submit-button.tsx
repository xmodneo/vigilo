'use client';

import { useFormStatus } from 'react-dom';

export function PendingSubmitButton({
  children,
  className,
  disabled = false,
  pendingLabel,
}: {
  children: React.ReactNode;
  className: string;
  disabled?: boolean;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={disabled || pending} aria-busy={pending} data-pending-label={pendingLabel}>
      {pending ? pendingLabel : children}
    </button>
  );
}
