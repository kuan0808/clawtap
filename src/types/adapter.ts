export interface AdapterConfig {
  models: { value: string; label: string; contextWindow: number }[];
  permissionModes: { value: string; label: string }[];
  effortLevels: { value: string; label: string }[];
  effortLabel: string;
}

export interface SavedInstruction {
  id: string;
  label: string;
  instruction: string;
  created_at: string;
}
