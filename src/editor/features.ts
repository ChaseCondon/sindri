// Editor decoration subscription — ADR-0024
// Bridges configStore.onDidChange to compartment reconfigures across all open views.
// Must be imported at app startup (App.tsx) for the subscription to be active.
import { getAllEditorViews } from "./groups";
import { applyChangedDecorations } from "./decoration-registry";
import { onDidChange } from "../workbench/settings/configStore";

onDidChange((changedKeys) => {
  applyChangedDecorations(changedKeys, getAllEditorViews());
});
