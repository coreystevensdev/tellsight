'use client';

import { Toaster } from 'sonner';
import { useTheme } from 'next-themes';
import { useIsMobile } from '@/lib/hooks/useIsMobile';

export function ResponsiveToaster() {
  const isMobile = useIsMobile();
  const { resolvedTheme } = useTheme();

  return (
    <Toaster
      position={isMobile ? 'top-center' : 'bottom-right'}
      theme={resolvedTheme as 'light' | 'dark' | undefined}
      richColors
    />
  );
}
