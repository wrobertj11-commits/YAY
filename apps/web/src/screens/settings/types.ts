import type { Nav } from '../../App.tsx';
import type { Me } from '../../api.ts';

/** Props every Account-screen section receives. */
export interface SectionProps {
  me: Me;
  nav: Nav;
  busy: boolean;
  /** Runs an API call with the busy flag, refreshes app data, and toasts `msg` on success (or the error). */
  run: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
  toast: (msg: string) => void;
  onSignOut: () => void;
}
