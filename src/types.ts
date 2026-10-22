export type Asset = {
  kind: 'image' | 'model'; model: ModelInfo | null;
  owners?: { id: string; name: string; relation: string }[];
  id: string; folder_id: string; path: string; name: string; ext: string;
  size: number; width: number; height: number; mtime: number; thumbnail: string | null;
  tags: string[]; favorite: boolean; status: string; error: string | null;
  score?: number; added: number; copy_count?: number; member_ids?: string[];
  collections?: { id: string; name: string }[];
  resource_count?: number; bound_count?: number; auxiliary_count?: number;
  recovery_candidates?: Asset[];
  history?: { old_path: string; action: string; created: number }[];
};
export type ModelResource = { path: string; reference: string; role?: string; exists: boolean; embedded: boolean;
  relation: 'bound' | 'auxiliary'; kind: 'texture' | 'buffer' | 'document';
  materials: { name: string; role: string }[] };
export type ModelInfo = { name: string; cache: string; vertices: number; triangles: number; meshes: number; bones?: number;
  bound_textures: number; auxiliary_files: number; missing_resources: number; comment: string; warnings: string[];
  materials: { name: string; bindings: { role: string; reference: string; exists: boolean; resource_index: number }[] }[];
  resources: ModelResource[] };
export type Folder = { id: string; name: string; path: string; count: number; status: string;
  exclusions: string[]; excluded_count: number };
export type Collection = { id: string; name: string; count: number };
export type Job = { id: string; folder_id: string; name: string; status: string; total: number;
  done: number; failed: number; error: string | null; created: number };
export type Summary = { total: number; favorites: number; counts: Record<string, number>;
  models: number; components: number; blender_available: boolean;
  recovery?: { action: string; count: number }[];
  folders: Folder[]; tags: { name: string; count: number }[]; model: string;
  model_error: string | null; data_dir: string; jobs: Job[]; collections: Collection[] };
export type Result = { items: Asset[]; total: number; scope_total?: number; unique_total?: number;
  collapsed_count?: number; top_k?: number; resource_total?: number };
export type Connection = { base: string; token: string };
declare global {
  interface Window {
    prism: {
      connection(): Promise<Connection>;
      api<T = unknown>(route: string, method?: string, body?: unknown): Promise<T>;
      chooseFolder(): Promise<string[]>;
      chooseImage(): Promise<string | null>;
      reveal(path: string): Promise<void>;
      openFile(id: string): Promise<void>;
      copy(text: string): Promise<void>;
      restart(): Promise<void>;
      confirmDetach(name: string): Promise<boolean>;
      filePath(file: File): string;
      onServiceError(callback: (message: string) => void): () => void;
    }
  }
}
