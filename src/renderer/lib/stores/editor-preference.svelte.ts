import { invoke } from "$lib/ipc.svelte";
import type { EditorId, EditorInfo } from "$shared/types";

class EditorPreferenceStore {
  editors = $state<EditorInfo[]>([]);
  preferredEditor = $state<EditorId>("system");
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  get availableEditors(): EditorInfo[] {
    return this.editors.filter((editor) => editor.available);
  }

  get preferredInfo(): EditorInfo | undefined {
    return this.editors.find((editor) => editor.id === this.preferredEditor);
  }

  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = Promise.all([
      invoke("editors:detect"),
      invoke("editors:getPreferred"),
    ])
      .then(([editors, preferredEditor]) => {
        this.editors = editors;
        this.preferredEditor = preferredEditor;
        this.loaded = true;
      })
      .catch(() => {
        this.editors = [];
      })
      .finally(() => {
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  async select(editorId: EditorId): Promise<void> {
    if (editorId === this.preferredEditor) return;
    const previous = this.preferredEditor;
    this.preferredEditor = editorId;
    try {
      await invoke("editors:setPreferred", editorId);
    } catch (error) {
      this.preferredEditor = previous;
      throw error;
    }
  }
}

export const editorPreference = new EditorPreferenceStore();
