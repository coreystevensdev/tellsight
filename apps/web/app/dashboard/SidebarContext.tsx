'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

interface SidebarState {
  open: boolean;
  setOpen: (open: boolean) => void;
  orgName: string;
  setOrgName: (name: string) => void;
  isAdmin: boolean;
}

const SidebarContext = createContext<SidebarState>({
  open: false,
  setOpen: () => {},
  orgName: '',
  setOrgName: () => {},
  isAdmin: false,
});

interface SidebarProviderProps {
  children: ReactNode;
  isAdmin?: boolean;
}

export function SidebarProvider({ children, isAdmin = false }: SidebarProviderProps) {
  const [open, setOpen] = useState(false);
  const [orgName, setOrgName] = useState('');

  return (
    <SidebarContext value={{ open, setOpen, orgName, setOrgName, isAdmin }}>
      {children}
    </SidebarContext>
  );
}

export function useSidebar() {
  return useContext(SidebarContext);
}
