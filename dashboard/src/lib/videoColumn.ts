import { createContext, useContext } from "react";

export interface VideoColumnContextValue {
  columnId: string;
}

const DEFAULT: VideoColumnContextValue = { columnId: "default" };

export const VideoColumnContext = createContext<VideoColumnContextValue>(DEFAULT);

export function useVideoColumn(): VideoColumnContextValue {
  return useContext(VideoColumnContext);
}
