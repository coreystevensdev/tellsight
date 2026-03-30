'use client';

import { Toaster } from 'sonner';
import { useIsMobile } from '@/lib/hooks/useIsMobile';

export function ResponsiveToaster() {
  const isMobile = useIsMobile();
  return <Toaster position={isMobile ? 'top-center' : 'bottom-right'} richColors />;
}
