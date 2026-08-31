import type { ReactNode } from 'react';

// Every route needs a main landmark. Without one a screen reader user has no
// way to jump past the chrome, and axe flags it. The dashboard gets its own
// from dashboard/layout.tsx; the auth routes had none.
//
// Deliberately adds no styling. Each page under here already renders its own
// full-screen container, so anything more would fight it.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <main id="main-content">{children}</main>;
}
