'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useAgentProposals, type UseAgentProposalsResult } from '@/lib/hooks/useAgentProposals';

interface ActionDrawerState extends UseAgentProposalsResult {
  open: boolean;
  setOpen: (open: boolean) => void;
  isOwner: boolean;
}

const ActionDrawerContext = createContext<ActionDrawerState>({
  status: 'idle',
  proposals: [],
  error: null,
  resolveProposal: async () => false,
  open: false,
  setOpen: () => {},
  isOwner: false,
});

interface ActionDrawerProviderProps {
  children: ReactNode;
  isAuthenticated?: boolean;
  isOwner?: boolean;
}

export function ActionDrawerProvider({
  children,
  isAuthenticated = false,
  isOwner = false,
}: ActionDrawerProviderProps) {
  const [open, setOpen] = useState(false);
  const { status, proposals, error, resolveProposal } = useAgentProposals(isAuthenticated);

  return (
    <ActionDrawerContext value={{ status, proposals, error, resolveProposal, open, setOpen, isOwner }}>
      {children}
    </ActionDrawerContext>
  );
}

export function useActionDrawer() {
  return useContext(ActionDrawerContext);
}
