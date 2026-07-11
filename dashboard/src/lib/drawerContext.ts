import { createContext, useContext } from "react";
import type { DrawerContextValue } from "./drawer";

export const DrawerContext = createContext<DrawerContextValue | null>(null);

export function useDrawer(): DrawerContextValue {
  const context = useContext(DrawerContext);
  if (!context) throw new Error("useDrawer must be used within DrawerProvider");
  return context;
}
