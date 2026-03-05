'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

interface SidebarState {
  open: boolean;
  setOpen: (open: boolean) => void;
  orgName: string;
  setOrgName: (name: string) => void;
}

const SidebarContext = createContext<SidebarState>({
  open: false,
  setOpen: () => {},
  orgName: '',
  setOrgName: () => {},
});

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [orgName, setOrgName] = useState('');

  return (
    <SidebarContext value={{ open, setOpen, orgName, setOrgName }}>
      {children}
    </SidebarContext>
  );
}

export function useSidebar() {
  return useContext(SidebarContext);
}
