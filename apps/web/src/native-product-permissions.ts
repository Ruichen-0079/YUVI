import { createContext } from "react";
/** UI projection only; the Server remains the authority for every request. */
export const NativeMemoryPermission = createContext<boolean | undefined>(undefined);
