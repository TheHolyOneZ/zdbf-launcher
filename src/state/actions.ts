import { api, errorText } from "../lib/api";
import { useStore } from "./store";

export function useBotActions(id: string | null) {
  const toast = useStore((s) => s.toast);
  const run = (fn: (id: string) => Promise<void>) => async () => {
    if (!id) return;
    try {
      await fn(id);
    } catch (e) {
      toast("bad", errorText(e));
    }
  };
  return { start: run(api.start), stop: run(api.stop), restart: run(api.restart) };
}
