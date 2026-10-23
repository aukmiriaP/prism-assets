export type SearchStrategy = 'hybrid' | 'keyword' | 'semantic';
export type Asset = {
  kind: 'image' | 'model' | 'material' | 'motion'; model: ModelInfo | null; material: MaterialInfo | null;
  motion?: MotionInfo | null;
  motion_package?: MotionPackage;
  owners?: { id: string; name: string; kind: string; relation: string }[];
  id: string; folder_id: string; path: string; name: string; ext: string;
  size: number; width: number; height: number; mtime: number; thumbnail: string | null;
  tags: string[]; favorite: boolean; status: string; error: string | null;
  score?: number; added: number; copy_count?: number; member_ids?: string[];
  match_kind?: 'keyword' | 'semantic' | 'both'; keyword_fields?: string[];
  collections?: { id: string; name: string; parent_id?: string | null; path?: string }[];
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
export type Directory = { name: string; path: string };
export type Collection = { id: string; name: string; count: number; parent_id: string | null;
  path: string; ancestor_ids: string[]; child_count: number };
export type Job = { id: string; folder_id: string; name: string; status: string; total: number;
  done: number; failed: number; error: string | null; created: number };
export type Summary = { total: number; favorites: number; counts: Record<string, number>;
  models: number; materials: number; motions: number; motion_packages: number; components: number; independent_images: number; blender_available: boolean;
  recovery?: { action: string; count: number }[];
  folders: Folder[]; tags: { name: string; count: number }[]; model: string;
  model_error: string | null; data_dir: string; jobs: Job[]; collections: Collection[] };
export type Result = { items: Asset[]; total: number; scope_total?: number; unique_total?: number;
  collapsed_count?: number; top_k?: number; resource_total?: number; strategy?: SearchStrategy;
  keyword_total?: number; returned_keyword?: number; warning?: string; semantic_available?: boolean };
export type Connection = { base: string; token: string };
export type MotionPackage = { name: string; path: string; count: number; types: Record<string, number>; duration: number; errors: number };
export type MotionInfo = { type: 'body' | 'facial' | 'camera' | 'other'; fps: number; frames: number; duration: number;
  bones: number; active_bones: string[]; bone_keys: number; morph_keys: number; camera_keys: number;
  ik_keys: number; warnings: string[]; target: string };
export type MaterialRole = 'base_color' | 'normal' | 'roughness' | 'metallic' | 'ao' | 'emissive' | 'opacity';
export type MaterialBinding = { file: string; channel: string; invert: boolean };
export type MaterialConfig = { version: number; source_dir: string; name: string;
  maps: Partial<Record<MaterialRole, MaterialBinding>>; normal_format: 'opengl' | 'directx';
  color: string; roughness: number; metallic: number; normal_strength: number;
  emissive_strength: number; opacity: number; repeat: number };
export type MaterialPreview = { preview_id?: string; cache?: string; config: MaterialConfig;
  maps: Partial<Record<MaterialRole, MaterialBinding & { cache_file: string; color_space: string; width: number; height: number }>>;
  warnings: string[] };
export type MaterialInfo = { config: MaterialConfig; published?: MaterialPreview };
export type MaterialInspection = { config: MaterialConfig;
  files: { file: string; name: string; width: number; height: number; alpha: boolean }[]; warnings: string[] };
declare global {
  interface Window {
    prism: {
      connection(): Promise<Connection>;
      api<T = unknown>(route: string, method?: string, body?: unknown): Promise<T>;
      chooseFolder(): Promise<string[]>;
      chooseImage(): Promise<string | null>;
      chooseMaterial(): Promise<string | null>;
      exportMaterial(id: string): Promise<string | null>;
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
