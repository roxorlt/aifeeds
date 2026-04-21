import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { Item } from "../types";

interface DrawerState {
  item: Item | null;
  siblings: Item[];
}

interface DrawerContextValue {
  state: DrawerState;
  openTweet: (item: Item, siblings?: Item[]) => void;
  close: () => void;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DrawerState>({ item: null, siblings: [] });

  const openTweet = useCallback((item: Item, siblings: Item[] = []) => {
    setState({ item, siblings });
  }, []);

  const close = useCallback(() => {
    setState({ item: null, siblings: [] });
  }, []);

  return (
    <DrawerContext.Provider value={{ state, openTweet, close }}>
      {children}
    </DrawerContext.Provider>
  );
}

export function useDrawer(): DrawerContextValue {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error("useDrawer must be used within DrawerProvider");
  return ctx;
}
