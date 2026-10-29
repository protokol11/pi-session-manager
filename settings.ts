// Config shape for the session-manager extension.

export type Settings = {
  defaultView: "recent" | "explorer";
  trashDir: string;
  debugLog: boolean;
};

export function loadSettings(): Settings {
  return {
    defaultView: "explorer",
    trashDir: ".trash",
    debugLog: process.env.PI_SS_DEBUG_LOG === "1",
  };
}
