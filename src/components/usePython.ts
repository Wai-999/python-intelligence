import { useEffect, useState } from "react";
import { getRunner, type RunnerStatus } from "../py/runner";

export function usePythonStatus(): RunnerStatus {
  const runner = getRunner();
  const [status, setStatus] = useState<RunnerStatus>(runner.status);
  useEffect(() => runner.onStatus(setStatus), [runner]);
  return status;
}

export const STATUS_TEXT: Record<RunnerStatus, string> = {
  idle: "Python not loaded yet. It downloads on first run (about 10 MB, then cached).",
  loading: "Loading Python… the first time takes a few seconds.",
  "loading-packages": "Loading lesson packages… the first download may take a minute. Run again to retry if it fails.",
  ready: "Python ready",
  running: "Running…",
  error: "Python failed to load",
};
